/**
 * The round in a few lines: one per clip and one per shot. This is all an AI model ever sees of
 * a project – no video, no images, no project document – and it is what the rules read too.
 */
import { shotStats } from '@golf/render';
import type { MediaRef, Project, Shot, WarningCode } from '@golf/schema';
import { isoDate, isSure, roundMedia, roundOrder } from './chronology';
import { playedShots } from './videos';

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
  course: string;
  hole: string;
  par: number | null;
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
  /** 0–1, as the analysis rated it. */
  confidence: number;
  flags: WarningCode[];
  /** Where the ball was teed up, as a fraction of the frame (for spotting retakes in one clip). */
  x: number;
  y: number;
}

export interface RoundSummary {
  name: string;
  course: string;
  /** Day of the first filmed clip (YYYY-MM-DD), or ''. */
  date: string;
  clips: ClipSummary[];
  shots: ShotSummary[];
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
  const shots = playedShots(doc).sort((a, b) => (nOf.get(a.mediaId) ?? 1e9) - (nOf.get(b.mediaId) ?? 1e9) || a.impactTime - b.impactTime);
  const first = order.find(isSure);
  const d = isoDate(first?.recordedAt);
  return {
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
      course: m.place?.course ?? '',
      hole: m.place?.hole ?? '',
      par: m.place?.par ?? null,
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
        confidence: round(s.confidence, 2),
        flags: [...new Set(s.warnings.map((w) => w.code))],
        x: round(s.anchor.x / Math.max(1, m.width), 2),
        y: round(s.anchor.y / Math.max(1, m.height), 2),
      };
    }),
    order: { by: ordered.by, unsure: ordered.unsure, conflict: ordered.conflict && [ordered.conflict[0].id, ordered.conflict[1].id] },
  };
}

/**
 * The summary as compact text for a language model: a header line, one line per clip and one
 * per shot. Small on purpose – a round of 80 shots stays well under 3 000 tokens.
 */
export function summaryText(s: RoundSummary): string {
  const lines = [`round "${s.name}" course "${s.course || '?'}" date ${s.date || '?'} clips ${s.clips.length} shots ${s.shots.length}`];
  for (const c of s.clips)
    lines.push(
      `clip ${c.n} id=${c.id} "${c.name}" filmed=${c.recordedAt ?? '?'} ${c.seconds}s ${c.portrait ? 'portrait' : 'landscape'} gps=${c.gps ? 'y' : 'n'} hole=${c.hole || '?'} par=${c.par ?? '?'} shots=${c.shots}`,
    );
  for (const x of s.shots)
    lines.push(
      `shot ${x.n} id=${x.id} clip=${x.clip} t=${x.t} hole=${x.hole || '?'} par=${x.par ?? '?'} club=${x.club} carry=${x.carryM ?? '?'} apex=${x.apexM ?? '?'} conf=${x.confidence} flags=${x.flags.join(',') || '-'}`,
    );
  return lines.join('\n');
}
