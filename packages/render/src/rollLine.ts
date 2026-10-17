/**
 * Roll line: a thin glowing line on the green along the path a putt rolled, growing with the
 * ball (as in TV putting graphics), held a moment where the ball stopped and faded out. Drawn
 * with the tracer's rasteriser and compositing, so preview and export match exactly.
 *
 * The path (`shot.putt.path`) is in source-video seconds and fractions of the source frame, so
 * the line follows trims, clip speed, slow motion (it runs on source time) and crops/reframing
 * (the same source → output transform as the tracer). The camera is assumed to stand still:
 * the analysis only keeps a path when a lying ball stayed put in the picture.
 */
import type { MediaRef, Shot, TracerStyle } from '@golf/schema';
import { Mask, blur, disc, segment } from './raster';
import { composite, type Affine, type RGBARegion, type TracerFrameOptions } from './tracer';

/** Source seconds the whole line stays after the ball stopped, then fades out over ROLL_FADE_S. */
export const ROLL_HOLD_S = 1.2;
export const ROLL_FADE_S = 0.8;
/** Line width: this share of the source diagonal (× √style.width), in source pixels. */
const WIDTH_K = 0.0008;

export interface RollGeometry {
  /** Source seconds, output pixels and drawn length (output px) from the start, densified. */
  t: number[];
  x: number[];
  y: number[];
  d: number[];
  length: number;
  start: number;
  end: number;
  /** Line width, output px. */
  w: number;
  holed: boolean;
}

/** The putt's roll line is switched on and has a path to draw. */
export const hasRollLine = (shot: Pick<Shot, 'kind' | 'putt'>): boolean => shot.kind === 'putt' && !!shot.putt?.line && (shot.putt.path?.length ?? 0) >= 2;

/**
 * Path in output pixels. The stored points are ~12 per second, uniform in time; a Catmull-Rom
 * spline through them (parameterised by time) is cut into ≤ 3 px steps so the line is smooth
 * and its tip follows the ball between points.
 */
export function rollGeometry(shot: Pick<Shot, 'putt' | 'style'>, media: Pick<MediaRef, 'width' | 'height'>, tf: Affine): RollGeometry | null {
  const path = shot.putt?.path;
  if (!path || path.length < 2) return null;
  const P = path.map((p) => ({ t: p.t, x: (p.x * media.width - tf.ox) * tf.scale, y: (p.y * media.height - tf.oy) * tf.scale }));
  const t: number[] = [P[0].t];
  const x: number[] = [P[0].x];
  const y: number[] = [P[0].y];
  const d: number[] = [0];
  let run = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    const steps = Math.max(1, Math.min(64, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3)));
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const u2 = u * u;
      const u3 = u2 * u;
      const cr = (a: number, b: number, c: number, e: number) =>
        0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - e) * u2 + (-a + 3 * b - 3 * c + e) * u3);
      const X = k === steps ? p2.x : cr(p0.x, p1.x, p2.x, p3.x);
      const Y = k === steps ? p2.y : cr(p0.y, p1.y, p2.y, p3.y);
      run += Math.hypot(X - x[x.length - 1], Y - y[y.length - 1]);
      t.push(p1.t + (p2.t - p1.t) * u);
      x.push(X);
      y.push(Y);
      d.push(run);
    }
  }
  const srcDiag = Math.hypot(media.width, media.height);
  const w = Math.max(1.2, WIDTH_K * srcDiag * Math.sqrt(Math.max(0.2, shot.style.width)) * tf.scale);
  return { t, x, y, d, length: run, start: P[0].t, end: P[P.length - 1].t, w, holed: shot.putt?.holed === true };
}

const smooth = (u: number) => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

/** How visible the line is at source second `s`: 0 before the stroke, 1 while rolling and held, then fading. */
export function rollFade(g: Pick<RollGeometry, 'start' | 'end'>, s: number): number {
  if (s < g.start) return 0;
  const after = s - g.end - ROLL_HOLD_S;
  return after <= 0 ? 1 : 1 - smooth(after / ROLL_FADE_S);
}

interface Prepared {
  n: number;
  hx: number;
  hy: number;
  hd: number;
  done: boolean;
  fade: number;
  bx: number;
  by: number;
  W: number;
  H: number;
}

/** Drawn length (output px) at source second s: up to the ball while it rolls. */
export function rollLengthAt(g: RollGeometry, s: number): number {
  return prepare(g, s, { width: Infinity, height: Infinity })?.hd ?? 0;
}

function prepare(g: RollGeometry, s: number, opt: TracerFrameOptions): Prepared | null {
  const fade = rollFade(g, s);
  if (fade <= 0.002 || g.t.length < 2) return null;
  const sc = Math.min(s, g.end);
  let n = 1;
  while (n < g.t.length && g.t[n] <= sc) n++;
  // Points 0..n-1 are drawn, plus an interpolated head between n-1 and n.
  let hx = g.x[n - 1];
  let hy = g.y[n - 1];
  let hd = g.d[n - 1];
  if (n < g.t.length) {
    const u = (sc - g.t[n - 1]) / Math.max(1e-9, g.t[n] - g.t[n - 1]);
    hx += (g.x[n] - hx) * u;
    hy += (g.y[n] - hy) * u;
    hd += (g.d[n] - hd) * u;
  }
  const done = s >= g.end;
  const margin = Math.ceil(g.w * 10 + 10);
  let x1 = hx;
  let x2 = hx;
  let y1 = hy;
  let y2 = hy;
  for (let i = 0; i < n; i++) {
    if (g.x[i] < x1) x1 = g.x[i];
    if (g.x[i] > x2) x2 = g.x[i];
    if (g.y[i] < y1) y1 = g.y[i];
    if (g.y[i] > y2) y2 = g.y[i];
  }
  const bx = Math.max(0, Math.floor(x1 - margin));
  const by = Math.max(0, Math.floor(y1 - margin));
  const W = Math.min(opt.width, Math.ceil(x2 + margin)) - bx;
  const H = Math.min(opt.height, Math.ceil(y2 + margin)) - by;
  if (W <= 0 || H <= 0) return null;
  return { n, hx, hy, hd, done, fade, bx, by, W, H };
}

/** Output-pixel box the roll line may draw into at source second s (no rasterising). */
export function rollLineBounds(g: RollGeometry, s: number, opt: TracerFrameOptions): { x: number; y: number; w: number; h: number } | null {
  const p = prepare(g, s, opt);
  return p ? { x: p.bx, y: p.by, w: p.W, h: p.H } : null;
}

/** Renders the roll line at source second `s` as a straight-alpha RGBA region (null = nothing visible). */
export function renderRollLine(g: RollGeometry, style: TracerStyle, s: number, opt: TracerFrameOptions): RGBARegion | null {
  const pr = prepare(g, s, opt);
  if (!pr) return null;
  const { n, hx, hy, hd, done, fade, bx, by, W, H } = pr;
  const gs = 0.25;
  const body = new Mask(W, H, !!style.color2);
  const core = new Mask(W, H);
  const glow = new Mask(Math.ceil(W * gs) + 1, Math.ceil(H * gs) + 1);
  // It leaves the ball's spot softly, and the colour runs from color to color2 along the roll.
  const rise = Math.min(g.length * 0.1, g.w * 8);
  const along = (dist: number) => Math.min(1, dist / Math.max(1e-6, g.length));
  const alpha = (dist: number) => (rise > 0 ? 0.25 + 0.75 * smooth(dist / rise) : 1);
  const xs = g.x.slice(0, n);
  const ys = g.y.slice(0, n);
  const ds = g.d.slice(0, n);
  if (hd > ds[ds.length - 1]) {
    xs.push(hx);
    ys.push(hy);
    ds.push(hd);
  }
  for (let i = 1; i < xs.length; i++) {
    const ax = xs[i - 1] - bx;
    const ay = ys[i - 1] - by;
    const cx = xs[i] - bx;
    const cy = ys[i] - by;
    const al = alpha(ds[i]);
    segment(body, ax, ay, cx, cy, g.w, al * 0.9, along(ds[i - 1]), along(ds[i]));
    segment(core, ax, ay, cx, cy, g.w * 0.35, al);
    segment(glow, ax * gs, ay * gs, cx * gs, cy * gs, g.w * 2.6 * gs, al);
  }
  if (done) {
    // Where the ball stopped: a small dot settles in; a holed putt gets a ring spreading from the cup.
    const after = s - g.end;
    const ex = g.x[g.x.length - 1] - bx;
    const ey = g.y[g.y.length - 1] - by;
    const grow = smooth(after / 0.25);
    segment(body, ex, ey, ex, ey, g.w * (1.2 + 1.2 * grow), 0.95, 1, 1);
    disc(core, ex, ey, g.w * 0.55 * grow, 1);
    disc(glow, ex * gs, ey * gs, g.w * 2.2 * gs, 0.8 * grow);
    if (g.holed && after < 1) {
      const k = smooth(after / 1);
      groundRing(body, ex, ey, g.w * (1.5 + 6 * k), Math.max(1, g.w * 0.5), 0.9 * (1 - k));
    }
  }
  blur(glow, Math.max(2, g.w * 1.8) * gs);
  return composite(body, core, glow, gs, style, fade, bx, by, W, H);
}

/** A ring lying on the green (an ellipse flattened like the landing ring), in the line's end colour. */
function groundRing(m: Mask, x: number, y: number, radius: number, width: number, value: number): void {
  const N = 40;
  let px = x + radius;
  let py = y;
  for (let i = 1; i <= N; i++) {
    const a = (i / N) * 2 * Math.PI;
    const qx = x + radius * Math.cos(a);
    const qy = y + radius * 0.38 * Math.sin(a);
    segment(m, px, py, qx, qy, width, value, 1, 1);
    px = qx;
    py = qy;
  }
}
