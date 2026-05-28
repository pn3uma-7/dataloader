import { fetchAuthSession } from 'aws-amplify/auth';

const BASE = '/api';

const cognitoConfigured = !!(
  import.meta.env.VITE_COGNITO_USER_POOL_ID &&
  import.meta.env.VITE_COGNITO_APP_CLIENT_ID
);

export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (!cognitoConfigured) return {};
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let msg: string;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      msg = parsed.error ?? parsed.message ?? body;
    } catch {
      msg = body;
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BASE}${path}`, { headers });
  return handleResponse<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiUploadFile<T>(path: string, file: File): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: authHeaders, body: form });
  return handleResponse<T>(res);
}

export function apiUploadFileWithProgress<T>(
  path: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const authHeaders = await getAuthHeaders();
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    for (const [k, v] of Object.entries(authHeaders)) xhr.setRequestHeader(k, v);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as T); }
        catch { reject(new Error('Invalid server response')); }
      } else {
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; message?: string };
          reject(new Error(body.error ?? body.message ?? `HTTP ${xhr.status}`));
        } catch { reject(new Error(`HTTP ${xhr.status}`)); }
      }
    };

    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}
