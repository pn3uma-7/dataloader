import { Router } from 'express';
import { Transform } from 'stream';
import { from as copyFrom } from 'pg-copy-streams';
import { extractUser } from '../middleware/auth';
import { getS3Stream, getS3ObjectSize } from '../s3';
import { createTrimmingTransform } from '../lib/trimCsv';
import { getPool } from '../db';
import { activeJobs } from '../lib/activeJobs';

const router = Router();

const ALLOWED_TYPES = new Set(['VARCHAR', 'INTEGER', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSONB']);
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

interface ColumnDef {
  name: string;
  type: string;
  primary_key: boolean;
  nullable: boolean;
}

router.post('/inject', extractUser, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { upload_id, s3_key, table_name, columns } = req.body as {
    upload_id: number | null;
    s3_key: string;
    table_name: string;
    columns: ColumnDef[];
  };

  const { email, groups } = req.user!;

  if (!TABLE_NAME_RE.test(table_name)) {
    send({ step: 'error', message: 'Invalid table name. Use lowercase letters, numbers, and underscores only.' });
    res.end();
    return;
  }

  const isBusinessOnly = groups.includes('data-loader-business') && !groups.includes('data-loader-dev');
  if (isBusinessOnly && !table_name.startsWith('biz_')) {
    send({ step: 'error', message: 'Business users must prefix table names with biz_' });
    res.end();
    return;
  }

  if (!Array.isArray(columns) || columns.length === 0) {
    send({ step: 'error', message: 'No columns defined' });
    res.end();
    return;
  }

  for (const col of columns) {
    if (!ALLOWED_TYPES.has(col.type)) {
      send({ step: 'error', message: `Unsupported column type: ${col.type}` });
      res.end();
      return;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col.name)) {
      send({ step: 'error', message: `Invalid column name: ${col.name}` });
      res.end();
      return;
    }
  }

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  activeJobs.set(jobId, {
    jobId,
    tableName: table_name,
    startedAt: new Date(),
    startedBy: email,
    phase: 'validating',
    bytesStreamed: 0,
    totalBytes: 0,
    columnCount: columns.length,
  });

  send({ step: 'validating', jobId });

  const pool = getPool();
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    let totalBytes = 0;
    if (upload_id != null) {
      const uploadRow = await client.query<{ size_bytes: number }>(
        'SELECT size_bytes FROM upload_log WHERE id = $1',
        [upload_id],
      );
      totalBytes = uploadRow.rows[0]?.size_bytes ?? 0;
    }
    if (totalBytes === 0) {
      totalBytes = await getS3ObjectSize(s3_key);
    }
    activeJobs.get(jobId)!.totalBytes = totalBytes;

    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [table_name],
    );
    if (exists.rows.length > 0) {
      activeJobs.delete(jobId);
      send({ step: 'error', code: 'TABLE_EXISTS', message: `Table '${table_name}' already exists.` });
      res.end();
      return;
    }

    const colDefs = columns.map((c) => {
      const nullable = c.nullable ? '' : ' NOT NULL';
      return `"${c.name}" ${c.type}${nullable}`;
    });
    const pkCols = columns.filter((c) => c.primary_key);
    if (pkCols.length > 0) {
      colDefs.push(`PRIMARY KEY (${pkCols.map((c) => `"${c.name}"`).join(', ')})`);
    }

    await client.query(`CREATE TABLE "${table_name}" (${colDefs.join(', ')})`);

    activeJobs.get(jobId)!.phase = 'table_created';
    send({ step: 'table_created', tableName: table_name, columnCount: columns.length });

    const s3Stream = await getS3Stream(s3_key);
    const ingestStream = client.query(
      copyFrom(`COPY "${table_name}" FROM STDIN WITH (FORMAT csv, HEADER true)`),
    );

    let bytesStreamed = 0;
    let lastSentBytes = 0;
    const PROGRESS_INTERVAL = 2 * 1024 * 1024; // 2 MB

    const progressTracker = new Transform({
      transform(chunk, _encoding, callback) {
        bytesStreamed += chunk.length;
        if (bytesStreamed - lastSentBytes >= PROGRESS_INTERVAL || lastSentBytes === 0) {
          lastSentBytes = bytesStreamed;
          const job = activeJobs.get(jobId);
          if (job) { job.bytesStreamed = bytesStreamed; job.phase = 'streaming'; }
          send({ step: 'progress', bytesStreamed, totalBytes });
        }
        callback(null, chunk);
      },
    });

    activeJobs.get(jobId)!.phase = 'streaming';
    send({ step: 'streaming', totalBytes });

    const trimmer = createTrimmingTransform();

    await new Promise<void>((resolve, reject) => {
      s3Stream.on('error', reject);
      trimmer.on('error', reject);
      progressTracker.on('error', reject);
      ingestStream.on('error', reject);
      ingestStream.on('finish', resolve);
      s3Stream.pipe(trimmer).pipe(progressTracker).pipe(ingestStream);
    });

    const rowCount: number = (ingestStream as unknown as { rowCount: number }).rowCount ?? 0;
    const durationMs = Date.now() - startTime;

    const logResult = await client.query<{ id: number }>(
      `INSERT INTO inject_log (upload_id, table_name, schema_json, status, row_count, duration_ms, injected_by)
       VALUES ($1, $2, $3, 'success', $4, $5, $6) RETURNING id`,
      [upload_id, table_name, JSON.stringify(columns), rowCount, durationMs, email],
    );

    activeJobs.delete(jobId);
    send({ step: 'done', rowCount, durationMs, injectId: logResult.rows[0].id });
    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Inject error:', err);
    activeJobs.delete(jobId);
    try {
      await pool.query(
        `INSERT INTO inject_log (upload_id, table_name, schema_json, status, error_msg, duration_ms, injected_by)
         VALUES ($1, $2, $3, 'failed', $4, $5, $6)`,
        [upload_id, table_name, JSON.stringify(columns), msg, Date.now() - startTime, email],
      );
    } catch (logErr) {
      console.error('Failed to write inject error log:', logErr);
    }
    send({ step: 'error', message: msg });
    res.end();
  } finally {
    client.release();
  }
});

export default router;
