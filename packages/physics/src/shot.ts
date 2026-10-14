/** Shot-level helpers on top of the model: effective anchor, handles, stats and refit. */
import type { Shot } from '@golf/schema';
import { fitConstrained, type Constraints, type FitResult } from './fit';
import { MAX_FLIGHT, apexIndex, project, projectSim, simulate, stats, type FlightStats, type Projection, type Vec2 } from './model';

type ShotLike = Pick<Shot, 'params' | 'camera' | 'anchor' | 'constraints' | 'track' | 'impactTime' | 'slowmo' | 'timing'> & Partial<Pick<Shot, 'club'>>;

export function shotAnchor(shot: Pick<Shot, 'anchor' | 'constraints'>): Vec2 {
  return shot.constraints.start ?? shot.anchor;
}

export function shotProjection(shot: ShotLike): Projection | null {
  return project(shot.params, shot.camera, shotAnchor(shot), true);
}

export function shotStats(shot: ShotLike): FlightStats | null {
  return stats(shot.params, shot.camera, shotAnchor(shot));
}

export interface Handles {
  start: Vec2;
  apex: Vec2;
  landing: Vec2;
  /** Flight seconds of apex and landing. */
  apexT: number;
  landingT: number;
}

export function shotHandles(shot: ShotLike): Handles | null {
  const anchor = shotAnchor(shot);
  const sim = simulate(shot.params, shot.camera, anchor, MAX_FLIGHT, true);
  if (!sim) return null;
  const pr = projectSim(sim, shot.params, shot.camera);
  const k = apexIndex(sim, shot.params);
  const last = sim.n - 1;
  return {
    start: anchor,
    apex: { x: pr.u[k], y: pr.v[k] },
    landing: { x: pr.u[last], y: pr.v[last] },
    apexT: sim.t[k],
    landingT: sim.t[last],
  };
}

/** Converts the stored constraints (extra points in source seconds) to fit constraints. */
export function fitConstraints(shot: ShotLike): Constraints {
  const c = shot.constraints;
  return {
    apex: c.apex,
    landing: c.landing,
    carry: c.carry,
    curve: c.curve,
    flightTime: c.flightTime,
    // Extra points are stored with source-video time; the model wants real flight seconds.
    points: c.points.map((q) => ({ t: (q.t - shot.impactTime) / shot.slowmo, x: q.x, y: q.y })),
  };
}

export interface RefitOptions {
  fps: number;
  longSide: number;
  /** Use the tracked points as soft evidence (default true). */
  useTrack?: boolean;
  maxIterations?: number;
  timeBudgetMs?: number;
  /** Start from these params instead of the shot's current ones. */
  from?: readonly number[];
  maxTrackPoints?: number;
  lambda?: number;
  reference?: readonly number[];
}

export function refitShot(shot: ShotLike, opt: RefitOptions): FitResult {
  const sigma = Math.max(1.5, Math.max(3, 0.0035 * Math.hypot(shot.camera.cx * 2, shot.camera.cy * 2)) / 3);
  const track = opt.useTrack === false || !shot.track.t.length ? null : shot.track;
  return fitConstrained({
    params: opt.from ?? shot.params,
    camera: shot.camera,
    anchor: shotAnchor(shot),
    longSide: opt.longSide,
    fps: opt.fps,
    sigmaPx: sigma,
    constraints: fitConstraints(shot),
    track,
    club: shot.club,
    maxIterations: opt.maxIterations,
    timeBudgetMs: opt.timeBudgetMs,
    maxTrackPoints: opt.maxTrackPoints,
    lambda: opt.lambda,
    reference: opt.reference,
  });
}

/** Clicking the ball at a source time adds a point constraint at the matching flight time. */
export function flightSecondsAtSource(shot: Pick<Shot, 'impactTime' | 'slowmo'>, sourceTime: number): number {
  return (sourceTime - shot.impactTime) / shot.slowmo;
}
