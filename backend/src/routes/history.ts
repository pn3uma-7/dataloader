import { Router } from 'express';
import { extractUser } from '../middleware/auth';
import { getPool } from '../db';
import { activeJobs } from '../lib/activeJobs';
import { activeUploads } from '../lib/activeUploads';

const router = Router();

router.get('/inject/active', extractUser, (req, res) => {
  const { email, groups } = req.user!;
  const isDev = groups.includes('data-loader-dev');
  const jobs = [...activeJobs.values()]
    .filter((j) => isDev || j.startedBy === email)
    .map((j) => ({ ...j, startedAt: j.startedAt.toISOString() }));
  res.json(jobs);
});

router.get('/history', extractUser, async (req, res) => {
  const { email, groups } = req.user!;
  const isDev = groups.includes('data-loader-dev');
  const userFilter = isDev ? [] : [email];

  // Collect in-memory active jobs synchronously — always available even if DB is down
  const activeUploadEntries = [...activeUploads.values()]
    .filter((j) => isDev || j.startedBy === email)
    .map((j) => ({
      type: 'upload' as const,
      id: j.uploadId,
      name: j.filename,
      s3_key: null,
      status: 'in_progress' as const,
      size_bytes: j.totalBytes,
      row_count: null,
      duration_ms: null,
      error_msg: null,
      by: j.startedBy,
      at: j.startedAt.toISOString(),
      progress: { phase: j.phase, bytesLoaded: j.bytesUploaded, totalBytes: j.totalBytes },
    }));

  const activeInjectEntries = [...activeJobs.values()]
    .filter((j) => isDev || j.startedBy === email)
    .map((j) => ({
      type: 'inject' as const,
      id: j.jobId,
      name: j.tableName,
      s3_key: null,
      status: 'in_progress' as const,
      size_bytes: null,
      row_count: null,
      duration_ms: null,
      error_msg: null,
      by: j.startedBy,
      at: j.startedAt.toISOString(),
      progress: { phase: j.phase, bytesLoaded: j.bytesStreamed, totalBytes: j.totalBytes },
    }));

  // Query DB with a timeout — fall back to active-only on failure so the page never hangs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let uploads: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let injects: any[] = [];

  try {
    const dbTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DB timeout')), 8000),
    );
    const [uploadRows, injectRows] = await Promise.race([
      Promise.all([
        isDev
          ? getPool().query(
              `SELECT id, filename, s3_key, uploaded_by, uploaded_at, size_bytes FROM upload_log ORDER BY uploaded_at DESC LIMIT 100`,
            )
          : getPool().query(
              `SELECT id, filename, s3_key, uploaded_by, uploaded_at, size_bytes FROM upload_log WHERE uploaded_by = $1 ORDER BY uploaded_at DESC LIMIT 100`,
              userFilter,
            ),
        isDev
          ? getPool().query(
              `SELECT id, table_name, status, row_count, error_msg, duration_ms, injected_by, injected_at FROM inject_log ORDER BY injected_at DESC LIMIT 100`,
            )
          : getPool().query(
              `SELECT id, table_name, status, row_count, error_msg, duration_ms, injected_by, injected_at FROM inject_log WHERE injected_by = $1 ORDER BY injected_at DESC LIMIT 100`,
              userFilter,
            ),
      ]),
      dbTimeout,
    ]);

    uploads = uploadRows.rows.map((r) => ({
      type: 'upload' as const,
      id: r.id,
      name: r.filename,
      s3_key: r.s3_key,
      status: 'success' as const,
      size_bytes: r.size_bytes,
      row_count: null,
      duration_ms: null,
      error_msg: null,
      by: r.uploaded_by,
      at: r.uploaded_at,
      progress: null,
    }));

    injects = injectRows.rows.map((r) => ({
      type: 'inject' as const,
      id: r.id,
      name: r.table_name,
      s3_key: null,
      status: r.status as 'success' | 'failed',
      size_bytes: null,
      row_count: r.row_count,
      duration_ms: r.duration_ms,
      error_msg: r.error_msg,
      by: r.injected_by,
      at: r.injected_at,
      progress: null,
    }));
  } catch (err) {
    console.error('History DB error (returning active-only):', err);
  }

  const all = [...activeUploadEntries, ...activeInjectEntries, ...uploads, ...injects].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  res.json(all);
});

// Keep old inject-only endpoint for backwards compat
router.get('/inject/history', extractUser, async (req, res) => {
  try {
    const { email, groups } = req.user!;
    const isDev = groups.includes('data-loader-dev');
    const result = isDev
      ? await getPool().query(
          `SELECT id AS inject_id, table_name, status, row_count, injected_by, injected_at FROM inject_log ORDER BY injected_at DESC LIMIT 100`,
        )
      : await getPool().query(
          `SELECT id AS inject_id, table_name, status, row_count, injected_by, injected_at FROM inject_log WHERE injected_by = $1 ORDER BY injected_at DESC LIMIT 100`,
          [email],
        );
    const inProgress = [...activeJobs.values()]
      .filter((j) => isDev || j.startedBy === email)
      .map((j) => ({
        inject_id: j.jobId,
        table_name: j.tableName,
        status: 'in_progress' as const,
        row_count: null,
        injected_by: j.startedBy,
        injected_at: j.startedAt.toISOString(),
        progress: { phase: j.phase, bytesStreamed: j.bytesStreamed, totalBytes: j.totalBytes },
      }));
    res.json([...inProgress, ...result.rows]);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
