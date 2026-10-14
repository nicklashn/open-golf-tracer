/**
 * Ballistic golf-ball flight, a TypeScript port of shottracer/physics.py.
 *
 * The ball starts on the ground at the address point. Its flight is simulated in 3D
 * (gravity, drag, backspin lift, sidespin curve) with explicit Euler steps of 1/240 s and
 * projected through a pinhole camera of unknown pitch, height and focal length.
 * Camera coordinates follow OpenCV: x right, y down, z forward.
 *
 * Keep this numerically identical to the Python version – parity is tested.
 */

export const G = 9.81;
export const KD = 0.0047;
export const DT = 1 / 240;
export const MAX_FLIGHT = 12;

export const PARAM_NAMES = ['V', 'theta', 'phi', 'kl', 'ks', 'pitch', 'log_h', 'log_f', 'dt0'] as const;
export type ParamName = (typeof PARAM_NAMES)[number];
export type Params = readonly number[];

export interface Camera {
  cx: number;
  cy: number;
}
export interface Vec2 {
  x: number;
  y: number;
}

export interface Simulation {
  /** Seconds since launch, one per step. */
  t: Float64Array;
  /** Camera-space positions, xyz interleaved. */
  P: Float64Array;
  n: number;
}

export interface Projection {
  t: Float64Array;
  u: Float64Array;
  v: Float64Array;
  z: Float64Array;
  n: number;
}

export function simulate(p: Params, cam: Camera, anchor: Vec2, tEnd: number, toGround = false): Simulation | null {
  const V = p[0];
  const th = p[1];
  const ph = p[2];
  const kl = p[3];
  const ks = p[4];
  const pitch = p[5];
  const h = Math.exp(p[6]);
  const f = Math.exp(p[7]);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const rx = (anchor.x - cam.cx) / f;
  const ry = (anchor.y - cam.cy) / f;
  const den = cp * ry + sp;
  if (den < 1e-3) return null; // the address ball would be above the horizon
  const z0 = h / den;
  let x = z0 * rx;
  let y = z0 * ry;
  let z = z0;
  const Fx = 0;
  const Fy = -sp;
  const Fz = cp;
  const Ux = 0;
  const Uy = -cp;
  const Uz = -sp;
  const cth = Math.cos(th);
  const sth = Math.sin(th);
  const cph = Math.cos(ph);
  const sph = Math.sin(ph);
  const hx = cph * Fx + sph;
  const hy = cph * Fy;
  const hz = cph * Fz;
  let vx = V * (cth * hx + sth * Ux);
  let vy = V * (cth * hy + sth * Uy);
  let vz = V * (cth * hz + sth * Uz);
  const gx = 0;
  const gy = G * cp;
  const gz = G * sp;
  const n = Math.floor(tEnd / DT) + 2;
  const P = new Float64Array(n * 3);
  P[0] = x;
  P[1] = y;
  P[2] = z;
  let k = 1;
  let t = 0;
  while (k < n) {
    const s = Math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-9;
    const ex = vx / s;
    const ey = vy / s;
    const ez = vz / s;
    const ud = Ux * ex + Uy * ey + Uz * ez;
    const nx = Ux - ud * ex;
    const ny = Uy - ud * ey;
    const nz = Uz - ud * ez;
    const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9;
    const sx = ey * Uz - ez * Uy;
    const sy = ez * Ux - ex * Uz;
    const sz = ex * Uy - ey * Ux;
    const sn = Math.sqrt(sx * sx + sy * sy + sz * sz) + 1e-9;
    const s2 = s * s;
    const lk = (kl * s2) / nn;
    const sk = (ks * s2) / sn;
    vx += (gx - KD * s * vx + lk * nx + sk * sx) * DT;
    vy += (gy - KD * s * vy + lk * ny + sk * sy) * DT;
    vz += (gz - KD * s * vz + lk * nz + sk * sz) * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;
    t += DT;
    P[3 * k] = x;
    P[3 * k + 1] = y;
    P[3 * k + 2] = z;
    k += 1;
    if (toGround && t > 0.1 && -(cp * y + sp * z) < -h) break;
  }
  const ts = new Float64Array(k);
  for (let i = 0; i < k; i++) ts[i] = i * DT;
  return { t: ts, P: P.subarray(0, 3 * k), n: k };
}

export function projectSim(sim: Simulation, p: Params, cam: Camera): Projection {
  const f = Math.exp(p[7]);
  const n = sim.n;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const zi = Math.max(sim.P[3 * i + 2], 1e-3);
    z[i] = zi;
    u[i] = cam.cx + (f * sim.P[3 * i]) / zi;
    v[i] = cam.cy + (f * sim.P[3 * i + 1]) / zi;
  }
  return { t: sim.t, u, v, z, n };
}

/** The whole flight (to landing) in image pixels, or null for an impossible camera. */
export function project(p: Params, cam: Camera, anchor: Vec2, toGround = true, tEnd = MAX_FLIGHT): Projection | null {
  const sim = simulate(p, cam, anchor, tEnd, toGround);
  return sim ? projectSim(sim, p, cam) : null;
}

/** Height above the ground (metres) of each simulated point. */
export function heights(sim: Simulation, p: Params): Float64Array {
  const sp = Math.sin(p[5]);
  const cp = Math.cos(p[5]);
  const h = Math.exp(p[6]);
  const out = new Float64Array(sim.n);
  for (let i = 0; i < sim.n; i++) out[i] = -(cp * sim.P[3 * i + 1] + sp * sim.P[3 * i + 2]) + h;
  return out;
}

export function apexIndex(sim: Simulation, p: Params): number {
  const sp = Math.sin(p[5]);
  const cp = Math.cos(p[5]);
  let best = 0;
  let bv = -Infinity;
  for (let i = 0; i < sim.n; i++) {
    const up = -(cp * sim.P[3 * i + 1] + sp * sim.P[3 * i + 2]);
    if (up > bv) {
      bv = up;
      best = i;
    }
  }
  return best;
}

/**
 * Exact ground crossing, interpolated between the last two steps. Unlike the last step
 * itself it moves smoothly with the parameters, which the fit's derivatives need.
 */
export function landing(sim: Simulation, p: Params, cam: Camera): { t: number; u: number; v: number; carry: number } {
  const sp = Math.sin(p[5]);
  const cp = Math.cos(p[5]);
  const h = Math.exp(p[6]);
  const f = Math.exp(p[7]);
  const n = sim.n;
  const P = sim.P;
  const height = (i: number) => -(cp * P[3 * i + 1] + sp * P[3 * i + 2]) + h;
  let a = 1;
  if (n >= 2) {
    const h0 = height(n - 2);
    const h1 = height(n - 1);
    if (h0 > 0 && h1 <= 0 && h0 !== h1) a = h0 / (h0 - h1);
  }
  const i0 = Math.max(0, n - 2);
  const i1 = n - 1;
  const lerp = (k: number) => P[3 * i0 + k] + (P[3 * i1 + k] - P[3 * i0 + k]) * (n >= 2 ? a : 1);
  const x = lerp(0);
  const y = lerp(1);
  const z = Math.max(lerp(2), 1e-3);
  const dx = x - P[0];
  const fwd = -sp * (y - P[1]) + cp * (z - P[2]);
  const t = n >= 2 ? sim.t[i0] + (sim.t[i1] - sim.t[i0]) * a : sim.t[i1];
  return { t, u: cam.cx + (f * x) / z, v: cam.cy + (f * y) / z, carry: Math.hypot(fwd, dx) };
}

/** Horizontal distance from start to the last simulated point (metres). */
export function carryOf(sim: Simulation, pitch: number): number {
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const last = 3 * (sim.n - 1);
  const dx = sim.P[last] - sim.P[0];
  const dy = sim.P[last + 1] - sim.P[1];
  const dz = sim.P[last + 2] - sim.P[2];
  const fwd = -sp * dy + cp * dz;
  return Math.hypot(fwd, dx);
}

export interface FlightStats {
  carryM: number;
  apexM: number;
  flightTimeS: number;
  ballSpeedMps: number;
  launchAngleDeg: number;
  /** Lateral metres at landing relative to the launch direction (+ = right). */
  curveM: number;
  cameraHeightM: number;
  cameraPitchDeg: number;
}

export function stats(p: Params, cam: Camera, anchor: Vec2): FlightStats | null {
  const sim = simulate(p, cam, anchor, MAX_FLIGHT, true);
  if (!sim) return null;
  const pitch = p[5];
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const last = 3 * (sim.n - 1);
  let apex = 0;
  for (let i = 0; i < sim.n; i++) {
    const dy = sim.P[3 * i + 1] - sim.P[1];
    const dz = sim.P[3 * i + 2] - sim.P[2];
    apex = Math.max(apex, -cp * dy - sp * dz);
  }
  const dx = sim.P[last] - sim.P[0];
  const dy = sim.P[last + 1] - sim.P[1];
  const dz = sim.P[last + 2] - sim.P[2];
  const fwd = -sp * dy + cp * dz;
  const right = dx;
  const phi = p[2];
  const lateral = -fwd * Math.sin(phi) + right * Math.cos(phi);
  return {
    carryM: Math.hypot(fwd, right),
    apexM: apex,
    flightTimeS: sim.t[sim.n - 1],
    ballSpeedMps: p[0],
    launchAngleDeg: (p[1] * 180) / Math.PI,
    curveM: lateral,
    cameraHeightM: Math.exp(p[6]),
    cameraPitchDeg: (pitch * 180) / Math.PI,
  };
}

export function bounds(f0: number, fps: number): { lo: number[]; hi: number[] } {
  const r = Math.PI / 180;
  return {
    lo: [15, 1 * r, -100 * r, 0, -0.005, -25 * r, Math.log(0.2), Math.log((0.3 * f0) / 0.75), -1.5 / fps],
    hi: [90, 60 * r, 100 * r, 0.008, 0.005, 40 * r, Math.log(3), Math.log((2.5 * f0) / 0.75), 1.5 / fps],
  };
}

export const CLUB_IDS = ['driver', 'wood', 'longIron', 'midIron', 'shortIron', 'wedge'] as const;
export type ClubId = (typeof CLUB_IDS)[number];
/** 'auto' (or null) means the club is unknown. */
export type Club = ClubId | 'auto';

/**
 * Typical launch per club in this model's terms: ball speed (m/s), launch angle (deg), lift kl.
 * Calibrated so carry/apex match good-amateur averages. Same table as CLUBS in physics.py.
 */
export const CLUBS: Record<ClubId, readonly [number, number, number]> = {
  driver: [67.0, 12.0, 0.00375],
  wood: [55.0, 13.0, 0.00525],
  longIron: [48.5, 15.0, 0.00625],
  midIron: [41.5, 18.0, 0.0075],
  shortIron: [36.5, 24.0, 0.0075],
  wedge: [30.5, 30.0, 0.0075],
};
const BY_SPEED = Object.values(CLUBS)
  .slice()
  .sort((a, b) => a[0] - b[0]);

/** numpy.interp over a small ascending table (clamped at the ends). */
function tableInterp(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (xs[i + 1] < x) i++;
  return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / (xs[i + 1] - xs[i]);
}

/**
 * Prior residuals on ball speed, launch angle and lift (mirrors launch_prior in physics.py).
 * With a club: its typical launch. Auto: speed is loose, but angle and lift must fit the speed
 * the way real clubs do, so a short track can't turn a 90 m wedge into a 140 m 7-iron.
 */
export function launchPrior(p: Params, club: Club | null | undefined): [number, number, number] {
  const r = Math.PI / 180;
  if (club && club !== 'auto') {
    const [v0, th0, kl0] = CLUBS[club];
    return [(p[0] - v0) / (0.15 * v0), (p[1] - th0 * r) / (5 * r), (p[3] - kl0) / 0.0015];
  }
  const vs = BY_SPEED.map((c) => c[0]);
  const th0 = tableInterp(
    p[0],
    vs,
    BY_SPEED.map((c) => c[1] * r),
  );
  const kl0 = tableInterp(
    p[0],
    vs,
    BY_SPEED.map((c) => c[2]),
  );
  return [(p[0] - 60) / 30, (p[1] - th0) / (8 * r), (p[3] - kl0) / 0.002];
}

/** A plausible shot when nothing was tracked: mid iron, or the club's typical launch (mirrors default_flight). */
export function defaultParams(longSide: number, direction = 0, club: Club | null = null): number[] {
  const [V, th, kl] = club && club !== 'auto' ? CLUBS[club] : [55, 16, 0.0035];
  return [V, (th * Math.PI) / 180, direction, kl, 0, (3 * Math.PI) / 180, Math.log(1.2), Math.log(0.75 * longSide), 0];
}

/** Linear interpolation of a sampled series at time tq (clamped), like numpy.interp. */
export function interp(tq: number, t: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = t.length;
  if (tq <= t[0]) return y[0];
  if (tq >= t[n - 1]) return y[n - 1];
  // Uniform steps (simulation) make this O(1); fall back to search otherwise.
  const step = (t[n - 1] - t[0]) / (n - 1);
  let i = Math.min(n - 2, Math.max(0, Math.floor((tq - t[0]) / step)));
  while (i > 0 && t[i] > tq) i--;
  while (i < n - 2 && t[i + 1] < tq) i++;
  const a = (tq - t[i]) / (t[i + 1] - t[i]);
  return y[i] + (y[i + 1] - y[i]) * a;
}
