/**
 * The "compose" job ("Make a video for me"): waits for the project's analysis, summarises the
 * round, makes a plan, stops to ask when the rules found doubts, and saves the finished
 * video(s) as new projects.
 */
import { compose, planFromRules, summarize, VideoPlan, type LayerNames, type PlanAnswers, type RoundSummary } from '@golf/compose';
import { migrateProject, type Project } from '@golf/schema';
import type { InternalApi } from './api';

type Locale = 'da' | 'en';

export interface ComposePayload {
  project_id: string;
  preference?: string;
  locale?: Locale;
  names?: LayerNames;
  media_ids?: string[];
  yes?: boolean;
  answers?: PlanAnswers | null;
  /** The plan the questions came from, sent back with the answers. */
  plan?: unknown;
}

/** Makes the plan; the rules here, an AI model in a later version. */
export type Planner = (summary: RoundSummary, preference: string, locale: Locale) => Promise<{ plan: VideoPlan }>;

export const rulePlanner: Planner = async (summary, preference, locale) => ({ plan: planFromRules(summary, preference, locale) });

/** How long a video waits between looks at the analysis. */
const WAIT_S = 5;

/** Only the chosen clips (and their shots and graphics); the rest of the project is left out. */
export function onlyClips(doc: Project, mediaIds: string[] | undefined): Project {
  if (!mediaIds?.length) return doc;
  const keep = new Set(mediaIds);
  const media = Object.fromEntries(Object.entries(doc.media).filter(([id, m]) => keep.has(id) || m.kind !== 'video'));
  return migrateProject({
    ...doc,
    media,
    clips: doc.clips.filter((c) => keep.has(c.mediaId)),
    shots: doc.shots.filter((s) => keep.has(s.mediaId)),
    layers: doc.layers.filter((l) => {
      const shotId = 'shotId' in l.props ? l.props.shotId : null;
      return !shotId || doc.shots.some((s) => s.id === shotId && keep.has(s.mediaId));
    }),
  });
}

type Api = Pick<InternalApi, 'jobProject' | 'defer' | 'awaitAnswers' | 'derive' | 'progress' | 'complete'>;

export async function handleCompose(
  api: Api,
  job: { id: string; payload: Record<string, unknown> },
  planner: Planner = rulePlanner,
): Promise<'waiting' | 'asked' | 'done'> {
  const p = job.payload as unknown as ComposePayload;
  const locale: Locale = p.locale === 'da' ? 'da' : 'en';
  const project = await api.jobProject(job.id);
  if (project.pending > 0) {
    await api.defer(job.id, WAIT_S, locale === 'da' ? 'Venter på analysen' : 'Waiting for the analysis');
    return 'waiting';
  }
  await api.progress(job.id, 0.2, locale === 'da' ? 'Planlægger videoen' : 'Planning the video');
  const doc = onlyClips(migrateProject(project.document), p.media_ids);
  const summary = summarize(doc);
  const stored = p.plan ? VideoPlan.safeParse(p.plan) : null;
  const plan = stored?.success ? stored.data : (await planner(summary, p.preference ?? '', locale)).plan;

  if (plan.questions.length && !p.answers && !p.yes) {
    await api.awaitAnswers(
      job.id,
      { plan, questions: plan.questions, notes: plan.notes, title: plan.title, kind: plan.kind },
      locale === 'da' ? 'Venter på dine svar' : 'Waiting for your answers',
    );
    return 'asked';
  }

  await api.progress(job.id, 0.5, locale === 'da' ? 'Klipper videoen' : 'Editing the video');
  const videos = compose(doc, plan, p.answers ?? {}, { locale, names: p.names ?? {} });
  const projects: { id: string; name: string }[] = [];
  for (const [i, v] of videos.entries()) {
    projects.push(await api.derive(job.id, v.name, v.document));
    await api.progress(job.id, 0.5 + (0.5 * (i + 1)) / videos.length);
  }
  await api.complete(job.id, {
    projects,
    kind: plan.kind,
    title: plan.title,
    description: plan.description ?? '',
    // Nothing left to show (every shot left out): say so instead of an empty project.
    notes: videos.length
      ? plan.notes
      : [...plan.notes, locale === 'da' ? 'Ingen slag blev tilbage, så der blev ikke lavet en video.' : 'No shots were left, so no video was made.'],
  });
  return 'done';
}
