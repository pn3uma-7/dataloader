import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';

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

interface HistoryEntry {
  type: 'upload' | 'inject';
  id: number | string;
  name: string;
  s3_key: string | null;
  status: 'success' | 'failed' | 'in_progress';
  size_bytes: number | null;
  row_count: number | null;
  duration_ms: number | null;
  error_msg: string | null;
  by: string;
  at: string;
  progress: { phase: string; bytesLoaded: number; totalBytes: number } | null;
}

function TypeBadge({ type }: { type: 'upload' | 'inject' }) {
  return type === 'upload' ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
      S3 Upload
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
      RDS Inject
    </span>
  );
}

function StatusCell({ entry }: { entry: HistoryEntry }) {
  if (entry.status === 'in_progress' && entry.progress) {
    const { phase, bytesLoaded, totalBytes } = entry.progress;
    const pct = totalBytes > 0 ? Math.min(100, (bytesLoaded / totalBytes) * 100) : 0;
    const label =
      phase === 'uploading' ? `Uploading to S3 — ${pct.toFixed(0)}%`
      : phase === 'saving' ? 'Saving…'
      : phase === 'validating' ? 'Validating…'
      : phase === 'table_created' ? 'Table created, streaming…'
      : phase === 'streaming' ? `Streaming — ${pct.toFixed(0)}%`
      : phase;

    return (
      <div className="space-y-1 min-w-[160px]">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-xs font-medium text-blue-700">in progress</span>
        </div>
        <p className="text-xs text-gray-500">{label}</p>
        {(phase === 'uploading' || phase === 'streaming') && totalBytes > 0 && (
          <div className="w-full bg-gray-200 rounded-full h-1.5">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
      entry.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
    }`}>
      {entry.status}
    </span>
  );
}

function DetailCell({ entry }: { entry: HistoryEntry }) {
  if (entry.status === 'in_progress') return <span className="text-gray-400">—</span>;

  if (entry.type === 'upload') {
    return (
      <span className="text-gray-600 text-xs">
        {entry.size_bytes != null ? fmt(entry.size_bytes) : '—'}
      </span>
    );
  }

  return (
    <div className="text-xs text-gray-600 space-y-0.5">
      {entry.row_count != null && <p>{entry.row_count.toLocaleString()} rows</p>}
      {entry.duration_ms != null && <p className="text-gray-400">{fmtDuration(entry.duration_ms)}</p>}
      {entry.status === 'failed' && entry.error_msg && (
        <p className="text-red-500 truncate max-w-xs" title={entry.error_msg}>{entry.error_msg}</p>
      )}
    </div>
  );
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const data = await apiGet<HistoryEntry[]>('/history');
      setEntries(data);
      setError(null);

      const hasActive = data.some((e) => e.status === 'in_progress');
      if (hasActive && !intervalRef.current) {
        intervalRef.current = setInterval(load, 3000);
      } else if (!hasActive && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  if (loading) return <p className="text-gray-400 text-sm">Loading history…</p>;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">History</h1>
        <p className="text-gray-500 mt-1 text-sm">All S3 uploads and RDS injects, most recent first</p>
      </div>

      {entries.length === 0 ? (
        <p className="text-gray-400 text-sm">No activity yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">When</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Details</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map((e) => (
                <tr
                  key={`${e.type}-${e.id}`}
                  className={e.status === 'in_progress' ? 'bg-blue-50/40' : 'hover:bg-gray-50 transition-colors'}
                >
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {new Date(e.at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <TypeBadge type={e.type} />
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-800 text-xs max-w-[200px] truncate" title={e.name}>
                    {e.name}
                  </td>
                  <td className="px-4 py-3">
                    <StatusCell entry={e} />
                  </td>
                  <td className="px-4 py-3">
                    <DetailCell entry={e} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{e.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
