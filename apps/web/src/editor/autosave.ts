'use client';

import { api, ApiError } from '@/lib/api';
import { useEditor } from './store';

const DEBOUNCE = 1200;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

export async function saveNow(force = false): Promise<boolean> {
  if (inflight) await inflight;
  const s = useEditor.getState();
  if (!force && s.saveState !== 'dirty' && s.saveState !== 'error') return true;
  const revision = s.revision;
  useEditor.setState({ saveState: 'saving' });
  let ok = false;
  inflight = (async () => {
    try {
      const r = await api<{ docVersion: number }>(`/projects/${s.projectId}/document`, {
        method: 'PUT',
        body: { document: s.doc, baseVersion: s.docVersion, force },
      });
      const now = useEditor.getState();
      useEditor.setState({ docVersion: r.docVersion, saveState: now.revision === revision ? 'saved' : 'dirty' });
      ok = true;
    } catch (e) {
      useEditor.setState({ saveState: e instanceof ApiError && e.code === 'version_conflict' ? 'conflict' : 'error' });
    } finally {
      inflight = null;
    }
  })();
  await inflight;
  if (ok && useEditor.getState().saveState === 'dirty') schedule();
  return ok;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), DEBOUNCE);
}

/** Starts autosaving; returns an unsubscribe function. */
export function startAutosave(): () => void {
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.revision !== prev.revision && s.saveState === 'dirty') schedule();
  });
  const beforeUnload = (e: BeforeUnloadEvent) => {
    const st = useEditor.getState().saveState;
    if (st === 'dirty' || st === 'saving' || st === 'error') {
      void saveNow();
      e.preventDefault();
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const retry = setInterval(() => {
    if (useEditor.getState().saveState === 'error') void saveNow();
  }, 10_000);
  return () => {
    unsub();
    window.removeEventListener('beforeunload', beforeUnload);
    clearInterval(retry);
    if (timer) clearTimeout(timer);
  };
}
