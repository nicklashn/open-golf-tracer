/**
 * "Make a video": finished edits built from all the shots of a project (a round or a single
 * clip) – a YouTube video with titles, hole cards, stats and course maps, or one vertical
 * highlight short of every shot. Pure functions: the caller saves the result as a new project.
 */
import { holeFacts, shotStats } from '@golf/render';
import {
  byTimeline,
  migrateProject,
  newId,
  timelineDuration,
  type Clip,
  type Layer,
  type MediaRef,
  type Project,
  type ReframeKey,
  type Shot,
  type VideoClip,
} from '@golf/schema';
import { layerDefaults, type LayerNames } from './layers';
import { placeTitle } from './place';
import { defaultPutts, type PuttShow } from './plan';
import { LOW_CONFIDENCE } from './rules';
import { scoreName, toPar, type HoleScore } from './score';
import { PUTT_LEAD_S, PUTT_TAIL_S, puttEnd, puttShort, shortFor } from './shorts';
import { summarize } from './summary';

export type VideoKind = 'youtube' | 'highlight';

type Locale = 'da' | 'en';

/** Seconds kept after each landing in the YouTube edit: long enough to read the stats card. */
const AFTER_LANDING_S = 3.2;

/** Waits between putts longer than this are cut out (PUTT_TAIL_S after a stop, PUTT_LEAD_S before the next stroke). */
export const PUTT_GAP_S = 2.5;
/** The most putting of one green kept in a video (seconds); the earliest putts go first. */
export const PUTT_HOLE_MAX_S = 12;
/** After a holed putt that ends a scored hole: a little longer, for the score. */
const SCORE_HOLD_S = 1.5;
/** A holed putt worth a place in the highlight by default: the analysis is this sure of it ... */
export const NOTABLE_PUTT_CONF = 0.75;
/** ... and the ball rolled at least this long (seconds of real time: a putt of several metres). */
export const NOTABLE_PUTT_S = 3;
const SCORECARD_S = 7;

/** Visible full shots in the order they were played: timeline order of their clips, then time. */
export function playedShots(doc: Project): Shot[] {
  return doc.shots.filter((s) => s.visible && s.kind === 'full' && doc.media[s.mediaId]).sort(byTimeline(doc.clips));
}

/** The analysis is sure of this putt: confident and without a warning about the count. */
export const surePutt = (s: Shot) => s.confidence >= LOW_CONFIDENCE && !s.warnings.some((w) => w.code === 'putt_count_unsure');

/**
 * Visible putts to show (never traced), in playing order: 'holed' keeps those that went in,
 * 'best' only holed ones the analysis is sure of that rolled a long way. Putts on `skipHoles`
 * (holes whose putting is in doubt) are left out.
 */
export function shownPutts(doc: Project, mode: PuttShow, skipHoles: readonly string[] = []): Shot[] {
  if (mode === 'none') return [];
  const keep = (s: Shot) =>
    mode === 'all' ||
    (s.putt?.holed === true &&
      (mode === 'holed' || (s.confidence >= NOTABLE_PUTT_CONF && surePutt(s) && (puttEnd(s) - s.impactTime) / s.slowmo >= NOTABLE_PUTT_S)));
  return doc.shots
    .filter((s) => s.visible && s.kind === 'putt' && doc.media[s.mediaId] && !skipHoles.includes(doc.media[s.mediaId].place?.hole ?? '') && keep(s))
    .sort(byTimeline(doc.clips));
}

/** Holes whose putting is left out by default: the analysis is unsure of the putts and no one answered. */
export const unsurePuttHoles = (scores: readonly HoleScore[], settled: readonly string[] = []) =>
  scores.filter((h) => h.puttsUnsure && !settled.includes(h.hole)).map((h) => h.hole);

/**
 * The putting on one green as cuts of its clip, from PUTT_LEAD_S before each stroke to
 * PUTT_TAIL_S after its ball stops (`tail` after the last one); a wait between putts longer than
 * PUTT_GAP_S is cut out (`whole` keeps it, e.g. when a putt was not found). At most
 * PUTT_HOLE_MAX_S (seconds of real time) are kept: the earliest putts are dropped first, the
 * last one always stays. `putts` are of one clip, in order.
 */
export function puttCuts(putts: Shot[], media: MediaRef, whole = false, tail = PUTT_TAIL_S): { a: number; b: number; putts: Shot[] }[] {
  const out: { a: number; b: number; putts: Shot[] }[] = [];
  putts.forEach((p, i) => {
    const a = Math.max(0, p.impactTime - PUTT_LEAD_S * p.slowmo);
    const b = Math.min(media.duration, puttEnd(p) + (i === putts.length - 1 ? tail : PUTT_TAIL_S) * p.slowmo);
    const last = out[out.length - 1];
    const prev = putts[i - 1];
    if (last && (whole || p.impactTime - puttEnd(prev) <= PUTT_GAP_S * p.slowmo || a <= last.b)) {
      last.b = Math.max(last.b, b);
      last.putts.push(p);
    } else out.push({ a, b, putts: [p] });
  });
  const slowmo = putts[0]?.slowmo ?? 1;
  const cap = PUTT_HOLE_MAX_S * slowmo;
  const length = () => out.reduce((n, c) => n + c.b - c.a, 0);
  while (out.length > 1 && length() > cap) out.shift();
  const c = out[0];
  if (c && c.b - c.a > cap) {
    // One long cut: keep its end, starting no later than the stroke of its last putt.
    const lastPutt = c.putts[c.putts.length - 1];
    c.a = Math.max(c.a, Math.min(lastPutt.impactTime - PUTT_LEAD_S * slowmo, c.b - cap));
    c.putts = c.putts.filter((p) => p.impactTime >= c.a);
  }
  return out;
}

/** Putts grouped into greens: consecutive putts in one clip on one hole. */
function greens(putts: Shot[], doc: Project): Shot[][] {
  const out: Shot[][] = [];
  for (const p of putts) {
    const g = out[out.length - 1];
    const hole = (s: Shot) => doc.media[s.mediaId].place?.hole ?? '';
    if (g && g[0].mediaId === p.mediaId && hole(g[0]) === hole(p)) g.push(p);
    else out.push([p]);
  }
  return out;
}

export interface VideoOptions {
  /** Putts shown: default the holed putt of each hole in the YouTube video, notable holed ones in the highlight (see `defaultPutts`). */
  putts?: PuttShow;
  /** Holes whose putting is left out; default every hole whose putts are unsure (see `unsurePuttHoles`). */
  skipPutts?: readonly string[];
  /** Hole scores; default from the project itself (see score.ts). */
  scores?: HoleScore[];
  /** Holes whose putting is kept whole (more putts than were found). */
  uncut?: readonly string[];
}

interface Window {
  shot: Shot;
  media: MediaRef;
  /** Source seconds of launch and landing (slow-motion clips included). */
  launch: number;
  land: number;
  a: number;
  b: number;
}

function windowOf(shot: Shot, media: MediaRef, before: number, after: number): Window {
  const st = shotStats(shot);
  const launch = shot.impactTime + shot.timing.launchOffset;
  const land = launch + ((st?.flightTimeS ?? 4) / shot.timing.speed) * shot.slowmo;
  return { shot, media, launch, land, a: Math.max(0, launch - before), b: Math.min(media.duration, land + after) };
}

const isoDate = (s: string | null | undefined) => (s ? new Date(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null);

function dateLabel(doc: Project, locale: Locale): string {
  const first = Object.values(doc.media).find((m) => m.kind === 'video' && m.recordedAt);
  const d = isoDate(first?.recordedAt);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(locale === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}

function courseName(doc: Project): string {
  return Object.values(doc.media).find((m) => m.place?.course)?.place?.course ?? '';
}

/** What every generated layer needs: the frame it is placed in, the language and the layer names. */
interface Ctx {
  doc: Project;
  locale: Locale;
  names: LayerNames;
}

/** A layer from the editor's defaults (so it looks like one added by hand), placed and timed. */
function layer<T extends Layer['type']>(
  type: T,
  { doc, locale, names }: Ctx,
  start: number,
  end: number,
  at: { x: number; y: number } | null,
  props: Partial<Extract<Layer, { type: T }>['props']>,
  anim?: Partial<Pick<Layer, 'animIn' | 'animOut'>>,
): Layer {
  const l = layerDefaults(type, names, doc, start, locale) as Extract<Layer, { type: T }>;
  return {
    ...l,
    start,
    end: Math.max(start + 0.5, end),
    keyframes: at ? [{ ...l.keyframes[0], x: at.x, y: at.y }] : l.keyframes,
    ...anim,
    props: { ...l.props, ...props },
  } as Layer;
}

/**
 * A YouTube video of the round: every shot from just before the swing to just after the
 * landing, in the order played. Opening title (course, date), hole card when the hole changes,
 * stat card after each shot and the course map where one was measured. Vertical clips go in a
 * 16:9 frame on a blurred copy of themselves.
 */
export function youtubeVideo(doc: Project, locale: Locale, name: string, names: LayerNames = {}, opts: VideoOptions = {}): Project {
  const shots = playedShots(doc);
  const wins = shots.map((s) => windowOf(s, doc.media[s.mediaId], 3, AFTER_LANDING_S));
  const scores = opts.scores ?? summarize(doc).holes;
  const scored = new Map(scores.filter((h) => h.strokes !== null && h.par).map((h) => [h.hole, h]));
  const holeOf = (s: Shot) => doc.media[s.mediaId].place?.hole ?? '';

  // Full shots and the putting of each green, in playing order.
  interface Seg {
    media: MediaRef;
    a: number;
    b: number;
    key: number;
    win?: Window;
    putts?: Shot[];
  }
  const segs: Seg[] = wins.map((w) => ({ media: w.media, a: w.a, b: w.b, key: w.shot.impactTime, win: w }));
  const putts = shownPutts(doc, opts.putts ?? defaultPutts('youtube'), opts.skipPutts ?? unsurePuttHoles(scores));
  greens(putts, doc).forEach((g, i, all) => {
    const media = doc.media[g[0].mediaId];
    const hole = holeOf(g[0]);
    const last = g[g.length - 1];
    const ends = scored.has(hole) && last.putt?.holed === true && !all.slice(i + 1).some((x) => holeOf(x[0]) === hole);
    for (const c of puttCuts(g, media, !!hole && !!opts.uncut?.includes(hole), ends ? SCORE_HOLD_S : PUTT_TAIL_S))
      segs.push({ media, a: c.a, b: c.b, key: c.putts[0].impactTime, putts: c.putts });
  });
  const rank = new Map<string, number>();
  doc.clips.forEach((c, i) => rank.has(c.mediaId) || rank.set(c.mediaId, i));
  segs.sort((x, y) => (rank.get(x.media.id) ?? Infinity) - (rank.get(y.media.id) ?? Infinity) || x.key - y.key);

  const clips: Clip[] = [];
  /** Timeline times of a shot or a putting cut; `cut` is where its footage starts. */
  const at: { shot: Shot; launch: number; land: number; clipStart: number; cut: number; putt: boolean }[] = [];
  let t = 0;
  let clipStart = 0;
  let cur: VideoClip | null = null;
  for (const g of segs) {
    const last = clips[clips.length - 1];
    // Shots close together in one video share a clip instead of jumping back in time.
    if (last && last.kind === 'video' && last.mediaId === g.media.id && g.a <= last.out + 0.5) {
      t -= last.out - last.in;
      last.out = Math.max(last.out, g.b);
      t += last.out - last.in;
    } else {
      cur = { id: newId('c_'), kind: 'video', mediaId: g.media.id, in: g.a, out: g.b, speed: 1, volume: 1, muted: false };
      clips.push(cur);
      clipStart = t;
      t += g.b - g.a;
      // The ball lands after the video ends: hold the last frame while the tracer finishes.
      if (g.win && g.win.land > g.media.duration - 0.05) {
        const hold = Math.min(6, g.win.land - g.media.duration + 1);
        clips.push({ id: newId('c_'), kind: 'freeze', mediaId: g.media.id, at: Math.max(0, g.media.duration - 0.05), duration: hold });
        t += hold;
      }
    }
    const from = cur!.in;
    const T = (x: number) => clipStart + (x - from);
    if (g.win) at.push({ shot: g.win.shot, launch: T(g.win.launch), land: T(g.win.land), clipStart, cut: clipStart, putt: false });
    else if (g.putts)
      at.push({ shot: g.putts[0], launch: T(g.putts[0].impactTime), land: T(puttEnd(g.putts[g.putts.length - 1])), clipStart, cut: T(g.a), putt: true });
  }
  if (!clips.length) return doc;

  // The scorecard over the last frame, when a hole has a score.
  const card = scored.size ? scores : [];
  const cardStart = t;
  if (card.length) {
    const end = clips[clips.length - 1];
    clips.push({
      id: newId('c_'),
      kind: 'freeze',
      mediaId: end.mediaId,
      at: end.kind === 'video' ? Math.max(end.in, end.out - 0.05) : end.at,
      duration: SCORECARD_S,
    });
  }

  const landscape = segs.filter((g) => g.media.width >= g.media.height).length >= segs.length / 2;
  const base = migrateProject({
    ...doc,
    name,
    clips,
    layers: [],
    audioTracks: [],
    template: null,
    format: { aspect: '16:9', fill: landscape ? 'crop' : 'blur', reframe: { mode: 'center', keyframes: [] } },
  });
  const ctx: Ctx = { doc: base, locale, names };
  const total = timelineDuration(base);
  const layers: Layer[] = [];
  const course = courseName(doc);
  const date = dateLabel(doc, locale);
  if (course || date) {
    layers.push(
      layer(
        'lowerThird',
        ctx,
        0.4,
        Math.min(total, 4.6),
        { x: 0.24, y: 0.84 },
        { title: course || doc.name, subtitle: date, style: 'tv' },
        {
          animIn: { preset: 'wipe', duration: 0.5 },
        },
      ),
    );
  }
  let hole = '';
  at.forEach((it, i) => {
    const media = doc.media[it.shot.mediaId];
    const next = at[i + 1];
    // Hole card when a new hole starts (from the video's GPS); not over the opening title.
    const h = media.place?.hole ?? '';
    if (h && h !== hole) {
      hole = h;
      const facts = holeFacts({ project: { ...doc, shots: [it.shot] }, locale });
      const start = Math.max(it.cut + 0.2, i === 0 && (course || date) ? 4.8 : 0);
      layers.push(
        layer(
          'holeInfo',
          ctx,
          Math.min(start, it.launch - 0.3),
          Math.max(it.launch + 0.4, start + 2.5),
          { x: 0.17, y: 0.13 },
          { ...facts, unit: base.units },
          {
            animIn: { preset: 'slideRight', duration: 0.45 },
          },
        ),
      );
    }
    // The score once the hole's last stroke is done.
    const score = scored.get(h);
    if (score && !at.slice(i + 1).some((x) => (doc.media[x.shot.mediaId].place?.hole ?? '') === h)) {
      // At least 2.5 s on screen, also when the hole ends right where the scorecard starts.
      const start = Math.max(it.launch, Math.min(it.land + 0.3, cardStart - 2.5));
      layers.push(
        layer(
          'lowerThird',
          ctx,
          start,
          Math.min(cardStart, start + 3.5),
          { x: 0.24, y: 0.84 },
          { title: scoreTitle(score, locale), subtitle: scoreSubtitle(score, locale), style: 'tv' },
          { animIn: { preset: 'wipe', duration: 0.5 } },
        ),
      );
    }
    if (it.putt) return;
    // Stats once the ball is down, until the next shot starts.
    const statEnd = Math.min(total, next ? next.cut - 0.05 : total, it.land + 4.5);
    layers.push(
      layer(
        'statCard',
        ctx,
        Math.min(it.land + 0.2, total - 0.5),
        statEnd,
        { x: 0.2, y: 0.3 },
        { shotId: it.shot.id, width: 0.24, theme: 'dark' },
        {
          animIn: { preset: 'slideUp', duration: 0.45 },
        },
      ),
    );
    // The course map measured for this shot, following the flight.
    const map = doc.layers.find((l) => l.type === 'courseMap' && l.props.shotId === it.shot.id);
    if (map && map.type === 'courseMap') {
      layers.push(layer('courseMap', ctx, Math.max(0, it.launch - 0.4), Math.min(total, it.land + 3.5), { x: 0.86, y: 0.58 }, { ...map.props, size: 0.5 }));
    }
  });
  if (card.length) layers.push(...scorecard(ctx, card, cardStart, total, course));
  return migrateProject({ ...base, layers });
}

const SCORE_L = {
  da: {
    hole: 'Hul',
    strokes: 'Slag',
    total: 'I alt',
    card: 'Scorekort',
    missing: '– = ikke alle slag filmet',
    n: (n: number) => `${n} slag`,
    putts: (n: number) => `${n} ${n === 1 ? 'putt' : 'putts'}`,
  },
  en: {
    hole: 'Hole',
    strokes: 'Strokes',
    total: 'Total',
    card: 'Scorecard',
    missing: '– = not every stroke filmed',
    n: (n: number) => `${n} ${n === 1 ? 'stroke' : 'strokes'}`,
    putts: (n: number) => `${n} ${n === 1 ? 'putt' : 'putts'}`,
  },
};

/** "Hul 7 · Par 4 · Birdie". */
export function scoreTitle(h: HoleScore, locale: Locale): string {
  return `${SCORE_L[locale].hole} ${h.hole} · Par ${h.par} · ${scoreName(h.strokes!, h.par!, locale)}`;
}

function scoreSubtitle(h: HoleScore, locale: Locale): string {
  return `${SCORE_L[locale].n(h.strokes!)} · ${SCORE_L[locale].putts(h.putts)}`;
}

/** Holes, par and strokes as columns of text on a dark card; holes without a score show '–'. */
function scorecard(ctx: Ctx, holes: HoleScore[], start: number, end: number, course: string): Layer[] {
  const L = SCORE_L[ctx.locale];
  const done = holes.filter((h) => h.strokes !== null && h.par);
  const strokes = done.reduce((n, h) => n + h.strokes!, 0);
  const par = done.reduce((n, h) => n + h.par!, 0);
  const col = Math.min(0.07, 0.84 / (holes.length + 5));
  const x0 = 0.5 - (col * (holes.length + 5)) / 2;
  const size = Math.min(0.045, col * 0.9);
  const cell = (x: number, text: string, weight = 700) =>
    layer('text', ctx, start + 0.3, end, { x, y: 0.53 }, { text, font: 'barlow', weight, size, align: 'center', background: null, shadow: false });
  return [
    layer(
      'shape',
      ctx,
      start,
      end,
      { x: 0.5, y: 0.5 },
      { shape: 'rect', w: 0.9, h: 0.46, fill: '#111113', fillOpacity: 0.88, stroke: null, radius: 0.02 },
      { animIn: { preset: 'fade', duration: 0.4 } },
    ),
    layer(
      'text',
      ctx,
      start + 0.2,
      end,
      { x: 0.5, y: 0.35 },
      { text: course ? `${L.card} · ${course}` : L.card, font: 'barlow', size: 0.05, background: null },
    ),
    cell(x0 + col * 1.25, `${L.hole}\nPar\n${L.strokes}`, 600),
    ...holes.map((h, i) => cell(x0 + col * (2.5 + i + 0.5), `${h.hole}\n${h.par ?? '–'}\n${h.strokes ?? '–'}`)),
    cell(x0 + col * (2.5 + holes.length + 1.25), `${L.total}\n${par}\n${strokes} (${toPar(strokes - par)})`, 800),
    ...(done.length < holes.length
      ? [layer('text', ctx, start + 0.3, end, { x: 0.5, y: 0.69 }, { text: L.missing, font: 'inter', weight: 500, size: 0.022, background: null })]
      : []),
  ];
}

/**
 * One vertical short of every shot back to back: each cut tight around swing and flight with
 * slow motion through impact and the frame following the ball (the per-shot shorts, joined),
 * a hole badge when the hole changes and stats after each landing. Putts (by default only
 * notable holed ones the analysis is sure of) come as plain cuts, without tracer or stats.
 */
export function highlightShort(
  doc: Project,
  locale: Locale,
  name: string,
  names: LayerNames = {},
  opts: Pick<VideoOptions, 'putts' | 'skipPutts' | 'scores'> = {},
): Project {
  const putts = shownPutts(doc, opts.putts ?? defaultPutts('highlight'), opts.skipPutts ?? unsurePuttHoles(opts.scores ?? summarize(doc).holes));
  const shots = [...playedShots(doc), ...putts].sort(byTimeline(doc.clips));
  const clips: Clip[] = [];
  const keys: ReframeKey[] = [];
  const marks: { shot: Shot; start: number; land: number; end: number }[] = [];
  let t = 0;
  for (const shot of shots) {
    const one = shot.kind === 'putt' ? puttShort(doc, shot, name) : shortFor(doc, shot, name, locale);
    const len = timelineDuration(one);
    for (const c of one.clips) clips.push({ ...c, id: newId('c_') });
    for (const k of one.format.reframe.keyframes) keys.push({ ...k, t: k.t + t });
    // Landing in the short's own timeline: its last framing key sits on the landing.
    const own = one.format.reframe.keyframes;
    marks.push({ shot, start: t, land: t + (own.length ? own[own.length - 1].t : len * 0.8), end: t + len });
    t += len;
  }
  if (!clips.length) return doc;
  const base = migrateProject({
    ...doc,
    name,
    clips,
    layers: [],
    audioTracks: [],
    template: null,
    format: { aspect: '9:16', fill: 'crop', reframe: { mode: 'auto', keyframes: keys } },
  });
  const ctx: Ctx = { doc: base, locale, names };
  const layers: Layer[] = [];
  let hole = '';
  for (const m of marks) {
    const media = doc.media[m.shot.mediaId];
    const h = media.place?.hole ?? '';
    if (h && h !== hole) {
      hole = h;
      layers.push(
        layer(
          'text',
          ctx,
          m.start + 0.1,
          Math.min(m.end, m.start + 2.6),
          { x: 0.5, y: 0.12 },
          {
            text: placeTitle(media.place, locale).toLocaleUpperCase(),
            font: 'barlow',
            size: 0.034,
            background: '#111113',
            backgroundOpacity: 0.85,
          },
        ),
      );
    }
    if (m.shot.kind === 'putt') continue;
    layers.push(
      layer(
        'statCard',
        ctx,
        Math.min(m.land + 0.1, m.end - 0.4),
        m.end - 0.05,
        { x: 0.5, y: 0.74 },
        { shotId: m.shot.id, width: 0.62, theme: 'dark' },
        {
          animIn: { preset: 'pop', duration: 0.35 },
        },
      ),
    );
  }
  return migrateProject({ ...base, layers });
}
