/** Client for the API's internal worker endpoints (INTERNAL_TOKEN). */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');

function readToken(): string {
  if (process.env.INTERNAL_TOKEN) return process.env.INTERNAL_TOKEN;
  const dataDir = process.env.DATA_DIR ?? resolve(ROOT, 'data');
  const f = resolve(dataDir, '.internal-token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('INTERNAL_TOKEN is missing (start the API first and it is created).');
}

export class InternalApi {
  readonly base: string;
  private token: string | null = null;

  constructor(base = process.env.API_URL ?? 'http://127.0.0.1:8000') {
    this.base = base.replace(/\/$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.token ??= readToken();
    const r = await fetch(`${this.base}/api/internal${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`API ${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  claim(kinds: string[], worker: string) {
    return this.call<{ job: null | { id: string; kind: string; payload: Record<string, unknown>; userId: string } }>('POST', '/jobs/claim', { kinds, worker });
  }
  progress(id: string, progress: number | null, message?: string, log?: string) {
    return this.call<{ continue: boolean }>('POST', `/jobs/${id}/progress`, { progress, message, log });
  }
  complete(id: string, result: Record<string, unknown>) {
    return this.call('POST', `/jobs/${id}/complete`, { result });
  }
  fail(id: string, error: string, retry = true) {
    return this.call<{ status: string }>('POST', `/jobs/${id}/fail`, { error, retry });
  }
  /** The job's project (merged document) and how many of its media jobs are still running. */
  jobProject(id: string) {
    return this.call<{ id: string; name: string; document: unknown; pending: number }>('GET', `/jobs/${id}/project`);
  }
  /** The AI model the job's user has chosen, key included (chatgpt: a fresh access token). Never log it. */
  jobAi(id: string) {
    return this.call<{
      provider: 'none' | 'ollama' | 'openai-compatible' | 'anthropic' | 'chatgpt';
      model: string;
      baseUrl: string;
      apiKey: string;
      maxTokens: number;
      /** May send still frames from the green when the putt count is unsure. */
      vision: boolean;
      source: string;
      /** chatgpt without a token: why (not signed in, or the sign-in could not be renewed). */
      error?: string;
    }>('GET', `/jobs/${id}/ai`);
  }
  defer(id: string, seconds: number, message: string) {
    return this.call<{ status: string }>('POST', `/jobs/${id}/defer`, { seconds, message });
  }
  /** Merges `data` into the job's payload, so a retry of the job starts from there. */
  checkpoint(id: string, data: Record<string, unknown>) {
    return this.call<{ ok: boolean }>('POST', `/jobs/${id}/checkpoint`, { data });
  }
  awaitAnswers(id: string, result: Record<string, unknown>, message?: string) {
    return this.call<{ status: string }>('POST', `/jobs/${id}/await`, { result, message });
  }
  /** Saves a generated document as a new project next to the job's project. */
  derive(id: string, name: string, document: unknown) {
    return this.call<{ id: string; name: string }>('POST', `/jobs/${id}/derive`, { name, document });
  }
  media(id: string) {
    return this.call<{ id: string; kind: string; path: string; probe: Record<string, unknown>; derived: Record<string, string> }>('GET', `/media/${id}`);
  }
  exportStart(id: string) {
    return this.call<{ path: string }>('POST', `/exports/${id}/start`);
  }
  exportDone(id: string, body: { width: number; height: number; duration: number }) {
    return this.call('POST', `/exports/${id}/done`, body);
  }
}
