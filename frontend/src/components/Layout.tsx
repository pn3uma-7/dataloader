import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { signOut } from 'aws-amplify/auth';

const NAV = [
  { path: '/upload', label: 'Upload' },
  { path: '/inject', label: 'Inject' },
  { path: '/history', label: 'History' },
];

const cognitoConfigured = !!(import.meta.env.VITE_COGNITO_USER_POOL_ID);

type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

function HealthDot({ status }: { status: HealthStatus }) {
  const color =
    status === 'healthy' ? 'bg-green-400'
    : status === 'unhealthy' ? 'bg-red-400'
    : 'bg-gray-300';
  const label =
    status === 'healthy' ? 'Backend connected'
    : status === 'unhealthy' ? 'Backend unreachable'
    : 'Checking backend…';
  return (
    <span title={label} className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color} ${status === 'healthy' ? 'animate-none' : ''}`} />
      <span className="text-xs text-gray-400 hidden sm:inline">{label}</span>
    </span>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const [health, setHealth] = useState<HealthStatus>('unknown');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/health');
        if (!cancelled) setHealth(res.ok ? 'healthy' : 'unhealthy');
      } catch {
        if (!cancelled) setHealth('unhealthy');
      }
    }

    check();
    const interval = setInterval(check, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-8">
          <span className="font-bold text-gray-900 tracking-tight">DataLoader</span>

          <nav className="flex gap-6 flex-1">
            {NAV.map(({ path, label }) => (
              <Link
                key={path}
                to={path}
                className={`text-sm font-medium transition-colors ${
                  pathname === path
                    ? 'text-blue-600'
                    : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <HealthDot status={health} />

            {cognitoConfigured && (
              <button
                onClick={() => signOut()}
                className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
