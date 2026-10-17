/**
 * Two shots from different clips: one strike filmed by two cameras, the same player hitting again
 * (a retake), or two different strikes (a partner teeing off right after). Reads the round summary
 * only: the strike's sound signature, strike times, GPS, hole and flight.
 */
import type { GeoPoint } from '@golf/schema';
import type { ClipSummary, RoundSummary, ShotSummary } from './summary';

export type MatchVerdict = 'same' | 'retake' | 'different';
type Sound = NonNullable<ShotSummary['sound']>;

export interface ShotMatch {
  a: ShotSummary;
  b: ShotSummary;
  /** 0–1: how likely the two are one strike. */
  score: number;
  verdict: MatchVerdict;
  /** One strike, and sure enough to decide without asking. */
  sure: boolean;
  /** Sound signature similarity (0–1), when both have one. */
  sound: number | null;
  /** Seconds between the strikes, after a clock offset between the cameras. */
  dt: number | null;
  /** Metres between the two clips' GPS positions. */
  distM: number | null;
}

/** The same strike filmed by two cameras lands this close in time. */
export const SAME_SHOT_S = 1.5;
/** Retakes: the next shot on the same hole within this many seconds and close to the same spot. */
export const RETAKE_S = 180;
export const RETAKE_SPOT = 0.08;
/** From this score two shots are offered as one (a question); sure ones are decided. */
export const SAME_ASK = 0.7;
export const SAME_SURE = 0.9;
/** Sound similarity a sure match needs; such pairs also reveal a clock offset between cameras. */
export const SOUND_SURE = 0.75;
/** Clips filmed this close (metres) are from the same spot. */
const NEAR_M = 15;
/** Camera clocks can be this far apart (seconds). */
const MAX_OFFSET_S = 900;
const MAX_LAG_S = 0.15;
/** Frames from the impact frame on that hold the click itself (SIG_CLICK in shottracer/audio.py). */
const CLICK = [0, 2] as const;

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function pearson(u: number[], v: number[]): number {
  const n = u.length;
  const mu = u.reduce((x, y) => x + y, 0) / n;
  const mv = v.reduce((x, y) => x + y, 0) / n;
  let uv = 0;
  let uu = 0;
  let vv = 0;
  for (let i = 0; i < n; i++) {
    uv += (u[i] - mu) * (v[i] - mv);
    uu += (u[i] - mu) ** 2;
    vv += (v[i] - mv) ** 2;
  }
  return uu > 0 && vv > 0 ? uv / Math.sqrt(uu * vv) : 0;
}

const simCache = new WeakMap<Sound, WeakMap<Sound, number>>();

/**
 * Best correlation (0–1) of two sound signatures over small time shifts, leaving out both
 * clicks; the same as `signature_similarity` in shottracer/audio.py.
 */
export function soundSimilarity(a: Sound, b: Sound): number {
  const hit = simCache.get(a)?.get(b);
  if (hit !== undefined) return hit;
  let best = 0;
  if (a.bands.length === b.bands.length && a.rate === b.rate) {
    const m = Math.min(...a.bands.map((r) => r.length), ...b.bands.map((r) => r.length));
    const ia = Math.round(-a.start * a.rate);
    const ib = Math.round(-b.start * b.rate);
    const click = (k: number, i: number) => k >= i + CLICK[0] && k < i + CLICK[1];
    const lagN = Math.round(MAX_LAG_S * a.rate);
    for (let lag = -lagN; lag <= lagN; lag++) {
      const u: number[] = [];
      const v: number[] = [];
      for (let k = Math.max(0, lag); k < m + Math.min(0, lag); k++) {
        const j = k - lag;
        if (click(k, ia) || click(j, ib)) continue;
        for (let band = 0; band < a.bands.length; band++) {
          u.push(a.bands[band][k]);
          v.push(b.bands[band][j]);
        }
      }
      if (u.length >= 10) best = Math.max(best, pearson(u, v));
    }
  }
  if (!simCache.has(a)) simCache.set(a, new WeakMap());
  simCache.get(a)!.set(b, best);
  return best;
}

/** Metres between two GPS positions. */
export function geoDistance(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Seconds between the strikes by the camera clocks (or within one clip), unsigned. */
function rawGap(a: ShotSummary, b: ShotSummary): number | null {
  const ta = ms(a.at);
  const tb = ms(b.at);
  if (ta !== null && tb !== null) return Math.abs(tb - ta) / 1000;
  return a.clipId === b.clipId ? Math.abs(b.t - a.t) : null;
}

/**
 * Clock offsets (seconds) between cameras: strikes that sound alike lie this far apart by the
 * clocks. One such pair may be chance; an offset counts when two or more pairs agree on it.
 */
export function clockOffsets(s: RoundSummary): number[] {
  const d: number[] = [];
  for (let i = 0; i < s.shots.length; i++)
    for (let j = i + 1; j < s.shots.length; j++) {
      const a = s.shots[i];
      const b = s.shots[j];
      if (a.clipId === b.clipId || !a.sound || !b.sound || (a.hole && b.hole && a.hole !== b.hole)) continue;
      const gap = rawGap(a, b);
      if (gap !== null && gap <= MAX_OFFSET_S && soundSimilarity(a.sound, b.sound) >= SOUND_SURE) d.push(gap);
    }
  const out: number[] = [];
  for (const x of d) {
    const near = d.filter((y) => Math.abs(y - x) <= 0.5).sort((p, q) => p - q);
    const mid = near[Math.floor(near.length / 2)];
    if (near.length >= 2 && !out.some((o) => Math.abs(o - mid) <= 0.5)) out.push(mid);
  }
  return out;
}

/** +0.5 when two measures agree within 15 %, -1 when they are far apart. */
function agree(x: number | null, y: number | null): number {
  if (x === null || y === null || x <= 0 || y <= 0) return 0;
  const rel = Math.abs(x - y) / Math.max(x, y);
  return rel <= 0.15 ? 0.5 : rel > 0.4 ? -1 : 0;
}

const tracked = (x: ShotSummary) => x.trackPts >= 5 && !x.flags.includes('default_path') && !x.flags.includes('off_frame');

/**
 * Scores two shots. The log-odds of "one strike" start at -1 and add up the evidence: sound
 * signatures (±), strike times after the clock offset, GPS distance, hole and the fitted flights.
 * A same-clip pair is never one strike. Pairs that are not one strike are a retake when they are
 * on the same hole, minutes apart and hit from the same spot (seen from the same camera), else
 * different strikes – such as a partner on the same tee.
 */
export function compareShots(a: ShotSummary, b: ShotSummary, clipA: ClipSummary, clipB: ClipSummary, offsets: number[] = []): ShotMatch {
  const sound = a.sound && b.sound ? soundSimilarity(a.sound, b.sound) : null;
  const raw = rawGap(a, b);
  const dt = raw === null || a.clipId === b.clipId ? raw : Math.min(raw, ...offsets.map((o) => Math.abs(raw - o)));
  const distM = clipA.geo && clipB.geo ? geoDistance(clipA.geo, clipB.geo) : null;

  let logit = -1;
  if (sound !== null) logit += clamp((sound - 0.55) * 12, -3, 4);
  if (dt !== null) logit += dt <= 0.5 ? 3 : dt <= SAME_SHOT_S ? 2 : dt <= 5 ? -1 : dt <= 60 ? -3 : -5;
  if (distM !== null) logit += distM <= NEAR_M ? 1 : distM <= 50 ? 0 : -2;
  if (a.hole && b.hole) logit += a.hole === b.hole ? 0.5 : -3;
  if (tracked(a) && tracked(b)) logit += agree(a.carryM, b.carryM) + agree(a.flightS, b.flightS);
  const score = a.clipId === b.clipId ? 0 : 1 / (1 + Math.exp(-logit));

  let verdict: MatchVerdict = 'different';
  if (score >= SAME_ASK) verdict = 'same';
  else if (a.hole && a.hole === b.hole && dt !== null && dt > SAME_SHOT_S * 2 && dt <= RETAKE_S) {
    // The tee spot in the frame only compares within one camera view.
    const sameView = a.clipId === b.clipId || (clipA.width === clipB.width && clipA.height === clipB.height && (distM === null || distM <= NEAR_M));
    if (!sameView || Math.hypot(a.x - b.x, a.y - b.y) <= RETAKE_SPOT) verdict = 'retake';
  }
  const sure = verdict === 'same' && score >= SAME_SURE && sound !== null && sound >= SOUND_SURE && (dt === null || dt <= SAME_SHOT_S);
  return { a, b, score: Number(score.toFixed(3)), verdict, sure, sound: sound === null ? null : Number(sound.toFixed(3)), dt, distM };
}

/** Pairs from different clips that are one strike, surest first. */
export function sameShotPairs(s: RoundSummary): ShotMatch[] {
  const clip = new Map(s.clips.map((c) => [c.id, c]));
  const offsets = clockOffsets(s);
  const out: ShotMatch[] = [];
  for (let i = 0; i < s.shots.length; i++)
    for (let j = i + 1; j < s.shots.length; j++) {
      const a = s.shots[i];
      const b = s.shots[j];
      const ca = clip.get(a.clipId);
      const cb = clip.get(b.clipId);
      if (a.clipId === b.clipId || !ca || !cb || (a.hole && b.hole && a.hole !== b.hole)) continue;
      const gap = rawGap(a, b);
      if (gap !== null && gap > MAX_OFFSET_S) continue;
      const m = compareShots(a, b, ca, cb, offsets);
      if (m.verdict === 'same') out.push(m);
    }
  return out.sort((x, y) => y.score - x.score);
}

/** Shots that are one strike (joined by same-shot pairs), in round order; single shots alone. */
export function strikeGroups(s: RoundSummary, same: ShotMatch[]): ShotSummary[][] {
  const root = new Map(s.shots.map((x) => [x.id, x.id]));
  const find = (id: string): string => (root.get(id) === id ? id : find(root.get(id)!));
  for (const m of same) root.set(find(m.b.id), find(m.a.id));
  const groups = new Map<string, ShotSummary[]>();
  for (const x of s.shots) {
    const r = find(x.id);
    groups.set(r, [...(groups.get(r) ?? []), x]);
  }
  return [...groups.values()];
}
