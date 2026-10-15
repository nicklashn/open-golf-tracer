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
} from '@golf/schema';
import { layerDefaults, type LayerNames } from './layers';
import { placeTitle } from './place';
import { shortFor } from './shorts';

export type VideoKind = 'youtube' | 'highlight';

type Locale = 'da' | 'en';

/** Seconds kept after each landing in the YouTube edit: long enough to read the stats card. */
const AFTER_LANDING_S = 3.2;

/** Visible full shots in the order they were played: timeline order of their clips, then time. */
export function playedShots(doc: Project): Shot[] {
  return doc.shots.filter((s) => s.visible && s.kind === 'full' && doc.media[s.mediaId]).sort(byTimeline(doc.clips));
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
export function youtubeVideo(doc: Project, locale: Locale, name: string, names: LayerNames = {}): Project {
  const shots = playedShots(doc);
  const wins = shots.map((s) => windowOf(s, doc.media[s.mediaId], 3, AFTER_LANDING_S));
  const clips: Clip[] = [];
  const at: { shot: Shot; launch: number; land: number; clipStart: number }[] = [];
  let t = 0;
  for (const w of wins) {
    const last = clips[clips.length - 1];
    // Shots close together in one video share a clip instead of jumping back in time.
    if (last && last.kind === 'video' && last.mediaId === w.shot.mediaId && w.a <= last.out + 0.5) {
      t -= last.out - last.in;
      last.out = Math.max(last.out, w.b);
      t += last.out - last.in;
      at.push({ shot: w.shot, launch: t - (last.out - w.launch), land: t - (last.out - w.land), clipStart: t - (last.out - last.in) });
      continue;
    }
    clips.push({ id: newId('c_'), kind: 'video', mediaId: w.shot.mediaId, in: w.a, out: w.b, speed: 1, volume: 1, muted: false });
    const start = t;
    t += w.b - w.a;
    // The ball lands after the video ends: hold the last frame while the tracer finishes.
    if (w.land > w.media.duration - 0.05) {
      const hold = Math.min(6, w.land - w.media.duration + 1);
      clips.push({ id: newId('c_'), kind: 'freeze', mediaId: w.shot.mediaId, at: Math.max(0, w.media.duration - 0.05), duration: hold });
      t += hold;
    }
    at.push({ shot: w.shot, launch: start + (w.launch - w.a), land: start + (w.land - w.a), clipStart: start });
  }
  if (!clips.length) return doc;

  const landscape = wins.filter((w) => w.media.width >= w.media.height).length >= wins.length / 2;
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
      const start = Math.max(it.clipStart + 0.2, i === 0 && (course || date) ? 4.8 : 0);
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
    // Stats once the ball is down, until the next shot starts.
    const statEnd = Math.min(total, next ? next.clipStart - 0.05 : total, it.land + 4.5);
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
  return migrateProject({ ...base, layers });
}

/**
 * One vertical short of every shot back to back: each cut tight around swing and flight with
 * slow motion through impact and the frame following the ball (the per-shot shorts, joined),
 * a hole badge when the hole changes and stats after each landing.
 */
export function highlightShort(doc: Project, locale: Locale, name: string, names: LayerNames = {}): Project {
  const shots = playedShots(doc);
  const clips: Clip[] = [];
  const keys: ReframeKey[] = [];
  const marks: { shot: Shot; start: number; land: number; end: number }[] = [];
  let t = 0;
  for (const shot of shots) {
    const one = shortFor(doc, shot, name, locale);
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
