/**
 * The score of each hole from the clips, and where the next stroke was filmed.
 *
 * The strokes of a hole in round order: full shots once per strike (one strike filmed from two
 * angles counts once, a practice swing not at all), chips (unless they look like a practice
 * swing) and putts. A hole only gets a score when the clips show all of it:
 * - the first stroke is from the tee (its clip is at most TEE_M from the tee by GPS);
 * - the last stroke is a holed putt;
 * - each stroke starts about where the one before went: between two clips the GPS distance fits
 *   the previous stroke (a flight's carry plus roll, a chip's or a putt's length), with room for
 *   GPS error and the camera standing a few metres from the ball. Strokes in one clip need no
 *   check: the camera kept filming;
 * - nothing on the hole is in doubt (a retake, a maybe-same shot, unsure putts).
 * Otherwise the hole has no score ('–'); it is never guessed.
 *
 * The user's corrections (`Project.scoreEdits`, carried as `RoundSummary.edits`) win over all of
 * this: a par, the putts (the last one holed: the putts question is settled) or the strokes of
 * the hole (a score even when not every stroke was filmed).
 */
import type { GeoPoint, HoleEdit } from '@golf/schema';
import { sameShotPairs, strikeGroups, type ShotMatch } from './match';
import { haversine } from './place';
import { puttQuestionId } from './plan';
import { LOW_CONFIDENCE, retakePairs } from './rules';
import type { RoundSummary, ShotSummary, StrokeSummary } from './summary';

/** The first stroke's clip is at most this far from the tee (forward tees, GPS error). */
export const TEE_M = 40;
/** GPS error of one position when the file does not say (metres), and the most counted. */
const GPS_M = 8;
const MAX_ACC_M = 25;
/** The phone stands about this far from the ball. */
const CAMERA_M = 5;
/** A flight's carry fits the next stroke's spot from SHORT × carry to LONG × carry + ROLL_M. */
export const NEXT_SHORT = 0.75;
export const NEXT_LONG = 1.25;
const ROLL_M = 30;
/** Without a carry: the longest full shot, chip and putt (metres). */
const MAX_FULL_M = 330;
const MAX_CHIP_M = 80;
const MAX_PUTT_M = 30;

export const SCORE_GAPS = [
  'no_par',
  'no_tee',
  'not_holed',
  'no_gps',
  'gap',
  'same_spot',
  'next_shot_distance',
  'retake',
  'same_unsure',
  'putts_unsure',
] as const;
/** Why a hole has no score. */
export type ScoreGap = (typeof SCORE_GAPS)[number];

export interface HoleScore {
  hole: string;
  par: number | null;
  /** Strokes seen on the clips. */
  counted: number;
  putts: number;
  /** The score: `counted` when every stroke was filmed, else null. */
  strokes: number | null;
  why: ScoreGap[];
  /** The putts are in doubt (asked as `putts:<hole>`, see rules.ts); false once the user set them. */
  puttsUnsure: boolean;
  /** What the user corrected on this hole (`Project.scoreEdits`). */
  edited: (keyof HoleEdit)[];
  /** The strokes' shot ids in round order (the first angle of a full strike). */
  shotIds: string[];
}

interface Stroke {
  id: string;
  kind: 'full' | 'short' | 'putt';
  /** The shots of one full strike (several angles), empty for chips and putts. */
  full: ShotSummary[];
  hole: string;
  clip: number;
  t: number;
  clipIds: string[];
}

const EDIT_KEYS = ['par', 'strokes', 'putts'] as const;

const practice = (flags: readonly string[], confidence: number) => flags.includes('no_track') && confidence < LOW_CONFIDENCE;
const traced = (x: ShotSummary) => x.carryM !== null && x.trackPts >= 5 && !x.flags.includes('default_path') && !x.flags.includes('no_track');
const accuracy = (g: GeoPoint) => Math.min(MAX_ACC_M, g.acc ?? GPS_M);

/** Putts the analysis is unsure about: a warning, low confidence, or not known whether the last went in. */
export function puttsUnsure(putts: readonly StrokeSummary[]): boolean {
  if (!putts.length) return false;
  return putts.some((p) => p.flags.includes('putt_count_unsure') || p.confidence < LOW_CONFIDENCE) || putts[putts.length - 1].holed === null;
}

function strokesByHole(s: RoundSummary, same: ShotMatch[]): Map<string, Stroke[]> {
  const all: Stroke[] = [];
  for (const g of strikeGroups(s, same)) {
    const real = g.filter((x) => !practice(x.flags, x.confidence));
    if (real.length)
      all.push({
        id: real[0].id,
        kind: 'full',
        full: real,
        hole: real[0].hole,
        clip: real[0].clip,
        t: real[0].t,
        clipIds: [...new Set(real.map((x) => x.clipId))],
      });
  }
  for (const x of [...s.chips, ...s.putts])
    if (x.kind === 'putt' || !practice(x.flags, x.confidence))
      all.push({ id: x.id, kind: x.kind, full: [], hole: x.hole, clip: x.clip, t: x.t, clipIds: [x.clipId] });
  all.sort((a, b) => a.clip - b.clip || a.t - b.t);
  const out = new Map<string, Stroke[]>();
  for (const x of all) if (x.hole) out.set(x.hole, [...(out.get(x.hole) ?? []), x]);
  return out;
}

interface Notes {
  next: Map<string, number>;
  off: Set<string>;
  suggest: Map<string, number>;
}

/** The legs between consecutive strokes that do not fit (and, with `notes`, what each full shot's next stroke says). */
function checkLegs(s: RoundSummary, strokes: Stroke[], notes?: Notes): Set<ScoreGap> {
  const why = new Set<ScoreGap>();
  const geo = new Map(s.clips.map((c) => [c.id, c.geo]));
  for (let i = 1; i < strokes.length; i++) {
    const a = strokes[i - 1];
    const b = strokes[i];
    if (a.clipIds.some((id) => b.clipIds.includes(id))) continue;
    // From the cameras closest together: one of a strike's angles stands at the ball.
    let leg: { d: number; tol: number } | null = null;
    for (const x of a.clipIds)
      for (const y of b.clipIds) {
        const ga = geo.get(x);
        const gb = geo.get(y);
        if (!ga || !gb) continue;
        const d = haversine(ga, gb);
        if (!leg || d < leg.d) leg = { d, tol: accuracy(ga) + accuracy(gb) + 2 * CAMERA_M };
      }
    if (!leg) {
      why.add('no_gps');
      continue;
    }
    const { d, tol } = leg;
    if (a.kind !== 'full') {
      if (d - tol > (a.kind === 'putt' ? MAX_PUTT_M : MAX_CHIP_M)) why.add('gap');
      continue;
    }
    // Two full shots from about one spot: a retake or a partner, not where the ball went.
    if (b.kind === 'full' && d <= tol) {
      why.add('same_spot');
      continue;
    }
    for (const x of a.full) notes?.next.set(x.id, Math.round(d));
    const measured = a.full.filter(traced);
    if (!measured.length) {
      if (d > tol) for (const x of a.full) notes?.suggest.set(x.id, Math.round(d));
      if (d - tol > MAX_FULL_M) why.add('gap');
      continue;
    }
    const carry = measured.reduce((p, q) => (q.confidence > p.confidence ? q : p)).carryM!;
    if (d + tol < NEXT_SHORT * carry) {
      why.add('next_shot_distance');
      for (const x of measured) if (d + tol < NEXT_SHORT * x.carryM!) notes?.off.add(x.id);
    } else if (d - tol > NEXT_LONG * carry + ROLL_M) why.add('gap');
  }
  return why;
}

/**
 * Notes on each full shot from where the next stroke on its hole was filmed: the distance
 * (`nextM`), a carry that strongly contradicts it (`nextOff`), and a suggested carry when none
 * was measured (`carrySuggestM`). Only consecutive strokes on one hole, filmed in two clips.
 */
export function annotateNext(s: RoundSummary): void {
  const notes: Notes = { next: new Map(), off: new Set(), suggest: new Map() };
  for (const strokes of strokesByHole(s, sameShotPairs(s)).values()) checkLegs(s, strokes, notes);
  for (const x of s.shots) {
    x.nextM = notes.next.get(x.id) ?? null;
    x.nextOff = notes.off.has(x.id);
    x.carrySuggestM = notes.suggest.get(x.id) ?? null;
  }
}

/**
 * The score of each hole filmed, in round order. `answers` (question id → option, as
 * `resolveAnswers` gives them) settle the putts (`putts:<hole>`) and maybe-same shots; without
 * them a hole with doubts has no score.
 */
export function holeScores(s: RoundSummary, answers?: Readonly<Record<string, string>> | null): HoleScore[] {
  const same = sameShotPairs(s);
  const retakes = retakePairs(s, same);
  const clip = new Map(s.clips.map((c) => [c.id, c]));
  const answeredSame = (m: ShotMatch) =>
    Object.keys(answers ?? {}).some(
      (k) =>
        k.startsWith('same:') &&
        k
          .split(':')
          .slice(1)
          .some((id) => id === m.a.id || id === m.b.id),
    );
  const out: HoleScore[] = [];
  for (const [hole, strokes] of strokesByHole(s, same)) {
    const edit = s.edits?.[hole] ?? {};
    const edited = EDIT_KEYS.filter((k) => edit[k] !== undefined);
    const why = checkLegs(s, strokes);
    const par = edit.par ?? s.clips.find((c) => c.hole === hole && c.par)?.par ?? null;
    if (!par) why.add('no_par');
    const first = strokes[0];
    const fromTee = first.kind === 'putt' ? Infinity : Math.min(...first.clipIds.map((id) => clip.get(id)?.fromTee ?? Infinity));
    if (!(fromTee <= TEE_M)) why.add('no_tee');
    if (retakes.some(([a]) => a.hole === hole)) why.add('retake');
    if (same.some((m) => !m.sure && m.a.hole === hole && !answeredSame(m))) why.add('same_unsure');

    const putts = s.putts.filter((p) => p.hole === hole);
    const unsure = puttsUnsure(putts);
    let n: number | null = putts.length;
    let holed = putts[putts.length - 1]?.holed ?? null;
    const answer = answers?.[puttQuestionId(hole)];
    if (edit.putts !== undefined) {
      // The user counted them: the hole was finished with that many putts.
      n = edit.putts;
    } else {
      if (answer === 'notHoled') holed = false;
      else if (answer && /^[1-4]$/.test(answer)) {
        // '4' is "4 or more": the count is only known when at least four were found.
        const k = Number(answer);
        n = k < 4 ? k : putts.length >= 4 ? putts.length : null;
        holed = true;
      }
      if ((unsure && !answer) || n === null) why.add('putts_unsure');
      if (strokes[strokes.length - 1].kind !== 'putt' || holed !== true) why.add('not_holed');
    }
    let counted = strokes.filter((x) => x.kind !== 'putt').length + (n ?? 4);
    if (edit.strokes !== undefined) {
      // The user's count of the whole hole: nothing filmed is left in doubt, except a missing par.
      counted = edit.strokes;
      for (const g of SCORE_GAPS) if (g !== 'no_par') why.delete(g);
    }
    out.push({
      hole,
      par,
      counted,
      putts: n ?? 4,
      strokes: why.size ? null : counted,
      why: SCORE_GAPS.filter((g) => why.has(g)),
      puttsUnsure: unsure && edit.putts === undefined,
      edited,
      shotIds: strokes.map((x) => x.id),
    });
  }
  return out;
}

/**
 * The holes that count for a score: all of them once putts were filmed or the user corrected a
 * hole, else none (without putts on video no hole can be complete).
 */
export function scoredHoles(s: Pick<RoundSummary, 'holes' | 'putts'>): HoleScore[] {
  return s.putts.length || s.holes.some((h) => h.edited.length) ? s.holes : [];
}

/** The putts question's answer an edit gives (`putts:<hole>` → '1'…'4'), or null. */
export function editedPuttAnswer(edit: HoleEdit | undefined): string | null {
  return edit?.putts ? String(Math.min(4, edit.putts)) : null;
}

const NAMES = {
  da: { '-3': 'Albatros', '-2': 'Eagle', '-1': 'Birdie', '0': 'Par', '1': 'Bogey', '2': 'Dobbelt bogey' },
  en: { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', '0': 'Par', '1': 'Bogey', '2': 'Double bogey' },
} as const;

/** "+2", "−1", "±0". */
export function toPar(diff: number): string {
  return diff > 0 ? `+${diff}` : diff < 0 ? `−${-diff}` : '±0';
}

/** Birdie, par, bogey … and "+3" beyond double bogey. */
export function scoreName(strokes: number, par: number, locale: 'da' | 'en'): string {
  const d = strokes - par;
  return (NAMES[locale] as Record<string, string>)[String(d)] ?? toPar(d);
}
