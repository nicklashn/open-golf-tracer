/**
 * Keeping a flight where it can be seen and edited.
 *
 * A bad track (a bird, the tee, two balls) can fit a flight whose apex or landing lies far
 * outside the picture – the handles are then unreachable. `offFrameReason` is the sanity rule
 * the analysis applies too (shottracer/physics.py `off_frame_reason`, same thresholds), and
 * `intoView` / `fitThrough` build an in-frame flight from the start point and what is known.
 */
import type { Shot } from '@golf/schema';
import { fitConstrained } from './fit';
import { defaultParams, stats, type Vec2 } from './model';
import { shotAnchor, shotHandles, type Handles } from './shot';

type ShotLike = Pick<Shot, 'params' | 'camera' | 'anchor' | 'constraints' | 'track' | 'impactTime' | 'slowmo' | 'timing'> & Partial<Pick<Shot, 'club'>>;

/** A rectangle in source-video pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Thresholds of the sanity rule (mirrored in shottracer/physics.py). */
export const OFF_FRAME = {
  /** Apex or landing more than this many frame sizes outside the picture. */
  slack: 1,
  /** Longer flights never really land in the model (MAX_FLIGHT is 12 s). */
  maxFlightS: 11,
  /** No golf shot carries further. */
  maxCarryM: 360,
  /** The apex must come after the launch: a flight that only falls is no shot. */
  minApexS: 0.25,
} as const;

/** The whole source frame of a shot (its camera centre is the frame centre). */
export function frameBox(shot: Pick<Shot, 'camera'>): Box {
  return { x: 0, y: 0, w: shot.camera.cx * 2, h: shot.camera.cy * 2 };
}

/** How far a point lies outside a box, in box sizes along the worse axis (0 = inside). */
export function outsideBy(p: Vec2, b: Box): number {
  const dx = p.x < b.x ? (b.x - p.x) / b.w : p.x > b.x + b.w ? (p.x - b.x - b.w) / b.w : 0;
  const dy = p.y < b.y ? (b.y - p.y) / b.h : p.y > b.y + b.h ? (p.y - b.y - b.h) / b.h : 0;
  return Math.max(dx, dy);
}

export function inBox(p: Vec2, b: Box): boolean {
  return outsideBy(p, b) === 0;
}

export function clampToBox(p: Vec2, b: Box): Vec2 {
  return { x: Math.min(Math.max(p.x, b.x), b.x + b.w), y: Math.min(Math.max(p.y, b.y), b.y + b.h) };
}

/** The box shrunk by a fraction of its size on every side. */
export function inset(b: Box, f: number): Box {
  return { x: b.x + b.w * f, y: b.y + b.h * f, w: b.w * (1 - 2 * f), h: b.h * (1 - 2 * f) };
}

/**
 * Why a flight cannot be what happened, judged against the picture it was filmed in – or null.
 * Handles more than a frame outside, no landing within the model's flight time, an absurd carry
 * or an apex at the start all mean the fit went wrong.
 */
export function offFrameReason(shot: ShotLike, frame: Box = frameBox(shot)): string | null {
  const h = shotHandles(shot);
  if (!h) return 'invalid flight';
  if (![h.apex.x, h.apex.y, h.landing.x, h.landing.y].every(Number.isFinite)) return 'invalid flight';
  if (outsideBy(h.apex, frame) > OFF_FRAME.slack) return 'apex off frame';
  if (outsideBy(h.landing, frame) > OFF_FRAME.slack) return 'landing off frame';
  if (h.landingT > OFF_FRAME.maxFlightS) return 'flight too long';
  if (h.apexT < OFF_FRAME.minApexS) return 'no rise';
  const st = stats(shot.params, shot.camera, shotAnchor(shot));
  if (st && st.carryM > OFF_FRAME.maxCarryM) return 'carry too long';
  return null;
}

export interface ViewFitOptions {
  fps: number;
  longSide: number;
}

const NO_CONSTRAINTS: Shot['constraints'] = { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null };

/**
 * A flight from `start` through `apex` to `landing` (image points), keeping the shot's known
 * carry, curve and flight time. Tries the default shot, a default aimed at the apex and the
 * current flight as starting points; of those that meet the points (within 3 px) it keeps the
 * most plausible one (lowest fit cost: least curve, typical launch), else the closest.
 */
export function fitThrough(shot: ShotLike, start: Vec2, apex: Vec2, landing: Vec2, opt: ViewFitOptions): { params: number[]; error: number } {
  const club = shot.club ?? null;
  const f0 = 0.75 * opt.longSide;
  const aim = Math.atan((apex.x - shot.camera.cx) / f0);
  const froms = [defaultParams(opt.longSide, 0, club), defaultParams(opt.longSide, Math.max(-1.5, Math.min(1.5, aim)), club), [...shot.params]];
  const c = shot.constraints;
  // Extra points are stored in source seconds; the model wants flight seconds.
  const points = c.points.map((q) => ({ t: (q.t - shot.impactTime) / shot.slowmo, x: q.x, y: q.y }));
  const constraints = { apex, landing, points, curve: c.curve, carry: c.carry, flightTime: c.flightTime };
  let best: { params: number[]; error: number; cost: number } | null = null;
  for (const from of froms) {
    const r = fitConstrained({
      params: from,
      camera: shot.camera,
      anchor: start,
      longSide: opt.longSide,
      fps: opt.fps,
      sigmaPx: 1,
      constraints,
      track: null,
      club,
      maxIterations: 60,
      reference: from,
    });
    const h = shotHandles({ ...shot, params: r.params, constraints: { ...c, start } });
    const error = h ? Math.hypot(h.apex.x - apex.x, h.apex.y - apex.y) + Math.hypot(h.landing.x - landing.x, h.landing.y - landing.y) : Infinity;
    const better = !best || (error < 3 ? best.error >= 3 || r.cost < best.cost : error < best.error);
    if (better) best = { params: r.params, error, cost: r.cost };
  }
  return { params: best!.params, error: best!.error };
}

/** Where a sensible flight would put its handles in `box`: the current ones where they are in
 *  view, else the default shot's, pulled inside the box. */
export function inViewTargets(shot: ShotLike, box: Box, opt: ViewFitOptions): { start: Vec2; apex: Vec2; landing: Vec2 } {
  const inner = inset(box, 0.06);
  const anchor = shotAnchor(shot);
  const start = inBox(anchor, box) ? anchor : clampToBox(anchor, inset(box, 0.03));
  const withStart = { ...shot, constraints: { ...shot.constraints, start } };
  const cur = offFrameReason(withStart) === 'invalid flight' ? null : shotHandles(withStart);
  const def: Handles | null = shotHandles({ ...withStart, params: defaultParams(opt.longSide, 0, shot.club ?? null) });
  const pick = (k: 'apex' | 'landing'): Vec2 => {
    if (cur && inBox(cur[k], inner)) return cur[k];
    if (def && inBox(def[k], inner)) return def[k];
    return clampToBox((def ?? cur)?.[k] ?? { x: start.x, y: box.y + box.h * (k === 'apex' ? 0.15 : 0.4) }, inner);
  };
  let apex = pick('apex');
  let landing = pick('landing');
  // The ball rises from the start to the apex and lands lower than the apex.
  const rise = 0.12 * box.h;
  if (apex.y > start.y - rise) apex = { x: apex.x, y: Math.max(inner.y, start.y - Math.max(rise, 0.45 * (start.y - inner.y))) };
  if (landing.y < apex.y + 0.04 * box.h)
    landing = { x: landing.x, y: Math.min(start.y - 0.04 * box.h, apex.y + Math.max(0.04 * box.h, 0.3 * (start.y - apex.y))) };
  return { start, apex, landing };
}

/**
 * Pulls a flight into `box` (what the preview shows): start, apex and landing are kept where they
 * are visible, others get the default shot's place; extra points outside the box are dropped.
 */
export function intoView(shot: ShotLike, box: Box, opt: ViewFitOptions): { params: number[]; constraints: Shot['constraints'] } {
  const { start, apex, landing } = inViewTargets(shot, box, opt);
  const c = shot.constraints;
  const points = c.points.filter((q) => inBox(q, box));
  const r = fitThrough({ ...shot, constraints: { ...c, points } }, start, apex, landing, opt);
  const anchor = shot.anchor;
  const moved = Math.hypot(start.x - anchor.x, start.y - anchor.y) > 0.5;
  // The track led the fit astray: later refits (dragging a handle) leave it out.
  return { params: r.params, constraints: { ...NO_CONSTRAINTS, ...c, start: moved || c.start ? start : null, apex, landing, points, ignoreTrack: true } };
}
