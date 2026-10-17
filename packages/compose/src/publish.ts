/**
 * Text for posting a made video on YouTube, without any AI: a short description from the facts
 * of the round (course, day, score, highlights) and chapters ("0:00 Intro", "1:12 Hul 1 – par 4
 * – birdie" …). With an AI model its description is used instead; the chapters always come from
 * the timeline, so their times are exact – also after the video was trimmed in the editor.
 */
import { clipStarts, timelineDuration, type Project, type Publish } from '@golf/schema';
import type { PlanAnswers, VideoPlan } from './plan';
import { holeScores, scoreName, toPar, type HoleScore } from './score';
import type { RoundSummary } from './summary';

type Locale = 'da' | 'en';

/** YouTube shows chapters only when there are at least 3, each at least 10 s long, the first at 0:00. */
export const CHAPTER_MIN_S = 10;
export const CHAPTERS_MIN = 3;

const L = {
  da: {
    hole: 'Hul',
    intro: 'Intro',
    round: (course: string, day: string) => [course ? `Golfrunde på ${course}` : 'Golfrunde', day].filter(Boolean).join(', ') + '.',
    score: (n: number, strokes: number, par: number) =>
      `Score: ${strokes} slag på ${n === 1 ? 'ét hul' : `${n} huller`} (par ${par}, ${toPar(strokes - par)}).`,
    scoreSome: (n: number, strokes: number, par: number) =>
      `Score på ${n === 1 ? 'det hul' : `de ${n} huller`}, hvor alle slag er filmet: ${strokes} (par ${par}, ${toPar(strokes - par)}).`,
    highlights: 'Højdepunkter',
    on: (what: string, hole: string) => `${what} på hul ${hole}`,
    longest: (d: string, hole: string) => `længste slag ${d}${hole ? ` (hul ${hole})` : ''}`,
    longPutt: (hole: string) => `langt putt i hul på hul ${hole}`,
    shots: (n: number) => (n === 1 ? 'Ét slag med tracer.' : `${n} slag med tracer.`),
  },
  en: {
    hole: 'Hole',
    intro: 'Intro',
    round: (course: string, day: string) => [course ? `A round of golf at ${course}` : 'A round of golf', day].filter(Boolean).join(', ') + '.',
    score: (n: number, strokes: number, par: number) => `Score: ${strokes} over ${n === 1 ? 'one hole' : `${n} holes`} (par ${par}, ${toPar(strokes - par)}).`,
    scoreSome: (n: number, strokes: number, par: number) =>
      `Score on ${n === 1 ? 'the hole' : `the ${n} holes`} where every stroke was filmed: ${strokes} (par ${par}, ${toPar(strokes - par)}).`,
    highlights: 'Highlights',
    on: (what: string, hole: string) => `${what} on hole ${hole}`,
    longest: (d: string, hole: string) => `longest shot ${d}${hole ? ` (hole ${hole})` : ''}`,
    longPutt: (hole: string) => `long holed putt on hole ${hole}`,
    shots: (n: number) => (n === 1 ? 'One shot with tracer.' : `${n} shots with tracer.`),
  },
};

const capital = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

function dayLabel(date: string, locale: Locale): string {
  const d = date ? new Date(`${date}T12:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(locale === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : '';
}

/** "Hul 4 – par 4 – birdie" (only what is known). */
export function chapterTitle(h: Pick<HoleScore, 'hole' | 'par' | 'strokes'>, locale: Locale): string {
  const parts = [`${L[locale].hole} ${h.hole}`];
  if (h.par) parts.push(`par ${h.par}`);
  if (h.par && h.strokes !== null) parts.push(scoreName(h.strokes, h.par, locale).toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-GB'));
  return parts.join(' – ');
}

/**
 * The description from facts only: course and day, the score of the holes where every stroke
 * was filmed, and the highlights of the shots in the video (eagles, birdies, the longest
 * measured carry, long holed putts).
 */
export function rulesDescription(summary: RoundSummary, scores: HoleScore[], shown: readonly string[], locale: Locale, units: 'm' | 'yd' = 'm'): string {
  const T = L[locale];
  const lines = [T.round(summary.course, dayLabel(summary.date, locale))];
  const filmed = scores.filter((h) => h.par);
  const done = filmed.filter((h) => h.strokes !== null);
  if (done.length) {
    const strokes = done.reduce((n, h) => n + h.strokes!, 0);
    const par = done.reduce((n, h) => n + h.par!, 0);
    lines.push(done.length === filmed.length ? T.score(done.length, strokes, par) : T.scoreSome(done.length, strokes, par));
  }
  const keep = new Set(shown);
  const shots = summary.shots.filter((x) => keep.has(x.id));
  const items: string[] = [];
  for (const h of done) {
    const d = h.strokes! - h.par!;
    if (d <= -1) items.push(T.on(scoreName(h.strokes!, h.par!, locale).toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-GB'), h.hole));
  }
  const longest = shots.find((x) => x.tags?.includes('longest'));
  if (longest?.carryM) {
    const d = units === 'yd' ? `${Math.round(longest.carryM * 1.0936)} yd` : `${longest.carryM} m`;
    items.push(T.longest(d, longest.hole));
  }
  for (const p of summary.putts) if (p.tags?.includes('long_putt') && keep.has(p.id) && p.hole) items.push(T.longPutt(p.hole));
  if (items.length) lines.push(`${T.highlights}: ${capital(items.slice(0, 6).join(', '))}.`);
  else if (shots.length) lines.push(T.shots(shots.length));
  return lines.join(' ').slice(0, 2000);
}

/** What a made video stores for posting (`Project.publish`); the chapters' times come later from its timeline. */
export function publishInfo(
  summary: RoundSummary,
  plan: VideoPlan,
  answers: PlanAnswers | null | undefined,
  scores: HoleScore[] | undefined,
  locale: Locale,
  units: 'm' | 'yd' = 'm',
  shown: readonly string[] = plan.includeShotIds,
): Publish {
  const s = scores ?? holeScores(summary, answers ?? undefined);
  return {
    title: plan.title,
    description: plan.description?.trim() || rulesDescription(summary, s, shown, locale, units),
    intro: L[locale].intro,
    holes: Object.fromEntries(s.filter((h) => h.hole).map((h) => [h.hole, chapterTitle(h, locale)])),
  };
}

export interface Chapter {
  t: number;
  title: string;
}

/**
 * The video's chapters from its timeline: one where each hole starts (the first clip filmed on
 * it), "Intro" before the first when that starts later. Within `range` (an export of part of the
 * video) the times count from its start. Kept only as YouTube shows them: at least 3, each at
 * least 10 s long, the first at 0:00 – else none.
 */
export function timelineChapters(doc: Pick<Project, 'clips' | 'media' | 'publish'>, range?: { start: number; end: number } | null): Chapter[] {
  const pub = doc.publish;
  if (!pub || !Object.keys(pub.holes).length) return [];
  const starts = clipStarts(doc.clips);
  const marks: Chapter[] = [];
  let last = '';
  doc.clips.forEach((c, i) => {
    const hole = doc.media[c.mediaId]?.place?.hole ?? '';
    if (!hole || hole === last) return;
    last = hole;
    const title = pub.holes[hole];
    if (title) marks.push({ t: starts[i], title });
  });
  if (!marks.length) return [];
  if (marks[0].t > 0) marks.unshift({ t: 0, title: pub.intro || 'Intro' });
  const from = range ? Math.max(0, range.start) : 0;
  const to = range ? range.end : timelineDuration(doc);
  // The chapter running at the start of the range starts the export.
  const at = marks.filter((m) => m.t <= from + 1e-6).pop();
  const inRange = [...(at ? [{ ...at, t: from }] : []), ...marks.filter((m) => m.t > from + 1e-6 && m.t < to)].map((m) => ({ ...m, t: m.t - from }));
  const out: Chapter[] = [];
  for (const m of inRange) {
    const prev = out[out.length - 1];
    // Too close to the one before (YouTube needs 10 s per chapter): a short intro gives way to
    // the first hole, otherwise the one before runs on.
    if (prev && m.t - prev.t < CHAPTER_MIN_S) {
      if (out.length === 1) prev.title = m.title;
      continue;
    }
    out.push(m);
  }
  if (out.length && to - from - out[out.length - 1].t < CHAPTER_MIN_S) out.pop();
  return out.length >= CHAPTERS_MIN ? out : [];
}

/** "1:12" or "1:02:05" as YouTube reads chapter times. */
export function chapterClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Description and chapters as one text to paste into YouTube ('' when there is nothing). */
export function publishText(doc: Pick<Project, 'clips' | 'media' | 'publish'>, range?: { start: number; end: number } | null): string {
  const chapters = timelineChapters(doc, range);
  return [doc.publish?.description?.trim() ?? '', chapters.map((c) => `${chapterClock(c.t)} ${c.title}`).join('\n')].filter(Boolean).join('\n\n');
}
