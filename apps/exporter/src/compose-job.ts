/**
 * The "compose" job ("Make a video for me"): waits for the project's analysis, summarises the
 * round, makes a plan, stops to ask when the rules found doubts, and saves the finished
 * video(s) as new projects.
 */
import {
  AiError,
  applyPuttVision,
  compose,
  frameTimes,
  noUsage,
  planCallEstimate,
  planFromRules,
  planWithAI,
  puttSegment,
  puttsHoleOf,
  resolvePuttsWithVision,
  testConnection,
  summarize,
  templatesFor,
  VideoPlan,
  VISION_MAX_CALLS,
  visionCallEstimate,
  type AiConfig,
  type AiUsage,
  type LayerNames,
  type PlanAnswers,
  type RoundSummary,
} from '@golf/compose';
import { migrateProject, type Project } from '@golf/schema';
import type { InternalApi } from './api';
import { grabFrames } from './frames';

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
  /** What the AI found itself from still frames before asking (answers and their notes). */
  vision?: VisionFound | null;
}

/** The AI model for a job (from the API: the user's settings, else the .env defaults). */
export type JobAiConfig = AiConfig & { source?: string; vision?: boolean };

interface VisionFound {
  answers: PlanAnswers;
  notes: string[];
}

/** Base64 JPEGs of a clip at the given seconds (see frames.ts). */
export type FrameGrabber = (mediaId: string, times: number[]) => Promise<string[]>;

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

type Api = Pick<InternalApi, 'jobProject' | 'jobAi' | 'defer' | 'awaitAnswers' | 'derive' | 'progress' | 'complete'> & Partial<Pick<InternalApi, 'media'>>;
type Log = (msg: string, extra: Record<string, unknown>) => void;

const T = {
  da: {
    byModel: (m: string) => `Planen er lavet af AI-modellen ${m}.`,
    fellBack: 'AI-svaret kunne ikke bruges (to gange), så planen er lavet af faste regler.',
    none: 'Ingen slag blev tilbage, så der blev ikke lavet en video.',
    visionBudget: "AI'en så ikke på billederne fra greenen: det ville bruge flere tokens end loftet.",
  },
  en: {
    byModel: (m: string) => `The plan was made by the AI model ${m}.`,
    fellBack: "The AI's answer could not be used (twice), so the plan was made by fixed rules.",
    none: 'No shots were left, so no video was made.',
    visionBudget: 'The AI did not look at frames from the green: it would use more tokens than the ceiling.',
  },
};

/** Frames from the media file the API points to. */
const ffmpegFrames =
  (api: Api): FrameGrabber =>
  async (mediaId, times) => {
    if (!api.media) throw new Error('no media lookup');
    const m = await api.media(mediaId);
    return grabFrames(m.path, times, { hdr: Boolean((m.probe as { hdr?: unknown }).hdr) });
  };

/**
 * Before asking about putts: the AI looks at a few frames of each unsure hole's putting (only
 * when the user turned it on). Sure answers are filled in and their questions dropped; anything
 * else stays a question. Never fails the video.
 */
async function lookAtPutts(
  ai: JobAiConfig,
  doc: Project,
  summary: RoundSummary,
  preference: string,
  start: VideoPlan,
  usage: AiUsage,
  ctx: { locale: Locale; yes: boolean; frames: FrameGrabber; log: Log; job: string; doFetch?: typeof fetch },
): Promise<{ plan: VideoPlan; usage: AiUsage; found: VisionFound }> {
  let plan = start;
  const found: VisionFound = { answers: {}, notes: [] };
  const shots = new Map(doc.shots.map((s) => [s.id, s]));
  let calls = 0;
  let overBudget = false;
  for (const q of start.questions) {
    const hole = puttsHoleOf(q);
    if (hole === null || calls >= VISION_MAX_CALLS) continue;
    const seg = puttSegment(q, (id) => shots.get(id)?.putt?.end ?? null);
    if (!seg) continue;
    const duration = doc.media[seg.mediaId]?.duration ?? 0;
    const times = frameTimes(seg.from, duration > 0 ? Math.min(seg.to, duration - 0.05) : seg.to);
    // Room for the plan call after the user's answers (this question may stay).
    const reserve = ctx.yes ? 0 : planCallEstimate(summary, preference, plan, {});
    // No frames taken when the call would not fit anyway.
    if (usage.inputTokens + usage.outputTokens + visionCallEstimate(times.length) + reserve > ai.maxTokens) {
      overBudget = true;
      continue;
    }
    let frames: string[];
    try {
      frames = await ctx.frames(seg.mediaId, times);
    } catch (e) {
      ctx.log('ai vision frames failed', { job: ctx.job, hole, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
      continue;
    }
    const clip = summary.clips.find((c) => c.id === seg.mediaId);
    const out = await resolvePuttsWithVision(ai, { hole, par: clip?.par ?? null, times: times.slice(0, frames.length) }, frames, {
      used: usage,
      reserve,
      fetch: ctx.doFetch,
      log: (m, x) => ctx.log(m, { job: ctx.job, ...x }),
    });
    usage = out.usage;
    if (out.skipped === 'budget') {
      overBudget = true;
      continue;
    }
    calls++;
    const applied = out.result && applyPuttVision(plan, hole, out.result, ctx.locale);
    ctx.log('ai vision result', { job: ctx.job, hole, used: !!applied, confidence: out.result?.confidence ?? null, skipped: out.skipped ?? null });
    if (!applied) continue;
    plan = applied.plan;
    Object.assign(found.answers, applied.answers);
    found.notes.push(applied.note);
  }
  if (overBudget) {
    const note = T[ctx.locale].visionBudget;
    plan = { ...plan, notes: [...plan.notes.slice(0, 9), note] };
    found.notes.push(note);
  }
  return { plan, usage, found };
}

export async function handleCompose(
  api: Api,
  job: { id: string; payload: Record<string, unknown> },
  log: Log = () => {},
  doFetch?: typeof fetch,
  frames?: FrameGrabber,
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
  let found: VisionFound = { answers: p.vision?.answers ?? {}, notes: p.vision?.notes ?? [] };
  const answers = (extra: PlanAnswers | null | undefined): PlanAnswers => ({ ...found.answers, ...(extra ?? {}) });
  if (stored?.success) {
    plan = useAi && p.answers && stored.data.questions.length ? await withAi(stored.data, answers(p.answers)) : stored.data;
    // The model writes its own notes; what it saw in the frames stays said.
    const missing = found.notes.filter((n) => !plan.notes.includes(n));
    if (missing.length) plan = { ...plan, notes: [...plan.notes, ...missing].slice(0, 10) };
  } else {
    plan = useAi ? await withAi(rules, null) : rules;
    if (useAi && ai.vision) {
      const v = await lookAtPutts(ai, doc, summary, p.preference ?? '', plan, usage, {
        locale,
        yes: !!p.yes,
        frames: frames ?? ffmpegFrames(api),
        log,
        job: job.id,
        doFetch,
      });
      plan = v.plan;
      usage = v.usage;
      found = v.found;
    }
  }

  if (plan.questions.length && !p.answers && !p.yes) {
    await api.awaitAnswers(
      job.id,
      {
        plan,
        questions: plan.questions,
        notes: plan.notes,
        title: plan.title,
        kind: plan.kind,
        usage: useAi ? usage : null,
        vision: Object.keys(found.answers).length ? found : null,
      },
      locale === 'da' ? 'Venter på dine svar' : 'Waiting for your answers',
    );
    return 'asked';
  }

  await api.progress(job.id, 0.5, locale === 'da' ? 'Klipper videoen' : 'Editing the video');
  const videos = compose(doc, plan, answers(p.answers), { locale, names: p.names ?? {} });
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
