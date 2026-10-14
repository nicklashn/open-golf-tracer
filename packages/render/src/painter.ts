/** A small Canvas-like drawing API on top of the deterministic Surface. */
import { blur } from './raster';
import { fontMetrics, measureText, textPath, type TextStyle } from './text';
import {
  IDENTITY,
  Path,
  fillCoverage,
  mul,
  paintShadow,
  parseColor,
  rotate,
  scaleM,
  strokeCoverage,
  translate,
  unionCoverage,
  type Coverage,
  type Mat,
  type Surface,
} from './vector';

export interface Shadow {
  color: string;
  /** Blur radius in local units. */
  blur: number;
  dx?: number;
  dy?: number;
}

export interface ImageData8 {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export class Painter {
  m: Mat = IDENTITY;
  alpha = 1;
  private stack: { m: Mat; alpha: number; clip: Coverage | null }[] = [];

  constructor(readonly s: Surface) {}

  save(): void {
    this.stack.push({ m: this.m, alpha: this.alpha, clip: this.s.clip });
  }

  restore(): void {
    const st = this.stack.pop();
    if (st) {
      this.m = st.m;
      this.alpha = st.alpha;
      this.s.clip = st.clip;
    }
  }

  translate(x: number, y: number): void {
    this.m = mul(this.m, translate(x, y));
  }

  rotate(rad: number): void {
    this.m = mul(this.m, rotate(rad));
  }

  scale(sx: number, sy = sx): void {
    this.m = mul(this.m, scaleM(sx, sy));
  }

  /** Average linear scale of the current transform. */
  get unit(): number {
    return Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2])) || 1;
  }

  path(): Path {
    return new Path(this.m);
  }

  private shadowOf(cov: Coverage | null, sh?: Shadow): void {
    if (!sh || !cov) return;
    const u = this.unit;
    paintShadow(this.s, cov, parseColor(sh.color, this.alpha), sh.blur * u, (sh.dx ?? 0) * u, (sh.dy ?? 0) * u);
  }

  fill(p: Path, color: string, opts: { alpha?: number; shadow?: Shadow } = {}): void {
    const cov = fillCoverage(p, this.s.w, this.s.h);
    this.shadowOf(cov, opts.shadow);
    this.s.paint(cov, parseColor(color, this.alpha * (opts.alpha ?? 1)));
  }

  stroke(p: Path, width: number, color: string, opts: { alpha?: number; dash?: number[]; closed?: boolean; shadow?: Shadow } = {}): void {
    const u = this.unit;
    const cov = strokeCoverage(
      p,
      Math.max(0.5, width * u),
      this.s.w,
      this.s.h,
      opts.dash?.map((d) => d * u),
      opts.closed,
    );
    this.shadowOf(cov, opts.shadow);
    this.s.paint(cov, parseColor(color, this.alpha * (opts.alpha ?? 1)));
  }

  /** Fill and stroke sharing one shadow (e.g. an arrow's shaft and head). */
  group(parts: { path: Path; fill?: string; stroke?: { width: number; color: string; dash?: number[] } }[], shadow?: Shadow): void {
    const u = this.unit;
    const covs = parts.map((p) =>
      p.stroke
        ? strokeCoverage(
            p.path,
            Math.max(0.5, p.stroke.width * u),
            this.s.w,
            this.s.h,
            p.stroke.dash?.map((d) => d * u),
          )
        : fillCoverage(p.path, this.s.w, this.s.h),
    );
    this.shadowOf(unionCoverage(covs), shadow);
    parts.forEach((p, i) => this.s.paint(covs[i], parseColor(p.stroke ? p.stroke.color : (p.fill ?? '#ffffff'), this.alpha)));
  }

  measure(text: string, st: TextStyle): number {
    return measureText(text, st);
  }

  metrics(st: TextStyle) {
    return fontMetrics(st);
  }

  text(text: string, x: number, y: number, st: TextStyle & { color: string; align?: 'left' | 'center' | 'right'; shadow?: Shadow }): void {
    if (!text) return;
    const w = measureText(text, st);
    const x0 = st.align === 'center' ? x - w / 2 : st.align === 'right' ? x - w : x;
    const p = textPath(text, x0, y, st, this.m);
    this.fill(p, st.color, { shadow: st.shadow });
  }

  /** Rectangle clip in local coordinates (combined with any clip already active). */
  clipRect(x: number, y: number, w: number, h: number): void {
    const cov = fillCoverage(this.path().rect(x, y, w, h), this.s.w, this.s.h);
    this.s.clip = this.s.clip && cov ? intersect(this.s.clip, cov) : (cov ?? emptyClip());
  }

  image(img: ImageData8, x: number, y: number, w: number, h: number, radius = 0): void {
    const m = mul(this.m, mul(translate(x, y), scaleM(w / img.width, h / img.height)));
    const clip = radius > 0 ? fillCoverage(this.path().roundRect(x, y, w, h, radius), this.s.w, this.s.h) : null;
    this.s.drawImage(img, m, this.alpha, clip);
  }
}

function emptyClip(): Coverage {
  return { x: 0, y: 0, m: { w: 1, h: 1, v: new Float32Array(1), attr: null } as never };
}

function intersect(a: Coverage, b: Coverage): Coverage {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.m.w, b.x + b.m.w);
  const y1 = Math.min(a.y + a.m.h, b.y + b.m.h);
  if (x1 <= x0 || y1 <= y0) return emptyClip();
  const w = x1 - x0;
  const h = y1 - y0;
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      v[y * w + x] = a.m.v[(y + y0 - a.y) * a.m.w + (x + x0 - a.x)] * b.m.v[(y + y0 - b.y) * b.m.w + (x + x0 - b.x)];
    }
  }
  return { x: x0, y: y0, m: { w, h, v, attr: null } as never };
}

export { blur };
