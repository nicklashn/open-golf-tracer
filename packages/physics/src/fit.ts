/**
 * Live refit of a flight to the user's handles (start, apex, landing, extra points,
 * carry, curve, flight time) with Levenberg–Marquardt. Mirrors fit_constrained() in
 * shottracer/physics.py: same residual layout, priors and robust loss.
 */
import { MAX_FLIGHT, apexIndex, bounds, interp, landing, launchPrior, projectSim, simulate, type Camera, type Club, type Params, type Vec2 } from './model';

export const CONSTRAINT_PX = 0.5;
export const CURVE_KS = 0.003;
const DEG = Math.PI / 180;

export interface Constraints {
  apex?: Vec2 | null;
  landing?: Vec2 | null;
  /** Extra ball positions at given flight seconds. */
  points?: { t: number; x: number; y: number }[];
  carry?: number | null;
  /** -1 draw … +1 fade. */
  curve?: number | null;
  flightTime?: number | null;
}

export interface Track {
  t: ArrayLike<number>;
  u: ArrayLike<number>;
  v: ArrayLike<number>;
}

export interface FitInput {
  params: Params;
  camera: Camera;
  anchor: Vec2;
  longSide: number;
  fps: number;
  sigmaPx: number;
  constraints: Constraints;
  track?: Track | null;
  /** Known club narrows speed/launch/lift; 'auto' keeps them loosely coupled. */
  club?: Club | null;
  maxIterations?: number;
  /** Stop after this many milliseconds (keeps drags under one frame). */
  timeBudgetMs?: number;
  /** Use at most this many tracked points (evenly subsampled) – for live drags. */
  maxTrackPoints?: number;
  /** LM damping to start from (pass the previous result's `lambda` while dragging). */
  lambda?: number;
  /** Parameters the solution should stay close to (default: `params`). */
  reference?: Params;
}

export interface FitResult {
  params: number[];
  cost: number;
  iterations: number;
  evaluations: number;
  ms: number;
  rmsPx: number | null;
  lambda: number;
  converged: boolean;
}

function subsample(tr: Track, max: number): Track {
  const n = tr.t.length;
  if (n <= max) return tr;
  const t: number[] = [];
  const u: number[] = [];
  const v: number[] = [];
  for (let k = 0; k < max; k++) {
    const i = Math.round((k * (n - 1)) / (max - 1));
    t.push(tr.t[i]);
    u.push(tr.u[i]);
    v.push(tr.v[i]);
  }
  return { t, u, v };
}

function hasFull(c: Constraints): boolean {
  return !!(c.apex || c.landing || (c.points && c.points.length) || c.carry || c.flightTime);
}

/** Residuals for the user's handles (same order as Python). */
export function constraintResiduals(p: Params, cam: Camera, anchor: Vec2, c: Constraints, out: number[]): void {
  if (c.curve != null) out.push((p[4] - c.curve * CURVE_KS) / 0.0002);
  if (!hasFull(c)) return;
  const nTerms = (c.apex ? 2 : 0) + (c.landing ? 2 : 0) + 2 * (c.points?.length ?? 0) + (c.carry ? 1 : 0) + (c.flightTime ? 1 : 0);
  const sim = simulate(p, cam, anchor, MAX_FLIGHT, true);
  if (!sim) {
    for (let i = 0; i < nTerms; i++) out.push(50);
    return;
  }
  const pr = projectSim(sim, p, cam);
  if (c.apex) {
    const k = apexIndex(sim, p);
    out.push((pr.u[k] - c.apex.x) / CONSTRAINT_PX, (pr.v[k] - c.apex.y) / CONSTRAINT_PX);
  }
  const land = c.landing || c.carry || c.flightTime ? landing(sim, p, cam) : null;
  if (c.landing && land) {
    out.push((land.u - c.landing.x) / CONSTRAINT_PX, (land.v - c.landing.y) / CONSTRAINT_PX);
  }
  for (const q of c.points ?? []) {
    const tq = Math.min(Math.max(q.t, 0), sim.t[sim.n - 1]);
    out.push((interp(tq, sim.t, pr.u) - q.x) / CONSTRAINT_PX, (interp(tq, sim.t, pr.v) - q.y) / CONSTRAINT_PX);
  }
  if (c.carry && land) out.push((land.carry - c.carry) / (0.01 * c.carry));
  if (c.flightTime && land) out.push((land.t - c.flightTime) / 0.03);
}

const STAY = [20, 0.3, 0.3, 0.003, 0.002, 0.3, 0.5, 0.5, 1.0];

export function makeResiduals(input: FitInput): (p: Params) => number[] {
  const { camera: cam, anchor, constraints: con, fps, sigmaPx } = input;
  const f0 = 0.75 * input.longSide;
  const ref = Array.from(input.reference ?? input.params);
  const tr0 = input.track && input.track.t.length > 0 ? input.track : null;
  const tr = tr0 && input.maxTrackPoints ? subsample(tr0, input.maxTrackPoints) : tr0;
  let tEnd = 0;
  if (tr) for (let i = 0; i < tr.t.length; i++) tEnd = Math.max(tEnd, tr.t[i]);
  tEnd += 0.1;
  return (p: Params) => {
    const out: number[] = [];
    if (tr) {
      const n = tr.t.length;
      const sim = simulate(p, cam, anchor, tEnd + 2 / fps);
      if (!sim) {
        for (let i = 0; i < 3 * n; i++) out.push(50);
      } else {
        const f = Math.exp(p[7]);
        const sp = Math.sin(p[5]);
        const cp = Math.cos(p[5]);
        const h = Math.exp(p[6]);
        const T = sim.t[sim.n - 1];
        const ru: number[] = [];
        const rv: number[] = [];
        const under: number[] = [];
        // Component series for interpolation without allocating per point.
        const xs = new Float64Array(sim.n);
        const ys = new Float64Array(sim.n);
        const zs = new Float64Array(sim.n);
        for (let i = 0; i < sim.n; i++) {
          xs[i] = sim.P[3 * i];
          ys[i] = sim.P[3 * i + 1];
          zs[i] = sim.P[3 * i + 2];
        }
        for (let i = 0; i < n; i++) {
          const tq = Math.min(Math.max(tr.t[i] - p[8], 0), T);
          const x = interp(tq, sim.t, xs);
          const y = interp(tq, sim.t, ys);
          const z = Math.max(interp(tq, sim.t, zs), 1e-3);
          ru.push((cam.cx + (f * x) / z - tr.u[i]) / sigmaPx);
          rv.push((cam.cy + (f * y) / z - tr.v[i]) / sigmaPx);
          const height = -(cp * y + sp * z) + h;
          under.push(Math.min(height, 0) * 20);
        }
        // Tracked points may contain outliers: robust loss on them only, so the user's
        // handles (plain least squares) always win over contradicting track points.
        out.push(...robust(ru), ...robust(rv), ...under);
      }
    }
    out.push(
      ...launchPrior(p, input.club),
      con.curve == null ? p[4] / 0.0015 : 0,
      (p[5] - 3 * DEG) / (12 * DEG),
      (p[6] - Math.log(1.2)) / 0.4,
      (p[7] - Math.log(f0)) / 0.35,
      p[8] / (0.5 / fps),
    );
    for (let i = 0; i < 9; i++) out.push((0.3 * (p[i] - ref[i])) / STAY[i]);
    constraintResiduals(p, cam, anchor, con, out);
    return out;
  };
}

/** scipy's soft_l1 loss expressed as a residual transform, so plain LM minimises it. */
export function robust(r: number[], c = 1.5): number[] {
  const out = new Array<number>(r.length);
  for (let i = 0; i < r.length; i++) {
    const z = (r[i] / c) ** 2;
    out[i] = Math.sign(r[i]) * c * Math.sqrt(2 * (Math.sqrt(1 + z) - 1));
  }
  return out;
}

function sumSq(r: number[]): number {
  let s = 0;
  for (const x of r) s += x * x;
  return 0.5 * s;
}

/** Solves A x = b for a small dense SPD-ish system (Gaussian elimination, partial pivoting). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const STEP_SCALE = [1, 0.01, 0.01, 1e-4, 1e-4, 0.01, 0.01, 0.01, 1e-3];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function fitConstrained(input: FitInput): FitResult {
  const t0 = now();
  const { lo, hi } = bounds(0.75 * input.longSide, input.fps);
  const clip = (p: number[]) => p.map((x, i) => Math.min(Math.max(x, lo[i] + 1e-9), hi[i] - 1e-9));
  const R = makeResiduals(input);
  const F = R;
  let p = clip(Array.from(input.params));
  let r = F(p);
  let cost = sumSq(r);
  let evals = 1;
  let lambda = Math.min(Math.max(input.lambda ?? 1e-3, 1e-7), 1e2);
  let converged = false;
  const maxIt = input.maxIterations ?? 40;
  const budget = input.timeBudgetMs ?? Infinity;
  let it = 0;
  while (it < maxIt) {
    if (now() - t0 > budget) break;
    it++;
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(9).fill(0));
    for (let j = 0; j < 9; j++) {
      let h = 1e-4 * Math.max(Math.abs(p[j]), STEP_SCALE[j]);
      if (p[j] + h > hi[j]) h = -h; // step inside the bounds
      const q = p.slice();
      q[j] += h;
      const rq = F(q);
      evals++;
      for (let i = 0; i < m; i++) J[i][j] = (rq[i] - r[i]) / h;
    }
    const A: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const g = new Array<number>(9).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      const ri = r[i];
      for (let a = 0; a < 9; a++) {
        if (Ji[a] === 0) continue;
        g[a] += Ji[a] * ri;
        for (let b = a; b < 9; b++) A[a][b] += Ji[a] * Ji[b];
      }
    }
    for (let a = 0; a < 9; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    // Active set: parameters pinned at a bound whose gradient pushes outward stay fixed.
    const free: number[] = [];
    for (let a = 0; a < 9; a++) {
      const atLo = p[a] <= lo[a] + 1e-8 && g[a] > 0;
      const atHi = p[a] >= hi[a] - 1e-8 && g[a] < 0;
      if (!atLo && !atHi) free.push(a);
    }
    let improved = false;
    let rel = 0;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = free.map((a) => free.map((b) => (a === b ? A[a][b] + lambda * Math.max(A[a][b], 1e-9) : A[a][b])));
      const d = solve(
        Ad,
        free.map((a) => -g[a]),
      );
      if (d) {
        const step = p.slice();
        free.forEach((a, k) => (step[a] += d[k]));
        const pn = clip(step);
        const rn = F(pn);
        evals++;
        const cn = sumSq(rn);
        if (cn < cost) {
          rel = (cost - cn) / Math.max(cost, 1e-12);
          p = pn;
          r = rn;
          cost = cn;
          lambda = Math.max(lambda / 3, 1e-7);
          improved = true;
          break;
        }
      }
      lambda = Math.min(lambda * 4, 1e7);
      if (now() - t0 > budget) break;
    }
    if (!improved || rel < 1e-7) {
      converged = improved || lambda >= 1e7;
      if (!improved && lambda < 1e7) continue;
      break;
    }
  }
  // Hand back a moderate damping so the next drag update starts responsive.
  lambda = Math.min(lambda, 1e2);
  const tr = input.track;
  const rmsPx = tr && tr.t.length ? trackRms(p, input.camera, input.anchor, tr) : null;
  return { params: p, cost, iterations: it, evaluations: evals, ms: now() - t0, rmsPx, lambda, converged };
}

/** Root-mean-square image distance (px) between the flight and the tracked points. */
export function trackRms(p: Params, cam: Camera, anchor: Vec2, tr: Track): number | null {
  let tEnd = 0;
  for (let i = 0; i < tr.t.length; i++) tEnd = Math.max(tEnd, tr.t[i]);
  const sim = simulate(p, cam, anchor, tEnd + 0.2);
  if (!sim) return null;
  const pr = projectSim(sim, p, cam);
  const T = sim.t[sim.n - 1];
  let s = 0;
  for (let i = 0; i < tr.t.length; i++) {
    const tq = Math.min(Math.max(tr.t[i] - p[8], 0), T);
    s += (interp(tq, sim.t, pr.u) - tr.u[i]) ** 2 + (interp(tq, sim.t, pr.v) - tr.v[i]) ** 2;
  }
  return Math.sqrt(s / tr.t.length);
}
