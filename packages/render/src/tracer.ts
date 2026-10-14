/**
 * Broadcast-style tracer: a glowing line that thins and fades with distance, drawn in sync
 * with the flight. Pure TypeScript (see raster.ts) so preview and export match exactly.
 */
import { project, type Projection } from '@golf/physics';
import type { Shot, TracerStyle } from '@golf/schema';
import { Mask, blur, disc, ellipseRing, sample, segment } from './raster';

export interface Affine {
  /** out = (src - origin) * scale */
  ox: number;
  oy: number;
  scale: number;
}

export interface RGBARegion {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** Source-pixel flight of a shot (cached; projection is the expensive part). */
export interface SourcePath {
  t: Float64Array;
  u: Float64Array;
  v: Float64Array;
  z: Float64Array;
  n: number;
  landT: number;
  srcDiag: number;
}

const cache = new Map<string, SourcePath | null>();
const CACHE_MAX = 96;

export function shotKey(shot: Pick<Shot, 'params' | 'anchor' | 'camera' | 'constraints'>): string {
  const a = shot.constraints.start ?? shot.anchor;
  return `${shot.params.join(',')}|${a.x},${a.y}|${shot.camera.cx},${shot.camera.cy}`;
}

export function sourcePath(shot: Pick<Shot, 'params' | 'anchor' | 'camera' | 'constraints'>): SourcePath | null {
  const key = shotKey(shot);
  if (cache.has(key)) return cache.get(key)!;
  const anchor = shot.constraints.start ?? shot.anchor;
  const pr: Projection | null = project(shot.params, shot.camera, anchor, true);
  const out = pr
    ? { t: pr.t as Float64Array, u: pr.u, v: pr.v, z: pr.z, n: pr.n, landT: pr.t[pr.n - 1], srcDiag: Math.hypot(shot.camera.cx * 2, shot.camera.cy * 2) }
    : null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

export interface Geometry {
  t: number[];
  x: number[];
  y: number[];
  w: number[];
  a: number[];
  /** Drawn length (output px) from the ball to each point, and in total. */
  d: number[];
  length: number;
  landT: number;
  /** Line width at launch, output px. */
  w0: number;
  anchor: { x: number; y: number };
}

/** Flight in output pixels with perspective width/opacity, decimated to ~2.5 px steps. */
export function geometry(sp: SourcePath, style: TracerStyle, tf: Affine, anchorSrc: { x: number; y: number }): Geometry {
  const base = 0.0022 * sp.srcDiag * style.width * tf.scale;
  const p = style.perspective;
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const w: number[] = [];
  const a: number[] = [];
  const d: number[] = [];
  let run = 0;
  const z0 = sp.z[0];
  let lx = Infinity;
  let ly = Infinity;
  for (let i = 0; i < sp.n; i++) {
    const X = (sp.u[i] - tf.ox) * tf.scale;
    const Y = (sp.v[i] - tf.oy) * tf.scale;
    const last = i === sp.n - 1;
    if (!last && i > 0 && Math.hypot(X - lx, Y - ly) < 2.5) continue;
    if (i > 0) run += Math.hypot(X - lx, Y - ly);
    lx = X;
    ly = Y;
    const near = Math.min(1, Math.max(0, z0 / sp.z[i]));
    let wi = base * Math.max(Math.pow(near, 0.75 * p), 0.09);
    // A thin start, unless the line fades in (then it rises wide and soft out of the ball).
    const ease = Math.min(1, Math.max(0, sp.t[i] / 0.06));
    if (style.fadeIn <= 0) wi *= 0.35 + 0.65 * ease * ease * (3 - 2 * ease);
    t.push(sp.t[i]);
    x.push(X);
    y.push(Y);
    w.push(Math.max(wi, 0.8));
    a.push(1 - p * 0.65 * (1 - Math.pow(near, 0.4)));
    d.push(run);
  }
  return {
    t,
    x,
    y,
    w,
    a,
    d,
    length: run,
    landT: sp.landT,
    w0: Math.max(base * 0.35, 0.8),
    anchor: { x: (anchorSrc.x - tf.ox) * tf.scale, y: (anchorSrc.y - tf.oy) * tf.scale },
  };
}

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const smooth = (u: number) => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

export interface TracerFrameOptions {
  /** Output frame size; the region is clipped to it. */
  width: number;
  height: number;
}

interface Prepared {
  px: number[];
  py: number[];
  pw: number[];
  pa: number[];
  pt: number[];
  pd: number[];
  fade: number;
  landed: boolean;
  sClamped: number;
  flash: boolean;
  bx: number;
  by: number;
  W: number;
  H: number;
}

/** Visible part of the flight at second s and its bounding box (shared by render and bounds). */
function prepare(g: Geometry, style: TracerStyle, s: number, opt: TracerFrameOptions): Prepared | null {
  if (s < 0 || g.t.length < 2) return null;
  const landed = s >= g.landT;
  let fade = 1;
  if (landed) {
    const after = s - g.landT;
    if (style.afterLanding === 'hide') fade = 1 - smooth(after / 0.25);
    else if (style.afterLanding === 'fade') fade = 1 - smooth(after / Math.max(0.05, style.fadeSeconds));
    if (fade <= 0.002) return null;
  }
  const sClamped = Math.min(s, g.landT);
  // Points up to now, plus an interpolated head so the line grows smoothly between samples.
  let n = 0;
  while (n < g.t.length && g.t[n] <= sClamped) n++;
  const px: number[] = g.x.slice(0, n);
  const py: number[] = g.y.slice(0, n);
  const pw: number[] = g.w.slice(0, n);
  const pa: number[] = g.a.slice(0, n);
  const pt: number[] = g.t.slice(0, n);
  const pd: number[] = g.d.slice(0, n);
  if (n < g.t.length && n > 0) {
    const u = (sClamped - g.t[n - 1]) / (g.t[n] - g.t[n - 1]);
    px.push(g.x[n - 1] + (g.x[n] - g.x[n - 1]) * u);
    py.push(g.y[n - 1] + (g.y[n] - g.y[n - 1]) * u);
    pw.push(g.w[n - 1] + (g.w[n] - g.w[n - 1]) * u);
    pa.push(g.a[n - 1] + (g.a[n] - g.a[n - 1]) * u);
    pt.push(sClamped);
    pd.push(g.d[n - 1] + (g.d[n] - g.d[n - 1]) * u);
  }
  const flash = style.impactFlash && s < 0.2;
  if (px.length < 2 && !flash) return null;
  // Bounding box (output px) with room for glow and markers.
  let wMax = g.w0;
  for (const w of pw) if (w > wMax) wMax = w;
  const margin = Math.ceil(wMax * 8 + 10);
  let x1 = g.anchor.x;
  let x2 = g.anchor.x;
  let y1 = g.anchor.y;
  let y2 = g.anchor.y;
  for (let i = 0; i < px.length; i++) {
    if (px[i] < x1) x1 = px[i];
    if (px[i] > x2) x2 = px[i];
    if (py[i] < y1) y1 = py[i];
    if (py[i] > y2) y2 = py[i];
  }
  const bx = Math.max(0, Math.floor(x1 - margin));
  const by = Math.max(0, Math.floor(y1 - margin));
  const W = Math.min(opt.width, Math.ceil(x2 + margin)) - bx;
  const H = Math.min(opt.height, Math.ceil(y2 + margin)) - by;
  if (W <= 0 || H <= 0) return null;
  return { px, py, pw, pa, pt, pd, fade, landed, sClamped, flash, bx, by, W, H };
}

/** Output-pixel box the tracer may draw into at second s (no rasterising). */
export function tracerBounds(g: Geometry, style: TracerStyle, s: number, opt: TracerFrameOptions): { x: number; y: number; w: number; h: number } | null {
  const p = prepare(g, style, s, opt);
  return p ? { x: p.bx, y: p.by, w: p.W, h: p.H } : null;
}

/**
 * Renders the tracer at flight second `s` (negative = before launch). Returns a straight-alpha
 * RGBA region in output pixels, or null when nothing is visible.
 */
export function renderTracer(g: Geometry, style: TracerStyle, s: number, opt: TracerFrameOptions): RGBARegion | null {
  const pr = prepare(g, style, s, opt);
  if (!pr) return null;
  const { px, py, pw, pa, pt, pd, fade, landed, sClamped, flash, bx, by, W, H } = pr;
  // The line rises softly out of the ball (as in most shot-tracer clips): faint near it, full
  // strength after `fadeIn` of the whole drawn path.
  const fadeLen = style.fadeIn * g.length;
  const riseAlpha = (dist: number) => (fadeLen > 0 ? smooth(dist / fadeLen) : 1);
  // Colour runs from color to color2 along the drawn line (in a down-the-line view most of it
  // is the climb, so the top of the arc turns warm, as in broadcast and app tracers).
  const along = (dist: number) => Math.min(1, dist / Math.max(1e-6, g.length));
  // Comet: only the last `comet` seconds stay visible, fading out towards the tail.
  const tailFrom = style.comet > 0 ? sClamped - style.comet : -Infinity;
  const tailAlpha = (t: number) => (style.comet > 0 ? smooth((t - tailFrom) / (style.comet * 0.7)) : 1);

  const gs = 0.25;
  const body = new Mask(W, H, !!style.color2);
  const core = new Mask(W, H);
  const glow = new Mask(Math.ceil(W * gs) + 1, Math.ceil(H * gs) + 1);

  // Far segments first is irrelevant with max compositing; the nearer (more opaque) one wins.
  for (let i = 1; i < px.length; i++) {
    const ta = tailAlpha(pt[i]);
    if (ta <= 0.002) continue;
    const ax = px[i - 1] - bx;
    const ay = py[i - 1] - by;
    const cx = px[i] - bx;
    const cy = py[i] - by;
    const al = pa[i] * ta * riseAlpha(pd[i]);
    segment(body, ax, ay, cx, cy, pw[i], al * 0.9, along(pd[i - 1]), along(pd[i]));
    segment(core, ax, ay, cx, cy, pw[i] * 0.3, al);
    segment(glow, ax * gs, ay * gs, cx * gs, cy * gs, pw[i] * 2.2 * gs, al);
  }
  const hx = px[px.length - 1] - bx;
  const hy = py[py.length - 1] - by;
  const hw = pw[pw.length - 1];
  if (style.ballHead && !landed && px.length >= 2) {
    disc(core, hx, hy, Math.max(2, hw * 0.7), 1);
    disc(glow, hx * gs, hy * gs, Math.max(2, hw * 1.6) * gs, 1);
  }
  if (flash) {
    const k = s / 0.2;
    const r = g.w0 * (3 + 14 * k);
    const v = (1 - k) * 0.95;
    disc(core, g.anchor.x - bx, g.anchor.y - by, r * 0.35, v);
    disc(glow, (g.anchor.x - bx) * gs, (g.anchor.y - by) * gs, r * gs, v);
  }
  if (style.landingMarker && landed) {
    const after = s - g.landT;
    const grow = smooth(after / 0.5);
    const lx = g.x[g.x.length - 1] - bx;
    const ly = g.y[g.y.length - 1] - by;
    const lw = g.w[g.w.length - 1];
    const rr = Math.max(4, lw * (2 + 5 * grow));
    ringEllipse(body, lx, ly, rr, Math.max(1, lw * 0.6), 0.9);
    disc(core, lx, ly, Math.max(1.5, lw * 0.8), 1);
    disc(glow, lx * gs, ly * gs, Math.max(2, lw * 2) * gs, 0.8);
  }

  blur(glow, Math.max(2, g.w0 * 2.6) * gs);

  const c1 = hexRgb(style.color);
  const c2 = style.color2 ? hexRgb(style.color2) : c1;
  const glowK = style.glow;
  const data = new Uint8ClampedArray(W * H * 4);
  let any = false;
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const i = yy * W + xx;
      const ag = sample(glow, (xx + 0.5) * gs, (yy + 0.5) * gs) * glowK * fade;
      const ab = body.v[i] * fade;
      const ac = core.v[i] * fade;
      if (ag < 1 / 512 && ab === 0 && ac === 0) continue;
      const f = body.attr ? body.attr[i] : 0;
      const r = c1[0] + (c2[0] - c1[0]) * f;
      const gC = c1[1] + (c2[1] - c1[1]) * f;
      const b = c1[2] + (c2[2] - c1[2]) * f;
      let a = ag;
      let cr = ag * r;
      let cg = ag * gC;
      let cb = ag * b;
      cr = cr * (1 - ab) + ab * r;
      cg = cg * (1 - ab) + ab * gC;
      cb = cb * (1 - ab) + ab * b;
      a = a * (1 - ab) + ab;
      const kr = r + (255 - r) * style.core;
      const kg = gC + (255 - gC) * style.core;
      const kb = b + (255 - b) * style.core;
      cr = cr * (1 - ac) + ac * kr;
      cg = cg * (1 - ac) + ac * kg;
      cb = cb * (1 - ac) + ac * kb;
      a = a * (1 - ac) + ac;
      if (a <= 0) continue;
      const o = i * 4;
      data[o] = Math.round(cr / a);
      data[o + 1] = Math.round(cg / a);
      data[o + 2] = Math.round(cb / a);
      data[o + 3] = Math.round(Math.min(1, a) * 255);
      any = true;
    }
  }
  return any ? { x: bx, y: by, w: W, h: H, data } : null;
}

/** Landing ring seen in perspective: an ellipse flattened to sit on the ground. */
function ringEllipse(m: Mask, x: number, y: number, radius: number, width: number, value: number): void {
  ellipseRing(m, x, y, radius, radius * 0.38, width, value);
}
