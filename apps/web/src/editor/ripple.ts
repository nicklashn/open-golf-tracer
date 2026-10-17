/**
 * Timeline maths for editing the main track: keeping graphics, music and crop keyframes with
 * the picture they belong to when clips are trimmed, deleted, moved or slowed (ripple), and
 * snapping. Pure functions – no store – so they are easy to test.
 */
import { clipDuration, clipStarts, type Clip, type Project } from '@golf/schema';
import type { Draft } from 'immer';

const EPS = 1e-6;

/**
 * Maps a timeline time before a clip edit to the time of the same picture after it.
 * A time inside a clip follows the clip (by id, or by source time into a clip split off it);
 * a time in footage that was trimmed away lands on the edge where it was cut; a time in a
 * deleted clip lands where the next remaining clip now starts. `isEnd` reads the time as the
 * end of a span (it belongs to the clip that ends there, not to the one that starts there).
 */
export function timelineRemap(before: readonly Clip[], after: readonly Clip[]): (t: number, isEnd?: boolean) => number {
  const bStarts = clipStarts(before);
  const aStarts = clipStarts(after);
  const bTotal = before.reduce((s, c) => s + clipDuration(c), 0);
  const aTotal = after.reduce((s, c) => s + clipDuration(c), 0);
  const aIndex = new Map(after.map((c, i) => [c.id, i]));
  const beforeIds = new Set(before.map((c) => c.id));
  const fresh = after.map((c, i) => ({ c, i })).filter((x) => !beforeIds.has(x.c.id));

  return (t: number, isEnd = false) => {
    if (!before.length || t <= 0) return t;
    if (t > bTotal + EPS || (!isEnd && t >= bTotal - EPS)) return aTotal + (t - bTotal);
    let i = 0;
    for (let k = 0; k < before.length; k++) {
      if (isEnd ? bStarts[k] < t - EPS : bStarts[k] <= t + EPS) i = k;
      else break;
    }
    const c = before[i];
    const local = Math.max(0, Math.min(clipDuration(c), t - bStarts[i]));
    const j = aIndex.get(c.id);
    if (c.kind === 'video') {
      const src = c.in + local * c.speed;
      const inside = (x: Clip) => x.kind === 'video' && x.mediaId === c.mediaId && src >= x.in - EPS && src <= x.out + EPS;
      const at = (k: number) => {
        const x = after[k] as Extract<Clip, { kind: 'video' }>;
        return aStarts[k] + (Math.min(x.out, Math.max(x.in, src)) - x.in) / x.speed;
      };
      if (j != null && inside(after[j])) return at(j);
      const split = fresh.find((x) => inside(x.c));
      if (split) return at(split.i);
      if (j != null) {
        const x = after[j];
        return x.kind === 'video' && src < x.in ? aStarts[j] : aStarts[j] + clipDuration(x);
      }
    } else if (j != null) {
      return aStarts[j] + Math.min(local, clipDuration(after[j]));
    }
    // The clip is gone: close the gap.
    for (let k = i + 1; k < before.length; k++) {
      const n = aIndex.get(before[k].id);
      if (n != null) return aStarts[n];
    }
    return aTotal;
  };
}

/**
 * After the main track changed (from `base`), moves graphics, music and crop keyframes so they
 * stay with their picture. Values are computed from `base`, so a drag that is applied again on
 * every pointer move never accumulates rounding or loses a layer it squeezed on the way.
 * `dropInside`: layers that were entirely inside deleted footage are removed with it.
 */
export function rippleLinked(base: Project, d: Draft<Project>, opts: { dropInside?: boolean } = {}): void {
  const map = timelineRemap(base.clips, d.clips as Clip[]);
  const total = (d.clips as Clip[]).reduce((s, c) => s + clipDuration(c), 0);
  const drop = new Set<string>();
  for (const bl of base.layers) {
    const l = d.layers.find((x) => x.id === bl.id);
    if (!l) continue;
    let s = map(bl.start);
    let e = map(bl.end, true);
    if (opts.dropInside && e - s < 0.05 && bl.end - bl.start >= 0.05) {
      drop.add(bl.id);
      continue;
    }
    s = Math.max(0, Math.min(s, Math.max(0, total - 0.1)));
    e = Math.max(s + 0.1, Math.min(e, total));
    if (Math.abs(l.start - s) > EPS) l.start = s;
    if (Math.abs(l.end - e) > EPS) l.end = e;
  }
  if (drop.size) d.layers = d.layers.filter((l) => !drop.has(l.id));
  for (const ba of base.audioTracks) {
    const a = d.audioTracks.find((x) => x.id === ba.id);
    if (!a) continue;
    const s = Math.max(0, map(ba.start));
    if (Math.abs(a.start - s) > EPS) a.start = s;
  }
  const bk = base.format.reframe.keyframes;
  const dk = d.format.reframe.keyframes;
  if (bk.length === dk.length) {
    bk.forEach((k, i) => {
      const t = Math.max(0, map(k.t));
      if (Math.abs(dk[i].t - t) > EPS) dk[i].t = t;
    });
  }
}

export interface Snap {
  t: number;
  /** The point snapped to, or null when nothing was within reach. */
  to: number | null;
}

/** Snaps t to the nearest point within `tolerance` seconds. */
export function snapTime(t: number, points: readonly number[], tolerance: number): Snap {
  let best: number | null = null;
  let bestD = tolerance;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best == null ? { t, to: null } : { t: best, to: best };
}

/** Every clip boundary on the main track (cut points), including 0 and the end. */
export function editPoints(clips: readonly Clip[]): number[] {
  const starts = clipStarts(clips);
  const total = clips.reduce((s, c) => s + clipDuration(c), 0);
  return [...starts, total];
}

/** The next (dir 1) or previous (dir -1) time in `points` from t, or null. */
export function stepTo(points: readonly number[], t: number, dir: 1 | -1): number | null {
  const sorted = [...points].sort((a, b) => a - b);
  if (dir > 0) return sorted.find((p) => p > t + 1e-3) ?? null;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < t - 1e-3) return sorted[i];
  return null;
}
