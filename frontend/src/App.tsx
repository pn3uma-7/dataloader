import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { fetchAuthSession, signInWithRedirect } from 'aws-amplify/auth';
import Layout from './components/Layout';
import Upload from './pages/Upload';
import Inject from './pages/Inject';
import History from './pages/History';

const cognitoConfigured = !!(
  import.meta.env.VITE_COGNITO_USER_POOL_ID &&
  import.meta.env.VITE_COGNITO_APP_CLIENT_ID
);

export default function App() {
  // If Cognito is configured, wait until we know the auth state before rendering
  const [authReady, setAuthReady] = useState(!cognitoConfigured);

  useEffect(() => {
    if (!cognitoConfigured) return;

    fetchAuthSession()
      .then((session) => {
        if (session.tokens?.idToken) {
          setAuthReady(true);
        } else {
          signInWithRedirect();
        }
      })
      .catch(() => {
        signInWithRedirect();
      });
  }, []);

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Signing in…</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/upload" replace />} />
        <Route element={<Layout />}>
          <Route path="/upload" element={<Upload />} />
          <Route path="/inject" element={<Inject />} />
          <Route path="/history" element={<History />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
