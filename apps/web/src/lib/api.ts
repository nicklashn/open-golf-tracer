/** Browser API client: same-origin /api (Next rewrite), typed errors. */
import type { Dict } from './i18n';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly ref?: string,
  ) {
    super(message);
  }
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: BodyInit;
  headers?: Record<string, string>;
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body, signal: opts.signal, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Ingen forbindelse til serveren.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown>; ref?: string } })?.error;
    throw new ApiError(
      res.status,
      err?.code ?? (res.status >= 500 ? 'server_error' : 'http_error'),
      err?.message ?? res.statusText,
      err?.details ?? {},
      err?.ref,
    );
  }
  return data as T;
}

/** A user-facing, translated message for any error. */
export function errorMessage(e: unknown, t: Dict): string {
  if (e instanceof ApiError) {
    const known = (t.errors as Record<string, string>)[e.code];
    if (known) return known;
    if (e.status === 0) return t.errors.network;
    return e.message || t.errors.generic;
  }
  return t.errors.generic;
}

export const fetcher = <T>(path: string) => api<T>(path);
