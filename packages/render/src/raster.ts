/**
 * A tiny deterministic software rasteriser for the tracer.
 *
 * The tracer is drawn into float coverage buffers with *max* compositing: overlapping
 * segments never add up (no beads at joints), and where the descent passes behind the
 * ascent the nearer, more opaque segment wins. Doing this in plain TypeScript instead of
 * Canvas 2D makes the result bit-identical in the browser and in the Node exporter.
 */

export class Mask {
  readonly w: number;
  readonly h: number;
  readonly v: Float32Array;
  /** Optional per-pixel attribute of the winning segment (e.g. position along the flight). */
  readonly attr: Float32Array | null;

  constructor(w: number, h: number, withAttr = false) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.v = new Float32Array(this.w * this.h);
    this.attr = withAttr ? new Float32Array(this.w * this.h) : null;
  }

  clear(): void {
    this.v.fill(0);
    this.attr?.fill(0);
  }
}

/** Anti-aliased thick segment (round ends) with max compositing. */
export function segment(m: Mask, x0: number, y0: number, x1: number, y1: number, width: number, value: number, attr0 = 0, attr1 = 0): void {
  const half = width / 2;
  // Lines thinner than a pixel get proportionally less coverage instead of disappearing.
  const thin = Math.min(1, width);
  const r = Math.max(half, 0.5) + 1;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(m.w - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(m.h - 1, Math.ceil(Math.max(y0, y1) + r));
  if (minX > maxX || minY > maxY) return;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const hw = Math.max(half, 0.5);
  const buf = m.v;
  const at = m.attr;
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    const row = py * m.w;
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      let u = len2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const qx = x0 + u * dx - cx;
      const qy = y0 + u * dy - cy;
      const d = Math.sqrt(qx * qx + qy * qy);
      let c = hw + 0.5 - d;
      if (c <= 0) continue;
      if (c > 1) c = 1;
      const val = c * thin * value;
      const i = row + px;
      if (val > buf[i]) {
        buf[i] = val;
        if (at) at[i] = attr0 + (attr1 - attr0) * u;
      }
    }
  }
}

/** Filled anti-aliased disc with max compositing. */
export function disc(m: Mask, x: number, y: number, radius: number, value: number): void {
  const r = radius + 1;
  const minX = Math.max(0, Math.floor(x - r));
  const maxX = Math.min(m.w - 1, Math.ceil(x + r));
  const minY = Math.max(0, Math.floor(y - r));
  const maxY = Math.min(m.h - 1, Math.ceil(y + r));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      let c = radius + 0.5 - d;
      if (c <= 0) continue;
      if (c > 1) c = 1;
      const i = py * m.w + px;
      const val = c * value;
      if (val > m.v[i]) m.v[i] = val;
    }
  }
}

/** Anti-aliased ring (circle outline). */
export function ring(m: Mask, x: number, y: number, radius: number, width: number, value: number): void {
  const r = radius + width + 1;
  const minX = Math.max(0, Math.floor(x - r));
  const maxX = Math.min(m.w - 1, Math.ceil(x + r));
  const minY = Math.max(0, Math.floor(y - r));
  const maxY = Math.min(m.h - 1, Math.ceil(y + r));
  const hw = Math.max(width / 2, 0.5);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = Math.abs(Math.hypot(px + 0.5 - x, py + 0.5 - y) - radius);
      let c = hw + 0.5 - d;
      if (c <= 0) continue;
      if (c > 1) c = 1;
      const i = py * m.w + px;
      const val = c * value * Math.min(1, width);
      if (val > m.v[i]) m.v[i] = val;
    }
  }
}

/** In-place box blur (one pass each direction). Three passes approximate a Gaussian. */
function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * norm;
      const add = src[o + Math.min(w - 1, x + r + 1)];
      const sub = src[o + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      const add = src[Math.min(h - 1, y + r + 1) * w + x];
      const sub = src[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
}

/** Approximate Gaussian blur with standard deviation sigma (pixels). */
export function blur(m: Mask, sigma: number): void {
  if (sigma < 0.5) return;
  // Box sizes for three passes (Kovesi, "Fast almost-Gaussian filtering").
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const mm = Math.round(mIdeal);
  const tmp = new Float32Array(m.v.length);
  for (let i = 0; i < n; i++) {
    const r = ((i < mm ? wl : wu) - 1) / 2;
    boxBlurH(m.v, tmp, m.w, m.h, r);
    boxBlurV(tmp, m.v, m.w, m.h, r);
  }
}

/** Bilinear sample of a mask at fractional pixel coordinates (pixel centres at +0.5). */
export function sample(m: Mask, x: number, y: number): number {
  // No closures here: this runs once per pixel.
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const w1 = m.w - 1;
  const h1 = m.h - 1;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 > w1 ? w1 : x0;
  x1 = x1 < 0 ? 0 : x1 > w1 ? w1 : x1;
  y0 = y0 < 0 ? 0 : y0 > h1 ? h1 : y0;
  y1 = y1 < 0 ? 0 : y1 > h1 ? h1 : y1;
  const v = m.v;
  const a = v[y0 * m.w + x0] * (1 - ax) + v[y0 * m.w + x1] * ax;
  const b = v[y1 * m.w + x0] * (1 - ax) + v[y1 * m.w + x1] * ax;
  return a * (1 - ay) + b * ay;
}

/** Anti-aliased ellipse outline (distance via first-order approximation). */
export function ellipseRing(m: Mask, x: number, y: number, rx: number, ry: number, width: number, value: number): void {
  const r = Math.max(rx, ry) + width + 1;
  const minX = Math.max(0, Math.floor(x - r));
  const maxX = Math.min(m.w - 1, Math.ceil(x + r));
  const minY = Math.max(0, Math.floor(y - ry - width - 1));
  const maxY = Math.min(m.h - 1, Math.ceil(y + ry + width + 1));
  const hw = Math.max(width / 2, 0.5);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      const k = Math.hypot(dx / rx, dy / ry);
      const gx = dx / (rx * rx);
      const gy = dy / (ry * ry);
      const gn = Math.hypot(gx, gy) / Math.max(k, 1e-6);
      const d = gn > 0 ? Math.abs(k - 1) / gn : Math.abs(k - 1) * Math.min(rx, ry);
      let c = hw + 0.5 - d;
      if (c <= 0) continue;
      if (c > 1) c = 1;
      const i = py * m.w + px;
      const val = c * value * Math.min(1, width);
      if (val > m.v[i]) m.v[i] = val;
    }
  }
}
