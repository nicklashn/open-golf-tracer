/**
 * Templates: finished looks that set tracer style, cards and text in one go.
 * `applyTemplate` is pure; the editor wraps it in one undoable command.
 */
import {
  M_TO_YD,
  TRACER_PRESETS,
  newId,
  sourceToTimeline,
  timelineDuration,
  type Keyframe,
  type Layer,
  type Project,
  type StatField,
  type TracerStyle,
} from '@golf/schema';
import { shotStats } from './frame';
import type { Locale } from './i18n';

export interface Template {
  id: string;
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  style: TracerStyle;
  build: (ctx: TemplateContext) => Layer[];
}

export interface TemplateContext {
  project: Project;
  locale: Locale;
  /** Timeline second of each visible shot's launch and landing. */
  shots: { id: string; launch: number; land: number }[];
  duration: number;
  aspect: number;
}

const kf = (x: number, y: number, extra: Partial<Keyframe> = {}): Keyframe => ({
  t: 0,
  x,
  y,
  scale: 1,
  rotation: 0,
  opacity: 1,
  easing: 'easeInOut',
  ...extra,
});

const portrait = (c: TemplateContext) => c.aspect < 1;

const CLUB_NAMES: Record<Locale, Record<string, string>> = {
  da: { driver: 'Driver', wood: 'Træ', longIron: 'Langt jern', midIron: 'Jern', shortIron: 'Kort jern', wedge: 'Wedge' },
  en: { driver: 'Driver', wood: 'Wood', longIron: 'Long iron', midIron: 'Iron', shortIron: 'Short iron', wedge: 'Wedge' },
};

/** Hole number, par and length from the video's GPS (OpenStreetMap), and the first shot's club. */
export function holeFacts(c: Pick<TemplateContext, 'project' | 'locale'>): { hole: number; par: number; length: number; club: string } {
  const shot = c.project.shots.find((s) => s.visible && s.kind === 'full') ?? c.project.shots[0];
  const place = shot ? c.project.media[shot.mediaId]?.place : null;
  const metres = place?.fromTee != null && place.toGreen != null ? place.fromTee + place.toGreen : null;
  return {
    hole: Math.min(99, Math.max(1, parseInt(place?.hole ?? '', 10) || 1)),
    par: place?.par ?? 4,
    length: metres == null ? 0 : Math.round(c.project.units === 'yd' ? metres * M_TO_YD : metres),
    club: shot && shot.club !== 'auto' ? CLUB_NAMES[c.locale][shot.club] : '',
  };
}

function statCards(c: TemplateContext, theme: 'dark' | 'light' | 'accent', accent: string, fields: StatField[]): Layer[] {
  return c.shots.map((s, i) => {
    const next = c.shots[i + 1]?.launch ?? c.duration;
    const start = Math.min(s.land + 0.2, c.duration);
    const end = Math.max(start + 0.5, Math.min(next - 0.1, start + 4.5, c.duration));
    return {
      id: newId('l_'),
      type: 'statCard',
      name: `Statistik ${i + 1}`,
      start,
      end,
      keyframes: [kf(portrait(c) ? 0.5 : 0.2, portrait(c) ? 0.72 : 0.28)],
      animIn: { preset: 'slideUp', duration: 0.45 },
      animOut: { preset: 'fade', duration: 0.3 },
      hidden: false,
      locked: false,
      props: { shotId: s.id, fields, theme, title: '', accent, width: portrait(c) ? 0.62 : 0.26 },
    } as Layer;
  });
}

function text(
  c: TemplateContext,
  value: string,
  at: { x: number; y: number },
  start: number,
  end: number,
  extra: Record<string, unknown> = {},
  anim: Layer['animIn']['preset'] = 'slideUp',
): Layer {
  return {
    id: newId('l_'),
    type: 'text',
    name: value.slice(0, 30),
    start,
    end,
    keyframes: [kf(at.x, at.y)],
    animIn: { preset: anim, duration: 0.5 },
    animOut: { preset: 'fade', duration: 0.4 },
    hidden: false,
    locked: false,
    props: {
      text: value,
      font: 'inter',
      weight: 800,
      size: portrait(c) ? 0.034 : 0.06,
      color: '#ffffff',
      align: 'center',
      background: null,
      backgroundOpacity: 0.8,
      uppercase: true,
      letterSpacing: 0.02,
      shadow: true,
      ...extra,
    },
  } as Layer;
}

export const TEMPLATES: Template[] = [
  {
    id: 'range',
    name: { da: 'Range-session', en: 'Range session' },
    description: { da: 'Klassisk rød tracer og et kort med tal efter hvert slag.', en: 'Classic red tracer and a stats card after every shot.' },
    style: TRACER_PRESETS.classic,
    build: (c) => [
      ...statCards(c, 'dark', '#ff3b30', ['carry', 'apex', 'ballSpeed']),
      {
        id: newId('l_'),
        type: 'lowerThird',
        name: 'Titel',
        start: 0,
        end: Math.min(3.5, c.duration),
        keyframes: [kf(portrait(c) ? 0.5 : 0.24, portrait(c) ? 0.86 : 0.84)],
        animIn: { preset: 'wipe', duration: 0.5 },
        animOut: { preset: 'fade', duration: 0.4 },
        hidden: false,
        locked: false,
        props: {
          title: c.locale === 'da' ? 'Range-session' : 'Range session',
          subtitle: new Date().toLocaleDateString(c.locale === 'da' ? 'da-DK' : 'en-GB'),
          accent: '#ff3b30',
          style: 'bar',
          font: 'barlow',
        },
      } as Layer,
    ],
  },
  {
    id: 'minimal',
    name: { da: 'Minimal', en: 'Minimal' },
    description: { da: 'Tynd hvid tracer uden pynt. Lader slaget tale.', en: 'Thin white tracer, nothing else. Let the shot speak.' },
    style: TRACER_PRESETS.minimalWhite,
    build: () => [],
  },
  {
    id: 'tv',
    name: { da: 'TV-transmission', en: 'TV broadcast' },
    description: { da: 'Guld-tracer, landingsmarkør og hul-info som på tv.', en: 'Gold tracer, landing marker and hole info like on TV.' },
    style: TRACER_PRESETS.tvGold,
    build: (c) => [
      {
        id: newId('l_'),
        type: 'holeInfo',
        name: 'Hul-info',
        start: 0,
        end: Math.min(c.shots[0]?.launch ?? 4, c.duration) || Math.min(4, c.duration),
        keyframes: [kf(portrait(c) ? 0.5 : 0.17, portrait(c) ? 0.14 : 0.13)],
        animIn: { preset: 'slideRight', duration: 0.45 },
        animOut: { preset: 'fade', duration: 0.35 },
        hidden: false,
        locked: false,
        props: { ...holeFacts(c), unit: c.project.units, accent: '#ffc83d', font: 'barlow' },
      } as Layer,
      ...statCards(c, 'dark', '#ffc83d', ['carry', 'apex', 'ballSpeed', 'launch']),
    ],
  },
  {
    id: 'holeInOne',
    name: { da: 'Hole-in-one', en: 'Hole-in-one' },
    description: { da: 'Gradient-tracer og en stor titel, når bolden lander.', en: 'Gradient tracer and a big title when the ball lands.' },
    style: TRACER_PRESETS.gradient,
    build: (c) => {
      const s = c.shots[0];
      const at = s ? s.land : Math.max(0, c.duration - 3);
      return [
        text(
          c,
          'Hole in one',
          { x: 0.5, y: portrait(c) ? 0.3 : 0.24 },
          at,
          Math.min(c.duration, at + 3.5),
          { font: 'bebas', weight: 400, size: portrait(c) ? 0.075 : 0.13, letterSpacing: 0.04 },
          'pop',
        ),
        ...statCards(c, 'accent', '#ff3b30', ['carry', 'flightTime']),
      ];
    },
  },
  {
    id: 'swing',
    name: { da: 'Swing-analyse', en: 'Swing analysis' },
    description: { da: 'Komet-hale, alle tal og en rolig overskrift til analyse.', en: 'Comet tail, every number and a calm heading for analysis.' },
    style: TRACER_PRESETS.comet,
    build: (c) => [
      text(
        c,
        c.locale === 'da' ? 'Swing-analyse' : 'Swing analysis',
        { x: 0.5, y: 0.09 },
        0,
        Math.min(3, c.duration),
        {
          font: 'inter',
          weight: 700,
          size: portrait(c) ? 0.026 : 0.045,
          background: '#111113',
          backgroundOpacity: 0.8,
          uppercase: false,
          letterSpacing: 0,
          shadow: false,
        },
        'fade',
      ),
      ...statCards(c, 'light', '#ff3b30', ['carry', 'apex', 'ballSpeed', 'launch', 'flightTime', 'curve']),
    ],
  },
  {
    id: 'neon',
    name: { da: 'Neon', en: 'Neon' },
    description: { da: 'Neongrøn tracer med impact-flash til aftenrunder.', en: 'Neon green tracer with impact flash for evening rounds.' },
    style: TRACER_PRESETS.neon,
    build: (c) => statCards(c, 'dark', '#39ff88', ['carry', 'ballSpeed']),
  },
];

export function templateContext(project: Project, locale: Locale): TemplateContext {
  const media = project.clips[0] ? project.media[project.clips[0].mediaId] : undefined;
  const aspect =
    project.format.aspect === 'original'
      ? media
        ? media.width / Math.max(1, media.height)
        : 16 / 9
      : { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 0.8 }[project.format.aspect];
  const shots: TemplateContext['shots'] = [];
  for (const s of project.shots) {
    if (!s.visible || s.kind !== 'full') continue;
    const times = sourceToTimeline(project.clips, s.mediaId, s.impactTime);
    if (!times.length) continue;
    const st = shotStats(s);
    const launch = times[0] + s.params[8] * s.slowmo + s.timing.launchOffset;
    const land = launch + ((st?.flightTimeS ?? 4) / s.timing.speed) * s.slowmo;
    shots.push({ id: s.id, launch, land });
  }
  shots.sort((a, b) => a.launch - b.launch);
  return { project, locale, shots, duration: timelineDuration(project), aspect };
}

/** Returns a new project with the template's tracer style on every shot and its layers added
 *  (layers from a previous template are replaced). */
export function applyTemplate(project: Project, templateId: string, locale: Locale): Project {
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return project;
  const ctx = templateContext(project, locale);
  const layers = tpl.build(ctx).map((l) => ({ ...l, name: l.name, id: l.id }));
  const keep = project.layers.filter((l) => !l.name.startsWith('⧉'));
  return {
    ...project,
    shots: project.shots.map((s) => ({ ...s, style: { ...tpl.style } })),
    // Template layers are tagged so applying another template replaces them.
    layers: [...keep, ...layers.map((l) => ({ ...l, name: `⧉ ${l.name}` }))],
    template: templateId,
  };
}

const isPortrait = (p: Project) => templateContext({ ...p, shots: [] }, 'en').aspect < 1;

/** Text the user may have typed into a template layer; kept when the layout is rebuilt. */
const TEXT_PROPS = ['text', 'title', 'subtitle', 'label'] as const;

/**
 * After a format change between portrait and landscape, rebuild the template's layers for the
 * new frame (positions and widths differ), keeping the user's texts, hidden/locked flags and
 * tracer styles. Returns the project unchanged when no template applies. `force` rebuilds even
 * without an orientation change (e.g. a short cut from a longer project: new timing).
 */
export function relayoutTemplate(before: Project, after: Project, locale: Locale, force = false): Project {
  if (!after.template || (!force && isPortrait(before) === isPortrait(after))) return after;
  const old = after.layers.filter((l) => l.name.startsWith('⧉'));
  if (!old.length) return after;
  const rebuilt = applyTemplate(after, after.template, locale);
  const layers = rebuilt.layers.map((l) => {
    if (!l.name.startsWith('⧉')) return l;
    const prev = old.find((o) => o.name === l.name && o.type === l.type);
    if (!prev) return l;
    const props: Record<string, unknown> = { ...l.props };
    const prevProps = prev.props as Record<string, unknown>;
    for (const k of TEXT_PROPS) if (k in prevProps && k in props) props[k] = prevProps[k];
    return { ...l, hidden: prev.hidden, locked: prev.locked, props } as Layer;
  });
  return { ...after, layers };
}
