/**
 * The optional AI model behind "Make a video for me". The model thinks, the code works:
 *
 * - it only ever sees the round summary (summaryText) and the user's own words – never video or
 *   the project document; still frames only when the user turns that on (see vision.ts);
 * - it answers with a small plan (validated with zod) that adjusts the rule plan, never a project;
 * - at most two calls per video: one for the plan, one after the user's answers;
 * - doubts are found by the rules – the model may reword the questions, not add or remove them;
 * - invalid output gets one retry with the validation error, then the rule plan is used.
 *
 * Two adapters on plain fetch: OpenAI-compatible (Ollama, LM Studio, OpenAI, OpenRouter) and
 * the Anthropic Messages API.
 */
import { z } from 'zod';
import { PLAN_KINDS, PUTT_MODES, VideoPlan, type PlanAnswers } from './plan';
import { summaryText, type RoundSummary } from './summary';

export const AI_PROVIDERS = ['none', 'ollama', 'openai-compatible', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Ceiling for all tokens (in + out) one video may use. */
  maxTokens: number;
  /** Per request (ms). */
  timeoutMs?: number;
}

export const AI_DEFAULTS: Record<Exclude<AiProvider, 'none'>, { baseUrl: string; model: string }> = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
};
export const DEFAULT_AI_MAX_TOKENS = 8000;
/** Output budget per call: the plan is small (target ≤ 800 tokens); reasoning models need room to think. */
const OUTPUT_TOKENS = 2000;

export interface AiUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export const noUsage = (): AiUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
const add = addUsage;

/** A failure the user should see as it is (wrong key, Ollama not running, token ceiling). */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: 'config' | 'network' | 'auth' | 'model' | 'refused' | 'budget' | 'http' | 'invalid' | 'vision',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// The prompt. Fixed and first in every call so providers can cache it; nothing dynamic in it.

export const SYSTEM_PROMPT = `You plan golf videos for an editing app. The app has already analysed the clips and made a plan with fixed rules ("rule plan"). Your job is to adjust that plan to the user's wish. You never see video – only a summary with one line per clip and per shot.

Summary fields: clip n, filmed time, hole/par from GPS, shots in the clip; shot n, clip, t (seconds into the clip), hole, par, club, carry/apex in metres ('?' = unknown), conf (0–1 confidence of the analysis), flags (analysis warnings: no_track, implausible, carry_mismatch, default_path, next_shot_distance = doubtful flight; short_shot, low_confidence, few_points, start_extrapolated, manual), next (metres by GPS to the next stroke; carry=~N is a guess from it). A last "score" line gives strokes/par and putts per hole ('?' = not every stroke was filmed: never guess a score).

You may change:
- kind: "youtube" (16:9 video of the round), "highlight" (one vertical short of all shots) or "shorts" (one vertical short per shot). Follow the user's wish; keep the rule plan's choice when the wish says nothing about format.
- template: null or one of "range", "minimal", "tv", "holeInOne", "swing", "neon" (only the tracer look). Keep null unless the wish asks for a style.
- includeShotIds: a subset of the rule plan's shot ids, e.g. when the user wants only certain holes or the best shots. Never add ids that are not in the rule plan.
- putts: null (the app's default: each hole's putting in "youtube", only holed putts otherwise), "none", "holed" or "all". Putts are shown as plain video, never traced. Keep null unless the wish mentions putts.
- order: shot ids in playing order, only when the user asks for another order; otherwise an empty list.
- title: a short video title in the user's language.
- shotTexts: at most one short line (≤ 60 characters) for a few notable shots, e.g. "Longest drive of the day". Use only facts from the summary. Empty when not useful.
- description: 1–3 sentences for posting the video (YouTube/social), in the user's language, only facts from the summary.
- questions: the rule plan's questions with the SAME ids, option ids and number of questions. You may only rewrite "text" and option "label" to read better in the user's language, and pick a different "default" among the existing option ids when the wish clearly implies it (e.g. "only good shots" → leave doubtful shots out). Never add or remove questions or options.
- notes: short notes for the user (assumptions you made). At most 3.

When the user has answered the questions (answers are given), apply them: e.g. leave out shots the answers exclude, and make title/texts/description fit. Keep the questions as they are.

Write in the language of the user's wish (Danish or English). Answer with the JSON object only. Be brief.`;

/** JSON schema the model must answer with (structured output where the provider supports it). */
export const AI_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'template', 'putts', 'includeShotIds', 'order', 'title', 'shotTexts', 'description', 'questions', 'notes'],
  properties: {
    kind: { type: 'string', enum: [...PLAN_KINDS] },
    template: { anyOf: [{ type: 'string', enum: ['range', 'minimal', 'tv', 'holeInOne', 'swing', 'neon'] }, { type: 'null' }] },
    putts: { anyOf: [{ type: 'string', enum: [...PUTT_MODES] }, { type: 'null' }] },
    includeShotIds: { type: 'array', items: { type: 'string' } },
    order: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    shotTexts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shotId', 'text'],
        properties: { shotId: { type: 'string' }, text: { type: 'string' } },
      },
    },
    description: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'options', 'default'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          default: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: { id: { type: 'string' }, label: { type: 'string' } },
            },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** What the model answers (lenient: everything optional; merged into the rule plan). */
const AiAnswer = z.object({
  kind: z.enum(PLAN_KINDS).optional(),
  template: z.string().nullable().optional(),
  putts: z.enum(PUTT_MODES).nullable().optional(),
  includeShotIds: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
  title: z.string().optional(),
  shotTexts: z.array(z.object({ shotId: z.string(), text: z.string() })).optional(),
  description: z.string().optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().optional(),
        default: z.string().optional(),
        options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
      }),
    )
    .optional(),
  notes: z.array(z.string()).optional(),
});

/** The model's own words in the user message: summary, wish, rule plan and (second call) answers. */
export function userMessage(summary: RoundSummary, preference: string, rulePlan: VideoPlan, answers?: PlanAnswers | null): string {
  const plan = {
    kind: rulePlan.kind,
    template: rulePlan.template,
    putts: rulePlan.putts ?? null,
    includeShotIds: rulePlan.includeShotIds,
    title: rulePlan.title,
    questions: rulePlan.questions.map((q) => ({ id: q.id, text: q.text, options: q.options, default: q.default })),
  };
  return [
    'SUMMARY',
    summaryText(summary),
    '',
    'WISH',
    preference.trim() || '(none – make a good video of the round)',
    '',
    'RULE PLAN',
    JSON.stringify(plan),
    ...(answers ? ['', 'ANSWERS (question id → chosen option id; shot:<shot id> → keep or drop for that one shot, which wins)', JSON.stringify(answers)] : []),
  ].join('\n');
}

/**
 * The model's answer applied to the rule plan, within what it may change. Throws (with a
 * message the model can act on) when the answer cannot be used.
 */
export function mergeAiPlan(rulePlan: VideoPlan, raw: unknown, allowedTemplates: readonly string[]): VideoPlan {
  const a = AiAnswer.parse(raw);
  const allowed = new Set(rulePlan.includeShotIds);
  const include = a.includeShotIds?.filter((id) => allowed.has(id)) ?? rulePlan.includeShotIds;
  if (a.includeShotIds && include.length === 0 && rulePlan.includeShotIds.length)
    throw new Error('includeShotIds must keep at least one shot id from the rule plan');
  const questions = rulePlan.questions.map((q) => {
    const m = a.questions?.find((x) => x.id === q.id);
    if (!m) return q;
    const options = q.options.map((o) => ({ ...o, label: m.options?.find((x) => x.id === o.id)?.label?.trim() || o.label }));
    return { ...q, text: m.text?.trim() || q.text, options, default: m.default && q.options.some((o) => o.id === m.default) ? m.default : q.default };
  });
  const template = a.template === undefined ? rulePlan.template : a.template && allowedTemplates.includes(a.template) ? a.template : rulePlan.template;
  const shotTexts = Object.fromEntries(
    (a.shotTexts ?? []).filter((t) => allowed.has(t.shotId) && t.text.trim()).map((t) => [t.shotId, t.text.trim().slice(0, 80)]),
  );
  return VideoPlan.parse({
    ...rulePlan,
    kind: a.kind ?? rulePlan.kind,
    template,
    putts: a.putts === undefined ? rulePlan.putts : (a.putts ?? undefined),
    includeShotIds: include,
    order: a.order?.filter((id) => allowed.has(id)).length ? a.order.filter((id) => allowed.has(id)) : undefined,
    title: a.title?.trim().slice(0, 120) || rulePlan.title,
    shotTexts: Object.keys(shotTexts).length ? shotTexts : undefined,
    description: a.description?.trim().slice(0, 2000) || undefined,
    questions,
    notes: [
      ...(a.notes ?? [])
        .map((n) => n.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 3),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Adapters

interface Completion {
  text: string;
  usage: AiUsage;
}

/** What the user turn carries: text, or text with still frames (base64 JPEG). */
export type UserContent = string | { text: string; images: string[] };
const textOf = (u: UserContent) => (typeof u === 'string' ? u : u.text);
const imagesOf = (u: UserContent) => (typeof u === 'string' ? [] : u.images);

const visionError = (cfg: AiConfig, what: string, status: number) =>
  new AiError(`${what} could not use the pictures (${status}) – the model "${cfg.model}" may not support images.`, 'vision');

type Fetch = typeof fetch;

/** fetch with a timeout and one retry on network errors (not on HTTP errors). */
async function post(url: string, init: RequestInit, timeoutMs: number, doFetch: Fetch, what: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt >= 1) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        throw new AiError(
          timeout ? `${what} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `Cannot reach ${what} at ${new URL(url).origin}.`,
          'network',
        );
      }
    }
  }
}

async function httpError(r: Response, cfg: AiConfig, what: string): Promise<AiError> {
  let detail = '';
  try {
    const j = (await r.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '');
  } catch {
    /* not JSON */
  }
  detail = detail.replaceAll(cfg.apiKey || '\u0000', '***').slice(0, 300);
  if (r.status === 401 || r.status === 403) return new AiError(`${what} rejected the API key (${r.status}).`, 'auth');
  if (r.status === 404) return new AiError(`${what} does not know the model "${cfg.model}" (404)${detail ? `: ${detail}` : ''}.`, 'model');
  return new AiError(`${what} answered ${r.status}${detail ? `: ${detail}` : ''}.`, 'http');
}

const providerName = (cfg: AiConfig) =>
  cfg.provider === 'anthropic'
    ? 'Anthropic'
    : cfg.provider === 'ollama'
      ? 'Ollama'
      : (() => {
          try {
            return new URL(cfg.baseUrl).host;
          } catch {
            return 'The AI provider';
          }
        })();

/** OpenAI-compatible chat completions: Ollama, LM Studio, OpenAI, OpenRouter. */
async function openAiComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object, maxOut: number): Promise<Completion> {
  const what = providerName(cfg);
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const images = imagesOf(user);
  const content = images.length
    ? [{ type: 'text', text: textOf(user) }, ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }))]
    : textOf(user);
  const body = (format: unknown) =>
    JSON.stringify({
      model: cfg.model,
      max_tokens: maxOut,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: format,
    });
  const timeout = cfg.timeoutMs ?? 120_000;
  let r = await post(
    url,
    { method: 'POST', headers, body: body({ type: 'json_schema', json_schema: { name: 'video_plan', strict: true, schema } }) },
    timeout,
    doFetch,
    what,
  );
  // Older servers only know plain JSON mode.
  if (r.status === 400 || r.status === 422) r = await post(url, { method: 'POST', headers, body: body({ type: 'json_object' }) }, timeout, doFetch, what);
  if (!r.ok) {
    if (cfg.provider === 'ollama' && r.status === 404)
      throw new AiError(`Ollama does not have the model "${cfg.model}". Run: ollama pull ${cfg.model}`, 'model');
    if (images.length && [400, 415, 422, 500].includes(r.status)) throw visionError(cfg, what, r.status);
    throw await httpError(r, cfg, what);
  }
  const j = (await r.json()) as {
    choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = j.choices?.[0];
  if (choice?.message?.refusal) throw new AiError(`${what} declined: ${choice.message.refusal.slice(0, 200)}`, 'refused');
  return {
    text: choice?.message?.content ?? '',
    usage: {
      calls: 1,
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      cacheReadTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
}

/** Anthropic Messages API; the fixed system prompt is marked for prompt caching. */
async function anthropicComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object, maxOut: number): Promise<Completion> {
  if (!cfg.apiKey) throw new AiError('Anthropic needs an API key (AI_API_KEY or Settings → AI).', 'config');
  const r = await post(
    `${cfg.baseUrl.replace(/\/$/, '')}/v1/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxOut,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: imagesOf(user).length
              ? [
                  ...imagesOf(user).map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
                  { type: 'text', text: textOf(user) },
                ]
              : textOf(user),
          },
        ],
        // A small, well-specified task: little thinking needed.
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      }),
    },
    cfg.timeoutMs ?? 120_000,
    doFetch,
    'Anthropic',
  );
  if (!r.ok) {
    if (imagesOf(user).length && [400, 413, 415, 422].includes(r.status)) throw visionError(cfg, 'Anthropic', r.status);
    throw await httpError(r, cfg, 'Anthropic');
  }
  const j = (await r.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  const usage: AiUsage = {
    calls: 1,
    inputTokens: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: j.usage?.output_tokens ?? 0,
    cacheReadTokens: j.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: j.usage?.cache_creation_input_tokens ?? 0,
  };
  if (j.stop_reason === 'refusal') throw Object.assign(new AiError('Anthropic declined the request.', 'refused'), { usage });
  return {
    text: (j.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    usage,
  };
}

export function complete(
  cfg: AiConfig,
  system: string,
  user: UserContent,
  doFetch: Fetch = fetch,
  schema: object = AI_PLAN_SCHEMA,
  maxOut = OUTPUT_TOKENS,
): Promise<Completion> {
  if (cfg.provider === 'none') throw new AiError('No AI provider is set.', 'config');
  if (!cfg.model) throw new AiError('No AI model is set (AI_MODEL or Settings → AI).', 'config');
  return cfg.provider === 'anthropic'
    ? anthropicComplete(cfg, system, user, doFetch, schema, maxOut)
    : openAiComplete(cfg, system, user, doFetch, schema, maxOut);
}

/** "Test connection": the smallest possible call; shows that provider, key and model work. */
export async function testConnection(cfg: AiConfig, doFetch: Fetch = fetch): Promise<{ model: string; usage: AiUsage; ms: number }> {
  const t0 = Date.now();
  const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
  const c = await complete(cfg, 'Answer with the JSON object {"ok": true}.', 'ping', doFetch, schema, 256);
  parseJson(c.text);
  return { model: cfg.model, usage: c.usage, ms: Date.now() - t0 };
}

/** Pulls the JSON object out of a reply (models sometimes wrap it in ``` fences or prose). */
export function parseJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('the reply is not a JSON object');
  }
}

/** Rough token count before sending (4 characters per token), to keep within the ceiling. */
export const estimateTokens = (...texts: string[]) => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);

/** Tokens one plan call may need at most (prompt estimate + its output budget). */
export const planCallEstimate = (summary: RoundSummary, preference: string, plan: VideoPlan, answers?: PlanAnswers | null) =>
  estimateTokens(SYSTEM_PROMPT, userMessage(summary, preference, plan, answers)) + OUTPUT_TOKENS;

export interface PlanWithAiOptions {
  allowedTemplates: readonly string[];
  /** Tokens already used by this video (the first call, when answering). */
  used?: AiUsage;
  fetch?: Fetch;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}

/**
 * The plan from the model: one call (plus at most one retry when the answer is invalid). Falls
 * back to the rule plan with a note when the model's answer stays unusable; stops with an
 * AiError when the provider cannot be used or the token ceiling would be passed.
 */
export async function planWithAI(
  cfg: AiConfig,
  summary: RoundSummary,
  preference: string,
  rulePlan: VideoPlan,
  answers: PlanAnswers | null | undefined,
  opts: PlanWithAiOptions,
): Promise<{ plan: VideoPlan; usage: AiUsage; fellBack: boolean }> {
  let usage = opts.used ?? noUsage();
  const user = userMessage(summary, preference, rulePlan, answers);
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = feedback ? `${user}\n\nYOUR PREVIOUS ANSWER WAS INVALID: ${feedback}\nAnswer again with a valid JSON object.` : user;
    const spent = usage.inputTokens + usage.outputTokens;
    const next = estimateTokens(SYSTEM_PROMPT, message) + OUTPUT_TOKENS;
    if (spent + next > cfg.maxTokens)
      throw new AiError(`This video would use more than AI_MAX_TOKENS (${cfg.maxTokens}) tokens: ${spent} used, about ${next} more needed.`, 'budget');
    let c: Completion;
    try {
      c = await complete(cfg, SYSTEM_PROMPT, message, opts.fetch);
    } catch (e) {
      const u = (e as { usage?: AiUsage }).usage;
      if (u) usage = add(usage, u);
      throw e;
    }
    usage = add(usage, c.usage);
    opts.log?.('ai call', {
      provider: cfg.provider,
      model: cfg.model,
      attempt: attempt + 1,
      inputTokens: c.usage.inputTokens,
      outputTokens: c.usage.outputTokens,
      cacheReadTokens: c.usage.cacheReadTokens,
    });
    try {
      return { plan: mergeAiPlan(rulePlan, parseJson(c.text), opts.allowedTemplates), usage, fellBack: false };
    } catch (e) {
      feedback = e instanceof z.ZodError ? z.prettifyError(e).slice(0, 600) : String(e instanceof Error ? e.message : e).slice(0, 600);
    }
  }
  return { plan: rulePlan, usage, fellBack: true };
}
