/**
 * The plan without AI: the preference read by keywords (Danish and English) and the doubts
 * found by fixed rules. Always gives a valid plan; an AI model may only adjust this one.
 */
import type { WarningCode } from '@golf/schema';
import { VideoPlan, type PlanKind, type PlanQuestion } from './plan';
import type { RoundSummary, ShotSummary } from './summary';

type Locale = 'da' | 'en';

/** Analysis warnings that make a flight doubtful. */
export const DOUBT_FLAGS: readonly WarningCode[] = ['no_track', 'implausible', 'carry_mismatch', 'default_path'];
/** Below this confidence a shot is doubtful too. */
export const LOW_CONFIDENCE = 0.6;
/** Retakes: the next shot on the same hole within this many seconds and close to the same spot. */
const RETAKE_S = 180;
const RETAKE_SPOT = 0.08;
/** The same strike filmed by two cameras lands this close in time. */
const SAME_SHOT_S = 1.5;
/** Seconds of a clip without shots used as a mood shot in the YouTube video. */
export const BROLL_S = 6;

export interface Preference {
  kind: PlanKind | null;
  /** "only good shots": doubtful shots and retakes default to being left out. */
  goodOnly: boolean;
  template: string | null;
  title: string | null;
}

const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

/** Reads the free-text preference with plain keywords; anything not recognised keeps the default. */
export function readPreference(text: string): Preference {
  const t = ` ${text.toLocaleLowerCase()} `;
  let kind: PlanKind | null = null;
  if (has(t, ['hvert slag', 'hver slag', 'each shot', 'every shot', 'per shot', 'pr. slag', 'per slag', 'one short per', 'en short per'])) kind = 'shorts';
  else if (has(t, ['short', 'reel', 'tiktok', 'lodret', 'vertical', 'portrait', 'highlight', 'stående', '9:16'])) kind = 'highlight';
  else if (has(t, ['youtube', 'hele runden', 'whole round', 'full round', 'lang video', 'long video', 'vandret', 'landscape', '16:9'])) kind = 'youtube';
  const goodOnly = has(t, [
    'kun gode',
    'kun de gode',
    'only good',
    'only the good',
    'best shots',
    'bedste slag',
    'de bedste',
    'only the best',
    'kun de bedste',
  ]);
  let template: string | null = null;
  if (has(t, ['rolig', 'enkel', 'minimal', 'calm', 'simple', 'clean', 'diskret', 'subtle'])) template = 'minimal';
  else if (has(t, [' tv', 'tv-', 'broadcast', 'fjernsyn'])) template = 'tv';
  else if (has(t, ['neon'])) template = 'neon';
  else if (has(t, ['hole in one', 'hole-in-one'])) template = 'holeInOne';
  const quoted = text.match(/["“”«]([^"“”»]{2,120})["“”»]/);
  return { kind, goodOnly, template, title: quoted ? quoted[1].trim() : null };
}

const L = {
  da: {
    hole: (h: string) => `hul ${h}`,
    shot: (s: ShotSummary) => `slag ${s.n}${s.hole ? ` (hul ${s.hole})` : ''}`,
    doubtful: (list: string, n: number) => `${n === 1 ? 'Et slag har' : `${n} slag har`} en usikker bane: ${list}. Skal ${n === 1 ? 'det' : 'de'} med?`,
    keep: 'Ja, tag dem med',
    drop: 'Nej, udelad dem',
    noShots: (list: string, n: number) =>
      `Der blev ikke fundet slag i ${n === 1 ? 'et klip' : `${n} klip`}: ${list}. Hvad skal der ske med ${n === 1 ? 'det' : 'dem'}?`,
    skip: 'Spring over',
    broll: `Brug som stemningsklip (op til ${BROLL_S} s)`,
    order: (list: string) => `${list} har ingen optagetid, så rækkefølgen bygger på filnavnet. Er det rigtigt?`,
    byName: 'Ja, brug filnavnene',
    asAdded: 'Nej, brug rækkefølgen klippene blev tilføjet i',
    gps: (clip: string, prev: string, next: string) => `${clip} har ingen GPS. Hvilket hul er det (klippet før er ${prev}, klippet efter er ${next})?`,
    samePrev: (h: string) => `Samme som klippet før (${h})`,
    sameNext: (h: string) => `Samme som klippet efter (${h})`,
    unknown: 'Ved ikke – intet hulkort',
    retake: (a: string, b: string) => `${a} og ${b} er slået tæt på samme sted kort efter hinanden. Er det et omslag?`,
    both: 'Tag begge med',
    last: 'Kun det sidste',
    best: 'Kun det bedste',
    same: (a: string, b: string) => `${a} og ${b} ser ud til at være det samme slag filmet fra to vinkler. Hvilket skal bruges?`,
    use: (s: string) => `Brug ${s}`,
    bothAngles: 'Begge (som gentagelse)',
    clip: (n: number, name: string) => `klip ${n} (${name})`,
    noAi: 'Planen er lavet med faste regler (ingen AI).',
    defaultKind: 'Formatet er ikke nævnt, så det bliver en YouTube-video.',
    noShotsAtAll: 'Der er ingen slag at lave video af endnu.',
    skipped: (list: string) => `Klip uden slag springes over: ${list}.`,
  },
  en: {
    hole: (h: string) => `hole ${h}`,
    shot: (s: ShotSummary) => `shot ${s.n}${s.hole ? ` (hole ${s.hole})` : ''}`,
    doubtful: (list: string, n: number) => `${n === 1 ? 'One shot has' : `${n} shots have`} an uncertain flight: ${list}. Include ${n === 1 ? 'it' : 'them'}?`,
    keep: 'Yes, include them',
    drop: 'No, leave them out',
    noShots: (list: string, n: number) =>
      `No shots were found in ${n === 1 ? 'one clip' : `${n} clips`}: ${list}. What should happen to ${n === 1 ? 'it' : 'them'}?`,
    skip: 'Skip',
    broll: `Use as a mood shot (up to ${BROLL_S} s)`,
    order: (list: string) => `${list} have no recording time, so the order is based on the file names. Is that right?`,
    byName: 'Yes, use the file names',
    asAdded: 'No, use the order the clips were added in',
    gps: (clip: string, prev: string, next: string) => `${clip} has no GPS. Which hole is it (the clip before is ${prev}, the clip after is ${next})?`,
    samePrev: (h: string) => `Same as the clip before (${h})`,
    sameNext: (h: string) => `Same as the clip after (${h})`,
    unknown: "Don't know – no hole card",
    retake: (a: string, b: string) => `${a} and ${b} were hit close to the same spot shortly after each other. Is it a retake?`,
    both: 'Keep both',
    last: 'Only the last one',
    best: 'Only the best one',
    same: (a: string, b: string) => `${a} and ${b} look like the same shot filmed from two angles. Which should be used?`,
    use: (s: string) => `Use ${s}`,
    bothAngles: 'Both (as a replay)',
    clip: (n: number, name: string) => `clip ${n} (${name})`,
    noAi: 'The plan was made with fixed rules (no AI).',
    defaultKind: 'No format was mentioned, so it will be a YouTube video.',
    noShotsAtAll: 'There are no shots to make a video of yet.',
    skipped: (list: string) => `Clips without shots are skipped: ${list}.`,
  },
};

export function isDoubtful(s: ShotSummary): boolean {
  return s.confidence < LOW_CONFIDENCE || s.flags.some((f) => DOUBT_FLAGS.includes(f));
}

/** A rough quality score for "only the best": confident, tracked shots win. */
export function shotScore(s: ShotSummary): number {
  return s.confidence - (isDoubtful(s) ? 1 : 0) - s.flags.length * 0.05;
}

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/** Consecutive shots that look like a retake: same hole, shortly after, close to the same spot. */
export function retakePairs(s: RoundSummary): [ShotSummary, ShotSummary][] {
  const out: [ShotSummary, ShotSummary][] = [];
  for (let i = 1; i < s.shots.length; i++) {
    const a = s.shots[i - 1];
    const b = s.shots[i];
    if (!a.hole || a.hole !== b.hole) continue;
    const ta = ms(a.at);
    const tb = ms(b.at);
    const gap = ta !== null && tb !== null ? (tb - ta) / 1000 : a.clipId === b.clipId ? b.t - a.t : null;
    if (gap === null || gap <= SAME_SHOT_S * 2 || gap > RETAKE_S) continue;
    // In one clip the tee spot must match; across clips the same hole and time are enough.
    if (a.clipId === b.clipId && Math.hypot(a.x - b.x, a.y - b.y) > RETAKE_SPOT) continue;
    out.push([a, b]);
  }
  return out;
}

/** The same strike in two clips (two cameras running at once). */
export function sameShotPairs(s: RoundSummary): [ShotSummary, ShotSummary][] {
  const out: [ShotSummary, ShotSummary][] = [];
  for (let i = 0; i < s.shots.length; i++)
    for (let j = i + 1; j < s.shots.length; j++) {
      const a = s.shots[i];
      const b = s.shots[j];
      const ta = ms(a.at);
      const tb = ms(b.at);
      if (a.clipId !== b.clipId && ta !== null && tb !== null && Math.abs(ta - tb) <= SAME_SHOT_S * 1000) out.push([a, b]);
    }
  return out;
}

function list(items: string[]): string {
  return items.length > 4 ? `${items.slice(0, 4).join(', ')} …` : items.join(', ');
}

/** The default title: course and day, else the project's name. */
export function defaultTitle(s: RoundSummary, locale: Locale): string {
  const d = s.date ? new Date(`${s.date}T12:00:00Z`) : null;
  const day = d ? d.toLocaleDateString(locale === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return [s.course, day].filter(Boolean).join(' · ') || s.name || 'Golf';
}

export function planFromRules(s: RoundSummary, preference: string, locale: Locale = 'en'): VideoPlan {
  const T = L[locale];
  const pref = readPreference(preference);
  const questions: PlanQuestion[] = [];
  const notes: string[] = [T.noAi];
  if (!pref.kind) notes.push(T.defaultKind);
  if (!s.shots.length) notes.push(T.noShotsAtAll);
  const kind = pref.kind ?? 'youtube';
  const clipName = (id: string) => {
    const c = s.clips.find((x) => x.id === id)!;
    return T.clip(c.n, c.name);
  };

  // Shots the analysis is unsure about.
  const doubtful = s.shots.filter(isDoubtful);
  if (doubtful.length)
    questions.push({
      id: 'doubtful',
      text: T.doubtful(list(doubtful.map(T.shot)), doubtful.length),
      options: [
        { id: 'keep', label: T.keep },
        { id: 'drop', label: T.drop },
      ],
      default: pref.goodOnly ? 'drop' : 'keep',
      shotIds: doubtful.map((x) => x.id),
      clipIds: [],
    });

  // Clips where no shot was found: only the YouTube video can use them (as a mood shot).
  const empty = s.clips.filter((c) => c.shots === 0);
  if (empty.length && kind === 'youtube')
    questions.push({
      id: 'noShots',
      text: T.noShots(list(empty.map((c) => T.clip(c.n, c.name))), empty.length),
      options: [
        { id: 'skip', label: T.skip },
        { id: 'broll', label: T.broll },
      ],
      default: 'skip',
      shotIds: [],
      clipIds: empty.map((c) => c.id),
    });
  else if (empty.length) notes.push(T.skipped(list(empty.map((c) => T.clip(c.n, c.name)))));

  // Clips without a recording time: the order falls back to the file name.
  const untimed = s.clips.filter((c) => !c.recordedAt);
  if (untimed.length && s.clips.length > 1)
    questions.push({
      id: 'order',
      text: T.order(list(untimed.map((c) => T.clip(c.n, c.name)))),
      options: [
        { id: 'filename', label: T.byName },
        { id: 'added', label: T.asAdded },
      ],
      default: 'filename',
      shotIds: [],
      clipIds: untimed.map((c) => c.id),
    });

  // Clips without GPS between clips on known holes.
  s.clips.forEach((c, i) => {
    if (c.gps || c.hole || c.shots === 0) return;
    const prev = [...s.clips.slice(0, i)].reverse().find((x) => x.hole);
    const next = s.clips.slice(i + 1).find((x) => x.hole);
    if (!prev || !next) return;
    const options = [{ id: 'previous', label: T.samePrev(T.hole(prev.hole)) }];
    if (next.hole !== prev.hole) options.push({ id: 'next', label: T.sameNext(T.hole(next.hole)) });
    options.push({ id: 'unknown', label: T.unknown });
    questions.push({
      id: `gps:${c.id}`,
      text: T.gps(T.clip(c.n, c.name), T.hole(prev.hole), T.hole(next.hole)),
      options,
      default: 'previous',
      shotIds: [],
      clipIds: [c.id, prev.id, next.id],
    });
  });

  // Possible retakes (mulligans) on the same hole.
  for (const [a, b] of retakePairs(s))
    questions.push({
      id: `retake:${a.id}:${b.id}`,
      text: T.retake(T.shot(a), T.shot(b)),
      options: [
        { id: 'both', label: T.both },
        { id: 'last', label: T.last },
        { id: 'best', label: T.best },
      ],
      default: pref.goodOnly ? 'best' : 'both',
      shotIds: [a.id, b.id],
      clipIds: [],
    });

  // The same shot filmed in two clips.
  for (const [a, b] of sameShotPairs(s)) {
    const better = shotScore(b) > shotScore(a) ? b : a;
    questions.push({
      id: `same:${a.id}:${b.id}`,
      text: T.same(`${T.shot(a)}, ${clipName(a.clipId)}`, `${T.shot(b)}, ${clipName(b.clipId)}`),
      options: [
        { id: `keep:${a.id}`, label: T.use(T.shot(a)) },
        { id: `keep:${b.id}`, label: T.use(T.shot(b)) },
        { id: 'both', label: T.bothAngles },
      ],
      default: `keep:${better.id}`,
      shotIds: [a.id, b.id],
      clipIds: [a.clipId, b.clipId],
    });
  }

  const template = pref.template ?? null;
  return VideoPlan.parse({
    kind,
    template,
    includeShotIds: s.shots.map((x) => x.id),
    title: pref.title ?? defaultTitle(s, locale),
    questions: questions.slice(0, 12),
    notes,
  });
}
