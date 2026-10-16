/**
 * The order of a round's clips. One rule set, mirrored in apps/api/golf_api/chronology.py (keep
 * both, and their tests, in step):
 *
 * - A clip's time is set at upload from the first source that has one (`recordedAtSource`): the
 *   file's metadata, its name, or the file's modified time ('file' – weak, copying changes it).
 *   Projects from before the source was stored count as metadata.
 * - Chapters of one GoPro recording (GX010123, GX020123 …) share the earliest time among them
 *   and stay together in chapter order.
 * - Every clip has a sure time (metadata or name): by time.
 * - No sure time at all and at least two clips have a hole: by hole, starting after the biggest
 *   gap (a round started on hole 10 wraps 18 → 1); clips without a hole follow.
 * - Otherwise: clips with a time by time, then the rest.
 * - Ties and clips without a time go by file name (numbers compared as numbers, GoPro files by
 *   recording and then chapter).
 */
import type { MediaRef, Project } from '@golf/schema';

export const isoDate = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
};

type Timed = Pick<MediaRef, 'id' | 'name' | 'recordedAt' | 'recordedAtSource' | 'place'>;

const GOPRO = /^(?:GOPR(\d{4})|G[PHX](\d{2})(\d{4}))(?!\d)/i;

/** A GoPro file's recording number and chapter (GOPR0123 is chapter 0, GP010123 the next). */
export function goPro(name: string): { rec: number; chapter: number } | null {
  const m = GOPRO.exec(name);
  if (!m) return null;
  return m[1] ? { rec: Number(m[1]), chapter: 0 } : { rec: Number(m[3]), chapter: Number(m[2]) };
}

/** Sorts file names as a person would: numbers by value, GoPro chapters after their recording. */
export function nameKey(name: string): string {
  const g = goPro(name);
  const base = g ? `gopro ${g.rec} ${g.chapter}` : name;
  return base.toLowerCase().replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, '').padStart(20, '0'));
}

export const timeOf = (m: Timed): number | null => isoDate(m.recordedAt)?.getTime() ?? null;

/** The time came from the file's metadata or name, not just from when the file was last changed. */
export const isSure = (m: Timed): boolean => timeOf(m) !== null && m.recordedAtSource !== 'file';

export function holeOf(m: Timed): number | null {
  const h = m.place?.hole ?? '';
  return /^\d+$/.test(h) && Number(h) > 0 ? Number(h) : null;
}

const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** By time (GoPro chapters at their recording's start), clips without a time last, then by name. */
function byTime<T extends Timed>(media: T[]): (a: T, b: T) => number {
  const first = new Map<number, number>();
  for (const m of media) {
    const g = goPro(m.name);
    const t = timeOf(m);
    if (g && t !== null) first.set(g.rec, Math.min(t, first.get(g.rec) ?? t));
  }
  const at = (m: T) => {
    const g = goPro(m.name);
    return (g ? first.get(g.rec) : null) ?? timeOf(m) ?? Infinity;
  };
  return (a, b) => {
    const ta = at(a);
    const tb = at(b);
    return (ta === tb ? 0 : ta < tb ? -1 : 1) || cmpKey(nameKey(a.name), nameKey(b.name));
  };
}

const holeCount = (holes: number[]) => Math.max(18, ...holes);

/** By hole number, starting after the biggest gap between the holes filmed; the rest by time. */
export function byHole<T extends Timed>(media: T[]): T[] {
  const holes = [...new Set(media.map(holeOf).filter((h): h is number => h !== null))].sort((a, b) => a - b);
  const time = byTime(media);
  if (!holes.length) return [...media].sort(time);
  const n = holeCount(holes);
  let start = holes[0];
  let gap = holes[0] + n - holes[holes.length - 1];
  for (let i = 1; i < holes.length; i++)
    if (holes[i] - holes[i - 1] > gap) {
      gap = holes[i] - holes[i - 1];
      start = holes[i];
    }
  const pos = (m: T) => {
    const h = holeOf(m);
    return h === null ? n : (h - start + n) % n;
  };
  return [...media].sort((a, b) => pos(a) - pos(b) || time(a, b));
}

/**
 * Two clips whose sure times put the holes strongly out of order (hole 7 filmed before hole 3),
 * or null. Going around the course once is fine, as is a step back of one hole (a tee next to
 * the previous green).
 */
export function holeConflict<T extends Timed>(ordered: T[]): [T, T] | null {
  const seq: [T, number][] = [];
  for (const m of ordered) {
    const h = holeOf(m);
    if (h !== null && isSure(m) && seq[seq.length - 1]?.[1] !== h) seq.push([m, h]);
  }
  if (seq.length < 2) return null;
  const n = holeCount(seq.map((x) => x[1]));
  let total = 0;
  let worst: [T, T] | null = null;
  let worstStep = 0;
  for (let i = 1; i < seq.length; i++) {
    let step = (seq[i][1] - seq[i - 1][1] + n) % n;
    if (step === n - 1) step = 0;
    total += step;
    if (step > worstStep) {
      worstStep = step;
      worst = [seq[i - 1][0], seq[i][0]];
    }
  }
  return total >= n ? worst : null;
}

export interface RoundOrder<T extends Timed = MediaRef> {
  media: T[];
  /** What decided the order: sure times, hole numbers, or a mix of times and file names. */
  by: 'time' | 'hole' | 'mixed';
  /** Clips placed without a sure time (and, ordered by hole, without a hole). */
  unsure: string[];
  /** Sure times that contradict the holes. */
  conflict: [T, T] | null;
}

export function roundOrder<T extends Timed>(media: T[]): RoundOrder<T> {
  if (media.every(isSure)) {
    const ordered = [...media].sort(byTime(media));
    return { media: ordered, by: 'time', unsure: [], conflict: holeConflict(ordered) };
  }
  if (!media.some(isSure) && media.filter((m) => holeOf(m) !== null).length >= 2)
    return { media: byHole(media), by: 'hole', unsure: media.filter((m) => holeOf(m) === null).map((m) => m.id), conflict: null };
  const ordered = [...media].sort(byTime(media));
  return { media: ordered, by: 'mixed', unsure: media.filter((m) => !isSure(m)).map((m) => m.id), conflict: holeConflict(ordered) };
}

/** The videos on the timeline (each once). */
export function roundMedia(doc: Pick<Project, 'media' | 'clips'>): MediaRef[] {
  const ids = new Set(doc.clips.map((c) => c.mediaId));
  return Object.values(doc.media).filter((m) => m.kind === 'video' && ids.has(m.id));
}

/**
 * Where a new clip of `mediaId` goes on the timeline: before the first clip that comes later in
 * the round order. Mirrors attach_video on the server.
 */
export function clipSlot(doc: Pick<Project, 'media' | 'clips'>, mediaId: string): number {
  const media = roundMedia(doc).filter((m) => m.id !== mediaId);
  const self = doc.media[mediaId];
  if (!self) return doc.clips.length;
  const rank = new Map(roundOrder([...media, self]).media.map((m, i) => [m.id, i]));
  const mine = rank.get(mediaId)!;
  const at = doc.clips.findIndex((c) => (rank.get(c.mediaId) ?? -1) > mine);
  return at < 0 ? doc.clips.length : at;
}
