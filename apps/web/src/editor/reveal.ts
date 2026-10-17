'use client';

/**
 * "Show this moment": jumps that come from outside the timeline (a shot in a list, a hole on the
 * scorecard) ask the timeline to scroll the playhead into view. Scrubbing and playback do not
 * need it (the playhead is under the pointer, or follows itself).
 */
type Listener = (t: number) => void;
const listeners = new Set<Listener>();

export function revealTime(t: number): void {
  for (const l of listeners) l(t);
}

export function onReveal(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
