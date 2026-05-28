import { Router } from 'express';
import multer from 'multer';
import { extractUser } from '../middleware/auth';
import { uploadToS3 } from '../s3';
import { getPool } from '../db';
import { activeUploads } from '../lib/activeUploads';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

router.post('/upload', extractUser, upload.single('file'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (!req.file) {
    send({ step: 'error', message: 'No file provided' });
    res.end();
    return;
  }

  const { email } = req.user!;
  const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const s3Key = `uploads/${Date.now()}_${req.file.originalname}`;
  const totalBytes = req.file.size;
  const skippedRows = parseInt(req.body?.skipped_rows ?? '0', 10) || 0;

  activeUploads.set(uploadId, {
    uploadId,
    filename: req.file.originalname,
    startedAt: new Date(),
    startedBy: email,
    phase: 'uploading',
    bytesUploaded: 0,
    totalBytes,
    skippedRows: skippedRows || undefined,
  });

  send({ step: 'received', filename: req.file.originalname, totalBytes, uploadId });

  try {
    await uploadToS3(s3Key, req.file.buffer, 'text/csv', (loaded, total) => {
      const job = activeUploads.get(uploadId);
      if (job) { job.bytesUploaded = loaded; job.totalBytes = total; }
      send({ step: 'uploading', bytesUploaded: loaded, totalBytes: total });
    });

    const job = activeUploads.get(uploadId);
    if (job) job.phase = 'saving';
    send({ step: 'saving' });

    const result = await getPool().query<{ id: number }>(
      `INSERT INTO upload_log (s3_key, filename, uploaded_by, size_bytes, skipped_rows)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [s3Key, req.file.originalname, email, totalBytes, skippedRows],
    );

    activeUploads.delete(uploadId);
    send({
      step: 'done',
      upload_id: result.rows[0].id,
      s3_key: s3Key,
      filename: req.file.originalname,
      size_bytes: totalBytes,
      skipped_rows: skippedRows || undefined,
    });
    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Upload error:', err);
    activeUploads.delete(uploadId);
    send({ step: 'error', message: msg });
    res.end();
  }
});

router.get('/uploads/active', extractUser, (req, res) => {
  const { email, groups } = req.user!;
  const isDev = groups.includes('data-loader-dev');
  const jobs = [...activeUploads.values()]
    .filter((j) => isDev || j.startedBy === email)
    .map((j) => ({ ...j, startedAt: j.startedAt.toISOString() }));
  res.json(jobs);
});

router.get('/uploads', extractUser, async (req, res) => {
  const { email, groups } = req.user!;
  const isDev = groups.includes('data-loader-dev');

  const active = [...activeUploads.values()]
    .filter((j) => isDev || j.startedBy === email)
    .map((j) => ({
      upload_id: j.uploadId,
      filename: j.filename,
      s3_key: null,
      uploaded_by: j.startedBy,
      uploaded_at: j.startedAt.toISOString(),
      size_bytes: j.totalBytes,
      skipped_rows: j.skippedRows ?? 0,
      status: 'in_progress' as const,
    }));

  let completed: unknown[] = [];
  try {
    const dbTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DB timeout')), 8000),
    );
    const result = await Promise.race([
      getPool().query(
        `SELECT id AS upload_id, filename, s3_key, uploaded_by, uploaded_at, size_bytes, skipped_rows
         FROM upload_log
         ORDER BY uploaded_at DESC
         LIMIT 50`,
      ),
      dbTimeout,
    ]);
    completed = result.rows;
  } catch (err) {
    console.error('List uploads DB error (returning active-only):', err);
  }

  res.json([...active, ...completed]);
});

export default router;
