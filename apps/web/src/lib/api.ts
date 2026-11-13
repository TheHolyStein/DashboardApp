import { DashError, ErrorDto, ID_RE, type ErrorCode, type ModuleApi, type ModuleId } from '@dash/contract';
import type { z } from 'zod';

interface ApiHooks {
  getCsrf: () => string | undefined;
  onUnauthenticated: () => void;
}

let hooks: ApiHooks = { getCsrf: () => undefined, onUnauthenticated: () => {} };

/** Registered by the session module; avoids a circular import. */
export function configureApi(h: ApiHooks): void {
  hooks = h;
}

const CODES: readonly string[] = ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'invalid', 'rate_limited', 'upstream', 'internal'];

async function request<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = hooks.getCsrf();
    if (csrf) headers['X-CSRF'] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new DashError('upstream', 'Network request failed');
  }
  if (!res.ok) {
    let err: DashError;
    try {
      const parsed = ErrorDto.parse(await res.json());
      const code = (CODES.includes(parsed.error.code) ? parsed.error.code : 'internal') as ErrorCode;
      err = new DashError(code, parsed.error.message, parsed.error.details);
    } catch {
      err = new DashError('internal', `Request failed (${res.status})`);
    }
    if (err.code === 'unauthenticated') hooks.onUnauthenticated();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new DashError('internal', 'Invalid response body');
  }
  if (!schema) return json as T;
  const out = schema.safeParse(json);
  if (!out.success) throw new DashError('internal', 'Unexpected response shape', out.error.issues);
  return out.data;
}

export const api = {
  get: <T>(path: string, schema?: z.ZodType<T>) => request<T>('GET', path, undefined, schema),
  post: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('POST', path, body, schema),
  put: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('PUT', path, body, schema),
  patch: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('PATCH', path, body, schema),
  delete: <T>(path: string, schema?: z.ZodType<T>) => request<T>('DELETE', path, undefined, schema),
};

/** Keep a module-relative path inside `/api/m/<id>/`: no dot segments, query, fragment, backslash or encoded `.`/`/`/`\`. */
function checkModulePath(path: string): string {
  const bad =
    !path.startsWith('/') ||
    /[?#\\]/.test(path) ||
    /%(2e|2f|5c)/i.test(path) ||
    path.split('/').some((seg) => seg === '.' || seg === '..');
  if (bad) throw new DashError('invalid', `Invalid module API path: ${path}`);
  return path;
}

export function moduleApi(moduleId: ModuleId): ModuleApi {
  if (!ID_RE.test(moduleId)) throw new DashError('invalid', `Invalid module id: ${moduleId}`);
  const base = `/m/${moduleId}`;
  // Validation failures reject the returned promise; no request is made.
  const guard = <T>(path: string, run: (full: string) => Promise<T>): Promise<T> => {
    try {
      return run(`${base}${checkModulePath(path)}`);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return {
    get: <T>(path: string, query?: Record<string, string | number | boolean>) => {
      const qs = query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : '';
      return guard(path, (full) => api.get<T>(`${full}${qs ? `?${qs}` : ''}`));
    },
    post: <T>(path: string, body?: unknown) => guard(path, (full) => api.post<T>(full, body)),
    put: <T>(path: string, body?: unknown) => guard(path, (full) => api.put<T>(full, body)),
    patch: <T>(path: string, body?: unknown) => guard(path, (full) => api.patch<T>(full, body)),
    delete: <T>(path: string) => guard(path, (full) => api.delete<T>(full)),
  };
}
