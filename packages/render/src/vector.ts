/**
 * Deterministic 2D vector rendering in plain TypeScript: paths (lines, quadratic/cubic
 * curves, arcs), anti-aliased fills (signed-area accumulation), strokes, blurred shadows,
 * images and clipping, composited into a premultiplied float surface.
 *
 * Why not Canvas 2D? Browsers and the exporter's Skia build rasterise text and shadows
 * differently. Doing it ourselves makes the preview and the exported video pixel-identical.
 */
import { Mask, blur, segment } from './raster';

export type Mat = readonly [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  // m ∘ n: apply n first, then m (canvas-style transform stacking).
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleM = (s: number, t = s): Mat => [s, 0, 0, t, 0, 0];
export const rotate = (rad: number): Mat => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(c: string, alpha = 1): RGBA {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1, 7), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: alpha };
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: (p[3] ?? 1) * alpha };
  }
  return { r: 0, g: 0, b: 0, a: alpha };
}

// ---------------------------------------------------------------------------------------------
// Paths (flattened to polylines in device space as they are built)

export class Path {
  readonly subpaths: number[][] = [];
  private cur: number[] | null = null;
  private lx = 0;
  private ly = 0;
  private sx = 0;
  private sy = 0;
  constructor(readonly m: Mat = IDENTITY) {}

  private tx(x: number, y: number): [number, number] {
    const m = this.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** Device-space scale factor, for curve flattening tolerance. */
  private get scale(): number {
    return Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2])) || 1;
  }

  moveTo(x: number, y: number): this {
    const [X, Y] = this.tx(x, y);
    this.cur = [X, Y];
    this.subpaths.push(this.cur);
    this.lx = this.sx = x;
    this.ly = this.sy = y;
    return this;
  }

  lineTo(x: number, y: number): this {
    if (!this.cur) return this.moveTo(x, y);
    const [X, Y] = this.tx(x, y);
    this.cur.push(X, Y);
    this.lx = x;
    this.ly = y;
    return this;
  }

  quadTo(cx: number, cy: number, x: number, y: number): this {
    if (!this.cur) this.moveTo(cx, cy);
    const x0 = this.lx;
    const y0 = this.ly;
    const len = (Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy)) * this.scale;
    const n = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(len) * 1.2)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      this.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
    }
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    if (!this.cur) this.moveTo(c1x, c1y);
    const x0 = this.lx;
    const y0 = this.ly;
    const len = (Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y)) * this.scale;
    const n = Math.min(96, Math.max(2, Math.ceil(Math.sqrt(len) * 1.4)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      this.lineTo(
        u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      );
    }
    return this;
  }

  /** Elliptical arc around (cx, cy) from angle a0 to a1 (radians, clockwise in screen space). */
  ellipseArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, connect = true): this {
    const sweep = a1 - a0;
    const n = Math.min(128, Math.max(4, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(rx, ry) * this.scale) * 1.6)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const x = cx + rx * Math.cos(a);
      const y = cy + ry * Math.sin(a);
      if (i === 0 && (!connect || !this.cur)) this.moveTo(x, y);
      else this.lineTo(x, y);
    }
    return this;
  }

  close(): this {
    if (this.cur && this.cur.length >= 4) {
      const [X, Y] = this.tx(this.sx, this.sy);
      const n = this.cur.length;
      if (this.cur[n - 2] !== X || this.cur[n - 1] !== Y) this.cur.push(X, Y);
    }
    this.cur = null;
    this.lx = this.sx;
    this.ly = this.sy;
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.moveTo(x, y)
      .lineTo(x + w, y)
      .lineTo(x + w, y + h)
      .lineTo(x, y + h)
      .close();
  }

  roundRect(x: number, y: number, w: number, h: number, r: number): this {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (rr <= 0) return this.rect(x, y, w, h);
    const P = Math.PI;
    this.moveTo(x + rr, y);
    this.lineTo(x + w - rr, y);
    this.ellipseArc(x + w - rr, y + rr, rr, rr, -P / 2, 0);
    this.lineTo(x + w, y + h - rr);
    this.ellipseArc(x + w - rr, y + h - rr, rr, rr, 0, P / 2);
    this.lineTo(x + rr, y + h);
    this.ellipseArc(x + rr, y + h - rr, rr, rr, P / 2, P);
    this.lineTo(x, y + rr);
    this.ellipseArc(x + rr, y + rr, rr, rr, P, (3 * P) / 2);
    return this.close();
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    this.ellipseArc(cx, cy, rx, ry, 0, Math.PI * 2, false);
    return this.close();
  }

  bounds(): Rect | null {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const sp of this.subpaths) {
      for (let i = 0; i < sp.length; i += 2) {
        if (sp[i] < x1) x1 = sp[i];
        if (sp[i] > x2) x2 = sp[i];
        if (sp[i + 1] < y1) y1 = sp[i + 1];
        if (sp[i + 1] > y2) y2 = sp[i + 1];
      }
    }
    return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Coverage masks positioned on the surface

export interface Coverage {
  x: number;
  y: number;
  m: Mask;
}

/** Non-zero fill coverage via signed-area accumulation (the font-rs method). */
export function fillCoverage(path: Path, clipW: number, clipH: number): Coverage | null {
  const b = path.bounds();
  if (!b) return null;
  const x0 = Math.max(0, Math.floor(b.x) - 1);
  const y0 = Math.max(0, Math.floor(b.y) - 1);
  const x1 = Math.min(clipW, Math.ceil(b.x + b.w) + 2);
  const y1 = Math.min(clipH, Math.ceil(b.y + b.h) + 2);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const acc = new Float32Array((w + 2) * h);
  const stride = w + 2;
  for (const sp of path.subpaths) {
    const n = sp.length;
    if (n < 4) continue;
    for (let i = 0; i < n; i += 2) {
      const ax = sp[i] - x0;
      const ay = sp[i + 1] - y0;
      const j = (i + 2) % n;
      const bx = sp[j] - x0;
      const by = sp[j + 1] - y0;
      accumulateLine(acc, stride, h, ax, ay, bx, by);
    }
  }
  const m = new Mask(w, h);
  for (let y = 0; y < h; y++) {
    let a = 0;
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      a += acc[row + x];
      const c = Math.abs(a);
      m.v[y * w + x] = c > 1 ? 1 : c;
    }
  }
  return { x: x0, y: y0, m };
}

function accumulateLine(acc: Float32Array, stride: number, h: number, ax: number, ay: number, bx: number, by: number): void {
  if (Math.abs(ay - by) <= 1e-9) return;
  const w = stride - 2;
  let dir = 1;
  let p0x = ax;
  let p0y = ay;
  let p1x = bx;
  let p1y = by;
  if (ay > by) {
    dir = -1;
    p0x = bx;
    p0y = by;
    p1x = ax;
    p1y = ay;
  }
  const dxdy = (p1x - p0x) / (p1y - p0y);
  let x = p0x;
  if (p0y < 0) x -= p0y * dxdy;
  const yStart = Math.max(0, Math.floor(p0y));
  const yEnd = Math.min(h, Math.ceil(p1y));
  for (let y = yStart; y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, p1y) - Math.max(y, p0y);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    // Horizontal clamping keeps the winding contribution for parts outside the region.
    let x0 = x < xnext ? x : xnext;
    let x1 = x < xnext ? xnext : x;
    x0 = x0 < 0 ? 0 : x0 > w ? w : x0;
    x1 = x1 < 0 ? 0 : x1 > w ? w : x1;
    const x0floor = Math.floor(x0);
    const x0i = x0floor;
    const x1ceil = Math.ceil(x1);
    const x1i = x1ceil;
    if (x1i <= x0i + 1) {
      const xm = Math.min(w, Math.max(0, 0.5 * (x + xnext)));
      const xmf = xm - x0floor;
      acc[row + x0i] += d - d * xmf;
      acc[row + x0i + 1] += d * xmf;
    } else {
      const sInv = 1 / (x1 - x0);
      const x0f = x0 - x0floor;
      const a0 = 0.5 * sInv * (1 - x0f) * (1 - x0f);
      const x1f = x1 - x1ceil + 1;
      const am = 0.5 * sInv * x1f * x1f;
      acc[row + x0i] += d * a0;
      if (x1i === x0i + 2) {
        acc[row + x0i + 1] += d * (1 - a0 - am);
      } else {
        const a1 = sInv * (1.5 - x0f);
        acc[row + x0i + 1] += d * (a1 - a0);
        for (let xi = x0i + 2; xi < x1i - 1; xi++) acc[row + xi] += d * sInv;
        const a2 = a1 + (x1i - x0i - 3) * sInv;
        acc[row + x1i - 1] += d * (1 - a2 - am);
      }
      acc[row + x1i] += d * am;
    }
    x = xnext;
  }
}

/** Stroke coverage: round-capped capsules per segment with max compositing (uniform alpha). */
export function strokeCoverage(path: Path, width: number, clipW: number, clipH: number, dash?: readonly number[], closed = false): Coverage | null {
  const b = path.bounds();
  if (!b) return null;
  const pad = width / 2 + 2;
  const x0 = Math.max(0, Math.floor(b.x - pad));
  const y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(clipW, Math.ceil(b.x + b.w + pad));
  const y1 = Math.min(clipH, Math.ceil(b.y + b.h + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  const m = new Mask(x1 - x0, y1 - y0);
  for (const sp of path.subpaths) {
    const pts = closed && sp.length >= 4 ? [...sp, sp[0], sp[1]] : sp;
    if (!dash || dash.length < 2) {
      for (let i = 2; i < pts.length; i += 2) segment(m, pts[i - 2] - x0, pts[i - 1] - y0, pts[i] - x0, pts[i + 1] - y0, width, 1);
      continue;
    }
    let on = true;
    let k = 0;
    let left = dash[0];
    for (let i = 2; i < pts.length; i += 2) {
      let ax = pts[i - 2];
      let ay = pts[i - 1];
      const bx = pts[i];
      const by = pts[i + 1];
      let len = Math.hypot(bx - ax, by - ay);
      while (len > 0) {
        const step = Math.min(left, len);
        const u = step / len;
        const cx = ax + (bx - ax) * u;
        const cy = ay + (by - ay) * u;
        if (on) segment(m, ax - x0, ay - y0, cx - x0, cy - y0, width, 1);
        ax = cx;
        ay = cy;
        len -= step;
        left -= step;
        if (left <= 1e-9) {
          on = !on;
          k = (k + 1) % dash.length;
          left = dash[k];
        }
      }
    }
  }
  return { x: x0, y: y0, m };
}

export function unionCoverage(list: (Coverage | null)[]): Coverage | null {
  const items = list.filter((c): c is Coverage => !!c);
  if (!items.length) return null;
  const x0 = Math.min(...items.map((c) => c.x));
  const y0 = Math.min(...items.map((c) => c.y));
  const x1 = Math.max(...items.map((c) => c.x + c.m.w));
  const y1 = Math.max(...items.map((c) => c.y + c.m.h));
  const m = new Mask(x1 - x0, y1 - y0);
  for (const c of items) {
    for (let y = 0; y < c.m.h; y++) {
      for (let x = 0; x < c.m.w; x++) {
        const v = c.m.v[y * c.m.w + x];
        const i = (y + c.y - y0) * m.w + (x + c.x - x0);
        if (v > m.v[i]) m.v[i] = v;
      }
    }
  }
  return { x: x0, y: y0, m };
}

// ---------------------------------------------------------------------------------------------
// Surface: premultiplied RGBA floats (0..1)

export class Surface {
  readonly w: number;
  readonly h: number;
  readonly px: Float32Array;
  dirty: Rect | null = null;
  /** Optional clip coverage applied to every draw. */
  clip: Coverage | null = null;

  constructor(w: number, h: number) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.px = new Float32Array(this.w * this.h * 4);
  }

  clear(): void {
    const d = this.dirty;
    if (!d) return;
    for (let y = d.y; y < d.y + d.h; y++) this.px.fill(0, (y * this.w + d.x) * 4, (y * this.w + d.x + d.w) * 4);
    this.dirty = null;
  }

  private mark(x: number, y: number, w: number, h: number): void {
    const x1 = Math.max(0, x);
    const y1 = Math.max(0, y);
    const x2 = Math.min(this.w, x + w);
    const y2 = Math.min(this.h, y + h);
    if (x2 <= x1 || y2 <= y1) return;
    if (!this.dirty) this.dirty = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    else {
      const d = this.dirty;
      const nx = Math.min(d.x, x1);
      const ny = Math.min(d.y, y1);
      this.dirty = { x: nx, y: ny, w: Math.max(d.x + d.w, x2) - nx, h: Math.max(d.y + d.h, y2) - ny };
    }
  }

  private clipAt(x: number, y: number): number {
    const c = this.clip;
    if (!c) return 1;
    const lx = x - c.x;
    const ly = y - c.y;
    if (lx < 0 || ly < 0 || lx >= c.m.w || ly >= c.m.h) return 0;
    return c.m.v[ly * c.m.w + lx];
  }

  /** Source-over a solid colour through a coverage mask. */
  paint(cov: Coverage | null, color: RGBA, dx = 0, dy = 0): void {
    if (!cov || color.a <= 0) return;
    const { m } = cov;
    const ox = cov.x + dx;
    const oy = cov.y + dy;
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const px = this.px;
    let any = false;
    for (let y = 0; y < m.h; y++) {
      const sy = oy + y;
      if (sy < 0 || sy >= this.h) continue;
      for (let x = 0; x < m.w; x++) {
        const sx = ox + x;
        if (sx < 0 || sx >= this.w) continue;
        let a = m.v[y * m.w + x];
        if (a <= 0) continue;
        a *= color.a;
        if (this.clip) a *= this.clipAt(sx, sy);
        if (a <= 0) continue;
        const i = (sy * this.w + sx) * 4;
        const k = 1 - a;
        px[i] = r * a + px[i] * k;
        px[i + 1] = g * a + px[i + 1] * k;
        px[i + 2] = b * a + px[i + 2] * k;
        px[i + 3] = a + px[i + 3] * k;
        any = true;
      }
    }
    if (any) this.mark(ox, oy, m.w, m.h);
  }

  /** Composite a straight-alpha RGBA byte region (e.g. the tracer). */
  blitRGBA(x0: number, y0: number, w: number, h: number, data: Uint8ClampedArray, alpha = 1): void {
    const px = this.px;
    for (let y = 0; y < h; y++) {
      const sy = y0 + y;
      if (sy < 0 || sy >= this.h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x0 + x;
        if (sx < 0 || sx >= this.w) continue;
        const j = (y * w + x) * 4;
        let a = (data[j + 3] / 255) * alpha;
        if (a <= 0) continue;
        if (this.clip) a *= this.clipAt(sx, sy);
        const i = (sy * this.w + sx) * 4;
        const k = 1 - a;
        px[i] = (data[j] / 255) * a + px[i] * k;
        px[i + 1] = (data[j + 1] / 255) * a + px[i + 1] * k;
        px[i + 2] = (data[j + 2] / 255) * a + px[i + 2] * k;
        px[i + 3] = a + px[i + 3] * k;
      }
    }
    this.mark(x0, y0, w, h);
  }

  /** Draws an RGBA image (straight alpha) mapped to the unit square by `m` (image px → device). */
  drawImage(img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }, m: Mat, alpha = 1, clipCov: Coverage | null = null): void {
    const W = img.width;
    const H = img.height;
    if (!W || !H) return;
    const corners = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const x1 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const y1 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const x2 = Math.min(this.w, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y2 = Math.min(this.h, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return;
    // Inverse transform: device → image.
    const ia = m[3] / det;
    const ib = -m[1] / det;
    const ic = -m[2] / det;
    const id = m[0] / det;
    const ie = -(ia * m[4] + ic * m[5]);
    const iff = -(ib * m[4] + id * m[5]);
    const d = img.data;
    const px = this.px;
    // Down-scaled images: average a small footprint to avoid aliasing.
    const minify = Math.max(1, Math.sqrt(1 / Math.abs(det)));
    const taps = minify > 1.5 ? Math.min(4, Math.ceil(minify)) : 1;
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        for (let ty = 0; ty < taps; ty++) {
          for (let tx = 0; tx < taps; tx++) {
            const dx = x + (tx + 0.5) / taps;
            const dy = y + (ty + 0.5) / taps;
            const u = ia * dx + ic * dy + ie - 0.5;
            const v = ib * dx + id * dy + iff - 0.5;
            if (u < -0.5 || v < -0.5 || u > W - 0.5 || v > H - 0.5) continue;
            const u0 = Math.floor(u);
            const v0 = Math.floor(v);
            const fu = u - u0;
            const fv = v - v0;
            for (let k = 0; k < 4; k++) {
              const uu = Math.min(W - 1, Math.max(0, u0 + (k & 1)));
              const vv = Math.min(H - 1, Math.max(0, v0 + (k >> 1)));
              const wgt = (k & 1 ? fu : 1 - fu) * (k >> 1 ? fv : 1 - fv);
              const j = (vv * W + uu) * 4;
              const a = (d[j + 3] / 255) * wgt;
              sr += (d[j] / 255) * a;
              sg += (d[j + 1] / 255) * a;
              sb += (d[j + 2] / 255) * a;
              sa += a;
            }
          }
        }
        const n = taps * taps;
        let a = (sa / n) * alpha;
        if (a <= 0) continue;
        let c = 1;
        if (clipCov) {
          const lx = x - clipCov.x;
          const ly = y - clipCov.y;
          c = lx < 0 || ly < 0 || lx >= clipCov.m.w || ly >= clipCov.m.h ? 0 : clipCov.m.v[ly * clipCov.m.w + lx];
        }
        if (this.clip) c *= this.clipAt(x, y);
        a *= c;
        if (a <= 0) continue;
        const k = 1 - a;
        const scale = (alpha * c) / n;
        const i = (y * this.w + x) * 4;
        px[i] = sr * scale + px[i] * k;
        px[i + 1] = sg * scale + px[i + 1] * k;
        px[i + 2] = sb * scale + px[i + 2] * k;
        px[i + 3] = a + px[i + 3] * k;
      }
    }
    this.mark(x1, y1, x2 - x1, y2 - y1);
  }

  /** Straight-alpha 8-bit RGBA of a region (default: the dirty rect). */
  toRGBA(r: Rect | null = this.dirty, out?: Uint8ClampedArray): { rect: Rect; data: Uint8ClampedArray } | null {
    if (!r) return null;
    const data = out ?? new Uint8ClampedArray(r.w * r.h * 4);
    const px = this.px;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * this.w + (r.x + x)) * 4;
        const o = (y * r.w + x) * 4;
        const a = px[i + 3];
        if (a <= 0) {
          data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
          continue;
        }
        data[o] = Math.round((px[i] / a) * 255);
        data[o + 1] = Math.round((px[i + 1] / a) * 255);
        data[o + 2] = Math.round((px[i + 2] / a) * 255);
        data[o + 3] = Math.round(a * 255);
      }
    }
    return { rect: r, data };
  }
}

/** Shadow: blurred, offset copy of a coverage mask painted in a colour. */
export function paintShadow(s: Surface, cov: Coverage | null, color: RGBA, blurPx: number, dx: number, dy: number): void {
  if (!cov) return;
  const pad = Math.ceil(blurPx * 2 + 2);
  const m = new Mask(cov.m.w + pad * 2, cov.m.h + pad * 2);
  for (let y = 0; y < cov.m.h; y++) for (let x = 0; x < cov.m.w; x++) m.v[(y + pad) * m.w + x + pad] = cov.m.v[y * cov.m.w + x];
  blur(m, blurPx / 2);
  s.paint({ x: cov.x - pad + Math.round(dx), y: cov.y - pad + Math.round(dy), m }, color);
}
