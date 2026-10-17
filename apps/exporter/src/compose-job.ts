/**
 * The "compose" job ("Make a video for me"): waits for the project's analysis, summarises the
 * round, makes a plan, stops to ask when the rules found doubts, and saves the finished
 * video(s) as new projects.
 */
import {
  addUsage,
  AiError,
  applyPuttVision,
  compose,
  noUsage,
  planFromRules,
  planWithAI,
  PLAN_KINDS,
  publishText,
  puttCrop,
  puttFrames,
  puttSegment,
  puttsHoleOf,
  resolvePuttsWithVision,
  testConnection,
  summarize,
  templatesFor,
  VideoPlan,
  VISION_MAX_CALLS,
  visionCallEstimate,
  visionFits,
  type AiConfig,
  type Crop,
  type AiUsage,
  type LayerNames,
  type PlanAnswers,
  type PlanKind,
  type RoundSummary,
} from '@golf/compose';
import { migrateProject, type Project } from '@golf/schema';
import type { InternalApi } from './api';
import { grabFrames } from './frames';

type Locale = 'da' | 'en';

export interface ComposePayload {
  project_id: string;
  /** The format the user picked (a card in the dialog); the wish cannot change it. */
  kind?: PlanKind | null;
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
  /**
   * Saved by an earlier attempt of this job (see `checkpoint`): the plan above already has the
   * answers applied by the AI, so a retry after a later failure does not call (or pay for) it again.
   */
  answered?: boolean;
  /** The videos an earlier attempt already saved, in order: a retry does not make them twice. */
  derived?: { id: string; name: string }[];
}

/** The AI model for a job (from the API: the user's settings, else the .env defaults). */
export type JobAiConfig = AiConfig & { source?: string; vision?: boolean };

interface VisionFound {
  answers: PlanAnswers;
  notes: string[];
}

/** Base64 JPEGs of a clip at the given seconds, of the whole frame or a region of it (see frames.ts). */
export type FrameGrabber = (mediaId: string, times: number[], crop?: Crop | null) => Promise<string[]>;

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

type Api = Pick<InternalApi, 'jobProject' | 'jobAi' | 'defer' | 'awaitAnswers' | 'derive' | 'progress' | 'complete'> &
  Partial<Pick<InternalApi, 'media' | 'checkpoint'>>;
type Log = (msg: string, extra: Record<string, unknown>) => void;

const T = {
  da: {
    byModel: (m: string) => `Planen er lavet af AI-modellen ${m}.`,
    fellBack: 'AI-svaret kunne ikke bruges (to gange), så planen er lavet af faste regler.',
    failed: (why: string) => `AI'en kunne ikke bruges (${why}), så planen er lavet af faste regler.`,
    budget: (max: number) =>
      `Runden er for stor til loftet på ${max} tokens, så planen er lavet af faste regler. Hæv loftet under Indstillinger → AI for at bruge AI'en.`,
    failedAfter: (why: string) => `AI'en kunne ikke tilpasse planen efter dine svar (${why}), så svarene er brugt på planen, som den var.`,
    overCeiling: (max: number) => `loftet på ${max} tokens ville blive overskredet`,
    none: 'Ingen slag blev tilbage, så der blev ikke lavet en video.',
    visionBudget: "AI'en så ikke på billederne fra greenen: det ville bruge flere tokens, end der er sat af til billeder.",
    reasons: {
      config: 'AI-indstillingerne mangler noget',
      network: (what: string) => `${what} kunne ikke nås eller svarede ikke i tide`,
      auth: (what: string) => `${what} afviste nøglen eller login`,
      model: (what: string, model: string) => `${what} kender ikke modellen "${model}"`,
      refused: (what: string) => `${what} afslog opgaven`,
      limit: 'grænsen for din ChatGPT-plan er nået',
      http: (what: string, status?: number) => `${what} svarede med en fejl${status ? ` (${status})` : ''}`,
      other: 'AI-tjenesten fejlede',
    },
  },
  en: {
    byModel: (m: string) => `The plan was made by the AI model ${m}.`,
    fellBack: "The AI's answer could not be used (twice), so the plan was made by fixed rules.",
    failed: (why: string) => `The AI could not be used (${why}), so the plan was made by fixed rules.`,
    budget: (max: number) =>
      `The round is too large for the ceiling of ${max} tokens, so the plan was made by fixed rules. Raise the ceiling under Settings → AI to use the AI.`,
    failedAfter: (why: string) => `The AI could not adjust the plan to your answers (${why}), so your answers were applied to the plan as it was.`,
    overCeiling: (max: number) => `the ceiling of ${max} tokens would be passed`,
    none: 'No shots were left, so no video was made.',
    visionBudget: 'The AI did not look at frames from the green: it would use more tokens than are set aside for pictures.',
    reasons: {
      config: 'the AI settings are incomplete',
      network: (what: string) => `${what} could not be reached or did not answer in time`,
      auth: (what: string) => `${what} rejected the key or sign-in`,
      model: (what: string, model: string) => `${what} does not know the model "${model}"`,
      refused: (what: string) => `${what} declined the task`,
      limit: 'the limit of your ChatGPT plan is reached',
      http: (what: string, status?: number) => `${what} answered with an error${status ? ` (${status})` : ''}`,
      other: 'the AI provider failed',
    },
  },
};

/** Frames from the media file the API points to. */
const ffmpegFrames =
  (api: Api): FrameGrabber =>
  async (mediaId, times, crop) => {
    if (!api.media) throw new Error('no media lookup');
    const m = await api.media(mediaId);
    return grabFrames(m.path, times, { hdr: Boolean((m.probe as { hdr?: unknown }).hdr), crop });
  };

/**
 * Before asking about putts: the AI looks at a few frames of each unsure hole's putting (only
 * when the user turned it on), taken at the putts found and cropped around the ball. Sure
 * answers are filled in and their questions dropped; anything else stays a question. The
 * frames have their own token allowance (vision.ts). Never fails the video.
 */
async function lookAtPutts(
  ai: JobAiConfig,
  doc: Project,
  summary: RoundSummary,
  start: VideoPlan,
  usage: AiUsage,
  ctx: { locale: Locale; frames: FrameGrabber; log: Log; job: string; doFetch?: typeof fetch },
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
    const media = doc.media[seg.mediaId];
    const inClip = (q.items ?? []).filter((it) => it.mediaId === seg.mediaId);
    const { times, roles } = puttFrames(
      inClip.map((it) => ({ t: it.t, end: shots.get(it.shotId)?.putt?.end ?? null })),
      media?.duration ?? Infinity,
    );
    if (!times.length) continue;
    // No frames taken when the call would not fit anyway.
    if (visionFits(ai, usage, visionCallEstimate(times.length, ' '.repeat(400)))) {
      overBudget = true;
      continue;
    }
    const putts = inClip.map((it) => shots.get(it.shotId)).filter((s): s is NonNullable<typeof s> => !!s);
    const crop = media ? puttCrop(putts, media.width, media.height) : null;
    let frames: string[];
    try {
      frames = await ctx.frames(seg.mediaId, times, crop);
    } catch (e) {
      ctx.log('ai vision frames failed', { job: ctx.job, hole, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
      continue;
    }
    // Frames past the end of the file are skipped by the grabber: keep times and roles in step.
    const n = Math.min(frames.length, times.length);
    const clip = summary.clips.find((c) => c.id === seg.mediaId);
    const out = await resolvePuttsWithVision(
      ai,
      {
        hole,
        par: clip?.par ?? null,
        times: times.slice(0, n),
        roles: frames.length === times.length ? roles : undefined,
        otherPutts: (q.items ?? []).length - inClip.length,
      },
      frames.slice(0, n),
      { used: usage, fetch: ctx.doFetch, log: (m, x) => ctx.log(m, { job: ctx.job, ...x }) },
    );
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

/** Why the AI could not be used, in a few words for a note – in the user's language. */
function aiReason(e: unknown, ai: AiConfig, locale: Locale): string {
  const R = T[locale].reasons;
  if (!(e instanceof AiError)) return R.other;
  const what = e.info.what ?? 'AI';
  switch (e.code) {
    case 'budget':
      return T[locale].overCeiling(ai.maxTokens);
    case 'config':
      return R.config;
    case 'network':
      return R.network(what);
    case 'auth':
      return R.auth(what);
    case 'model':
      return R.model(what, e.info.model ?? ai.model);
    case 'refused':
      return R.refused(what);
    case 'limit':
      return R.limit;
    case 'http':
    case 'vision':
    case 'invalid':
      return R.http(what, e.info.status);
  }
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
  const kind = p.kind && (PLAN_KINDS as readonly string[]).includes(p.kind) ? p.kind : null;
  const rules = planFromRules(summary, p.preference ?? '', locale, { kind });
  const ai = (await api.jobAi(job.id)) as JobAiConfig;
  const useAi = ai.provider !== 'none';
  let usage: AiUsage = p.usage ?? noUsage();
  // The rules' first note says "no AI"; with a model it says which one, or that its answer was unusable.
  const ruleNotes = rules.notes.slice(1);
  // Never fails the video: when the AI cannot be used (key, network, token ceiling …) the plan
  // is the rules' (first call) or the one the questions came from (after the answers), with a note.
  const withAi = async (base: VideoPlan, answers: PlanAnswers | null): Promise<VideoPlan> => {
    let out: Awaited<ReturnType<typeof planWithAI>>;
    try {
      out = await planWithAI(ai, summary, p.preference ?? '', base, answers, {
        allowedTemplates: templatesFor(),
        used: usage,
        kind,
        fetch: doFetch,
        log,
      });
    } catch (e) {
      const u = (e as { usage?: AiUsage }).usage;
      if (u) usage = addUsage(usage, u);
      log('ai failed', {
        job: job.id,
        provider: ai.provider,
        model: ai.model,
        code: e instanceof AiError ? e.code : 'unknown',
        error: e instanceof AiError ? e.message : 'unknown',
      });
      const budget = e instanceof AiError && e.code === 'budget';
      if (answers) return { ...base, notes: [...base.notes.slice(0, 9), T[locale].failedAfter(aiReason(e, ai, locale))] };
      return { ...base, notes: [budget ? T[locale].budget(ai.maxTokens) : T[locale].failed(aiReason(e, ai, locale)), ...ruleNotes] };
    }
    usage = out.usage;
    log('ai usage', { job: job.id, provider: ai.provider, model: ai.model, ...usage });
    return out.fellBack ? { ...base, notes: [T[locale].fellBack, ...ruleNotes] } : { ...out.plan, notes: [T[locale].byModel(ai.model), ...out.plan.notes] };
  };

  // First pass: one call for the plan. After the answers: one more call, only if there were questions.
  let plan: VideoPlan;
  let found: VisionFound = { answers: p.vision?.answers ?? {}, notes: p.vision?.notes ?? [] };
  const answers = (extra: PlanAnswers | null | undefined): PlanAnswers => ({ ...found.answers, ...(extra ?? {}) });
  // What the AI made is kept on the job right away: should anything later fail and the job run
  // again, it starts from there instead of calling (and paying for) the AI once more – the
  // ceiling is per video, not per attempt.
  const checkpoint = async (data: Partial<ComposePayload>) => {
    Object.assign(p, data);
    // Only a cost saving for a retry: never a reason to fail the video.
    await api
      .checkpoint?.(job.id, data as Record<string, unknown>)
      .catch((e: unknown) => log('checkpoint failed', { job: job.id, error: String(e).slice(0, 200) }));
  };
  if (stored?.success) {
    const again = useAi && p.answers && !p.answered && stored.data.questions.length;
    plan = again ? await withAi(stored.data, answers(p.answers)) : stored.data;
    if (again) await checkpoint({ plan, usage, answered: true });
    // The model writes its own notes; what it saw in the frames stays said.
    const missing = found.notes.filter((n) => !plan.notes.includes(n));
    if (missing.length) plan = { ...plan, notes: [...plan.notes, ...missing].slice(0, 10) };
  } else {
    plan = useAi ? await withAi(rules, null) : rules;
    if (useAi && ai.vision) {
      const v = await lookAtPutts(ai, doc, summary, plan, usage, {
        locale,
        frames: frames ?? ffmpegFrames(api),
        log,
        job: job.id,
        doFetch,
      });
      plan = v.plan;
      usage = v.usage;
      found = v.found;
    }
    if (useAi) await checkpoint({ plan, usage, vision: Object.keys(found.answers).length ? found : null });
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
  const projects: { id: string; name: string }[] = [...(p.derived ?? [])].slice(0, videos.length);
  for (const [i, v] of videos.entries()) {
    if (i < projects.length) continue;
    projects.push(await api.derive(job.id, v.name, v.document));
    await checkpoint({ derived: projects });
    await api.progress(job.id, 0.5 + (0.5 * (i + 1)) / videos.length);
  }
  await api.complete(job.id, {
    projects,
    kind: plan.kind,
    title: plan.title,
    // For YouTube: the AI's description or one from the facts, with chapters from the timeline.
    description: videos.length ? publishText(videos[0].document) : '',
    // Nothing left to show (every shot left out): say so instead of an empty project.
    notes: videos.length ? plan.notes : [...plan.notes, T[locale].none],
    ai: useAi ? { provider: ai.provider, model: ai.model } : null,
    usage: useAi ? usage : null,
  });
  return 'done';
}

/** "Test connection" from Settings → AI: one tiny call with the user's model (errors: see main.ts). */
export async function handleAiTest(api: Pick<InternalApi, 'jobAi' | 'complete'>, job: { id: string }, doFetch?: typeof fetch): Promise<void> {
  const ai = (await api.jobAi(job.id)) as JobAiConfig;
  const t = await testConnection(ai, doFetch);
  await api.complete(job.id, { provider: ai.provider, model: t.model, usage: t.usage, ms: t.ms });
}

export { AiError };
