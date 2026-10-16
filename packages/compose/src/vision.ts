/**
 * Optional, off by default: when the analysis is unsure how many putts were played on a hole,
 * the AI may look at a few still frames from the green so the user is not asked. With Ollama
 * the frames stay on the PC; with a cloud provider they are sent there.
 *
 * - one call per hole, at most VISION_MAX_CALLS per video, within the same AI_MAX_TOKENS ceiling;
 * - the answer is validated with zod and only used when the model is sure enough;
 * - anything that goes wrong (no image support, budget, nonsense) keeps the question for the user.
 */
import { z } from 'zod';
import { addUsage, AiError, complete, estimateTokens, noUsage, parseJson, type AiConfig, type AiUsage } from './ai';
import type { PlanAnswers, PlanQuestion, VideoPlan } from './plan';

export const VISION_FRAMES = 6;
export const VISION_MAX_CALLS = 6;
export const VISION_MIN_CONFIDENCE = 0.7;
/** Counted per frame before sending, and when the provider does not report usage (a 768 px JPEG is ~450–800). */
export const IMAGE_TOKENS = 800;
const VISION_OUTPUT_TOKENS = 600;

export const VISION_PROMPT = `You look at still frames from a golf video, taken in time order on the green of one hole. Count the putts: strokes with the putter that move the ball on the green. Say whether the last putt was holed (the ball dropped into the cup), or null when the frames do not show it. confidence (0–1) is how sure you are of the count. Answer with the JSON object only.`;

export const PUTT_VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['putts', 'holed', 'confidence'],
  properties: {
    putts: { type: 'integer', minimum: 1, maximum: 6 },
    holed: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export const PuttVision = z.object({
  putts: z.number().int().min(1).max(6),
  holed: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
});
export type PuttVision = z.infer<typeof PuttVision>;

/** The hole the frames are from, and where in the clip they were taken. */
export interface PuttHole {
  hole: string;
  par: number | null;
  /** Seconds into the clip's file, one per frame (same order as the frames). */
  times: number[];
}

export interface VisionOptions {
  /** Tokens already used by this video. */
  used?: AiUsage;
  /** Tokens to leave free for later calls (e.g. the plan call after the user's answers). */
  reserve?: number;
  fetch?: typeof fetch;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}

export interface VisionOutcome {
  result: PuttVision | null;
  usage: AiUsage;
  /** Why there is no result: 'budget' (not sent), 'error' (provider failed), 'invalid' (unusable answer). */
  skipped?: 'budget' | 'error' | 'invalid';
  error?: string;
}

/** Tokens a vision call may need at most. */
export const visionCallEstimate = (frames: number, text = '') => estimateTokens(VISION_PROMPT, text) + frames * IMAGE_TOKENS + VISION_OUTPUT_TOKENS;

/**
 * One look at the frames (base64 JPEG) of one hole's putting. Never throws: on any trouble the
 * outcome says why and the caller keeps the question.
 */
export async function resolvePuttsWithVision(cfg: AiConfig, hole: PuttHole, frames: string[], opts: VisionOptions = {}): Promise<VisionOutcome> {
  let usage = opts.used ?? noUsage();
  const text = [
    `Hole ${hole.hole || '?'}, par ${hole.par ?? '?'}.`,
    `${frames.length} frames; seconds into the clip: ${hole.times.map((t) => t.toFixed(1)).join(', ')}.`,
  ].join('\n');
  const spent = usage.inputTokens + usage.outputTokens;
  const next = visionCallEstimate(frames.length, text);
  if (!frames.length || spent + next + (opts.reserve ?? 0) > cfg.maxTokens)
    return { result: null, usage, skipped: 'budget', error: `would pass AI_MAX_TOKENS (${cfg.maxTokens}): ${spent} used, about ${next} more needed` };
  let raw: string;
  try {
    const c = await complete(cfg, VISION_PROMPT, { text, images: frames }, opts.fetch, PUTT_VISION_SCHEMA, VISION_OUTPUT_TOKENS);
    // Not every server reports usage; count the frames conservatively then.
    const reported = c.usage.inputTokens > 0;
    const u: AiUsage = {
      ...c.usage,
      inputTokens: reported ? c.usage.inputTokens : next - VISION_OUTPUT_TOKENS,
      outputTokens: c.usage.outputTokens || estimateTokens(c.text),
    };
    usage = addUsage(usage, u);
    opts.log?.('ai vision call', {
      provider: cfg.provider,
      model: cfg.model,
      hole: hole.hole,
      frames: frames.length,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estimated: !reported,
    });
    raw = c.text;
  } catch (e) {
    const u = (e as { usage?: AiUsage }).usage;
    if (u) usage = addUsage(usage, u);
    const error = e instanceof AiError ? e.message : 'the AI provider failed';
    opts.log?.('ai vision failed', { provider: cfg.provider, model: cfg.model, hole: hole.hole, code: e instanceof AiError ? e.code : 'unknown', error });
    return { result: null, usage, skipped: 'error', error };
  }
  try {
    return { result: PuttVision.parse(parseJson(raw)), usage };
  } catch {
    return { result: null, usage, skipped: 'invalid', error: 'the answer was not valid' };
  }
}

// ---------------------------------------------------------------------------------------------
// The putts question. Ids and options as rules.ts asks them: `putts:<hole>` → '1' | '2' | '3' |
// '4+', and `holed:<hole>` → 'yes' | 'no'. Kept here so they are easy to adapt.

// The putts question (rules.ts puttsQuestion): options '1'–'4' = that many putts, the last holed
// ('4' = four or more); 'notHoled' = the last did not drop or was not filmed to the end.
export const PUTTS_PREFIX = 'putts:';
export const puttsHoleOf = (q: PlanQuestion): string | null => (q.id.startsWith(PUTTS_PREFIX) ? q.id.slice(PUTTS_PREFIX.length) : null);
/** The option for what the AI saw; null when it could not see whether the ball dropped. */
export const puttsOption = (n: number, holed: boolean | null): string | null => (holed === null ? null : holed ? String(Math.min(4, n)) : 'notHoled');

/**
 * Where to look for a putts question: in the clip with most of its putts, from the first putt's
 * strike −1 s to the end of the last +1 s (`end` gives a putt's end; unknown → strike + 4 s).
 */
export function puttSegment(q: PlanQuestion, end: (shotId: string) => number | null): { mediaId: string; from: number; to: number } | null {
  const items = q.items ?? [];
  const byClip = new Map<string, typeof items>();
  for (const it of items) byClip.set(it.mediaId, [...(byClip.get(it.mediaId) ?? []), it]);
  const best = [...byClip.values()].sort((a, b) => b.length - a.length)[0];
  if (!best?.length) return null;
  const from = Math.max(0, Math.min(...best.map((it) => it.t)) - 1);
  const to = Math.max(...best.map((it) => end(it.shotId) ?? it.t + 4)) + 1;
  return { mediaId: best[0].mediaId, from, to };
}

/** Evenly spread frame times over a segment, both ends included. */
export function frameTimes(from: number, to: number, n = VISION_FRAMES): number[] {
  if (n <= 1 || to <= from) return [from];
  return Array.from({ length: n }, (_, i) => Number((from + ((to - from) * i) / (n - 1)).toFixed(2)));
}

const NOTE = {
  da: (n: number, hole: string) => `AI'en talte ${n === 1 ? '1 putt' : `${n} putts`} på hul ${hole} ud fra billeder.`,
  en: (n: number, hole: string) => `The AI counted ${n === 1 ? '1 putt' : `${n} putts`} on hole ${hole} from still frames.`,
};

/**
 * What the AI saw, applied to the plan: when it is sure enough, the hole's questions are
 * answered and dropped and a note says so; otherwise null (the user is asked).
 */
export function applyPuttVision(
  plan: VideoPlan,
  hole: string,
  v: PuttVision,
  locale: 'da' | 'en',
): { plan: VideoPlan; answers: PlanAnswers; note: string } | null {
  if (v.confidence < VISION_MIN_CONFIDENCE) return null;
  const putts = plan.questions.find((q) => q.id === PUTTS_PREFIX + hole);
  const option = puttsOption(v.putts, v.holed);
  if (!putts || !option || !putts.options.some((o) => o.id === option)) return null;
  const answers: PlanAnswers = { [putts.id]: option };
  const drop = new Set([putts.id]);
  const note = NOTE[locale](v.putts, hole);
  return {
    plan: { ...plan, questions: plan.questions.filter((q) => !drop.has(q.id)), notes: [...plan.notes.slice(0, 9), note] },
    answers,
    note,
  };
}
