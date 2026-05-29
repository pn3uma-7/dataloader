import { Router } from 'express';
import { Transform } from 'stream';
import { from as copyFrom } from 'pg-copy-streams';
import { extractUser } from '../middleware/auth';
import { getS3Stream, getS3ObjectSize } from '../s3';
import { createTrimmingTransform } from '../lib/trimCsv';
import { createFilterRowsTransform } from '../lib/filterRows';
import { validateColumnType } from '../lib/typeValidator';
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

  const { upload_id, s3_key, table_name, columns, skip_row_nums } = req.body as {
    upload_id: number | null;
    s3_key: string;
    table_name: string;
    columns: ColumnDef[];
    skip_row_nums?: number[];
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
    const skipSet = new Set(skip_row_nums ?? []);

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
      if (skipSet.size > 0) {
        const filter = createFilterRowsTransform(skipSet);
        filter.on('error', reject);
        s3Stream.pipe(filter).pipe(trimmer).pipe(progressTracker).pipe(ingestStream);
      } else {
        s3Stream.pipe(trimmer).pipe(progressTracker).pipe(ingestStream);
      }
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

router.post('/inject/preview', extractUser, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { s3_key, columns } = req.body as { s3_key: string; columns: ColumnDef[] };

  if (!s3_key || !Array.isArray(columns) || columns.length === 0) {
    send({ step: 'error', message: 'Missing s3_key or columns' });
    res.end();
    return;
  }

  try {
    const s3Stream = await getS3Stream(s3_key);

    let headerDone = false;
    let headers: string[] = [];
    let rowNum = 0;
    const sampleRows: string[][] = [];
    const typeErrors = new Map<string, { pgType: string; count: number; examples: string[] }>();
    const badRowNums: number[] = [];
    let leftover = '';

    const processLine = (line: string) => {
      if (!line) return;
      if (!headerDone) {
        headers = line.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        headerDone = true;
        return;
      }
      rowNum++;
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      let rowHasError = false;

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const value = values[i] ?? '';
        if (!value || col.type === 'VARCHAR' || col.type === 'BOOLEAN') continue;
        if (!validateColumnType(value, col.type)) {
          const entry = typeErrors.get(col.name) ?? { pgType: col.type, count: 0, examples: [] };
          entry.count++;
          if (entry.examples.length < 5) entry.examples.push(`row ${rowNum}, "${col.name}" = "${value}"`);
          typeErrors.set(col.name, entry);
          rowHasError = true;
        }
      }

      if (rowHasError) badRowNums.push(rowNum);
      if (sampleRows.length < 5) sampleRows.push(values);
      if (rowNum % 10_000 === 0) send({ step: 'scanning', rowsScanned: rowNum });
    };

    await new Promise<void>((resolve, reject) => {
      s3Stream.on('error', reject);
      s3Stream.on('data', (chunk: Buffer) => {
        const lines = (leftover + chunk.toString('utf8')).split('\n');
        leftover = lines.pop() ?? '';
        for (const raw of lines) processLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      });
      s3Stream.on('end', () => {
        if (leftover) processLine(leftover.endsWith('\r') ? leftover.slice(0, -1) : leftover);
        resolve();
      });
    });

    send({
      step: 'done',
      rowCount: rowNum,
      badRowCount: badRowNums.length,
      typeErrors: [...typeErrors.entries()].map(([column, d]) => ({
        column, pgType: d.pgType, count: d.count, examples: d.examples,
      })),
      headers,
      sampleRows,
      badRowNums,
    });
    res.end();
  } catch (err) {
    send({ step: 'error', message: err instanceof Error ? err.message : 'Preview failed' });
    res.end();
  }
});

export default router;
