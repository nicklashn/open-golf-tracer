'use client';

/**
 * Media URLs are signed and expire (apps/api/golf_api/media_urls.py, 6 h). An editor left open
 * longer gets a 403 on the next range request of a video or on a waveform: then the file's
 * URLs are asked for again and the element carries on from where it was.
 */
import { api } from '@/lib/api';
import { useEditor, type MediaInfo } from './store';

/** At most one refresh per file in this time: a file that is really gone does not loop. */
const MIN_INTERVAL_MS = 20_000;
const inflight = new Map<string, Promise<MediaInfo | null>>();
const lastAt = new Map<string, number>();

/** Fresh signed URLs for a file (stored in the editor's media); null when they cannot be had. */
export function refreshMedia(id: string): Promise<MediaInfo | null> {
  const running = inflight.get(id);
  if (running) return running;
  const now = Date.now();
  if (now - (lastAt.get(id) ?? -Infinity) < MIN_INTERVAL_MS) return Promise.resolve(null);
  lastAt.set(id, now);
  const p = api<MediaInfo>(`/media/${encodeURIComponent(id)}`)
    .then((fresh) => {
      const old = useEditor.getState().media[id];
      const m = { ...old, ...fresh, urls: { ...fresh.urls } };
      useEditor.getState().setMedia(m);
      return m;
    })
    .catch(() => null)
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** For tests. */
export function resetMediaRefresh(): void {
  inflight.clear();
  lastAt.clear();
}
