/**
 * The "compose" job ("Make a video for me"): waits for the project's analysis, summarises the
 * round, makes a plan, stops to ask when the rules found doubts, and saves the finished
 * video(s) as new projects.
 */
import {
  AiError,
  compose,
  noUsage,
  planFromRules,
  planWithAI,
  testConnection,
  summarize,
  templatesFor,
  VideoPlan,
  type AiConfig,
  type AiUsage,
  type LayerNames,
  type PlanAnswers,
} from '@golf/compose';
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
  /** Tokens the AI used before the job stopped to ask (the ceiling is per video). */
  usage?: AiUsage | null;
}

/** The AI model for a job (from the API: the user's settings, else the .env defaults). */
export type JobAiConfig = AiConfig & { source?: string };

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

type Api = Pick<InternalApi, 'jobProject' | 'jobAi' | 'defer' | 'awaitAnswers' | 'derive' | 'progress' | 'complete'>;
type Log = (msg: string, extra: Record<string, unknown>) => void;

const T = {
  da: {
    byModel: (m: string) => `Planen er lavet af AI-modellen ${m}.`,
    fellBack: 'AI-svaret kunne ikke bruges (to gange), så planen er lavet af faste regler.',
    none: 'Ingen slag blev tilbage, så der blev ikke lavet en video.',
  },
  en: {
    byModel: (m: string) => `The plan was made by the AI model ${m}.`,
    fellBack: "The AI's answer could not be used (twice), so the plan was made by fixed rules.",
    none: 'No shots were left, so no video was made.',
  },
};

export async function handleCompose(
  api: Api,
  job: { id: string; payload: Record<string, unknown> },
  log: Log = () => {},
  doFetch?: typeof fetch,
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
  const rules = planFromRules(summary, p.preference ?? '', locale);
  const ai = (await api.jobAi(job.id)) as JobAiConfig;
  const useAi = ai.provider !== 'none';
  let usage: AiUsage = p.usage ?? noUsage();
  // The rules' first note says "no AI"; with a model it says which one, or that its answer was unusable.
  const ruleNotes = rules.notes.slice(1);
  const withAi = async (base: VideoPlan, answers: PlanAnswers | null): Promise<VideoPlan> => {
    const out = await planWithAI(ai, summary, p.preference ?? '', base, answers, {
      allowedTemplates: templatesFor(),
      used: usage,
      fetch: doFetch,
      log,
    });
    usage = out.usage;
    log('ai usage', { job: job.id, provider: ai.provider, model: ai.model, ...usage });
    return out.fellBack ? { ...base, notes: [T[locale].fellBack, ...ruleNotes] } : { ...out.plan, notes: [T[locale].byModel(ai.model), ...out.plan.notes] };
  };

  // First pass: one call for the plan. After the answers: one more call, only if there were questions.
  let plan: VideoPlan;
  if (stored?.success) plan = useAi && p.answers && stored.data.questions.length ? await withAi(stored.data, p.answers) : stored.data;
  else plan = useAi ? await withAi(rules, null) : rules;

  if (plan.questions.length && !p.answers && !p.yes) {
    await api.awaitAnswers(
      job.id,
      { plan, questions: plan.questions, notes: plan.notes, title: plan.title, kind: plan.kind, usage: useAi ? usage : null },
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
    notes: videos.length ? plan.notes : [...plan.notes, T[locale].none],
    ai: useAi ? { provider: ai.provider, model: ai.model } : null,
    usage: useAi ? usage : null,
  });
  return 'done';
}

/** "Test connection" from Settings → AI: one tiny call with the user's model. */
export async function handleAiTest(api: Pick<InternalApi, 'jobAi' | 'complete'>, job: { id: string }, doFetch?: typeof fetch): Promise<void> {
  const ai = (await api.jobAi(job.id)) as JobAiConfig;
  const t = await testConnection(ai, doFetch);
  await api.complete(job.id, { provider: ai.provider, model: t.model, usage: t.usage, ms: t.ms });
}

export { AiError };
