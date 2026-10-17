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
 * Four adapters on plain fetch: OpenAI-compatible chat completions (LM Studio, OpenAI,
 * OpenRouter), Ollama's own /api/chat (so the context window can be sized to the prompt), the
 * Anthropic Messages API, and "chatgpt": the OpenAI Responses API with a Sign in with ChatGPT
 * access token, billed to the user's ChatGPT plan (the API refreshes the token).
 *
 * A request is sent again only when it never reached the provider (connection refused, name not
 * found) or was turned down before any work (a parameter the model does not take): a request
 * that timed out may have been billed, so it is not repeated – its tokens are counted as an
 * estimate instead.
 */
import { z } from 'zod';
import { PLAN_KINDS, PUTT_MODES, VideoPlan, type PlanAnswers, type PlanKind } from './plan';
import { guardFacts } from './facts';
import { summaryText, type RoundSummary } from './summary';

export const AI_PROVIDERS = ['none', 'ollama', 'openai-compatible', 'anthropic', 'chatgpt'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Ceiling for the plan calls' tokens (in + out) of one video. */
  maxTokens: number;
  /** A separate allowance for looking at still frames (vision.ts); default DEFAULT_VISION_TOKENS. */
  visionMaxTokens?: number;
  /** Per request (ms). */
  timeoutMs?: number;
  /** Why there is no usable key (chatgpt: not signed in, or the sign-in could not be renewed). */
  error?: string;
}

export const AI_DEFAULTS: Record<Exclude<AiProvider, 'none'>, { baseUrl: string; model: string }> = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  // The model is picked from the signed-in account's list.
  chatgpt: { baseUrl: 'https://api.openai.com/v1', model: '' },
};
/** Where users review and change what this app may use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
/**
 * The default ceiling: what both plan calls of a large round (100 shots in 90 clips, with
 * questions) need – see budget.ts `largeRound` and its test. Raised from 16 000, which a round
 * of that size passed on the second call.
 */
export const DEFAULT_AI_MAX_TOKENS = 20000;
/** Output budget per call: the plan is small (target ≤ 800 tokens); reasoning models need room to think. */
export const OUTPUT_TOKENS = 2000;

export interface AiUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of the tokens above, those spent looking at still frames (their own allowance, see vision.ts). */
  visionTokens?: number;
}
export const noUsage = (): AiUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  ...(a.visionTokens || b.visionTokens ? { visionTokens: (a.visionTokens ?? 0) + (b.visionTokens ?? 0) } : {}),
});
/** Tokens the plan calls have used (all minus those of the still frames). */
export const planTokensUsed = (u: AiUsage) => u.inputTokens + u.outputTokens - (u.visionTokens ?? 0);
const add = addUsage;

export type AiErrorCode = 'config' | 'network' | 'auth' | 'model' | 'refused' | 'budget' | 'http' | 'invalid' | 'vision' | 'limit';

/**
 * What the apps need to say an AiError in the user's language (see `aiErrorJson`): `reason`
 * tells cases of one code apart, the rest fills in the words. `detail` is the provider's own
 * text (English, never the key).
 */
export interface AiErrorInfo {
  reason?: string;
  what?: string;
  model?: string;
  status?: number;
  seconds?: number;
  origin?: string;
  detail?: string;
  max?: number;
  used?: number;
  need?: number;
}

/** A failure the user should see as it is (wrong key, Ollama not running, token ceiling). */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: AiErrorCode,
    readonly info: AiErrorInfo = {},
  ) {
    super(message);
  }
}

/** The job error for an AiError: `ai:` and a small JSON the apps translate (see `parseAiError`). */
export const AI_ERROR_PREFIX = 'ai:';
export function aiErrorJson(e: AiError): string {
  const info = { ...e.info, ...(e.info.detail ? { detail: e.info.detail.slice(0, 160) } : {}) };
  // The job keeps only the last 500 characters of an error: short enough to stay whole.
  return `${AI_ERROR_PREFIX}${JSON.stringify({ code: e.code, ...info, message: e.message.slice(0, 220) })}`;
}
export function parseAiError(text: string | null | undefined): (AiErrorInfo & { code: AiErrorCode; message: string }) | null {
  if (!text?.startsWith(AI_ERROR_PREFIX)) return null;
  try {
    const j = JSON.parse(text.slice(AI_ERROR_PREFIX.length)) as AiErrorInfo & { code?: AiErrorCode; message?: string };
    return typeof j.code === 'string' ? { ...j, code: j.code, message: String(j.message ?? '') } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The prompt. Fixed and first in every call so providers can cache it; nothing dynamic in it.

export const SYSTEM_PROMPT = `You plan golf videos for an editing app. The app has already analysed the clips and made a plan with fixed rules ("rule plan"). Your job is to adjust that plan to the user's wish. You never see video – only a summary with one line per clip and per shot.

Summary fields: clip n, time of day filmed, length, portrait/landscape, nogps (no GPS), hole/par from GPS; shot n (its number: name shots only by it), clip, t (seconds into the clip), hole (par is the clip's), club when known, carry in metres ('?' = unknown), conf (0–1 confidence of the analysis), flags (analysis warnings: no_track, implausible, carry_mismatch, default_path, off_frame, next_shot_distance = doubtful flight; short_shot, low_confidence, few_points, start_extrapolated, manual), next (metres by GPS to the next stroke; carry=~N is a guess from it, never a fact), tags (highlights found by the app: eagle, birdie, longest = longest measured carry, close = approach close to the next stroke, long_putt = long holed putt; "putt" lines list tagged putts). A last "score" line gives strokes/par and putts per hole ('?' = not every stroke was filmed: never guess a score).

You may change:
- kind: "youtube" (16:9 video of the round), "highlight" (one vertical short of all shots) or "shorts" (one vertical short per shot). When a FORMAT line is given the user picked it: keep it, whatever the wish says. Otherwise follow the wish; keep the rule plan's choice when the wish says nothing about format.
- template: null or one of "range", "minimal", "tv", "holeInOne", "swing", "neon" (only the tracer look). Keep null unless the wish asks for a style.
- includeShots: a subset of the rule plan's shot numbers, e.g. when the user wants only certain holes or the best shots. Never add numbers that are not in the rule plan.
- putts: null (the app's default: the holed putt of each hole in "youtube", only long holed putts in "highlight", none in "shorts"), "none", "holed" or "all" (every putt). Putts are shown as plain video, never traced. Keep null unless the wish mentions putts.
- order: shot numbers in playing order, only when the user asks for another order; otherwise an empty list.
- title: a short video title in the user's language.
- shotTexts: by shot number, at most one short line (≤ 60 characters) for a few notable shots, e.g. "Longest drive of the day" – prefer shots with tags. Use only facts from the summary; any number must be one of its values (no ~ guesses), or the text is dropped. Empty when not useful.
- description: 1–3 sentences for posting the video (YouTube/social), in the user's language, only facts from the summary (same rule for numbers).
- questions: the rule plan's questions with the SAME ids, option ids and number of questions. You may only rewrite "text" and option "label" to read better in the user's language, and pick a different "default" among the existing option ids when the wish clearly implies it (e.g. "only good shots" → leave doubtful shots out). Never add or remove questions or options.
- notes: short notes for the user (assumptions you made). At most 3.

When the user has answered the questions (answers are given), apply them: e.g. leave out shots the answers exclude, and make title/texts/description fit. Keep the questions as they are.

Write in the language of the user's wish (Danish or English). Answer with the JSON object only. Be brief.`;

/** JSON schema the model must answer with (structured output where the provider supports it). */
export const AI_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'template', 'putts', 'includeShots', 'order', 'title', 'shotTexts', 'description', 'questions', 'notes'],
  properties: {
    kind: { type: 'string', enum: [...PLAN_KINDS] },
    template: { anyOf: [{ type: 'string', enum: ['range', 'minimal', 'tv', 'holeInOne', 'swing', 'neon'] }, { type: 'null' }] },
    putts: { anyOf: [{ type: 'string', enum: [...PUTT_MODES] }, { type: 'null' }] },
    includeShots: { type: 'array', items: { type: 'integer' } },
    order: { type: 'array', items: { type: 'integer' } },
    title: { type: 'string' },
    shotTexts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shot', 'text'],
        properties: { shot: { type: 'integer' }, text: { type: 'string' } },
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

/** A shot as the model names it: its number (or, from older prompts, its id). */
const ShotRef = z.union([z.number(), z.string()]);
type ShotRef = z.infer<typeof ShotRef>;

/** What the model answers (lenient: everything optional; merged into the rule plan). */
const AiAnswer = z.object({
  kind: z.enum(PLAN_KINDS).optional(),
  template: z.string().nullable().optional(),
  putts: z.enum(PUTT_MODES).nullable().optional(),
  includeShots: z.array(ShotRef).optional(),
  includeShotIds: z.array(ShotRef).optional(),
  order: z.array(ShotRef).optional(),
  title: z.string().optional(),
  shotTexts: z.array(z.object({ shot: ShotRef.optional(), shotId: ShotRef.optional(), text: z.string() })).optional(),
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

/** Shot ids ↔ the numbers the model sees ("shot n" in the summary). */
export function shotNumbers(summary: RoundSummary): { num: (id: string) => number | null; id: (ref: ShotRef) => string | null } {
  const byId = new Map(summary.shots.map((x) => [x.id, x.n]));
  const byN = new Map(summary.shots.map((x) => [x.n, x.id]));
  return {
    num: (id) => byId.get(id) ?? null,
    id: (ref) => {
      if (typeof ref === 'string' && byId.has(ref)) return ref;
      const m = typeof ref === 'number' ? [String(ref), String(ref)] : /^\s*(?:shot\s*|s)?(\d+)\s*$/i.exec(ref);
      return m ? (byN.get(Number(m[1])) ?? null) : null;
    },
  };
}

/**
 * The model's own words in the user message: summary, the format the user picked (when they
 * did), wish, rule plan and (second call) answers – shots by number throughout.
 */
export function userMessage(summary: RoundSummary, preference: string, rulePlan: VideoPlan, answers?: PlanAnswers | null, kind?: PlanKind | null): string {
  const hide = withoutFileNames(summary);
  const { num } = shotNumbers(summary);
  const nums = (ids: readonly string[]) => ids.map(num).filter((n): n is number => n !== null);
  const shown = answers
    ? Object.fromEntries(
        Object.entries(answers).flatMap(([k, v]) => {
          if (!k.startsWith('shot:')) return [[k, v]];
          const n = num(k.slice(5));
          return n === null ? [] : [[`shot:${n}`, v]];
        }),
      )
    : null;
  const plan = {
    kind: rulePlan.kind,
    template: rulePlan.template,
    putts: rulePlan.putts ?? null,
    includeShots: nums(rulePlan.includeShotIds),
    title: rulePlan.title,
    questions: rulePlan.questions.map((q) => ({
      id: q.id,
      text: hide(q.text),
      options: q.options.map((o) => ({ ...o, label: hide(o.label) })),
      default: q.default,
    })),
  };
  return [
    'SUMMARY',
    summaryText(summary),
    '',
    ...(kind ? ['FORMAT', kind, ''] : []),
    'WISH',
    preference.trim() || '(none – make a good video of the round)',
    '',
    'RULE PLAN',
    JSON.stringify(plan),
    ...(shown ? ['', 'ANSWERS (question id → chosen option id; shot:<shot number> → keep or drop for that one shot, which wins)', JSON.stringify(shown)] : []),
  ].join('\n');
}

/**
 * Clip file names out of a text for the model (the rules' questions say "clip 3 (IMG_0042.MOV)"):
 * "(name)" goes, a bare name becomes "clip n". Names too short to be told apart from words stay.
 */
export function withoutFileNames(summary: RoundSummary): (text: string) => string {
  const names = summary.clips.filter((c) => c.name.trim().length >= 3).sort((a, b) => b.name.length - a.name.length);
  return (text) => {
    let t = text;
    for (const c of names) t = t.split(` (${c.name})`).join('').split(c.name).join(`clip ${c.n}`);
    return t;
  };
}

export interface MergeOptions {
  /** Turns the model's shot numbers into ids; without it the answer must name ids. */
  summary?: RoundSummary;
  /** The format the user picked: the model cannot change it. */
  kind?: PlanKind | null;
}

/**
 * The model's answer applied to the rule plan, within what it may change. Throws (with a
 * message the model can act on) when the answer cannot be used.
 */
export function mergeAiPlan(rulePlan: VideoPlan, raw: unknown, allowedTemplates: readonly string[], opts: MergeOptions = {}): VideoPlan {
  const a = AiAnswer.parse(raw);
  const allowed = new Set(rulePlan.includeShotIds);
  const toId = opts.summary ? shotNumbers(opts.summary).id : (ref: ShotRef) => String(ref);
  const ids = (refs: ShotRef[] | undefined) => refs?.map(toId).filter((id): id is string => id !== null && allowed.has(id));
  const asked = a.includeShots ?? a.includeShotIds;
  const include = ids(asked) ?? rulePlan.includeShotIds;
  if (asked && include.length === 0 && rulePlan.includeShotIds.length) throw new Error('includeShots must keep at least one shot number from the rule plan');
  const order = ids(a.order);
  const questions = rulePlan.questions.map((q) => {
    const m = a.questions?.find((x) => x.id === q.id);
    if (!m) return q;
    const options = q.options.map((o) => ({ ...o, label: m.options?.find((x) => x.id === o.id)?.label?.trim() || o.label }));
    return { ...q, text: m.text?.trim() || q.text, options, default: m.default && q.options.some((o) => o.id === m.default) ? m.default : q.default };
  });
  const template = a.template === undefined ? rulePlan.template : a.template && allowedTemplates.includes(a.template) ? a.template : rulePlan.template;
  // The rules' lines (highlights) stay for shots kept; the model's own win.
  const shotTexts = {
    ...Object.fromEntries(Object.entries(rulePlan.shotTexts ?? {}).filter(([id]) => include.includes(id))),
    ...Object.fromEntries(
      (a.shotTexts ?? []).flatMap((t) => {
        const ref = t.shot ?? t.shotId;
        const id = ref === undefined ? null : toId(ref);
        return id && allowed.has(id) && t.text.trim() ? [[id, t.text.trim().slice(0, 80)]] : [];
      }),
    ),
  };
  return VideoPlan.parse({
    ...rulePlan,
    kind: opts.kind ?? a.kind ?? rulePlan.kind,
    template,
    putts: a.putts === undefined ? rulePlan.putts : (a.putts ?? undefined),
    includeShotIds: include,
    order: order?.length ? order : undefined,
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
  new AiError(`${what} could not use the pictures (${status}) – the model "${cfg.model}" may not support images.`, 'vision', {
    what,
    model: cfg.model,
    status,
  });

type Fetch = typeof fetch;

/** Error codes of a connection that never reached the server: the request was not sent. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** The request never left: the connection was refused, the host is unknown, or fetch would not try. */
function notSent(e: unknown): boolean {
  const c = (e as { cause?: { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } })?.cause;
  const code = String(c?.code ?? c?.errors?.[0]?.code ?? '');
  return NOT_SENT.has(code) || /bad port/i.test(String(c?.message ?? ''));
}
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/**
 * fetch with a timeout, sent once more only when the first never reached the server. A timeout
 * or a connection that broke off is not repeated: the provider may have done (and billed) the work.
 */
async function post(url: string, init: RequestInit, timeoutMs: number, doFetch: Fetch, what: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const unsent = notSent(e);
      if (unsent && attempt < 1) continue;
      if (isTimeout(e))
        throw new AiError(`${what} did not answer within ${Math.round(timeoutMs / 1000)} s.`, 'network', {
          reason: 'timeout',
          what,
          seconds: Math.round(timeoutMs / 1000),
        });
      const origin = new URL(url).origin;
      throw new AiError(unsent ? `Cannot reach ${what} at ${origin}.` : `The connection to ${what} broke off.`, 'network', {
        reason: unsent ? 'unreachable' : 'broken',
        what,
        origin,
      });
    }
  }
}

/** An error answer: the provider's message (never the key) and which parameter it was about. */
interface ErrorBody {
  message: string;
  param: string;
  code: string;
}
async function errorBody(r: Response, cfg: AiConfig): Promise<ErrorBody> {
  let j: { error?: { message?: string; param?: string | null; code?: string | null } | string } = {};
  try {
    j = (await r.json()) as typeof j;
  } catch {
    /* not JSON */
  }
  const e = j.error;
  const message = (typeof e === 'string' ? e : (e?.message ?? '')).replaceAll(cfg.apiKey || '\u0000', '***').slice(0, 300);
  return { message, param: typeof e === 'object' ? (e?.param ?? '') : '', code: typeof e === 'object' ? (e?.code ?? '') : '' };
}

function statusError(status: number, body: ErrorBody, cfg: AiConfig, what: string): AiError {
  const detail = body.message;
  if (status === 401 || status === 403) return new AiError(`${what} rejected the API key (${status}).`, 'auth', { reason: 'key', what, status });
  if (status === 404)
    return new AiError(`${what} does not know the model "${cfg.model}" (404)${detail ? `: ${detail}` : ''}.`, 'model', { what, model: cfg.model, detail });
  return new AiError(`${what} answered ${status}${detail ? `: ${detail}` : ''}.`, 'http', { what, status, detail });
}

async function httpError(r: Response, cfg: AiConfig, what: string): Promise<AiError> {
  return statusError(r.status, await errorBody(r, cfg), cfg, what);
}

const providerName = (cfg: AiConfig) =>
  cfg.provider === 'anthropic'
    ? 'Anthropic'
    : cfg.provider === 'chatgpt'
      ? 'ChatGPT'
      : cfg.provider === 'ollama'
        ? 'Ollama'
        : (() => {
            try {
              return new URL(cfg.baseUrl).host;
            } catch {
              return 'The AI provider';
            }
          })();

/**
 * OpenAI's reasoning models (o1, o3, o4-mini, gpt-5 …) take `max_completion_tokens` instead of
 * `max_tokens`, only the default temperature, and `reasoning_effort`. Known by name up front;
 * other servers are found out from their 400 (see `openAiComplete`).
 */
export const isReasoningModel = (model: string) => /^(?:openai\/)?(?:o\d|gpt-5)/i.test(model.trim());

/** What one chat-completions request carries; the fields a server turned down are dropped. */
interface ChatParams {
  limit: 'max_tokens' | 'max_completion_tokens';
  temperature: boolean;
  effort: boolean;
  format: 'json_schema' | 'json_object';
}

/** The parameter a 400 is about, when it says so (OpenAI: `param`; others only in the text). */
function rejectedParam(e: ErrorBody): 'max_tokens' | 'temperature' | 'reasoning_effort' | 'response_format' | null {
  const text = `${e.param} ${e.message}`.toLowerCase();
  if (/max_tokens/.test(e.param) || (/max_tokens/.test(text) && /max_completion_tokens|unsupported|not supported/.test(text))) return 'max_tokens';
  if (/temperature/.test(text)) return 'temperature';
  if (/reasoning_effort/.test(text)) return 'reasoning_effort';
  if (/response_format|json_schema|json schema|structured/.test(text)) return 'response_format';
  return null;
}

/** OpenAI-compatible chat completions: LM Studio, OpenAI, OpenRouter. */
async function openAiComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object, maxOut: number): Promise<Completion> {
  const what = providerName(cfg);
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const images = imagesOf(user);
  const content = images.length
    ? [{ type: 'text', text: textOf(user) }, ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }))]
    : textOf(user);
  const reasoning = isReasoningModel(cfg.model);
  const p: ChatParams = { limit: reasoning ? 'max_completion_tokens' : 'max_tokens', temperature: !reasoning, effort: reasoning, format: 'json_schema' };
  // A reasoning model spends part of the limit thinking before it writes the plan.
  const limit = reasoning ? maxOut * 2 : maxOut;
  const body = () =>
    JSON.stringify({
      model: cfg.model,
      [p.limit]: limit,
      ...(p.temperature ? { temperature: 0.2 } : {}),
      ...(p.effort ? { reasoning_effort: 'low' } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format:
        p.format === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'video_plan', strict: true, schema } } : { type: 'json_object' },
    });
  const timeout = cfg.timeoutMs ?? 120_000;
  let r: Response;
  let err: ErrorBody | null = null;
  // A 400 is not billed: change what it was about and send again (at most once per parameter).
  for (let tries = 0; ; tries++) {
    r = await post(url, { method: 'POST', headers, body: body() }, timeout, doFetch, what);
    err = null;
    if (r.ok || (r.status !== 400 && r.status !== 422) || tries >= 4) break;
    err = await errorBody(r, cfg);
    const param = rejectedParam(err);
    if (param === 'max_tokens' && p.limit === 'max_tokens') p.limit = 'max_completion_tokens';
    else if (param === 'temperature' && p.temperature) p.temperature = false;
    else if (param === 'reasoning_effort' && p.effort) p.effort = false;
    // Older servers only know plain JSON mode.
    else if (p.format === 'json_schema') p.format = 'json_object';
    else break;
  }
  if (!r.ok) {
    if (images.length && [400, 415, 422, 500].includes(r.status)) throw visionError(cfg, what, r.status);
    throw err && (r.status === 400 || r.status === 422) ? statusError(r.status, err, cfg, what) : await httpError(r, cfg, what);
  }
  const j = (await r.json()) as {
    choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = j.choices?.[0];
  const usage: AiUsage = {
    calls: 1,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    cacheReadTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
  if (choice?.message?.refusal) throw Object.assign(new AiError(`${what} declined: ${choice.message.refusal.slice(0, 200)}`, 'refused', { what }), { usage });
  return { text: choice?.message?.content ?? '', usage };
}

/** Ollama's context window when the request does not say: prompts beyond it are cut silently. */
export const OLLAMA_DEFAULT_CTX = 4096;
export const OLLAMA_MAX_CTX = 131_072;

/**
 * The context window (`num_ctx`) a request to Ollama asks for: the prompt with a margin (the
 * 4-characters-per-token estimate runs low for JSON and Danish), each picture and the answer,
 * in steps of 2 048 so the model is not reloaded for every small difference.
 */
export function ollamaContext(promptTokens: number, images: number, maxOut: number): number {
  const need = Math.ceil(promptTokens * 1.3) + images * 800 + maxOut + 256;
  return Math.min(OLLAMA_MAX_CTX, Math.max(OLLAMA_DEFAULT_CTX, Math.ceil(need / 2048) * 2048));
}

/**
 * Ollama's own chat API (/api/chat). Its OpenAI-compatible endpoint uses the server's default
 * context (2–4k tokens) and silently cuts longer prompts – a whole round is longer – so the
 * window is set here, sized to the prompt. The base URL may end in /v1 (the old setting).
 */
async function ollamaComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object, maxOut: number): Promise<Completion> {
  const root = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = `${root}/api/chat`;
  const images = imagesOf(user);
  const text = textOf(user);
  const numCtx = ollamaContext(estimateTokens(system, text), images.length, maxOut);
  const body = (format: object | 'json') =>
    JSON.stringify({
      model: cfg.model,
      stream: false,
      format,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text, ...(images.length ? { images } : {}) },
      ],
      options: { num_ctx: numCtx, num_predict: maxOut, temperature: 0.2 },
    });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const timeout = cfg.timeoutMs ?? 120_000;
  let r = await post(url, { method: 'POST', headers, body: body(schema) }, timeout, doFetch, 'Ollama');
  // Ollama before 0.5 knows only "json" as a format.
  if (r.status === 400) r = await post(url, { method: 'POST', headers, body: body('json') }, timeout, doFetch, 'Ollama');
  if (!r.ok) {
    if (r.status === 404)
      throw new AiError(`Ollama does not have the model "${cfg.model}". Run: ollama pull ${cfg.model}`, 'model', {
        reason: 'ollamaPull',
        what: 'Ollama',
        model: cfg.model,
      });
    if (images.length && [400, 500].includes(r.status)) throw visionError(cfg, 'Ollama', r.status);
    throw await httpError(r, cfg, 'Ollama');
  }
  const j = (await r.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  return {
    text: j.message?.content ?? '',
    usage: { calls: 1, inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Anthropic Messages API; the fixed system prompt is marked for prompt caching. */
async function anthropicComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object, maxOut: number): Promise<Completion> {
  if (!cfg.apiKey) throw new AiError('Anthropic needs an API key (AI_API_KEY or Settings → AI).', 'config', { reason: 'noKey', what: 'Anthropic' });
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
  if (j.stop_reason === 'refusal') throw Object.assign(new AiError('Anthropic declined the request.', 'refused', { what: 'Anthropic' }), { usage });
  return {
    text: (j.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    usage,
  };
}

// Sign in with ChatGPT: the Responses API, always streamed, on the user's ChatGPT plan.

interface ResponsesError {
  code?: string | null;
  message?: string;
  param?: string | null;
}
interface ResponseObject {
  error?: ResponsesError | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
}

const SIGN_IN = 'Sign in with ChatGPT under Settings → AI to use your ChatGPT plan.';

const responsesUsage = (r: ResponseObject | undefined): AiUsage => ({
  calls: 1,
  inputTokens: r?.usage?.input_tokens ?? 0,
  outputTokens: r?.usage?.output_tokens ?? 0,
  cacheReadTokens: r?.usage?.input_tokens_details?.cached_tokens ?? 0,
  cacheWriteTokens: 0,
});

/** What to tell the user about a ChatGPT plan error (codes from OpenAI's "Errors and recovery"). */
function chatgptError(status: number, err: ResponsesError | null | undefined, detail: string, cfg: AiConfig): AiError {
  const code = err?.code ?? '';
  const msg = (err?.message || detail).replaceAll(cfg.apiKey || '\u0000', '***').slice(0, 300);
  const said = msg ? `: ${msg}` : '';
  const what = [status || '', code].filter(Boolean).join(', ');
  const info = { what: 'ChatGPT', ...(status ? { status } : {}), ...(msg ? { detail: msg } : {}) };
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429)
    return new AiError(
      `The usage limit for your ChatGPT plan or for this app is reached. Review it in ChatGPT under Settings → Usage (${CHATGPT_USAGE_URL}).`,
      'limit',
      { what: 'ChatGPT' },
    );
  if (code === 'subscription_sharing_user_not_eligible')
    return new AiError('Using a ChatGPT plan is not available for this account or workspace.', 'auth', { reason: 'notEligible', what: 'ChatGPT' });
  if (status === 401 || code === 'subscription_sharing_invalid_user')
    return new AiError(`ChatGPT did not accept the sign-in (${what}). Sign in with ChatGPT again under Settings → AI.`, 'auth', {
      reason: 'signIn',
      what: 'ChatGPT',
    });
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503)
    return new AiError(`Your ChatGPT plan cannot be used right now (${what}). Try again in a while.`, 'http', { ...info, reason: 'unavailable' });
  if (code === 'subscription_sharing_unsupported_capability')
    return new AiError(`ChatGPT does not support part of the request${err?.param ? ` (${err.param})` : ''}${said}.`, 'http', {
      ...info,
      reason: 'unsupported',
    });
  if (status === 404 || code === 'model_not_found')
    return new AiError(`ChatGPT does not offer the model "${cfg.model}" to this account${said}.`, 'model', { ...info, model: cfg.model, reason: 'chatgpt' });
  if (status === 403) return new AiError(`ChatGPT refused the request (${what})${said}.`, 'auth', { ...info, reason: 'refused' });
  return new AiError(`ChatGPT answered with an error${what ? ` (${what})` : ''}${said}.`, 'http', info);
}

async function chatgptHttpError(r: Response, cfg: AiConfig): Promise<AiError> {
  let err: ResponsesError | undefined;
  let detail = '';
  try {
    // Admission errors can be {"detail": "..."} instead of the usual error object.
    const j = (await r.json()) as { error?: ResponsesError | string; detail?: unknown };
    if (typeof j.error === 'string') detail = j.error;
    else err = j.error;
    if (typeof j.detail === 'string') detail = j.detail;
  } catch {
    /* not JSON */
  }
  return chatgptError(r.status, err, detail, cfg);
}

/** The `data:` objects of a server-sent event stream, in order. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m || (done && buf.trim()); m = /\r?\n\r?\n/.exec(buf)) {
        const block = m ? buf.slice(0, m.index) : buf;
        buf = m ? buf.slice(m.index + m[0].length) : '';
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          /* not JSON: skip */
        }
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * POST /responses with the access token: store false, stream true, the prompt as `instructions`,
 * no output limit or temperature (not accepted on this route). Done only at response.completed.
 */
async function chatgptComplete(cfg: AiConfig, system: string, user: UserContent, doFetch: Fetch, schema: object): Promise<Completion> {
  const url = `${(cfg.baseUrl || AI_DEFAULTS.chatgpt.baseUrl).replace(/\/$/, '')}/responses`;
  const images = imagesOf(user);
  const input = [
    {
      role: 'user',
      content: [{ type: 'input_text', text: textOf(user) }, ...images.map((data) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${data}` }))],
    },
  ];
  const body = (structured: boolean) =>
    JSON.stringify({
      model: cfg.model,
      instructions: system,
      input,
      store: false,
      stream: true,
      ...(structured ? { text: { format: { type: 'json_schema', name: 'answer', strict: true, schema } } } : {}),
    });
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${cfg.apiKey}` };
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  let r = await post(url, { method: 'POST', headers, body: body(true) }, timeoutMs, doFetch, 'ChatGPT');
  // Structured output not accepted: the prompt asks for JSON anyway, and the answer is validated.
  if (r.status === 400) r = await post(url, { method: 'POST', headers, body: body(false) }, timeoutMs, doFetch, 'ChatGPT');
  if (!r.ok) {
    const e = await chatgptHttpError(r, cfg);
    if (images.length && r.status === 400 && e.code === 'http') throw visionError(cfg, 'ChatGPT', r.status);
    throw e;
  }
  if (!r.body) throw new AiError('ChatGPT sent an empty answer.', 'http', { reason: 'empty', what: 'ChatGPT' });
  let text = '';
  let done: ResponseObject | undefined;
  try {
    for await (const ev of sseEvents(r.body)) {
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
      else if (ev.type === 'response.completed') {
        done = (ev.response ?? {}) as ResponseObject;
        break;
      } else if (ev.type === 'response.failed') {
        const resp = ev.response as ResponseObject | undefined;
        throw Object.assign(chatgptError(0, resp?.error, '', cfg), { usage: responsesUsage(resp) });
      } else if (ev.type === 'response.incomplete') {
        const resp = ev.response as ResponseObject | undefined;
        const why = resp?.incomplete_details?.reason ?? 'incomplete';
        throw Object.assign(
          new AiError(`ChatGPT stopped before the answer was complete (${why}).`, 'http', { reason: 'incomplete', what: 'ChatGPT', detail: why }),
          {
            usage: responsesUsage(resp),
          },
        );
      } else if (ev.type === 'error') throw chatgptError(0, ev as ResponsesError, '', cfg);
    }
  } catch (e) {
    if (e instanceof AiError) throw e;
    const seconds = Math.round(timeoutMs / 1000);
    throw isTimeout(e)
      ? new AiError(`ChatGPT did not answer within ${seconds} s.`, 'network', { reason: 'timeout', what: 'ChatGPT', seconds })
      : new AiError('The connection to ChatGPT broke off before the answer was complete.', 'network', { reason: 'broken', what: 'ChatGPT' });
  }
  if (!done) throw new AiError('The answer from ChatGPT ended before it was complete.', 'network', { reason: 'broken', what: 'ChatGPT' });
  const usage = responsesUsage(done);
  const parts = (done.output ?? []).flatMap((o) => o.content ?? []);
  const refusal = parts.find((c) => c.type === 'refusal');
  if (refusal && !text)
    throw Object.assign(new AiError(`ChatGPT declined: ${(refusal.refusal ?? '').slice(0, 200)}`, 'refused', { what: 'ChatGPT' }), { usage });
  return {
    text:
      text ||
      parts
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join(''),
    usage,
  };
}

/**
 * One request to the provider. When it timed out the provider may still have done the work and
 * billed it: the error carries an estimate of its tokens (the prompt and a full answer), so the
 * ceiling counts it.
 */
export async function complete(
  cfg: AiConfig,
  system: string,
  user: UserContent,
  doFetch: Fetch = fetch,
  schema: object = AI_PLAN_SCHEMA,
  maxOut = OUTPUT_TOKENS,
): Promise<Completion> {
  if (cfg.provider === 'none') throw new AiError('No AI provider is set.', 'config', { reason: 'noProvider' });
  const run = (): Promise<Completion> => {
    if (cfg.provider === 'chatgpt') {
      if (!cfg.apiKey) throw new AiError(cfg.error || SIGN_IN, 'auth', { reason: cfg.error ? 'signInAgain' : 'notSignedIn', what: 'ChatGPT' });
      if (!cfg.model) throw new AiError('Pick a ChatGPT model under Settings → AI.', 'config', { reason: 'chatgptModel', what: 'ChatGPT' });
      return chatgptComplete(cfg, system, user, doFetch, schema);
    }
    if (!cfg.model) throw new AiError('No AI model is set (AI_MODEL or Settings → AI).', 'config', { reason: 'noModel' });
    if (cfg.provider === 'anthropic') return anthropicComplete(cfg, system, user, doFetch, schema, maxOut);
    if (cfg.provider === 'ollama') return ollamaComplete(cfg, system, user, doFetch, schema, maxOut);
    return openAiComplete(cfg, system, user, doFetch, schema, maxOut);
  };
  try {
    return await run();
  } catch (e) {
    if (e instanceof AiError && e.code === 'network' && e.info.reason !== 'unreachable' && !(e as { usage?: AiUsage }).usage)
      Object.assign(e, {
        usage: {
          calls: 1,
          inputTokens: estimateTokens(system, textOf(user)) + imagesOf(user).length * 800,
          outputTokens: maxOut,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    throw e;
  }
}

/** "Test connection": the smallest possible call; shows that provider, key and model work. */
export async function testConnection(cfg: AiConfig, doFetch: Fetch = fetch): Promise<{ model: string; usage: AiUsage; ms: number }> {
  const t0 = Date.now();
  const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
  // Room for a reasoning model to think before the two-word answer.
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
export const planCallEstimate = (summary: RoundSummary, preference: string, plan: VideoPlan, answers?: PlanAnswers | null, kind?: PlanKind | null) =>
  estimateTokens(SYSTEM_PROMPT, userMessage(summary, preference, plan, answers, kind)) + OUTPUT_TOKENS;

export interface PlanWithAiOptions {
  allowedTemplates: readonly string[];
  /** Tokens already used by this video (the first call, when answering). */
  used?: AiUsage;
  /** The format the user picked (a card in the dialog): the wish and the model cannot change it. */
  kind?: PlanKind | null;
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
  // What this call spent: an error carries it (as `usage`), so the caller still counts it.
  let here = noUsage();
  const fail = (e: unknown) => Object.assign(e as object, { usage: here });
  const user = userMessage(summary, preference, rulePlan, answers, opts.kind);
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = feedback ? `${user}\n\nYOUR PREVIOUS ANSWER WAS INVALID: ${feedback}\nAnswer again with a valid JSON object.` : user;
    const spent = planTokensUsed(usage);
    const next = estimateTokens(SYSTEM_PROMPT, message) + OUTPUT_TOKENS;
    if (spent + next > cfg.maxTokens)
      throw Object.assign(
        new AiError(`This video would use more than AI_MAX_TOKENS (${cfg.maxTokens}) tokens: ${spent} used, about ${next} more needed.`, 'budget', {
          max: cfg.maxTokens,
          used: spent,
          need: next,
        }),
        { usage: here },
      );
    let c: Completion;
    try {
      c = await complete(cfg, SYSTEM_PROMPT, message, opts.fetch);
    } catch (e) {
      const u = (e as { usage?: AiUsage }).usage;
      if (u) here = add(here, u);
      throw fail(e);
    }
    usage = add(usage, c.usage);
    here = add(here, c.usage);
    opts.log?.('ai call', {
      provider: cfg.provider,
      model: cfg.model,
      attempt: attempt + 1,
      inputTokens: c.usage.inputTokens,
      outputTokens: c.usage.outputTokens,
      cacheReadTokens: c.usage.cacheReadTokens,
    });
    let merged: VideoPlan;
    try {
      merged = mergeAiPlan(rulePlan, parseJson(c.text), opts.allowedTemplates, { summary, kind: opts.kind });
    } catch (e) {
      feedback = e instanceof z.ZodError ? z.prettifyError(e).slice(0, 600) : String(e instanceof Error ? e.message : e).slice(0, 600);
      continue;
    }
    const guarded = guardFacts(merged, summary, { preference, fallbackTitle: rulePlan.title });
    if (guarded.dropped.length) opts.log?.('ai facts dropped', { provider: cfg.provider, model: cfg.model, dropped: guarded.dropped });
    return { plan: guarded.plan, usage, fellBack: false };
  }
  return { plan: rulePlan, usage, fellBack: true };
}
