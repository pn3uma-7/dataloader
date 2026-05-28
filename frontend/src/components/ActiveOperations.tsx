import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';

// ── shared helpers ──────────────────────────────────────────────────────────

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function pct(loaded: number, total: number) {
  return total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
}

function MiniBar({ loaded, total }: { loaded: number; total: number }) {
  const p = pct(loaded, total);
  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="w-full bg-gray-200 rounded-full h-1.5">
        <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${p}%` }} />
      </div>
      <p className="text-xs text-gray-500">{fmt(loaded)} / {fmt(total)} ({p.toFixed(0)}%)</p>
    </div>
  );
}

function StepRow({ done, active, label, children }: { done: boolean; active: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      {done
        ? <span className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs flex-shrink-0">✓</span>
        : active
        ? <span className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin flex-shrink-0" />
        : <span className="w-5 h-5 rounded-full border-2 border-gray-200 flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${done ? 'text-gray-700' : active ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>{label}</p>
        {children}
      </div>
    </div>
  );
}

// ── Active uploads ──────────────────────────────────────────────────────────

interface ActiveUploadJob {
  uploadId: string;
  filename: string;
  startedAt: string;
  startedBy: string;
  phase: 'uploading' | 'saving' | 'done' | 'error';
  bytesUploaded: number;
  totalBytes: number;
}

function UploadDetail({ job }: { job: ActiveUploadJob }) {
  const { phase, bytesUploaded, totalBytes, filename } = job;
  const step1Done = phase === 'saving' || phase === 'done';
  const step2Done = phase === 'done';

  return (
    <div className="mt-3 pl-3 border-l-2 border-blue-200 space-y-3">
      <StepRow done={step1Done} active={phase === 'uploading'} label={step1Done ? `Uploaded — ${fmt(totalBytes)}` : `Uploading ${filename} to S3…`}>
        {phase === 'uploading' && totalBytes > 0 && <MiniBar loaded={bytesUploaded} total={totalBytes} />}
      </StepRow>
      <StepRow done={step2Done} active={phase === 'saving'} label={step2Done ? 'Logged to database' : 'Log to database'} />
    </div>
  );
}

export function ActiveUploadsPanel() {
  const [jobs, setJobs] = useState<ActiveUploadJob[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      const data = await apiGet<ActiveUploadJob[]>('/uploads/active');
      setJobs(data);
      if (data.length === 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      } else if (data.length > 0 && !intervalRef.current) {
        intervalRef.current = setInterval(poll, 2000);
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 space-y-2">
      <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Active S3 uploads</p>
      {jobs.map((job) => (
        <div key={job.uploadId}>
          <button
            onClick={() => setExpanded(expanded === job.uploadId ? null : job.uploadId)}
            className="w-full flex items-center gap-2 text-left"
          >
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <span className="flex-1 text-sm text-gray-800 font-mono truncate">{job.filename}</span>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {job.phase === 'uploading' && job.totalBytes > 0
                ? `${pct(job.bytesUploaded, job.totalBytes).toFixed(0)}%`
                : job.phase}
            </span>
            <span className="text-gray-400 text-xs flex-shrink-0">{expanded === job.uploadId ? '▲' : '▼'}</span>
          </button>
          {expanded === job.uploadId && <UploadDetail job={job} />}
        </div>
      ))}
    </div>
  );
}

// ── Active injects ──────────────────────────────────────────────────────────

interface ActiveInjectJob {
  jobId: string;
  tableName: string;
  startedAt: string;
  startedBy: string;
  phase: string;
  bytesStreamed: number;
  totalBytes: number;
  columnCount: number;
}

function InjectDetail({ job }: { job: ActiveInjectJob }) {
  const { phase, bytesStreamed, totalBytes, tableName, columnCount } = job;
  const step1Done = ['streaming', 'done'].includes(phase);
  const step2Done = phase === 'done';

  return (
    <div className="mt-3 pl-3 border-l-2 border-blue-200 space-y-3">
      <StepRow
        done={step1Done}
        active={phase === 'validating' || phase === 'table_created'}
        label={step1Done ? `Table "${tableName}" created (${columnCount} columns)` : `Creating table "${tableName}"…`}
      />
      <StepRow done={step2Done} active={phase === 'streaming'} label={step2Done ? 'Rows loaded' : 'Streaming rows from S3…'}>
        {phase === 'streaming' && totalBytes > 0 && <MiniBar loaded={bytesStreamed} total={totalBytes} />}
      </StepRow>
      <StepRow done={step2Done} active={false} label={step2Done ? 'Complete' : 'Finalise'} />
    </div>
  );
}

export function ActiveInjectsPanel() {
  const [jobs, setJobs] = useState<ActiveInjectJob[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      const data = await apiGet<ActiveInjectJob[]>('/inject/active');
      setJobs(data);
      if (data.length === 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      } else if (data.length > 0 && !intervalRef.current) {
        intervalRef.current = setInterval(poll, 2000);
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 space-y-2">
      <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Active RDS injects</p>
      {jobs.map((job) => (
        <div key={job.jobId}>
          <button
            onClick={() => setExpanded(expanded === job.jobId ? null : job.jobId)}
            className="w-full flex items-center gap-2 text-left"
          >
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <span className="flex-1 text-sm text-gray-800 font-mono truncate">{job.tableName}</span>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {job.phase === 'streaming' && job.totalBytes > 0
                ? `${pct(job.bytesStreamed, job.totalBytes).toFixed(0)}%`
                : job.phase}
            </span>
            <span className="text-gray-400 text-xs flex-shrink-0">{expanded === job.jobId ? '▲' : '▼'}</span>
          </button>
          {expanded === job.jobId && <InjectDetail job={job} />}
        </div>
      ))}
    </div>
  );
}
