import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ColumnEditor from '../components/ColumnEditor';
import Papa from 'papaparse';
import { apiGet, apiDelete, getAuthHeaders } from '../lib/api';
import { ActiveInjectsPanel, ActiveUploadsPanel } from '../components/ActiveOperations';
import type { Column, S3File, Upload, UploadResponse } from '../types';

const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// ── Preview types ────────────────────────────────────────────────────────────

interface PreviewTypeError {
  column: string;
  pgType: string;
  count: number;
  examples: string[];
}

interface InjectPreviewResult {
  rowCount: number;
  badRowCount: number;
  typeErrors: PreviewTypeError[];
  headers: string[];
  sampleRows: string[][];
  badRowNums: number[];
}

type PreviewPhase = 'idle' | 'scanning' | 'done' | 'error';

interface PreviewProgress {
  phase: PreviewPhase;
  rowsScanned?: number;
  result?: InjectPreviewResult;
  errorMessage?: string;
}

// ── Inject types ─────────────────────────────────────────────────────────────

type InjectPhase = 'idle' | 'validating' | 'table_created' | 'streaming' | 'done' | 'error';

interface InjectProgress {
  phase: InjectPhase;
  tableName?: string;
  columnCount?: number;
  bytesStreamed?: number;
  totalBytes?: number;
  rowCount?: number;
  durationMs?: number;
  errorMessage?: string;
  errorCode?: string;
}

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

type StepStatus = 'pending' | 'active' | 'done' | 'error';

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return (
    <span className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold flex-shrink-0">✓</span>
  );
  if (status === 'error') return (
    <span className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-red-600 text-xs font-bold flex-shrink-0">✕</span>
  );
  if (status === 'active') return (
    <span className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin flex-shrink-0" />
  );
  return (
    <span className="w-6 h-6 rounded-full border-2 border-gray-200 flex-shrink-0" />
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="mt-2 space-y-1">
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-500">{fmt(value)} / {fmt(max)} ({pct.toFixed(0)}%)</p>
    </div>
  );
}

function InjectSteps({ progress }: { progress: InjectProgress }) {
  const { phase } = progress;

  const step1Status: StepStatus =
    phase === 'error' && !progress.tableName ? 'error'
    : ['table_created', 'streaming', 'done'].includes(phase) ? 'done'
    : ['validating'].includes(phase) ? 'active'
    : 'pending';

  const step2Status: StepStatus =
    phase === 'error' && !!progress.tableName ? 'error'
    : phase === 'done' ? 'done'
    : phase === 'streaming' ? 'active'
    : 'pending';

  const step3Status: StepStatus =
    phase === 'done' ? 'done'
    : phase === 'error' ? 'error'
    : 'pending';

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-4">
      {/* Step 1: Create table */}
      <div className="flex items-start gap-3">
        <StepIcon status={step1Status} />
        <div className="flex-1 min-w-0">
          {progress.tableName ? (
            <>
              <p className="text-sm font-medium text-gray-800">
                Table <span className="font-mono">"{progress.tableName}"</span> created
              </p>
              <p className="text-xs text-gray-500">{progress.columnCount} columns defined</p>
            </>
          ) : (
            <p className="text-sm font-medium text-gray-700">
              {step1Status === 'active' ? 'Validating & creating table…' : 'Create table'}
            </p>
          )}
        </div>
      </div>

      {/* Step 2: Stream rows */}
      <div className="flex items-start gap-3">
        <StepIcon status={step2Status} />
        <div className="flex-1 min-w-0">
          {phase === 'done' ? (
            <>
              <p className="text-sm font-medium text-gray-800">
                {progress.rowCount?.toLocaleString()} rows loaded
              </p>
            </>
          ) : phase === 'streaming' || (phase === 'progress' as InjectPhase) ? (
            <>
              <p className="text-sm font-medium text-gray-700">Streaming rows from S3…</p>
              {(progress.totalBytes ?? 0) > 0 && (
                <ProgressBar value={progress.bytesStreamed ?? 0} max={progress.totalBytes ?? 0} />
              )}
            </>
          ) : (
            <p className="text-sm font-medium text-gray-400">Stream rows into RDS</p>
          )}
        </div>
      </div>

      {/* Step 3: Done / Error */}
      <div className="flex items-start gap-3">
        <StepIcon status={step3Status} />
        <div className="flex-1 min-w-0">
          {phase === 'done' ? (
            <p className="text-sm font-medium text-green-700">
              Completed in {fmtDuration(progress.durationMs ?? 0)}
            </p>
          ) : phase === 'error' ? (
            <p className="text-sm font-medium text-red-700">{progress.errorMessage}</p>
          ) : (
            <p className="text-sm font-medium text-gray-400">Finalise</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({ preview }: { preview: PreviewProgress }) {
  if (preview.phase === 'scanning') {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
        <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin flex-shrink-0" />
        Scanning file… {preview.rowsScanned ? `(${preview.rowsScanned.toLocaleString()} rows checked)` : ''}
      </div>
    );
  }

  if (preview.phase === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-medium text-red-700">✕ Preview failed — {preview.errorMessage}</p>
      </div>
    );
  }

  if (preview.phase !== 'done' || !preview.result) return null;

  const { result } = preview;
  const hasErrors = result.typeErrors.length > 0;

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-3 ${hasErrors ? 'bg-yellow-50 border-yellow-300' : 'bg-green-50 border-green-200'}`}>
      <p className={`text-sm font-medium ${hasErrors ? 'text-yellow-800' : 'text-green-700'}`}>
        {hasErrors
          ? `⚠ ${result.rowCount.toLocaleString()} rows scanned — ${result.badRowCount.toLocaleString()} row${result.badRowCount > 1 ? 's' : ''} have type mismatches`
          : `✓ ${result.rowCount.toLocaleString()} rows scanned — no type issues found`}
      </p>

      {result.typeErrors.map((err, i) => (
        <div key={i} className="text-sm">
          <p className="font-medium text-yellow-800">
            ⚠ {err.count.toLocaleString()} value{err.count > 1 ? 's' : ''} in "{err.column}" don't match {err.pgType}
          </p>
          <ul className="mt-1 ml-4 space-y-0.5">
            {err.examples.map((ex, j) => (
              <li key={j} className="text-xs text-gray-500 font-mono">{ex}</li>
            ))}
          </ul>
        </div>
      ))}

      {result.sampleRows.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">First {result.sampleRows.length} rows</p>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="text-xs w-full">
              <thead className="bg-gray-50">
                <tr>
                  {result.headers.map((h) => (
                    <th key={h} className="px-2 py-1 text-left font-mono font-medium text-gray-600 border-r border-gray-200 last:border-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.sampleRows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="px-2 py-1 font-mono text-gray-700 border-r border-gray-200 last:border-0 max-w-xs truncate">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DeleteButton({ s3Key, confirmingDeleteKey, deletingKey, onAskConfirm, onConfirm, onCancel }: {
  s3Key: string;
  confirmingDeleteKey: string | null;
  deletingKey: string | null;
  onAskConfirm: (key: string) => void;
  onConfirm: (key: string) => void;
  onCancel: () => void;
}) {
  if (deletingKey === s3Key) {
    return <span className="px-4 text-xs text-gray-400">Deleting…</span>;
  }
  if (confirmingDeleteKey === s3Key) {
    return (
      <div className="flex items-center gap-2 px-3">
        <span className="text-xs text-gray-500">Delete?</span>
        <button onClick={() => onConfirm(s3Key)} className="text-xs text-red-600 font-medium hover:text-red-800">Yes</button>
        <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">No</button>
      </div>
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAskConfirm(s3Key); }}
      className="px-4 text-gray-300 hover:text-red-500 transition-colors"
      title="Delete from S3"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    </button>
  );
}

export default function Inject() {
  const location = useLocation();
  const navigate = useNavigate();

  const passedUpload = (location.state as { upload?: UploadResponse; columns?: Column[] } | null)?.upload;
  const passedColumns = (location.state as { upload?: UploadResponse; columns?: Column[] } | null)?.columns;

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [s3Files, setS3Files] = useState<S3File[]>([]);
  const [selectedUpload, setSelectedUpload] = useState<Upload | UploadResponse | null>(passedUpload ?? null);
  const [columns, setColumns] = useState<Column[]>(passedColumns ?? []);
  const [tableName, setTableName] = useState('');
  const [progress, setProgress] = useState<InjectProgress>({ phase: 'idle' });
  const [inferringColumns, setInferringColumns] = useState(false);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewProgress>({ phase: 'idle' });

  const injecting = !['idle', 'done', 'error'].includes(progress.phase);

  useEffect(() => {
    apiGet<Upload[]>('/uploads').then(setUploads).catch(console.error);
    apiGet<S3File[]>('/s3/files').then(setS3Files).catch(console.error);
  }, []);

  // S3 files not already tracked in the DB (dedup by s3_key)
  const dbKeys = new Set(uploads.map((u) => u.s3_key).filter(Boolean));
  const s3OnlyFiles = s3Files.filter((f) => !dbKeys.has(f.key));

  async function inferColumnsFromS3(s3Key: string) {
    setColumns([]);
    setPreview({ phase: 'idle' });
    setInferringColumns(true);
    try {
      const { text } = await apiGet<{ text: string }>(`/s3/preview?key=${encodeURIComponent(s3Key)}`);
      const result = Papa.parse<string[]>(text, { preview: 2 });
      const headers = result.data[0] ?? [];
      setColumns(
        headers
          .filter((h) => h.trim())
          .map((h) => ({
            name: h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
            type: 'VARCHAR' as const,
            primary_key: false,
            nullable: false,
          })),
      );
    } catch {
      // Leave columns empty; user can define them manually
    } finally {
      setInferringColumns(false);
    }
  }

  async function handleDeleteFile(key: string) {
    setDeletingKey(key);
    setConfirmingDeleteKey(null);
    try {
      await apiDelete(`/s3/files?key=${encodeURIComponent(key)}`);
      setS3Files((prev) => prev.filter((f) => f.key !== key));
      setUploads((prev) => prev.filter((u) => u.s3_key !== key));
      if (selectedUpload?.s3_key === key) {
        setSelectedUpload(null);
        setColumns([]);
        setProgress({ phase: 'idle' });
      }
    } catch {
      // leave the file in the list — delete failed silently
    } finally {
      setDeletingKey(null);
    }
  }

  async function handlePreview() {
    if (!selectedUpload) return;
    setPreview({ phase: 'scanning', rowsScanned: 0 });

    const headers = await getAuthHeaders();
    const response = await fetch('/api/inject/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ s3_key: selectedUpload.s3_key, columns }),
    });

    if (!response.ok || !response.body) {
      setPreview({ phase: 'error', errorMessage: `HTTP ${response.status}` });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (event.step === 'scanning') {
            setPreview({ phase: 'scanning', rowsScanned: event.rowsScanned as number });
          } else if (event.step === 'done') {
            setPreview({ phase: 'done', result: event as unknown as InjectPreviewResult });
          } else if (event.step === 'error') {
            setPreview({ phase: 'error', errorMessage: event.message as string });
          }
        }
      }
    }
  }

  async function selectS3File(f: S3File) {
    setSelectedUpload({
      upload_id: null,
      filename: f.filename,
      s3_key: f.key,
      uploaded_by: '',
      uploaded_at: f.last_modified,
      size_bytes: f.size_bytes,
    });
    await inferColumnsFromS3(f.key);
  }

  const tableNameError =
    tableName && !TABLE_NAME_RE.test(tableName)
      ? 'Use lowercase letters, numbers, and underscores only'
      : null;

  async function handleInject(skipRowNums?: number[]) {
    if (!selectedUpload || !tableName || tableNameError) return;
    setProgress({ phase: 'validating' });

    const headers = await getAuthHeaders();
    const response = await fetch('/api/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        upload_id: selectedUpload.upload_id,
        s3_key: selectedUpload.s3_key,
        table_name: tableName,
        columns,
        skip_row_nums: skipRowNums,
      }),
    });

    if (!response.ok || !response.body) {
      setProgress({ phase: 'error', errorMessage: `Request failed: HTTP ${response.status}` });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEvent = (raw: string) => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }

      const step = event.step as string;
      if (step === 'validating') {
        setProgress({ phase: 'validating' });
      } else if (step === 'table_created') {
        setProgress({
          phase: 'table_created',
          tableName: event.tableName as string,
          columnCount: event.columnCount as number,
        });
      } else if (step === 'streaming') {
        setProgress((p) => ({ ...p, phase: 'streaming', totalBytes: event.totalBytes as number }));
      } else if (step === 'progress') {
        setProgress((p) => ({
          ...p,
          phase: 'streaming',
          bytesStreamed: event.bytesStreamed as number,
          totalBytes: event.totalBytes as number,
        }));
      } else if (step === 'done') {
        setProgress((p) => ({
          ...p,
          phase: 'done',
          rowCount: event.rowCount as number,
          durationMs: event.durationMs as number,
        }));
      } else if (step === 'error') {
        setProgress((p) => ({
          ...p,
          phase: 'error',
          errorMessage: event.message as string,
          errorCode: event.code as string | undefined,
        }));
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) handleEvent(line.slice(6));
        }
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Inject into RDS</h1>
        <p className="text-gray-500 mt-1 text-sm">Step 2 of 2 — Define schema and load data</p>
      </div>

      <ActiveUploadsPanel />
      <ActiveInjectsPanel />

      {/* Upload selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Source upload</label>
        {selectedUpload ? (
          <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
            <div>
              <p className="font-medium text-gray-800">{selectedUpload.filename}</p>
              <p className="text-xs text-gray-500 font-mono">{selectedUpload.s3_key}</p>
            </div>
            <button
              onClick={() => { setSelectedUpload(null); setColumns([]); setProgress({ phase: 'idle' }); }}
              className="text-sm text-gray-400 hover:text-gray-700"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {uploads.length === 0 && s3OnlyFiles.length === 0 ? (
              <p className="text-gray-400 text-sm">
                No CSV files found in S3.{' '}
                <button onClick={() => navigate('/upload')} className="text-blue-600 underline">
                  Upload a CSV first
                </button>
              </p>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-80 overflow-y-auto">
                {/* DB-tracked uploads */}
                {uploads.map((u) => {
                  const inProgress = u.status === 'in_progress';
                  return inProgress ? (
                    <div
                      key={u.upload_id}
                      className="w-full text-left px-4 py-3 opacity-50 cursor-not-allowed"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                        <p className="font-medium text-gray-600 text-sm">{u.filename}</p>
                      </div>
                      <p className="text-xs text-blue-500 mt-0.5">Uploading to S3… not yet injectable</p>
                    </div>
                  ) : (
                    <div key={u.upload_id} className="flex items-center hover:bg-gray-50 transition-colors">
                      <button
                        onClick={() => {
                          setSelectedUpload(u);
                          setProgress({ phase: 'idle' });
                          if (u.s3_key) inferColumnsFromS3(u.s3_key);
                        }}
                        className="flex-1 text-left px-4 py-3"
                      >
                        <p className="font-medium text-gray-800 text-sm">{u.filename}</p>
                        <p className="text-xs text-gray-400">
                          {new Date(u.uploaded_at).toLocaleString()} · {u.uploaded_by}
                        </p>
                      </button>
                      {u.s3_key && <DeleteButton s3Key={u.s3_key} confirmingDeleteKey={confirmingDeleteKey} deletingKey={deletingKey} onAskConfirm={setConfirmingDeleteKey} onConfirm={handleDeleteFile} onCancel={() => setConfirmingDeleteKey(null)} />}
                    </div>
                  );
                })}

                {/* S3-only files not yet tracked in DB */}
                {s3OnlyFiles.length > 0 && (
                  <>
                    {uploads.length > 0 && (
                      <div className="px-4 py-2 bg-gray-50 sticky top-0">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          Other files in S3
                        </p>
                      </div>
                    )}
                    {s3OnlyFiles.map((f) => (
                      <div key={f.key} className="flex items-center hover:bg-gray-50 transition-colors">
                        <button
                          onClick={() => selectS3File(f)}
                          className="flex-1 text-left px-4 py-3"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">S3</span>
                            <p className="font-medium text-gray-800 text-sm">{f.filename}</p>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {new Date(f.last_modified).toLocaleString()} · {fmt(f.size_bytes)}
                          </p>
                        </button>
                        <DeleteButton s3Key={f.key} confirmingDeleteKey={confirmingDeleteKey} deletingKey={deletingKey} onAskConfirm={setConfirmingDeleteKey} onConfirm={handleDeleteFile} onCancel={() => setConfirmingDeleteKey(null)} />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedUpload && (
        <>
          {/* Table name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Target table name</label>
            <input
              value={tableName}
              onChange={(e) => { setTableName(e.target.value.toLowerCase()); setPreview({ phase: 'idle' }); }}
              placeholder="e.g. customers_2026"
              disabled={injecting}
              className={`border rounded-lg px-3 py-2 text-sm font-mono w-72 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 ${
                tableNameError ? 'border-red-400' : 'border-gray-300'
              }`}
            />
            {tableNameError && <p className="text-red-500 text-xs mt-1">{tableNameError}</p>}
          </div>

          {/* Column editor */}
          {inferringColumns ? (
            <p className="text-sm text-blue-500 italic">Detecting schema from file…</p>
          ) : !injecting && progress.phase === 'idle' ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-700">
                  Schema definition
                  {columns.length > 0 && <span className="ml-1 text-gray-400 font-normal">({columns.length} columns)</span>}
                </h2>
                <button
                  onClick={() => setColumns((prev) => [...prev, { name: '', type: 'VARCHAR', primary_key: false, nullable: false }])}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  + Add column
                </button>
              </div>
              {columns.length > 0 ? (
                <ColumnEditor columns={columns} onChange={setColumns} />
              ) : (
                <p className="text-sm text-gray-400 italic">
                  No columns detected — click "Add column" to define the schema manually,
                  or go to the Upload page to auto-detect from a CSV.
                </p>
              )}
            </div>
          ) : null}

          {/* Primary key warning */}
          {columns.length > 0 && !columns.some((c) => c.primary_key) && progress.phase === 'idle' && (
            <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-300 rounded-lg px-4 py-3">
              <span className="text-yellow-500 text-base leading-5 flex-shrink-0">⚠</span>
              <p className="text-sm text-yellow-800">
                No primary key selected — the first column is usually the ID. Select one before injecting.
              </p>
            </div>
          )}

          {/* Preview panel */}
          {preview.phase !== 'idle' && progress.phase === 'idle' && (
            <PreviewPanel preview={preview} />
          )}

          {/* Progress steps */}
          {progress.phase !== 'idle' && <InjectSteps progress={progress} />}

          {/* Action buttons */}
          {progress.phase === 'idle' && !injecting && (() => {
            const previewDone = preview.phase === 'done' && !!preview.result;
            const hasTypeErrors = previewDone && preview.result!.typeErrors.length > 0;
            const canPreview = columns.length > 0 && !!tableName && !tableNameError;
            const isPreviewing = preview.phase === 'scanning';

            return (
              <div className="space-y-3">
                {/* Preview button — always shown until preview is done */}
                {!previewDone && (
                  <button
                    onClick={handlePreview}
                    disabled={!canPreview || isPreviewing}
                    className="bg-gray-700 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isPreviewing ? 'Scanning…' : 'Preview'}
                  </button>
                )}

                {/* Re-preview button after preview is done */}
                {previewDone && (
                  <button
                    onClick={() => { setPreview({ phase: 'idle' }); }}
                    className="text-sm text-gray-500 underline"
                  >
                    Re-run preview
                  </button>
                )}

                {/* Inject buttons — only shown after preview */}
                {previewDone && (
                  <div className="space-y-2">
                    <button
                      onClick={() => handleInject()}
                      disabled={hasTypeErrors}
                      className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Inject into RDS
                    </button>

                    {hasTypeErrors && (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => handleInject(preview.result!.badRowNums)}
                          className="bg-amber-500 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-amber-600 transition-colors text-sm"
                        >
                          Skip {preview.result!.badRowCount.toLocaleString()} invalid rows & inject
                        </button>
                        <span className="text-xs text-gray-400">
                          {(preview.result!.rowCount - preview.result!.badRowCount).toLocaleString()} clean rows will be injected
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {injecting && (
            <button disabled className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium opacity-50 cursor-not-allowed">
              Injecting…
            </button>
          )}
        </>
      )}
    </div>
  );
}
