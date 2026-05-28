import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import DropZone from '../components/DropZone';
import ColumnEditor from '../components/ColumnEditor';
import { getAuthHeaders } from '../lib/api';
import { ActiveUploadsPanel } from '../components/ActiveOperations';
import { inferType } from '../lib/inferTypes';
import type { Column, UploadResponse } from '../types';

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── Validation ─────────────────────────────────────────────────────────────

interface ValidationIssue {
  severity: 'error' | 'warning';
  title: string;
  examples?: string[];
}

interface ValidationResult {
  totalRows: number;
  issues: ValidationIssue[];
  dupCheckLimited: boolean;
  badRowNums: Set<number>;
}

const MAX_DUP_ROWS = Infinity;
const MAX_EXAMPLES = 5;

// Literal strings treated as "null" in data — blocked as hard errors
const NULL_LIKE = new Set(['null', 'none', 'n/a', 'na', 'nil', 'undefined', 'nan']);

function runValidation(
  file: File,
  headers: string[],
  onProgress: (rows: number) => void,
  onDone: (result: ValidationResult) => void,
) {
  const issues: ValidationIssue[] = [];

  // Header checks (instant)
  const emptyHeaders = headers.filter((h) => !h.trim());
  if (emptyHeaders.length > 0) {
    issues.push({ severity: 'error', title: `${emptyHeaders.length} empty column header(s) — fix the CSV before uploading` });
  }
  const seen = headers.filter((h, i) => headers.indexOf(h) !== i);
  const dupHeaders = [...new Set(seen)];
  if (dupHeaders.length > 0) {
    issues.push({ severity: 'error', title: `Duplicate column names: ${dupHeaders.join(', ')}` });
  }

  let rowNum = 0;
  let blankCount = 0;
  const blankExamples: string[] = [];
  let nullLikeCount = 0;
  const nullLikeExamples: string[] = [];
  let embeddedSpaceCount = 0;
  const embeddedSpaceExamples: string[] = [];
  let specialCharCount = 0;
  const specialCharExamples: string[] = [];
  let paddedCount = 0;
  const paddedExamples: string[] = [];
  let dupCount = 0;
  const dupExamples: string[] = [];
  const rowSeen = new Set<string>();
  const badRowNums = new Set<number>();

  Papa.parse<Record<string, string>>(file, {
    header: true,
    skipEmptyLines: true,
    step: (result) => {
      rowNum++;
      const row = result.data;
      let rowHasError = false;

      // Check all expected columns — catches missing fields (short rows) too
      for (const col of headers) {
        const raw = row[col];
        const str = raw === undefined || raw === null ? '' : String(raw);
        const trimmed = str.trim();

        if (trimmed === '') {
          blankCount++;
          rowHasError = true;
          if (blankExamples.length < MAX_EXAMPLES) {
            blankExamples.push(`row ${rowNum}, column "${col}"`);
          }
        } else if (NULL_LIKE.has(trimmed.toLowerCase())) {
          nullLikeCount++;
          rowHasError = true;
          if (nullLikeExamples.length < MAX_EXAMPLES) {
            nullLikeExamples.push(`row ${rowNum}, column "${col}" = "${trimmed}"`);
          }
        } else if (/\s/.test(trimmed)) {
          // Embedded whitespace (internal spaces/tabs) — trimming won't fix these
          embeddedSpaceCount++;
          rowHasError = true;
          if (embeddedSpaceExamples.length < MAX_EXAMPLES) {
            const preview = trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
            embeddedSpaceExamples.push(`row ${rowNum}, column "${col}" = "${preview}"`);
          }
        } else if (/[^a-zA-Z0-9]/.test(trimmed)) {
          // Non-alphanumeric character (colon, semicolon, symbol, etc.)
          specialCharCount++;
          rowHasError = true;
          if (specialCharExamples.length < MAX_EXAMPLES) {
            const badChars = [...new Set(trimmed.match(/[^a-zA-Z0-9]/g) ?? [])].join(' ');
            const preview = trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
            specialCharExamples.push(`row ${rowNum}, column "${col}" = "${preview}"  [${badChars}]`);
          }
        } else if (str !== trimmed) {
          // Leading/trailing whitespace — auto-trimmed at inject, not a hard error
          paddedCount++;
          if (paddedExamples.length < MAX_EXAMPLES) {
            paddedExamples.push(`row ${rowNum}, column "${col}"`);
          }
        }
      }

      // Duplicates — deterministic fingerprint over headers order
      if (rowNum <= MAX_DUP_ROWS) {
        const fp = headers.map((h) => (row[h] ?? '').trim()).join('\x00');
        if (rowSeen.has(fp)) {
          dupCount++;
          rowHasError = true;
          if (dupExamples.length < MAX_EXAMPLES) dupExamples.push(`row ${rowNum}`);
        } else {
          rowSeen.add(fp);
        }
      }

      if (rowHasError) badRowNums.add(rowNum);

      if (rowNum % 10_000 === 0) onProgress(rowNum);
    },
    complete: () => {
      rowSeen.clear();
      onProgress(rowNum);

      if (blankCount > 0) {
        issues.push({
          severity: 'error',
          title: `${blankCount.toLocaleString()} blank cell${blankCount > 1 ? 's' : ''} found`,
          examples: blankExamples,
        });
      }
      if (nullLikeCount > 0) {
        issues.push({
          severity: 'error',
          title: `${nullLikeCount.toLocaleString()} null-like value${nullLikeCount > 1 ? 's' : ''} found (null, none, N/A, etc.)`,
          examples: nullLikeExamples,
        });
      }
      if (embeddedSpaceCount > 0) {
        issues.push({
          severity: 'error',
          title: `${embeddedSpaceCount.toLocaleString()} cell${embeddedSpaceCount > 1 ? 's' : ''} contain embedded whitespace — fix in source CSV (not auto-trimmed)`,
          examples: embeddedSpaceExamples,
        });
      }
      if (specialCharCount > 0) {
        issues.push({
          severity: 'error',
          title: `${specialCharCount.toLocaleString()} cell${specialCharCount > 1 ? 's' : ''} contain non-alphanumeric characters — only a–z, A–Z, 0–9 allowed`,
          examples: specialCharExamples,
        });
      }
      if (paddedCount > 0) {
        issues.push({
          severity: 'warning',
          title: `${paddedCount.toLocaleString()} cell${paddedCount > 1 ? 's' : ''} have leading/trailing spaces — will be auto-trimmed at inject`,
          examples: paddedExamples,
        });
      }
      if (dupCount > 0) {
        issues.push({
          severity: 'error',
          title: `${dupCount.toLocaleString()} duplicate row${dupCount > 1 ? 's' : ''} found`,
          examples: dupExamples,
        });
      }

      onDone({ totalRows: rowNum, issues, dupCheckLimited: rowNum > MAX_DUP_ROWS, badRowNums });
    },
  });
}

// ── Validation panel ────────────────────────────────────────────────────────

function ValidationPanel({
  validating,
  rowsChecked,
  result,
}: {
  validating: boolean;
  rowsChecked: number;
  result: ValidationResult | null;
}) {
  if (validating) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
        <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin flex-shrink-0" />
        Validating file… {rowsChecked > 0 && `(${rowsChecked.toLocaleString()} rows checked)`}
      </div>
    );
  }

  if (!result) return null;

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const clean = result.issues.length === 0;

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-3 ${
      errors.length > 0
        ? 'bg-red-50 border-red-200'
        : warnings.length > 0
        ? 'bg-yellow-50 border-yellow-200'
        : 'bg-green-50 border-green-200'
    }`}>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-medium ${
          errors.length > 0 ? 'text-red-700'
          : warnings.length > 0 ? 'text-yellow-700'
          : 'text-green-700'
        }`}>
          {clean
            ? `✓ ${result.totalRows.toLocaleString()} rows — no issues found`
            : errors.length > 0
            ? `✕ ${errors.length} error${errors.length > 1 ? 's' : ''} found — fix before uploading`
            : `⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''} — review before uploading`
          }
        </span>
        {!clean && (
          <span className="text-xs text-gray-400">
            {result.totalRows.toLocaleString()} rows checked
          </span>
        )}
      </div>

      {result.issues.map((issue, i) => (
        <div key={i} className="text-sm">
          <p className={`font-medium ${issue.severity === 'error' ? 'text-red-700' : 'text-yellow-700'}`}>
            {issue.severity === 'error' ? '✕' : '⚠'} {issue.title}
          </p>
          {issue.examples && (
            <ul className="mt-1 ml-4 space-y-0.5">
              {issue.examples.map((ex, j) => (
                <li key={j} className="text-xs text-gray-500 font-mono">{ex}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Upload progress ─────────────────────────────────────────────────────────

type UploadPhase = 'uploading' | 'saving' | 'done' | 'error';

interface UploadProgress {
  phase: UploadPhase;
  bytesUploaded: number;
  totalBytes: number;
  errorMessage?: string;
  skippedRows?: number;
}

function UploadSteps({ progress }: { progress: UploadProgress }) {
  const { phase, bytesUploaded, totalBytes, skippedRows } = progress;
  const pct = totalBytes > 0 ? Math.min(100, (bytesUploaded / totalBytes) * 100) : 0;

  const step1Done = phase === 'saving' || phase === 'done';
  const step2Done = phase === 'done';
  const isError = phase === 'error';

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-4">
      {/* Step 1: Upload to server */}
      <div className="flex items-start gap-3">
        {step1Done ? (
          <span className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold flex-shrink-0">✓</span>
        ) : isError ? (
          <span className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-red-600 text-xs font-bold flex-shrink-0">✕</span>
        ) : (
          <span className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800">
            {step1Done
              ? `Uploaded to S3 — ${fmt(totalBytes)}${skippedRows ? ` · ${skippedRows.toLocaleString()} rows skipped` : ''}`
              : 'Uploading to S3…'}
          </p>
          {!step1Done && !isError && (
            <div className="mt-2 space-y-1">
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">{fmt(bytesUploaded)} / {fmt(totalBytes)} ({pct.toFixed(0)}%)</p>
            </div>
          )}
          {isError && (
            <p className="text-xs text-red-600 mt-1">{progress.errorMessage}</p>
          )}
        </div>
      </div>

      {/* Step 2: Save to S3 */}
      <div className="flex items-start gap-3">
        {step2Done ? (
          <span className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold flex-shrink-0">✓</span>
        ) : phase === 'saving' ? (
          <span className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin flex-shrink-0" />
        ) : (
          <span className="w-6 h-6 rounded-full border-2 border-gray-200 flex-shrink-0" />
        )}
        <div className="flex-1">
          <p className={`text-sm font-medium ${phase === 'saving' || step2Done ? 'text-gray-800' : 'text-gray-400'}`}>
            {step2Done ? 'Logged to database' : phase === 'saving' ? 'Logging to database…' : 'Log to database'}
          </p>
        </div>
      </div>

      {/* Step 3: Ready */}
      <div className="flex items-start gap-3">
        {step2Done ? (
          <span className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold flex-shrink-0">✓</span>
        ) : (
          <span className="w-6 h-6 rounded-full border-2 border-gray-200 flex-shrink-0" />
        )}
        <div className="flex-1">
          <p className={`text-sm font-medium ${step2Done ? 'text-green-700' : 'text-gray-400'}`}>
            {step2Done ? 'Redirecting to Inject…' : 'Complete'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Upload() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [preview, setPreview] = useState<string[][]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [validating, setValidating] = useState(false);
  const [rowsChecked, setRowsChecked] = useState(0);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [isFiltering, setIsFiltering] = useState(false);

  function handleFile(selected: File) {
    setFile(selected);
    setValidation(null);
    setRowsChecked(0);

    // Quick pass: preview + type inference (first 100 rows)
    Papa.parse<Record<string, string>>(selected, {
      header: true,
      preview: 100,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const rows = results.data;
        const inferred: Column[] = headers.map((header) => ({
          name: header,
          type: inferType(rows.map((row) => row[header] ?? '')),
          primary_key: false,
          nullable: false,
        }));
        setColumns(inferred);
        setPreview([headers, ...rows.slice(0, 5).map((row) => headers.map((h) => row[h] ?? ''))]);

        // Full validation pass in background
        setValidating(true);
        runValidation(
          selected,
          headers,
          (n) => setRowsChecked(n),
          (result) => { setValidation(result); setValidating(false); },
        );
      },
    });
  }

  function buildFilteredCsv(src: File, badRows: Set<number>): Promise<File> {
    return new Promise((resolve, reject) => {
      const parts: string[] = [];
      let rowIndex = 0; // 0 = header row

      Papa.parse<string[]>(src, {
        header: false,
        skipEmptyLines: false,
        step: (result) => {
          if (rowIndex === 0 || !badRows.has(rowIndex)) {
            parts.push(Papa.unparse([result.data]));
          }
          rowIndex++;
        },
        complete: () => {
          const blob = new Blob([parts.join('\n')], { type: 'text/csv' });
          resolve(new File([blob], src.name, { type: 'text/csv' }));
        },
        error: reject,
      });
    });
  }

  async function doUpload(fileToUpload: File, skippedCount = 0) {
    setUploadProgress({ phase: 'uploading', bytesUploaded: 0, totalBytes: fileToUpload.size, skippedRows: skippedCount || undefined });

    try {
      const authHeaders = await getAuthHeaders();
      const form = new FormData();
      form.append('file', fileToUpload);
      if (skippedCount > 0) form.append('skipped_rows', String(skippedCount));

      const response = await fetch('/api/upload', { method: 'POST', headers: authHeaders, body: form });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let uploadResult: UploadResponse | null = null;

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
            const step = event.step as string;

            if (step === 'received') {
              setUploadProgress((p) => ({ ...p!, phase: 'uploading', bytesUploaded: 0, totalBytes: event.totalBytes as number }));
            } else if (step === 'uploading') {
              setUploadProgress((p) => ({ ...p!, phase: 'uploading', bytesUploaded: event.bytesUploaded as number, totalBytes: event.totalBytes as number }));
            } else if (step === 'saving') {
              setUploadProgress((p) => ({ ...p!, phase: 'saving' }));
            } else if (step === 'done') {
              uploadResult = {
                upload_id: event.upload_id as number,
                s3_key: event.s3_key as string,
                filename: event.filename as string,
                size_bytes: event.size_bytes as number,
                skipped_rows: event.skipped_rows as number | undefined,
              };
              setUploadProgress((p) => ({ ...p!, phase: 'done' }));
            } else if (step === 'error') {
              throw new Error(event.message as string);
            }
          }
        }
      }

      if (uploadResult) {
        await new Promise((r) => setTimeout(r, 700));
        navigate('/inject', { state: { upload: uploadResult, columns } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadProgress((p) => ({ ...p!, phase: 'error', errorMessage: msg }));
    }
  }

  function handleUpload() {
    if (!file) return;
    doUpload(file);
  }

  async function handleUploadFiltered() {
    if (!file || !validation) return;
    setIsFiltering(true);
    try {
      const filtered = await buildFilteredCsv(file, validation.badRowNums);
      setIsFiltering(false);
      doUpload(filtered, validation.badRowNums.size);
    } catch {
      setIsFiltering(false);
    }
  }

  const uploading = uploadProgress !== null && uploadProgress.phase !== 'error';
  const hasErrors = validation?.issues.some((i) => i.severity === 'error') ?? false;
  const canUpload = !uploading && !validating && !isFiltering && columns.length > 0 && !hasErrors;
  const canSkip = hasErrors && !validating && !uploading && !isFiltering
    && !!validation && validation.badRowNums.size < validation.totalRows;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Upload CSV</h1>
        <p className="text-gray-500 mt-1 text-sm">Step 1 of 2 — Upload your file to S3</p>
      </div>

      <ActiveUploadsPanel />

      {!file ? (
        <DropZone onFile={handleFile} />
      ) : (
        <div className="space-y-6">
          {/* File info */}
          <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-green-600 text-lg">✓</span>
              <div>
                <p className="font-medium text-gray-800">{file.name}</p>
                <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
            <button
              onClick={() => { setFile(null); setColumns([]); setPreview([]); setValidation(null); }}
              className="text-sm text-gray-400 hover:text-gray-700"
            >
              Change file
            </button>
          </div>

          {/* Data preview */}
          {preview.length > 1 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Preview (first 5 rows)</h2>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="text-xs w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      {preview[0].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-mono font-medium text-gray-600 border-r border-gray-200 last:border-0">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.slice(1).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        {row.map((cell, j) => (
                          <td key={j} className="px-3 py-2 font-mono text-gray-700 border-r border-gray-200 last:border-0 max-w-xs truncate">
                            {cell || <span className="text-gray-300 italic">empty</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Validation */}
          <ValidationPanel
            validating={validating}
            rowsChecked={rowsChecked}
            result={validation}
          />

          {/* Column editor */}
          {columns.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-2">
                Inferred schema — adjust types as needed
              </h2>
              <ColumnEditor columns={columns} onChange={setColumns} readonlyNames />
            </div>
          )}

          {/* Upload progress */}
          {uploadProgress && <UploadSteps progress={uploadProgress} />}

          {!uploadProgress && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleUpload}
                  disabled={!canUpload}
                  className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Upload to S3
                </button>
                {validating && (
                  <span className="text-xs text-gray-400">Upload available after validation completes</span>
                )}
                {hasErrors && !canSkip && (
                  <span className="text-xs text-red-500">Fix errors above before uploading</span>
                )}
              </div>

              {canSkip && (
                <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
                  <button
                    onClick={handleUploadFiltered}
                    disabled={isFiltering}
                    className="bg-amber-500 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                  >
                    {isFiltering
                      ? 'Filtering CSV…'
                      : `Skip ${validation!.badRowNums.size.toLocaleString()} invalid rows & upload`}
                  </button>
                  {!isFiltering && (
                    <span className="text-xs text-gray-400">
                      {(validation!.totalRows - validation!.badRowNums.size).toLocaleString()} clean rows will be uploaded
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {uploadProgress?.phase === 'error' && (
            <button
              onClick={() => setUploadProgress(null)}
              className="text-sm text-blue-600 underline"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
