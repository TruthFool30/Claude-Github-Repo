/**
 * Fetch wrapper for the Hearth API. Paths are relative to /api:
 *   const lists = await api.get<List[]>('/lists');
 *   await api.post('/lists', { name: 'Groceries' });
 *   await api.upload<Photo>('/photos', formData);
 * Errors throw ApiError { status, message, data }. A 401 on a non-auth route
 * emits a global "unauthorized" event, which the AuthProvider turns into a redirect to /login.
 */
export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export const UNAUTHORIZED_EVENT = 'hearth:unauthorized';
/** Fired when the server says this tab's family is no longer ours (removed / deleted). */
export const FAMILY_LOST_EVENT = 'hearth:family-lost';

/**
 * The family this browser tab is working in. Sent as `X-Family-Id` on every request so two tabs
 * can safely use different families. Managed by the AuthProvider (useAuth().switchFamily).
 */
let activeFamilyId: number | null = null;
export function setApiFamily(id: number | null) {
  activeFamilyId = id;
}
export function getApiFamily(): number | null {
  return activeFamilyId;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = new Headers(init.headers);
  if (activeFamilyId && !headers.has('X-Family-Id')) headers.set('X-Family-Id', String(activeFamilyId));
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again');
  }
  const type = res.headers.get('content-type') || '';
  const data: unknown = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : null) || `Request failed (${res.status})`;
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    if (res.status === 403 && data && typeof data === 'object' && (data as { code?: string }).code === 'NOT_MEMBER') {
      window.dispatchEvent(new CustomEvent(FAMILY_LOST_EVENT));
    }
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => request<T>('POST', path, body ?? {}, init),
  patch: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => request<T>('PATCH', path, body ?? {}, init),
  put: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => request<T>('PUT', path, body ?? {}, init),
  /** DELETE; an optional JSON body is supported (e.g. { confirm_name }). */
  del: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => request<T>('DELETE', path, body, init),
  /** POST multipart/form-data. Build a FormData with a `file` field (+ any extra fields). */
  upload: <T = unknown>(path: string, formData: FormData, init?: RequestInit) => request<T>('POST', path, formData, init),
};

/** Human message for any thrown value (use in toast.error(errorMessage(e))). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return 'Something went wrong';
}

/** Build a query string, skipping null/undefined/'' values: qs({ from, to }) -> "?from=..&to=.." */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
