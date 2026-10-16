/**
 * Plan + answers → finished projects, built with the same generators as "Make a video". The
 * project passed in is never changed; each video is a new project (one per short).
 */
import { TEMPLATES } from '@golf/render';
import { migrateProject, newId, timelineDuration, type Clip, type Layer, type Project } from '@golf/schema';
import { layerDefaults, type LayerNames } from './layers';
import { resolveAnswers, shotChoices, type PlanAnswers, type VideoPlan } from './plan';
import { BROLL_S, shotScore } from './rules';
import { shortFor } from './shorts';
import { clipOrder, summarize } from './summary';
import { highlightShort, playedShots, youtubeVideo } from './videos';

type Locale = 'da' | 'en';

export interface ComposedVideo {
  name: string;
  document: Project;
}

export interface ComposeOptions {
  locale: Locale;
  names?: LayerNames;
}

/**
 * The project as the plan and answers want it before a generator runs: shots left out are
 * hidden (per-shot choices win over a question's answer), clips are in playing order, clips without GPS get the hole the user picked.
 */
export function prepare(doc: Project, plan: VideoPlan, answers: PlanAnswers | null | undefined): { doc: Project; broll: string[] } {
  const a = resolveAnswers(plan, answers);
  const summary = summarize(doc);
  const byId = new Map(summary.shots.map((s) => [s.id, s]));
  const keep = new Set(plan.includeShotIds.filter((id) => byId.has(id)));
  const q = (id: string) => plan.questions.find((x) => x.id === id);

  if (a.doubtful === 'drop') for (const id of q('doubtful')?.shotIds ?? []) keep.delete(id);
  for (const question of plan.questions) {
    const choice = a[question.id];
    if (question.id.startsWith('retake:') && question.shotIds.length === 2) {
      const [x, y] = question.shotIds;
      if (choice === 'last') keep.delete(x);
      if (choice === 'best') {
        const sx = byId.get(x);
        const sy = byId.get(y);
        if (sx && sy) keep.delete(shotScore(sy) > shotScore(sx) ? x : y);
      }
    }
    if (question.id.startsWith('same:') && choice.startsWith('keep:')) {
      const chosen = choice.slice(5);
      for (const id of question.shotIds) if (id !== chosen) keep.delete(id);
    }
  }
  // A choice for one shot wins over its question's answer.
  for (const [id, choice] of shotChoices(plan, answers)) {
    if (choice === 'drop') keep.delete(id);
    else if (byId.has(id)) keep.add(id);
  }

  // Playing order: as filmed (file names for clips without a time), as added, or the plan's own.
  const media = { ...doc.media };
  let order = a.order === 'added' ? [...new Set(doc.clips.map((c) => c.mediaId))] : clipOrder(doc).map((m) => m.id);
  if (plan.order?.length) {
    const fromPlan = [...new Set(plan.order.map((id) => byId.get(id)?.clipId).filter((x): x is string => !!x))];
    order = [...fromPlan, ...order.filter((id) => !fromPlan.includes(id))];
  }
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? 1e9 : i;
  };
  const clips = [...doc.clips].sort((x, y) => pos(x.mediaId) - pos(y.mediaId));

  // Holes for clips without GPS, as answered.
  for (const question of plan.questions) {
    if (!question.id.startsWith('gps:')) continue;
    const [clip, prev, next] = question.clipIds;
    const from = a[question.id] === 'previous' ? prev : a[question.id] === 'next' ? next : null;
    if (clip && from && media[clip] && media[from]?.place) media[clip] = { ...media[clip], place: { ...media[from].place! } };
  }

  const shots = doc.shots.map((s) => (byId.has(s.id) ? { ...s, visible: keep.has(s.id) } : s));
  const broll = a.noShots === 'broll' ? (q('noShots')?.clipIds ?? []) : [];
  return { doc: migrateProject({ ...doc, media, clips, shots }), broll };
}

/** Clips without shots as short mood shots, each placed before the first cut of a later clip. */
function withBroll(video: Project, source: Project, broll: string[]): Project {
  if (!broll.length) return video;
  const order = source.clips.map((c) => c.mediaId);
  let clips = [...video.clips];
  let layers = [...video.layers];
  for (const id of broll) {
    const m = source.media[id];
    if (!m) continue;
    const len = Math.min(BROLL_S, m.duration);
    const rank = order.indexOf(id);
    let at = clips.findIndex((c) => c.kind === 'video' && order.indexOf(c.mediaId) > rank);
    if (at < 0) at = clips.length;
    const t = timelineDuration({ ...video, clips: clips.slice(0, at) });
    clips = [
      ...clips.slice(0, at),
      { id: newId('c_'), kind: 'video', mediaId: id, in: 0, out: len, speed: 1, volume: 1, muted: false } as Clip,
      ...clips.slice(at),
    ];
    layers = layers.map((l) => (l.start >= t - 1e-6 ? { ...l, start: l.start + len, end: l.end + len } : l));
  }
  return migrateProject({ ...video, clips, layers });
}

/** The plan's per-shot texts as text layers, shown with each shot's stat card. */
function withShotTexts(video: Project, plan: VideoPlan, opts: ComposeOptions): Project {
  const texts = Object.entries(plan.shotTexts ?? {}).filter(([, t]) => t.trim());
  if (!texts.length) return video;
  const layers: Layer[] = [...video.layers];
  for (const [shotId, text] of texts) {
    const card = video.layers.find((l) => l.type === 'statCard' && l.props.shotId === shotId);
    if (!card) continue;
    const l = layerDefaults('text', opts.names ?? {}, video, card.start, opts.locale);
    if (l.type !== 'text') continue;
    layers.push({ ...l, start: card.start, end: card.end, props: { ...l.props, text } });
  }
  return migrateProject({ ...video, layers });
}

function withTemplateLook(doc: Project, template: string | null): Project {
  const tpl = template ? TEMPLATES.find((t) => t.id === template) : null;
  return tpl ? { ...doc, shots: doc.shots.map((s) => ({ ...s, style: { ...tpl.style } })) } : doc;
}

/** Builds the video(s) the plan describes. Empty when no shot is left to show. */
export function compose(source: Project, plan: VideoPlan, answers: PlanAnswers | null | undefined, opts: ComposeOptions): ComposedVideo[] {
  const { doc: prepared, broll } = prepare(source, plan, answers);
  const doc = withTemplateLook(prepared, plan.template);
  const names = opts.names ?? {};
  if (!playedShots(doc).length) return [];
  if (plan.kind === 'shorts')
    return playedShots(doc).map((shot, i) => {
      const short = shortFor(doc, shot, `${plan.title} – ${i + 1}`, opts.locale);
      const total = timelineDuration(short);
      const one = migrateProject({ ...short, layers: short.layers.map((l) => ({ ...l, end: Math.min(l.end, total) })) });
      return { name: one.name, document: one };
    });
  const video =
    plan.kind === 'youtube' ? withBroll(youtubeVideo(doc, opts.locale, plan.title, names), doc, broll) : highlightShort(doc, opts.locale, plan.title, names);
  return [{ name: plan.title, document: withShotTexts(video, plan, opts) }];
}
