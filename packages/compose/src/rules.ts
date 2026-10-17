/**
 * The plan without AI: the preference read by keywords (Danish and English) and the doubts
 * found by fixed rules. Always gives a valid plan; an AI model may only adjust this one.
 */
import { TEMPLATES } from '@golf/render';
import type { WarningCode } from '@golf/schema';
import { compareShots, sameShotPairs, strikeGroups, type ShotMatch } from './match';
import { defaultPutts, puttQuestionId, REASON_CODES, VideoPlan, type PlanItem, type PlanKind, type PlanQuestion, type PuttMode, type ReasonCode } from './plan';
import type { ClipSummary, HighlightTag, RoundSummary, ShotSummary, StrokeSummary } from './summary';

type Locale = 'da' | 'en';

/** Analysis warnings that make a flight doubtful. */
export const DOUBT_FLAGS: readonly WarningCode[] = ['no_track', 'implausible', 'carry_mismatch', 'default_path', 'off_frame'];
/** Below this confidence a shot is doubtful too. */
export const LOW_CONFIDENCE = 0.6;
/** Seconds of a clip without shots used as a mood shot in the YouTube video. */
export const BROLL_S = 6;

export interface Preference {
  kind: PlanKind | null;
  /** "only good shots": doubtful shots and retakes default to being left out. */
  goodOnly: boolean;
  /** "the best shots": only the highlights (see `highlightScore`) are kept. */
  best: boolean;
  template: string | null;
  title: string | null;
  /** Which putts to show, when the wish says. */
  putts: PuttMode | null;
}

/** One thing the rules understood in the wish, for the apps to show as a chip. */
export type PreferenceChip =
  | { key: 'kind'; value: PlanKind }
  | { key: 'goodOnly' }
  | { key: 'best' }
  | { key: 'template'; value: string }
  | { key: 'putts'; value: PuttMode }
  | { key: 'title'; value: string };

const KINDS: [PlanKind, string[]][] = [
  ['shorts', ['hvert slag', 'hver slag', 'each shot', 'every shot', 'per shot', 'pr. slag', 'per slag', 'one short per', 'en short per']],
  ['highlight', ['short', 'reel', 'tiktok', 'lodret', 'vertical', 'portrait', 'highlight', 'stående', '9:16']],
  ['youtube', ['youtube', 'hele runden', 'whole round', 'full round', 'lang video', 'long video', 'vandret', 'landscape', '16:9']],
];
const GOOD = ['kun gode slag', 'kun de gode slag', 'kun gode', 'kun de gode', 'only good shots', 'only the good shots', 'only good', 'only the good'];
const BEST = ['best shots', 'bedste slag', 'de bedste', 'only the best', 'kun de bedste', 'highlights', 'top shots'];
const TEMPLATE_WORDS: [string, string[]][] = [
  ['minimal', ['rolig', 'enkel', 'minimal', 'calm', 'simple', 'clean', 'diskret', 'subtle']],
  ['tv', [' tv', 'tv-', 'broadcast', 'fjernsyn']],
  ['neon', ['neon']],
  ['holeInOne', ['hole in one', 'hole-in-one']],
];
const PUTT_WORDS: [PuttMode, string[]][] = [
  ['none', ['uden putt', 'ingen putt', 'no putt', 'without putt', 'skip putt', 'skip the putt', 'uden putning', 'no putting', 'without putting']],
  [
    'holed',
    ['putts der går i', 'putt der går i', 'putts, der går i', 'putts i hul', 'holed putt', 'putts that drop', 'putts that go in', 'putts that went in'],
  ],
  ['all', ['alle putts', 'all putts', 'all the putts', 'med putts', 'with putts', 'include putts', 'hele putningen', 'every putt']],
];
/** Small words that carry no wish of their own (Danish and English). */
const FILLER = new Set(
  (
    'a an the of and or with for to in on at by my me i want would like please make some it is be just also so that this from as ' +
    'video film clip clips round golf golfrunde og en et af med til fra i på min mit mine mig lav laver gerne jeg vil have den det de der som kan ' +
    'du venligst tak runde runden runder også bare så om lidt være skal meget stil style look'
  ).split(' '),
);

/**
 * The wish read with plain keywords (Danish and English), with what was understood and the
 * words that were not (shown to the user before the video is made when there is no AI).
 */
export function explainPreference(text: string): { preference: Preference; understood: PreferenceChip[]; unknown: string[] } {
  const t = ` ${text.toLocaleLowerCase()} `;
  const covered: [number, number][] = [];
  const has = (words: string[]) => {
    let hit = false;
    for (const w of words)
      for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
        covered.push([i, i + w.length]);
        hit = true;
      }
    return hit;
  };
  const first = <T>(lists: [T, string[]][]): T | null => lists.map(([v, w]) => (has(w) ? v : null)).find((v) => v !== null) ?? null;
  const kind = first(KINDS);
  const good = has(GOOD);
  const best = has(BEST);
  const template = first(TEMPLATE_WORDS);
  const putts = first(PUTT_WORDS);
  const quoted = text.match(/["“”«]([^"“”»]{2,120})["“”»]/);
  if (quoted?.index !== undefined) covered.push([quoted.index + 1, quoted.index + 1 + quoted[0].length]);
  const preference: Preference = { kind, goodOnly: good || best, best, template, title: quoted ? quoted[1].trim() : null, putts };

  const understood: PreferenceChip[] = [];
  if (kind) understood.push({ key: 'kind', value: kind });
  if (best) understood.push({ key: 'best' });
  else if (good) understood.push({ key: 'goodOnly' });
  if (template) understood.push({ key: 'template', value: template });
  if (putts) understood.push({ key: 'putts', value: putts });
  if (preference.title) understood.push({ key: 'title', value: preference.title });

  const unknown: string[] = [];
  for (const m of t.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’:-]*/gu)) {
    const a = m.index;
    const b = a + m[0].length;
    if (covered.some(([x, y]) => a < y && b > x)) continue;
    const w = m[0].replace(/[-'’:]+$/, '');
    if (w.length < 2 || FILLER.has(w) || unknown.includes(w)) continue;
    unknown.push(w);
  }
  return { preference, understood, unknown: unknown.slice(0, 20) };
}

/** Reads the free-text preference with plain keywords; anything not recognised keeps the default. */
export function readPreference(text: string): Preference {
  return explainPreference(text).preference;
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
    order: (list: string, n: number) =>
      `${list} har ingen sikker optagetid, så ${n === 1 ? 'dets' : 'deres'} plads er gættet ud fra filnavn og fildato. Er rækkefølgen rigtig?`,
    holeIn: (hole: string, clip: string) => `${hole} i ${clip}`,
    conflict: (a: string, b: string) => `Optagetiderne siger, at ${a} blev filmet før ${b}. Passer det?`,
    byName: 'Ja, behold rækkefølgen',
    asFilmed: 'Ja, som de blev filmet',
    asAdded: 'Nej, brug rækkefølgen klippene blev tilføjet i',
    byHoles: 'Nej, sorter efter hulnummer',
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
    sameKept: (shot: string, clips: string, kept: string) => `${shot} er filmet fra flere vinkler: ${clips}. Vi bruger ${kept}.`,
    clip: (n: number, name: string) => `klip ${n} (${name})`,
    noAi: 'Planen er lavet med faste regler (ingen AI).',
    defaultKind: 'Formatet er ikke nævnt, så det bliver en YouTube-video.',
    noShotsAtAll: 'Der er ingen slag at lave video af endnu.',
    skipped: (list: string) => `Klip uden slag springes over: ${list}.`,
    reasons: {
      practice_swing: 'Der lød et slag, men bolden blev ikke fundet – måske et prøvesving',
      no_track: 'Bolden blev ikke fundet i luften, så banen er gættet',
      implausible: 'Banen ligner ikke et rigtigt slag (for langsom, for kort eller passer dårligt)',
      default_path: 'Banen er en standardbane, ikke målt',
      off_frame: 'Banen er gættet – tjek den (analysen lagde den uden for billedet)',
      carry_mismatch: 'Længden passer ikke med den carry, der er skrevet ind',
      hole_limit: 'Landede længere væk end hullet tillader, så banen er forkortet',
      few_points: 'Bolden blev kun set kortvarigt',
      start_extrapolated: 'Bolden ved opstilling blev ikke fundet',
      short_shot: 'Ligner en chip eller et putt',
      low_confidence: 'Analysen er usikker på slaget',
      retake: 'Slået fra næsten samme sted kort efter et andet slag',
      same_shot: 'Ser ud til at være samme slag filmet fra en anden vinkel',
      next_shot_distance: 'Næste slag blev filmet {next} m herfra, men banen viser {carry} m',
      putt_count_unsure: 'Analysen er usikker på antallet af putts',
    } satisfies Record<ReasonCode, string>,
    putts: (hole: string, n: number) =>
      `${hole[0].toUpperCase()}${hole.slice(1)}: analysen fandt ${n === 1 ? 'et putt' : `${n} putts`}, men er usikker. Hvor mange putts var der?`,
    puttN: (n: number) => `${n === 4 ? '4+' : n} ${n === 1 ? 'putt' : 'putts'}, i hul`,
    notHoled: 'Ikke i hul / ikke filmet til ende',
    at: (n: number, time: string) => `Klip ${n} · ${time}`,
    longest: (m: number) => `Dagens længste: ${m} m`,
    close: 'Indspil tæt på',
    bestOnly: (n: number, of: number) => `Kun de bedste slag: ${n} af ${of} (birdies, længste slag og tætte indspil først).`,
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
    order: (list: string, n: number) =>
      `${list} ${n === 1 ? 'has' : 'have'} no reliable recording time, so ${n === 1 ? 'its' : 'their'} place is a guess from the file name and date. Is the order right?`,
    holeIn: (hole: string, clip: string) => `${hole} in ${clip}`,
    conflict: (a: string, b: string) => `The recording times say ${a} was filmed before ${b}. Is that right?`,
    byName: 'Yes, keep this order',
    asFilmed: 'Yes, as filmed',
    asAdded: 'No, use the order the clips were added in',
    byHoles: 'No, order by hole number',
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
    sameKept: (shot: string, clips: string, kept: string) => `${shot} was filmed from more than one angle: ${clips}. Using ${kept}.`,
    clip: (n: number, name: string) => `clip ${n} (${name})`,
    noAi: 'The plan was made with fixed rules (no AI).',
    defaultKind: 'No format was mentioned, so it will be a YouTube video.',
    noShotsAtAll: 'There are no shots to make a video of yet.',
    skipped: (list: string) => `Clips without shots are skipped: ${list}.`,
    reasons: {
      practice_swing: 'A strike was heard but no ball was found – maybe a practice swing',
      no_track: 'The ball was not found in the air, so the path is a guess',
      implausible: 'The path does not look like a real shot (too slow, too short or a poor fit)',
      default_path: 'The path is a default one, not measured',
      off_frame: 'The path is a guess – check it (the analysis put it outside the picture)',
      carry_mismatch: 'The length does not fit the carry that was entered',
      hole_limit: 'Landed further than the hole allows, so the path was shortened',
      few_points: 'The ball was only seen briefly',
      start_extrapolated: 'The ball at address was not found',
      short_shot: 'Looks like a chip or a putt',
      low_confidence: 'The analysis is unsure about this shot',
      retake: 'Hit from almost the same spot shortly after another shot',
      same_shot: 'Looks like the same shot filmed from another angle',
      next_shot_distance: 'The next stroke was filmed {next} m from here, but the flight shows {carry} m',
      putt_count_unsure: 'The analysis is unsure how many putts there were',
    } satisfies Record<ReasonCode, string>,
    putts: (hole: string, n: number) =>
      `${hole[0].toUpperCase()}${hole.slice(1)}: the analysis found ${n === 1 ? 'one putt' : `${n} putts`} but is unsure. How many putts were there?`,
    puttN: (n: number) => `${n === 4 ? '4+' : n} ${n === 1 ? 'putt' : 'putts'}, holed`,
    notHoled: 'Not holed / not filmed to the end',
    at: (n: number, time: string) => `Clip ${n} · ${time}`,
    longest: (m: number) => `Longest of the day: ${m} m`,
    close: 'Close approach',
    bestOnly: (n: number, of: number) => `Only the best shots: ${n} of ${of} (birdies, the longest shot and close approaches first).`,
  },
};

export function isDoubtful(s: ShotSummary): boolean {
  return s.confidence < LOW_CONFIDENCE || s.flags.some((f) => DOUBT_FLAGS.includes(f)) || !!s.nextOff;
}

/** Why a shot is doubtful, most telling first. No ball in the air and low confidence reads as a practice swing. */
export function shotReasons(s: ShotSummary, ...extra: ReasonCode[]): ReasonCode[] {
  const out = new Set<ReasonCode>(extra);
  for (const f of s.flags) if ((REASON_CODES as readonly string[]).includes(f)) out.add(f as ReasonCode);
  if (s.confidence < LOW_CONFIDENCE) out.add('low_confidence');
  if (s.nextOff) out.add('next_shot_distance');
  if (out.has('no_track') && out.has('low_confidence')) {
    out.delete('no_track');
    out.delete('low_confidence');
    out.add('practice_swing');
  }
  return [...out].sort((a, b) => REASON_CODES.indexOf(a) - REASON_CODES.indexOf(b));
}

/** A reason in plain words (`next_shot_distance` with the item's distances). */
export function reasonText(code: ReasonCode, locale: Locale = 'en', item?: Pick<PlanItem, 'nextM' | 'carryM'>): string {
  return L[locale].reasons[code].replace('{next}', String(item?.nextM ?? '?')).replace('{carry}', String(item?.carryM ?? '?'));
}

/** "4:07" from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Clip 4 · 0:37": where an item is in the video. */
export function itemPlace(item: Pick<PlanItem, 'clip' | 't'>, locale: Locale = 'en'): string {
  return L[locale].at(item.clip, clock(item.t));
}

/** A rough quality score for "only the best": confident, tracked shots win. */
export function shotScore(s: ShotSummary): number {
  return s.confidence - (isDoubtful(s) ? 1 : 0) - s.flags.length * 0.05;
}

/** What each highlight adds to a shot's rank for "the best shots" (see summary.ts tagHighlights). */
export const TAG_BONUS: Record<HighlightTag, number> = { eagle: 3, birdie: 2, longest: 1.5, close: 1.5, long_putt: 1.5 };
/** Shots kept for "the best shots" besides every tagged one. */
export const BEST_N = 6;

/** Golf quality first (eagle, birdie, longest, close approach), then the analysis' confidence. */
export function highlightScore(s: ShotSummary): number {
  return shotScore(s) + (s.tags ?? []).reduce((n, t) => n + TAG_BONUS[t], 0);
}

/** The best shots of a round: every tagged, undoubted one, filled up to BEST_N by `highlightScore`. */
export function bestShots(shots: ShotSummary[]): ShotSummary[] {
  const ranked = shots.filter((x) => !isDoubtful(x)).sort((a, b) => highlightScore(b) - highlightScore(a));
  const tagged = ranked.filter((x) => x.tags?.length);
  const keep = new Set([...tagged, ...ranked.slice(0, Math.max(0, BEST_N - tagged.length))]);
  return shots.filter((x) => keep.has(x));
}

/** A line for the shots worth a word: the longest measured carry, a close approach. */
export function highlightTexts(shots: ShotSummary[], locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of shots) {
    if (x.tags?.includes('longest') && x.carryM !== null) out[x.id] = L[locale].longest(x.carryM);
    else if (x.tags?.includes('close')) out[x.id] = L[locale].close;
  }
  return out;
}

/** The better angle of one strike: a confident, long track, filmed the way the video is shown. */
export function angleScore(s: ShotSummary, clip: ClipSummary | undefined, kind: PlanKind): number {
  return shotScore(s) + Math.min(s.trackPts, 60) / 300 + (clip && clip.portrait === (kind !== 'youtube') ? 0.1 : 0);
}

/**
 * Consecutive strikes that look like a retake: same hole, shortly after, close to the same spot.
 * A strike filmed from two angles counts once (`same` joins them, `pick` names the one to show);
 * a pair that is one strike or two players' strikes is no retake.
 */
export function retakePairs(
  s: RoundSummary,
  same: ShotMatch[] = sameShotPairs(s),
  pick: (g: ShotSummary[]) => ShotSummary = (g) => g[0],
): [ShotSummary, ShotSummary][] {
  const clip = new Map(s.clips.map((c) => [c.id, c]));
  const groups = strikeGroups(s, same);
  const out: [ShotSummary, ShotSummary][] = [];
  for (let i = 1; i < groups.length; i++) {
    const a = pick(groups[i - 1]);
    const b = pick(groups[i]);
    // Judged on one camera's view when a clip saw both strikes.
    let pair: [ShotSummary, ShotSummary] = [a, b];
    for (const x of groups[i - 1]) for (const y of groups[i]) if (x.clipId === y.clipId) pair = [x, y];
    const [x, y] = pair;
    const cx = clip.get(x.clipId);
    const cy = clip.get(y.clipId);
    if (cx && cy && compareShots(x, y, cx, cy).verdict === 'retake') out.push([a, b]);
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

/** Template ids a plan may use (all of them; nothing here is behind a plan). */
export function templatesFor(): string[] {
  return TEMPLATES.map((t) => t.id);
}

/**
 * The plan by fixed rules. `opts.kind` is the format the user picked (a card in the dialog): it
 * wins over any format word in the wish, which can then only add to it ("only good shots" …).
 */
export function planFromRules(s: RoundSummary, preference: string, locale: Locale = 'en', opts: { kind?: PlanKind | null } = {}): VideoPlan {
  const T = L[locale];
  const pref = readPreference(preference);
  const questions: PlanQuestion[] = [];
  const notes: string[] = [T.noAi];
  if (!opts.kind && !pref.kind) notes.push(T.defaultKind);
  if (!s.shots.length) notes.push(T.noShotsAtAll);
  const kind = opts.kind ?? pref.kind ?? 'youtube';
  const clipName = (id: string) => {
    const c = s.clips.find((x) => x.id === id)!;
    return T.clip(c.n, c.name);
  };
  const item = (x: ShotSummary | StrokeSummary, ...extra: ReasonCode[]): PlanItem => ({
    shotId: x.id,
    mediaId: x.clipId,
    clip: x.clip,
    clipName: s.clips.find((c) => c.id === x.clipId)?.name ?? '',
    t: x.t,
    reasons: 'kind' in x ? extra : shotReasons(x, ...extra),
    ...('kind' in x || !x.nextOff || x.nextM == null || x.carryM === null ? {} : { nextM: x.nextM, carryM: x.carryM }),
  });
  const clipOf = new Map(s.clips.map((c) => [c.id, c]));
  const best = (g: ShotSummary[]) => g.reduce((x, y) => (angleScore(y, clipOf.get(y.clipId), kind) > angleScore(x, clipOf.get(x.clipId), kind) ? y : x));

  // One strike filmed from several angles: sure ones keep the better angle, the rest is asked below.
  const same = sameShotPairs(s);
  const sureGroups = strikeGroups(
    s,
    same.filter((m) => m.sure),
  );
  const keptOf = new Map<string, ShotSummary>();
  for (const g of sureGroups) {
    if (g.length < 2) continue;
    const kept = best(g);
    for (const x of g) keptOf.set(x.id, kept);
    const shot = T.shot(kept);
    notes.push(T.sameKept(shot[0].toUpperCase() + shot.slice(1), g.map((x) => clipName(x.clipId)).join(', '), clipName(kept.clipId)));
  }
  const dropped = new Set([...keptOf].filter(([id, kept]) => id !== kept.id).map(([id]) => id));

  // Shots the analysis is unsure about.
  const doubtful = s.shots.filter((x) => isDoubtful(x) && !dropped.has(x.id));
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
      items: doubtful.slice(0, 200).map((x) => item(x)),
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

  // The order only needs a question when the times are missing or contradict the holes.
  const conflict = s.order.conflict?.map((id) => s.clips.find((c) => c.id === id)!);
  const untimed = s.clips.filter((c) => s.order.unsure.includes(c.id));
  const holes = s.order.by !== 'hole' && s.clips.filter((c) => /^\d+$/.test(c.hole)).length >= 2 ? [{ id: 'holes', label: T.byHoles }] : [];
  if (conflict && s.clips.length > 1)
    questions.push({
      id: 'order',
      text: T.conflict(...(conflict.map((c) => T.holeIn(T.hole(c.hole), T.clip(c.n, c.name))) as [string, string])),
      options: [{ id: 'filmed', label: T.asFilmed }, ...holes],
      default: 'filmed',
      shotIds: [],
      clipIds: conflict.map((c) => c.id),
    });
  else if (untimed.length && s.clips.length > 1)
    questions.push({
      id: 'order',
      text: T.order(list(untimed.map((c) => T.clip(c.n, c.name))), untimed.length),
      options: [{ id: 'filename', label: T.byName }, { id: 'added', label: T.asAdded }, ...holes],
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
  for (const [a, b] of retakePairs(s, same, best))
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
      items: [item(a, 'retake'), item(b, 'retake')],
    });

  // Maybe the same shot filmed in two clips.
  const asked = new Set<string>();
  for (const m of same) {
    if (m.sure) continue;
    const pair = [keptOf.get(m.a.id) ?? m.a, keptOf.get(m.b.id) ?? m.b];
    const [a, b] = s.shots.filter((x) => pair.includes(x));
    if (!b || asked.has(`${a.id}:${b.id}`)) continue;
    asked.add(`${a.id}:${b.id}`);
    const better = best([a, b]);
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
      items: [item(a, 'same_shot'), item(b, 'same_shot')],
    });
  }

  // Putts the analysis is unsure about, per hole. The id and options are fixed so another step
  // (e.g. a vision model) can fill in answers before the user sees them:
  //   id `putts:<hole>`; options '1', '2', '3' = that many putts, the last holed; '4' = four or
  //   more, the last holed; 'notHoled' = the last did not drop (or was not filmed to the end).
  // The answer sets the hole's score and the putts shown (the last N of those found).
  // Asked for the YouTube video's score, and wherever putts are shown (shorts show none by default).
  const putts = pref.putts ?? null;
  if (kind === 'youtube' || (putts ?? defaultPutts(kind)) !== 'none')
    for (const h of s.holes) {
      if (!h.puttsUnsure) continue;
      const list = s.putts.filter((p) => p.hole === h.hole);
      const last = list[list.length - 1];
      questions.push({
        id: puttQuestionId(h.hole),
        text: T.putts(T.hole(h.hole), list.length),
        options: [...[1, 2, 3, 4].map((n) => ({ id: String(n), label: T.puttN(n) })), { id: 'notHoled', label: T.notHoled }],
        default: last.holed === true ? String(Math.min(4, list.length)) : 'notHoled',
        shotIds: list.map((p) => p.id),
        clipIds: [...new Set(list.map((p) => p.clipId))],
        items: list.slice(0, 200).map((p) => item(p, 'putt_count_unsure')),
      });
    }

  const template = pref.template && templatesFor().includes(pref.template) ? pref.template : null;
  let included = s.shots.filter((x) => !dropped.has(x.id));
  if (pref.best && included.length > BEST_N) {
    const kept = bestShots(included);
    if (kept.length && kept.length < included.length) {
      notes.push(T.bestOnly(kept.length, included.length));
      included = kept;
    }
  }
  const texts = highlightTexts(included, locale);
  return VideoPlan.parse({
    kind,
    template,
    ...(putts ? { putts } : {}),
    includeShotIds: included.map((x) => x.id),
    ...(Object.keys(texts).length ? { shotTexts: texts } : {}),
    title: pref.title ?? defaultTitle(s, locale),
    questions: questions.slice(0, 12),
    notes: notes.slice(0, 10).map((n) => n.slice(0, 300)),
  });
}
