import type { Aspect, Clip, ExportPreset, MediaRef, Project, ReframeKey, Shot } from './project';

/** Timeline seconds a clip occupies. */
export function clipDuration(c: Clip): number {
  return c.kind === 'freeze' ? c.duration : Math.max(0, (c.out - c.in) / c.speed);
}

export function clipStarts(clips: readonly Clip[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const c of clips) {
    starts.push(t);
    t += clipDuration(c);
  }
  return starts;
}

export function timelineDuration(p: Pick<Project, 'clips'>): number {
  let t = 0;
  for (const c of p.clips) t += clipDuration(c);
  return t;
}

export interface ClipHit {
  clip: Clip;
  index: number;
  /** Timeline time where the clip begins. */
  start: number;
  /** Source time of the frame to show. */
  sourceTime: number;
  /**
   * Source-equivalent time that drives tracers. Equals `sourceTime` except in freeze
   * frames, where the picture stops but the ball keeps flying (the classic "hold").
   */
  tracerTime: number;
}

/** What is on screen at timeline time `t` (null past the end). */
export function clipAt(clips: readonly Clip[], t: number): ClipHit | null {
  let start = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const d = clipDuration(c);
    const last = i === clips.length - 1;
    if (t < start + d || (last && t <= start + d + 1e-9)) {
      const local = Math.max(0, Math.min(d, t - start));
      if (c.kind === 'freeze') {
        return { clip: c, index: i, start, sourceTime: c.at, tracerTime: c.at + local };
      }
      const s = c.in + local * c.speed;
      return { clip: c, index: i, start, sourceTime: s, tracerTime: s };
    }
    start += d;
  }
  return null;
}

/** All timeline times where `sourceTime` of `mediaId` is shown (one per clip that contains it). */
export function sourceToTimeline(clips: readonly Clip[], mediaId: string, sourceTime: number): number[] {
  const out: number[] = [];
  let start = 0;
  for (const c of clips) {
    if (c.mediaId === mediaId && c.kind === 'video' && sourceTime >= c.in - 1e-6 && sourceTime <= c.out + 1e-6) {
      out.push(start + (sourceTime - c.in) / c.speed);
    }
    start += clipDuration(c);
  }
  return out;
}

/**
 * Seconds of real flight shown for a shot at a given source time, after the user's
 * launch offset, slow-motion factor, fit offset and animation speed. Negative = before launch.
 */
export function flightTimeAt(shot: Pick<Shot, 'impactTime' | 'timing' | 'slowmo' | 'params'>, sourceTime: number): number {
  const dt0 = shot.params[8];
  const s = (sourceTime - shot.impactTime - shot.timing.launchOffset) / shot.slowmo - dt0;
  return s * shot.timing.speed;
}

/** Source time at which a given flight second is reached (inverse of `flightTimeAt`). */
export function sourceTimeOfFlight(shot: Pick<Shot, 'impactTime' | 'timing' | 'slowmo' | 'params'>, flight: number): number {
  return (flight / shot.timing.speed + shot.params[8]) * shot.slowmo + shot.impactTime + shot.timing.launchOffset;
}

// ---------------------------------------------------------------------------------------------
// Output size and reframing

export function aspectRatio(aspect: Aspect, src: { width: number; height: number }): number {
  switch (aspect) {
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '4:5':
      return 4 / 5;
    default:
      return src.width / Math.max(1, src.height);
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output pixel size for an aspect and a preset. `maxShortSide` caps resolution
 * (e.g. for quick previews or benchmarks). Never upscales beyond 2x the source.
 */
export function outputSize(
  aspect: Aspect,
  preset: ExportPreset,
  src: { width: number; height: number },
  maxShortSide = 4320,
): { width: number; height: number } {
  const r = aspectRatio(aspect, src);
  const srcShort = Math.min(src.width, src.height);
  let short = preset === 'youtube4k' ? 2160 : preset === 'original' ? srcShort : 1080;
  short = Math.min(short, maxShortSide, srcShort * 2);
  return r >= 1 ? { width: even(short * r), height: even(short) } : { width: even(short), height: even(short / r) };
}

/** Preview size (same aspect, fixed long side). */
export function previewSize(aspect: Aspect, src: { width: number; height: number }, longSide = 1280) {
  const r = aspectRatio(aspect, src);
  return r >= 1 ? { width: longSide, height: Math.round(longSide / r) } : { width: Math.round(longSide * r), height: longSide };
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

function ease(u: number) {
  return u * u * (3 - 2 * u);
}

/** Crop centre and zoom at timeline time t (linear-in-time with smoothstep easing between keys). */
export function reframeAt(keys: readonly ReframeKey[], t: number): { cx: number; cy: number; zoom: number } {
  if (keys.length === 0) return { cx: 0.5, cy: 0.5, zoom: 1 };
  if (t <= keys[0].t) return { cx: keys[0].cx, cy: keys[0].cy, zoom: keys[0].zoom };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, zoom: a.zoom + (b.zoom - a.zoom) * u };
    }
  }
  const z = keys[keys.length - 1];
  return { cx: z.cx, cy: z.cy, zoom: z.zoom };
}

/** Source-pixel crop for the project's aspect at timeline time t. */
export function cropAt(project: Pick<Project, 'format'>, src: { width: number; height: number }, t: number): Crop {
  const r = aspectRatio(project.format.aspect, src);
  if (project.format.fill === 'blur' && project.format.aspect !== 'original') {
    // The whole video, centred; the crop reaches past its edges (filled with the blurred copy).
    const w = Math.max(src.width, src.height * r);
    const h = Math.max(src.height, src.width / r);
    return { x: (src.width - w) / 2, y: (src.height - h) / 2, w, h };
  }
  const { mode, keyframes } = project.format.reframe;
  const f = mode === 'center' || project.format.aspect === 'original' ? { cx: 0.5, cy: 0.5, zoom: 1 } : reframeAt(keyframes, t);
  let w: number;
  let h: number;
  if (src.width / src.height > r) {
    h = src.height;
    w = h * r;
  } else {
    w = src.width;
    h = w / r;
  }
  w /= f.zoom;
  h /= f.zoom;
  const x = Math.min(Math.max(f.cx * src.width - w / 2, 0), src.width - w);
  const y = Math.min(Math.max(f.cy * src.height - h / 2, 0), src.height - h);
  return { x, y, w, h };
}

export function primaryMedia(project: Pick<Project, 'media' | 'clips'>): MediaRef | null {
  const first = project.clips[0];
  if (first && project.media[first.mediaId]) return project.media[first.mediaId];
  return Object.values(project.media).find((m) => m.kind === 'video') ?? null;
}

/** Orders shots as they are played: by where their video sits on the timeline, then by time. */
export function byTimeline(clips: readonly Clip[]): (a: { mediaId: string; impactTime: number }, b: { mediaId: string; impactTime: number }) => number {
  const first = new Map<string, number>();
  clips.forEach((c, i) => {
    if (!first.has(c.mediaId)) first.set(c.mediaId, i);
  });
  const at = (id: string) => first.get(id) ?? Infinity;
  return (a, b) => at(a.mediaId) - at(b.mediaId) || a.impactTime - b.impactTime;
}
