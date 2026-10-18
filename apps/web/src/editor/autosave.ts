'use client';

import { migrateProject } from '@golf/schema';
import { api, ApiError } from '@/lib/api';
import { useEditor, type MediaInfo, type SaveError } from './store';

const DEBOUNCE = 1200;
/** Retries of a save that failed for a passing reason (no connection, server busy). */
const RETRY_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 300_000];
/** keepalive requests may carry at most 64 KiB in total (Fetch standard). */
const KEEPALIVE_MAX = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let inflight: Promise<void> | null = null;

export type SaveResult = { ok: true } | { ok: false; reason: 'conflict' | SaveError['reason']; message: string };

/** What a failed save means for the user (the badge shows it, network/server retry). */
export function saveErrorOf(e: unknown): SaveError | 'conflict' {
  if (!(e instanceof ApiError)) return { reason: 'server', message: String((e as Error)?.message ?? e) };
  if (e.code === 'version_conflict') return 'conflict';
  if (e.status === 413 || e.code === 'document_too_large') return { reason: 'too_large', message: e.message };
  if (e.code === 'unknown_media') return { reason: 'unknown_media', message: e.message };
  if (e.status === 422 || e.code === 'invalid_document') {
    const path = typeof e.details.path === 'string' ? e.details.path : undefined;
    return { reason: 'invalid', message: String(e.details.error ?? e.message), path };
  }
  if (e.status === 0) return { reason: 'network', message: e.message };
  return { reason: 'server', message: e.message };
}

/**
 * Saves the document if it has unsaved changes, against the version it was loaded from. When
 * another tab or window saved meanwhile, nothing is overwritten: the conflict dialog opens and
 * the result says so. Call this before anything that reads the saved project on the server
 * (exports, "make a video", named versions).
 */
export function flush(): Promise<SaveResult> {
  return save(false);
}

/** Overwrites whatever is saved: only for "keep mine" in the conflict dialog. */
export function saveNow(force = false): Promise<SaveResult> {
  return save(force);
}

async function save(force: boolean): Promise<SaveResult> {
  if (inflight) await inflight;
  const s = useEditor.getState();
  if (!s.projectId || !s.doc) return { ok: true };
  if (!force && s.saveState === 'conflict') return { ok: false, reason: 'conflict', message: '' };
  if (!force && s.saveState !== 'dirty' && s.saveState !== 'error') return { ok: true };
  const revision = s.revision;
  // Saving now covers what a pending debounce would have saved.
  if (timer) clearTimeout(timer);
  timer = null;
  useEditor.setState({ saveState: 'saving' });
  let result: SaveResult = { ok: true };
  inflight = (async () => {
    try {
      const r = await api<{ docVersion: number }>(`/projects/${s.projectId}/document`, {
        method: 'PUT',
        body: { document: s.doc, baseVersion: s.docVersion, force },
      });
      const now = useEditor.getState();
      useEditor.setState({ docVersion: r.docVersion, saveState: now.revision === revision ? 'saved' : 'dirty', saveError: null });
      retries = 0;
      announce(s.projectId, r.docVersion);
    } catch (e) {
      const err = saveErrorOf(e);
      if (err === 'conflict') {
        useEditor.setState({ saveState: 'conflict', saveError: null });
        result = { ok: false, reason: 'conflict', message: e instanceof Error ? e.message : '' };
      } else {
        useEditor.setState({ saveState: 'error', saveError: err });
        result = { ok: false, reason: err.reason, message: err.message };
        if (err.reason === 'network' || err.reason === 'server') retryLater();
      }
    } finally {
      inflight = null;
    }
  })();
  await inflight;
  if (result.ok && useEditor.getState().saveState === 'dirty') schedule();
  return result;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), DEBOUNCE);
}

/** A passing failure: try again, waiting longer each time. A rejected document is not retried
 *  (it would fail the same way) until the next edit. */
function retryLater() {
  if (retryTimer) clearTimeout(retryTimer);
  const ms = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (useEditor.getState().saveState === 'error') void flush();
  }, ms);
}

// --- other tabs ----------------------------------------------------------------------------

const TAB = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null = null;

interface SavedMsg {
  type: 'saved';
  projectId: string;
  docVersion: number;
  tab: string;
}

function announce(projectId: string, docVersion: number) {
  try {
    channel?.postMessage({ type: 'saved', projectId, docVersion, tab: TAB } satisfies SavedMsg);
  } catch {
    /* channel closed */
  }
}

/**
 * Another tab saved this project. Without own changes the newer document is loaded right away;
 * with changes the conflict dialog asks (instead of the next save overwriting theirs).
 */
export async function onSavedElsewhere(m: SavedMsg): Promise<'reloaded' | 'conflict' | null> {
  const s = useEditor.getState();
  if (m.tab === TAB || m.projectId !== s.projectId || m.docVersion <= s.docVersion) return null;
  if (s.saveState === 'saved') {
    const p = await api<{ document: unknown; docVersion: number; media: MediaInfo[] }>(`/projects/${s.projectId}`).catch(() => null);
    const now = useEditor.getState();
    if (!p || now.projectId !== m.projectId || p.docVersion <= now.docVersion) return null;
    if (now.saveState === 'saved') {
      now.adopt({ doc: migrateProject(p.document), docVersion: p.docVersion, media: p.media });
      return 'reloaded';
    }
  }
  if (useEditor.getState().saveState !== 'conflict') useEditor.setState({ saveState: 'conflict' });
  return 'conflict';
}

/** Last chance while the page goes away: a keepalive request outlives it (small documents). */
function saveOnExit() {
  const s = useEditor.getState();
  if (s.saveState !== 'dirty' && s.saveState !== 'error') return;
  const body = JSON.stringify({ document: s.doc, baseVersion: s.docVersion, force: false });
  if (body.length > KEEPALIVE_MAX) return void flush();
  void fetch(`/api/projects/${s.projectId}/document`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  })
    .then(async (r) => {
      if (!r.ok) return;
      const { docVersion } = (await r.json()) as { docVersion: number };
      useEditor.setState({ docVersion, saveState: useEditor.getState().revision === s.revision ? 'saved' : 'dirty' });
      announce(s.projectId, docVersion);
    })
    .catch(() => undefined);
}

/** Starts autosaving; returns an unsubscribe function. `onReloaded`: another tab's newer save
 *  replaced the document (there were no changes here). */
export function startAutosave(opts: { onReloaded?: () => void } = {}): () => void {
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.revision !== prev.revision && s.saveState === 'dirty') {
      retries = 0;
      schedule();
    }
  });
  const beforeUnload = (e: BeforeUnloadEvent) => {
    const st = useEditor.getState().saveState;
    // Ask before leaving; if the user leaves anyway, pagehide sends what is unsaved.
    if (st === 'dirty' || st === 'saving' || st === 'error') e.preventDefault();
  };
  const hidden = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('pagehide', saveOnExit);
  document.addEventListener('visibilitychange', hidden);
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('ogt-documents');
    channel.onmessage = (e: MessageEvent<SavedMsg>) => {
      if (e.data?.type === 'saved') void onSavedElsewhere(e.data).then((r) => r === 'reloaded' && opts.onReloaded?.());
    };
  }
  return () => {
    unsub();
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('pagehide', saveOnExit);
    document.removeEventListener('visibilitychange', hidden);
    channel?.close();
    channel = null;
    if (timer) clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
    timer = retryTimer = null;
    retries = 0;
  };
}
