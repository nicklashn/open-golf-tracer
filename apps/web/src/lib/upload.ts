'use client';

/**
 * Chunked, resumable uploads. Files are sent in parallel chunks; failed chunks retry with
 * backoff; if the tab is reloaded, dropping the same file again resumes where it stopped.
 */
import { create } from 'zustand';
import { api, ApiError } from './api';

export type UploadKind = 'video' | 'audio' | 'image';

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  kind: UploadKind;
  sent: number;
  status: 'waiting' | 'preparing' | 'uploading' | 'validating' | 'done' | 'error' | 'canceled';
  error?: unknown;
  speed: number;
  projectId?: string | null;
  result?: UploadResult;
}

export interface UploadResult {
  media: {
    id: string;
    kind: string;
    name: string;
    width: number;
    height: number;
    duration: number;
    fps: number;
    hdr: boolean;
    hasAudio: boolean;
    status: string;
    urls: Record<string, string>;
  };
  projectId: string | null;
  project?: unknown;
}

interface UploadStore {
  items: UploadItem[];
  update: (key: string, p: Partial<UploadItem>) => void;
  add: (it: UploadItem) => void;
  remove: (key: string) => void;
}

export const useUploads = create<UploadStore>((set) => ({
  items: [],
  update: (key, p) => set((s) => ({ items: s.items.map((i) => (i.key === key ? { ...i, ...p } : i)) })),
  add: (it) => set((s) => ({ items: [...s.items.filter((i) => i.key !== it.key), it] })),
  remove: (key) => set((s) => ({ items: s.items.filter((i) => i.key !== key) })),
}));

const PARALLEL = 3;
/** Files sent at once (a round is 20–30 clips of 1–2 GB): the rest wait their turn, so the first
 *  clips finish – and can be analysed – early, and the server is not flooded. */
const FILES_AT_ONCE = 2;
const controllers = new Map<string, AbortController>();

let sending = 0;
const waiting: (() => void)[] = [];

/** Waits for a free upload slot (rejects if the upload is cancelled meanwhile). */
function turn(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    function go() {
      signal.removeEventListener('abort', stop);
      sending++;
      resolve();
    }
    if (signal.aborted) return stop();
    if (sending < FILES_AT_ONCE) return go();
    waiting.push(go);
    signal.addEventListener('abort', stop, { once: true });
  });
}
function leave() {
  sending--;
  waiting.shift()?.();
}

function fileKey(f: File, projectId?: string | null) {
  return `${projectId ?? 'new'}:${f.name}:${f.size}:${f.lastModified}`;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(`gt_upload:${key}`);
  } catch {
    return null;
  }
}
function remember(key: string, id: string | null) {
  try {
    if (id) localStorage.setItem(`gt_upload:${key}`, id);
    else localStorage.removeItem(`gt_upload:${key}`);
  } catch {
    /* storage may be unavailable */
  }
}

export function kindOf(f: File): UploadKind {
  if (f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name)) return 'audio';
  if (f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(f.name)) return 'image';
  return 'video';
}

export function cancelUpload(key: string) {
  controllers.get(key)?.abort();
  useUploads.getState().update(key, { status: 'canceled' });
}

export async function uploadFile(file: File, opts: { projectId?: string | null; kind?: UploadKind } = {}): Promise<UploadResult> {
  const kind = opts.kind ?? kindOf(file);
  const key = fileKey(file, opts.projectId);
  const store = useUploads.getState();
  store.add({
    key,
    name: file.name,
    size: file.size,
    kind,
    sent: 0,
    status: sending < FILES_AT_ONCE ? 'preparing' : 'waiting',
    speed: 0,
    projectId: opts.projectId,
  });
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  let slot = false;
  const release = () => {
    if (slot) leave();
    slot = false;
  };
  try {
    await turn(ctrl.signal);
    slot = true;
    useUploads.getState().update(key, { status: 'preparing' });
    let status: { id: string; chunkSize: number; chunks: number; received: number[]; status: string } | null = null;
    const prev = remembered(key);
    if (prev) {
      try {
        status = await api(`/uploads/${prev}`);
        if (status?.status !== 'open') status = null;
      } catch {
        status = null;
      }
    }
    if (!status) {
      // lastModified: the last fallback for when a clip was filmed (see chronology.py).
      status = await api('/uploads', {
        body: { filename: file.name, size: file.size, kind, projectId: opts.projectId ?? null, lastModified: file.lastModified || null },
      });
      remember(key, status!.id);
    }
    const st = status!;
    const done = new Set(st.received);
    let sent = st.received.length * st.chunkSize;
    store.update(key, { status: 'uploading', sent: Math.min(sent, file.size) });
    const queue = Array.from({ length: st.chunks }, (_, i) => i).filter((i) => !done.has(i));
    const started = performance.now();
    const startSent = sent;
    async function worker() {
      while (queue.length) {
        const i = queue.shift()!;
        const blob = file.slice(i * st.chunkSize, Math.min(file.size, (i + 1) * st.chunkSize));
        for (let attempt = 0; ; attempt++) {
          try {
            await api(`/uploads/${st.id}/chunks/${i}`, {
              method: 'PUT',
              raw: blob,
              headers: { 'content-type': 'application/octet-stream' },
              signal: ctrl.signal,
            });
            break;
          } catch (e) {
            if (ctrl.signal.aborted) throw e;
            if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
            if (attempt >= 5) throw e;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
        }
        sent += blob.size;
        const secs = (performance.now() - started) / 1000;
        useUploads.getState().update(key, { sent: Math.min(sent, file.size), speed: secs > 0.5 ? (sent - startSent) / secs : 0 });
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length || 1) }, worker));
    release(); // the server checks the file now; the next one can start sending
    useUploads.getState().update(key, { status: 'validating', sent: file.size });
    const result = await complete(st.id);
    remember(key, null);
    useUploads.getState().update(key, { status: 'done', result });
    setTimeout(() => useUploads.getState().remove(key), 4000);
    return result;
  } catch (e) {
    if (ctrl.signal.aborted) {
      useUploads.getState().update(key, { status: 'canceled' });
      setTimeout(() => useUploads.getState().remove(key), 1500);
    } else {
      useUploads.getState().update(key, { status: 'error', error: e });
      if (e instanceof ApiError && ['invalid_media', 'wrong_kind', 'upload_expired', 'video_too_long'].includes(e.code)) remember(key, null);
    }
    throw e;
  } finally {
    release();
    controllers.delete(key);
  }
}

/**
 * Finishes an upload. Validation of a big file can outlast a proxy timeout; the server keeps
 * going, so on a network error we wait until it reports the upload done and then fetch the
 * result (completing an already completed upload just returns it). Calling complete again while
 * the first call still runs could create the video twice.
 */
async function complete(id: string): Promise<UploadResult> {
  try {
    return await api<UploadResult>(`/uploads/${id}/complete`, { method: 'POST' });
  } catch (e) {
    if (e instanceof ApiError && e.status > 0 && e.status < 500) throw e;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api<{ status: string }>(`/uploads/${id}`).catch(() => null);
      if (s?.status === 'complete') return api<UploadResult>(`/uploads/${id}/complete`, { method: 'POST' });
      if (s && s.status !== 'open') throw e;
    }
    throw e;
  }
}
