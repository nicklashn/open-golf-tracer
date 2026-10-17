/**
 * The round in a few lines: one per clip and one per shot. This is all an AI model ever sees of
 * a project – no video, no images, no project document – and it is what the rules read too.
 */
import { shotStats } from '@golf/render';
import { byTimeline, type GeoPoint, type MediaRef, type Project, type Shot, type WarningCode } from '@golf/schema';
import { isoDate, isSure, roundMedia, roundOrder } from './chronology';
import { annotateNext, holeScores, type HoleScore } from './score';

export interface ClipSummary {
  id: string;
  /** Position in the round (1-based), see `clipOrder`. */
  n: number;
  name: string;
  /** ISO time the clip was filmed, or null when neither the file's metadata nor its name said. */
  recordedAt: string | null;
  seconds: number;
  portrait: boolean;
  /** The phone's position was in the file. */
  gps: boolean;
  geo: GeoPoint | null;
  width: number;
  height: number;
  course: string;
  hole: string;
  par: number | null;
  /** Metres from the tee along the hole (GPS), when known. */
  fromTee: number | null;
  /** Metres from there to the green (GPS), when known. */
  toGreen?: number | null;
  shots: number;
}

export interface ShotSummary {
  id: string;
  /** Position in the round (1-based). */
  n: number;
  clipId: string;
  clip: number;
  /** Seconds into the clip, and the time of day when the clip's start is known. */
  t: number;
  at: string | null;
  hole: string;
  par: number | null;
  club: string;
  carryM: number | null;
  apexM: number | null;
  flightS: number | null;
  /** Ball positions tracked in flight. */
  trackPts: number;
  /** 0–1, as the analysis rated it. */
  confidence: number;
  flags: WarningCode[];
  /** Where the ball was teed up, as a fraction of the frame (for spotting retakes in one clip). */
  x: number;
  y: number;
  /** The strike's sound signature, when the clip had audio (see `match.ts`). */
  sound: Shot['sound'] | null;
  /** Metres by GPS to where the next stroke on the hole was filmed (see score.ts). */
  nextM?: number | null;
  /** The flight's carry strongly contradicts `nextM` (reason `next_shot_distance`). */
  nextOff?: boolean;
  /** No measured carry: `nextM` as a suggestion. */
  carrySuggestM?: number | null;
  /** Golf highlights (see `tagHighlights`). */
  tags?: HighlightTag[];
}

/**
 * What makes a stroke worth showing, from facts only (never from a guess):
 * - `eagle` / `birdie`: the strokes of a hole with a complete score (score.ts) under par;
 * - `longest`: the longest measured carry of the round (a traced flight, at least LONGEST_MIN shots);
 * - `close`: an approach followed by a putt filmed within CLOSE_M of the green (GPS), or by a
 *   single short holed putt;
 * - `long_putt`: a holed putt that rolled at least LONG_PUTT_S.
 */
export const HIGHLIGHT_TAGS = ['eagle', 'birdie', 'longest', 'close', 'long_putt'] as const;
export type HighlightTag = (typeof HIGHLIGHT_TAGS)[number];
/** Metres from the green where the first putt after a close approach was filmed (GPS). */
export const CLOSE_M = 8;
/** Seconds a holed putt rolls for it to count as long (a 2 m putt takes about 1.5 s, 10 m about 4–5 s). */
export const LONG_PUTT_S = 3.5;
/** Measured flights needed before one is "the longest of the round". */
export const LONGEST_MIN = 3;

/** A chip or a putt: never traced, but a stroke for the score. */
export interface StrokeSummary {
  id: string;
  kind: 'short' | 'putt';
  clipId: string;
  clip: number;
  t: number;
  hole: string;
  par: number | null;
  confidence: number;
  /** Analysis warnings (e.g. `putt_count_unsure`). */
  flags: string[];
  /** Putts: seconds into the clip when the ball stopped or dropped, and whether it was holed. */
  end: number | null;
  holed: boolean | null;
  /** Golf highlights (see `tagHighlights`). */
  tags?: HighlightTag[];
}

export interface RoundSummary {
  name: string;
  course: string;
  /** Day of the first filmed clip (YYYY-MM-DD), or ''. */
  date: string;
  clips: ClipSummary[];
  shots: ShotSummary[];
  /** Chips and putts in round order (any visibility: they are strokes, not tracer shots). */
  chips: StrokeSummary[];
  putts: StrokeSummary[];
  /** The score of each hole filmed, in round order (see score.ts). */
  holes: HoleScore[];
  /** How the clip order was found (see `roundOrder`): clip ids placed without a sure time, and two clips whose times contradict their holes. */
  order: { by: 'time' | 'hole' | 'mixed'; unsure: string[]; conflict: [string, string] | null };
}

/** Rounded to `decimals` places without float noise (2.4, not 2.4000000000000004): fewer tokens. */
const round = (v: number, decimals: number) => Number(v.toFixed(decimals));

/** The clips of the round in the order they were played (see chronology.ts). */
export function clipOrder(doc: Project): MediaRef[] {
  return roundOrder(roundMedia(doc)).media;
}

/** When the shot was struck (ms since epoch), if the clip's start time is surely known. */
export function strikeTime(shot: Shot, media: MediaRef): number | null {
  const start = isSure(media) ? isoDate(media.recordedAt) : null;
  return start ? start.getTime() + (shot.impactTime / Math.max(1, shot.slowmo)) * 1000 : null;
}

export function summarize(doc: Project): RoundSummary {
  const ordered = roundOrder(roundMedia(doc));
  const order = ordered.media;
  const nOf = new Map(order.map((m, i) => [m.id, i + 1]));
  const inRound = (s: Shot) => nOf.has(s.mediaId) && !!doc.media[s.mediaId];
  const byRound = (a: Shot, b: Shot) => (nOf.get(a.mediaId) ?? 1e9) - (nOf.get(b.mediaId) ?? 1e9) || a.impactTime - b.impactTime;
  const shots = doc.shots
    .filter((s) => s.visible && s.kind === 'full' && doc.media[s.mediaId])
    .sort(byTimeline(doc.clips))
    .sort(byRound);
  const stroke = (s: Shot): StrokeSummary => {
    const m = doc.media[s.mediaId];
    return {
      id: s.id,
      kind: s.kind === 'putt' ? 'putt' : 'short',
      clipId: s.mediaId,
      clip: nOf.get(s.mediaId) ?? 0,
      t: round(s.impactTime, 1),
      hole: m.place?.hole ?? '',
      par: m.place?.par ?? null,
      confidence: round(s.confidence, 2),
      flags: [...new Set(s.warnings.map((w) => w.code as string))],
      end: s.kind === 'putt' ? round(s.putt?.end ?? s.impactTime, 1) : null,
      holed: s.kind === 'putt' ? (s.putt?.holed ?? null) : null,
    };
  };
  const first = order.find(isSure);
  const d = isoDate(first?.recordedAt);
  const summary: RoundSummary = {
    name: doc.name,
    course: order.find((m) => m.place?.course)?.place?.course ?? '',
    date: d ? d.toISOString().slice(0, 10) : '',
    clips: order.map((m, i) => ({
      id: m.id,
      n: i + 1,
      name: m.name,
      recordedAt: isSure(m) ? m.recordedAt : null,
      seconds: round(m.duration, 1),
      portrait: m.height > m.width,
      gps: !!m.geo,
      geo: m.geo,
      width: m.width,
      height: m.height,
      course: m.place?.course ?? '',
      hole: m.place?.hole ?? '',
      par: m.place?.par ?? null,
      fromTee: m.place?.fromTee ?? null,
      toGreen: m.place?.toGreen ?? null,
      shots: shots.filter((s) => s.mediaId === m.id).length,
    })),
    shots: shots.map((s, i) => {
      const m = doc.media[s.mediaId];
      const st = shotStats(s);
      const at = strikeTime(s, m);
      return {
        id: s.id,
        n: i + 1,
        clipId: s.mediaId,
        clip: nOf.get(s.mediaId) ?? 0,
        t: round(s.impactTime, 1),
        at: at === null ? null : new Date(at).toISOString(),
        hole: m.place?.hole ?? '',
        par: m.place?.par ?? null,
        club: s.club,
        carryM: st ? Math.round(st.carryM) : null,
        apexM: st ? Math.round(st.apexM) : null,
        flightS: st ? round(st.flightTimeS, 1) : null,
        trackPts: s.track.t.length,
        confidence: round(s.confidence, 2),
        flags: [...new Set(s.warnings.map((w) => w.code))],
        x: round(s.anchor.x / Math.max(1, m.width), 2),
        y: round(s.anchor.y / Math.max(1, m.height), 2),
        sound: s.sound ?? null,
      };
    }),
    chips: doc.shots
      .filter((s) => s.kind === 'short' && inRound(s))
      .sort(byRound)
      .map(stroke),
    putts: doc.shots
      .filter((s) => s.kind === 'putt' && inRound(s))
      .sort(byRound)
      .map(stroke),
    holes: [],
    order: { by: ordered.by, unsure: ordered.unsure, conflict: ordered.conflict && [ordered.conflict[0].id, ordered.conflict[1].id] },
  };
  annotateNext(summary);
  summary.holes = holeScores(summary);
  tagHighlights(summary);
  return summary;
}

/** A flight that was measured, not guessed: tracked in the air, no default path, not doubtful. */
const measured = (x: ShotSummary) =>
  x.carryM !== null &&
  !x.carrySuggestM &&
  x.trackPts >= 5 &&
  !x.nextOff &&
  !x.flags.some((f) => f === 'no_track' || f === 'default_path' || f === 'implausible' || f === 'carry_mismatch');

/** Sets `tags` on the shots and putts of the summary (see HIGHLIGHT_TAGS). */
export function tagHighlights(s: RoundSummary): void {
  const add = (x: { tags?: HighlightTag[] }, tag: HighlightTag) => {
    x.tags = [...new Set([...(x.tags ?? []), tag])];
  };
  // Only with putts on video can a hole be complete.
  for (const h of s.putts.length ? s.holes : []) {
    if (h.strokes === null || h.par === null || h.strokes - h.par > -1) continue;
    const tag: HighlightTag = h.strokes - h.par <= -2 ? 'eagle' : 'birdie';
    for (const x of s.shots) if (x.hole === h.hole) add(x, tag);
    const putts = s.putts.filter((p) => p.hole === h.hole);
    if (putts.length) add(putts[putts.length - 1], tag);
  }
  const traced = s.shots.filter(measured);
  if (traced.length >= LONGEST_MIN)
    add(
      traced.reduce((a, b) => (b.carryM! > a.carryM! ? b : a)),
      'longest',
    );
  const clip = new Map(s.clips.map((c) => [c.id, c]));
  const order = (a: { clip: number; t: number }, b: { clip: number; t: number }) => a.clip - b.clip || a.t - b.t;
  for (const hole of new Set(s.shots.map((x) => x.hole).filter(Boolean))) {
    const putts = s.putts.filter((p) => p.hole === hole);
    const strokes = [...s.shots.filter((x) => x.hole === hole), ...s.chips.filter((x) => x.hole === hole), ...putts].sort(order);
    strokes.forEach((x, i) => {
      const next = strokes[i + 1];
      if ('kind' in x || !next || !('kind' in next) || next.kind !== 'putt' || x.nextOff) return;
      const near = (clip.get(next.clipId)?.toGreen ?? Infinity) <= CLOSE_M;
      const onePutt = putts.length === 1 && next.holed === true && next.end !== null && next.end - next.t < LONG_PUTT_S;
      if (near || onePutt) add(x, 'close');
    });
  }
  for (const p of s.putts) if (p.holed === true && p.end !== null && p.end - p.t >= LONG_PUTT_S) add(p, 'long_putt');
}

/**
 * The summary as compact text for a language model: a header line, one line per clip and one
 * per shot. Small on purpose – a round of 80 shots stays well under 3 000 tokens. Clips are
 * "clip n", never their file names (which can hold names, places or dates): the text may go to a
 * cloud provider.
 */
export function summaryText(s: RoundSummary): string {
  const lines = [`round "${s.name}" course "${s.course || '?'}" date ${s.date || '?'} clips ${s.clips.length} shots ${s.shots.length}`];
  for (const c of s.clips)
    lines.push(
      `clip ${c.n} id=${c.id} filmed=${c.recordedAt ?? '?'} ${c.seconds}s ${c.portrait ? 'portrait' : 'landscape'} gps=${c.gps ? 'y' : 'n'} hole=${c.hole || '?'} par=${c.par ?? '?'} shots=${c.shots}`,
    );
  for (const x of s.shots)
    lines.push(
      `shot ${x.n} id=${x.id} clip=${x.clip} t=${x.t} hole=${x.hole || '?'} par=${x.par ?? '?'} club=${x.club} carry=${x.carrySuggestM ? `~${x.carrySuggestM}` : (x.carryM ?? '?')} apex=${x.apexM ?? '?'} conf=${x.confidence} flags=${[...x.flags, ...(x.nextOff ? ['next_shot_distance'] : [])].join(',') || '-'}${x.nextM ? ` next=${x.nextM}` : ''}${x.tags?.length ? ` tags=${x.tags.join(',')}` : ''}`,
    );
  for (const p of s.putts)
    if (p.tags?.length) lines.push(`putt clip=${p.clip} t=${p.t} hole=${p.hole || '?'} holed=${p.holed ? 'y' : 'n'} tags=${p.tags.join(',')}`);
  // Only with putts on video can a hole be complete.
  const holes = s.putts.length ? s.holes : [];
  if (holes.length) {
    const done = holes.filter((h) => h.strokes !== null);
    const strokes = done.reduce((n, h) => n + h.strokes!, 0);
    const par = done.reduce((n, h) => n + h.par!, 0);
    lines.push(
      `score (hole:strokes/par putts, ?=not every stroke filmed) ${holes.map((h) => `${h.hole}:${h.strokes ?? '?'}/${h.par ?? '?'} ${h.putts}p`).join(', ')}${done.length ? ` total ${strokes}/${par}` : ''}`,
    );
  }
  return lines.join('\n');
}
