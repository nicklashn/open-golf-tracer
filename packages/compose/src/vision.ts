/**
 * Optional, off by default: when the analysis is unsure how many putts were played on a hole,
 * the AI may look at a few still frames from the green so the user is not asked. With Ollama
 * the frames stay on the PC; with a cloud provider they are sent there.
 *
 * - the frames are taken at the putts the analysis found: each strike, where each ball stopped,
 *   and 1 s after the last (did it vanish into the cup?), cropped around ball, cup and player;
 * - the model answers simple questions per frame (a stroke? the ball in the cup?) and the code
 *   counts; its own count only decides when the frames cannot;
 * - one call per hole, at most VISION_MAX_CALLS per video, from a separate allowance
 *   (`visionMaxTokens`, default DEFAULT_VISION_TOKENS) so the plan calls keep theirs; the hard
 *   ceiling for a video is AI_MAX_TOKENS + that allowance;
 * - the answer is validated with zod and only used when the model is sure enough;
 * - anything that goes wrong (no image support, budget, nonsense) keeps the question for the user.
 */
import type { Shot } from '@golf/schema';
import { z } from 'zod';
import { addUsage, AiError, complete, estimateTokens, noUsage, parseJson, type AiConfig, type AiUsage } from './ai';
import type { PlanAnswers, PlanQuestion, VideoPlan } from './plan';

export const VISION_FRAMES = 8;
export const VISION_MAX_CALLS = 6;
export const VISION_MIN_CONFIDENCE = 0.7;
/** Counted per frame before sending, and when the provider does not report usage (a 768 px JPEG is ~450–800). */
export const IMAGE_TOKENS = 800;
export const VISION_OUTPUT_TOKENS = 600;
/** Without a ball stop from the analysis: this long after the strike. */
export const PUTT_END_GUESS_S = 3;

export const VISION_PROMPT = `You look at still frames from a golf video of one green, in time order. Each frame is labelled with what the app thinks happens then: "strike" (a putt is struck), "end" (that putt's ball has stopped or dropped) or "after" (1 s after the last putt). For each frame n answer three yes/no questions, null when you cannot tell: stroke – is a player striking the ball with a putter (or has just struck it)?; ballVisible – can you see the golf ball?; inCup – is the ball in or dropping into the cup? Then give putts (how many putts these frames show), holed (whether the last putt was holed, null when the frames do not show it) and confidence (0–1, how sure you are). Answer with the JSON object only.`;

const yesNo = { anyOf: [{ type: 'boolean' }, { type: 'null' }] } as const;
export const PUTT_VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frames', 'putts', 'holed', 'confidence'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'stroke', 'ballVisible', 'inCup'],
        properties: { n: { type: 'integer' }, stroke: yesNo, ballVisible: yesNo, inCup: yesNo },
      },
    },
    putts: { type: 'integer', minimum: 1, maximum: 6 },
    holed: yesNo,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

/** What the AI saw, as used: the number of putts, whether the last went in, how sure. */
export const PuttVision = z.object({
  putts: z.number().int().min(1).max(6),
  holed: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
});
export type PuttVision = z.infer<typeof PuttVision>;

/** The model's answer: PuttVision plus its answers per frame. */
export const PuttVisionAnswer = PuttVision.extend({
  frames: z
    .array(
      z.object({
        n: z.number().int(),
        stroke: z.boolean().nullable().default(null),
        ballVisible: z.boolean().nullable().default(null),
        inCup: z.boolean().nullable().default(null),
      }),
    )
    .max(40)
    .default([]),
});
export type PuttVisionAnswer = z.infer<typeof PuttVisionAnswer>;

/** What a frame is meant to show: the strike of putt n (1-based), where it stopped, or 1 s after the last. */
export interface FrameRole {
  putt: number;
  at: 'strike' | 'end' | 'after';
}

/** The hole the frames are from, and where in the clip they were taken. */
export interface PuttHole {
  hole: string;
  par: number | null;
  /** Seconds into the clip's file, one per frame (same order as the frames). */
  times: number[];
  /** What each frame is meant to show (same order); without them only the model's own count is used. */
  roles?: FrameRole[];
  /** Putts on this hole filmed in other clips (added to the count). */
  otherPutts?: number;
}

export interface VisionOptions {
  /** Tokens already used by this video. */
  used?: AiUsage;
  /** Tokens to leave free under the hard ceiling for later calls. */
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

/** The default allowance for still frames per video: four holes' looks at full frame count. */
export const DEFAULT_VISION_TOKENS = Math.ceil((4 * visionCallEstimate(VISION_FRAMES, ' '.repeat(400))) / 1000) * 1000;
export const visionAllowance = (cfg: Pick<AiConfig, 'visionMaxTokens'>) => Math.max(0, cfg.visionMaxTokens ?? DEFAULT_VISION_TOKENS);

/** Whether a vision call of about `next` tokens fits its allowance and the video's hard ceiling; else why not. */
export function visionFits(cfg: AiConfig, used: AiUsage, next: number, reserve = 0): string | null {
  const spent = used.visionTokens ?? 0;
  const allowance = visionAllowance(cfg);
  if (spent + next > allowance) return `would pass the allowance for pictures (${allowance}): ${spent} used, about ${next} more needed`;
  const total = used.inputTokens + used.outputTokens;
  const hard = cfg.maxTokens + allowance;
  if (total + next + reserve > hard) return `would pass the ceiling (${hard}): ${total} used, about ${next} more needed`;
  return null;
}

const ROLE = { strike: 'strike', end: 'end', after: 'after' } as const;

/**
 * The model's answers per frame, counted by the code: the putts whose strike frame shows a
 * stroke, and whether the last ball is in the cup. Where the code's count and the model's
 * disagree, the result is not sure (the user is asked).
 */
export function countFromFrames(a: PuttVisionAnswer, roles: FrameRole[] | undefined, otherPutts = 0): PuttVision {
  let { putts, holed, confidence } = a;
  if (roles?.length) {
    const frame = (i: number) => a.frames.find((f) => f.n === i + 1);
    const strikes = roles.map((r, i) => ({ r, f: frame(i) })).filter((x) => x.r.at === 'strike');
    const found = Math.max(...roles.map((r) => r.putt));
    if (strikes.length === found && strikes.every((x) => x.f && x.f.stroke !== null)) {
      const counted = strikes.filter((x) => x.f!.stroke).length;
      if (counted !== putts) confidence = Math.min(confidence, 0.5);
      if (counted > 0) putts = counted;
    }
    // The last ball: in the cup 1 s after (or when it stopped), or still lying there.
    const last = roles
      .map((r, i) => ({ r, f: frame(i) }))
      .filter((x) => x.r.putt === found && x.r.at !== 'strike' && x.f)
      .sort((x, y) => (x.r.at === 'after' ? -1 : 0) - (y.r.at === 'after' ? -1 : 0))[0]?.f;
    const seen = last?.inCup === true ? true : last?.inCup === false && last.ballVisible === true ? false : null;
    if (seen !== null) {
      if (holed !== null && holed !== seen) confidence = Math.min(confidence, 0.5);
      holed = seen;
    }
  }
  return { putts: Math.min(6, Math.max(1, putts + otherPutts)), holed, confidence };
}

/**
 * One look at the frames (base64 JPEG) of one hole's putting. Never throws: on any trouble the
 * outcome says why and the caller keeps the question.
 */
export async function resolvePuttsWithVision(cfg: AiConfig, hole: PuttHole, frames: string[], opts: VisionOptions = {}): Promise<VisionOutcome> {
  let usage = opts.used ?? noUsage();
  const label = (i: number) => {
    const r = hole.roles?.[i];
    return r ? `, putt ${r.putt} ${ROLE[r.at]}` : '';
  };
  const text = [
    `Hole ${hole.hole || '?'}, par ${hole.par ?? '?'}.`,
    `${frames.length} frames (seconds into the clip${hole.roles ? ', what the app expects' : ''}):`,
    ...hole.times.slice(0, frames.length).map((t, i) => `frame ${i + 1}: ${t.toFixed(1)} s${label(i)}`),
  ].join('\n');
  const next = visionCallEstimate(frames.length, text);
  const over = frames.length ? visionFits(cfg, usage, next, opts.reserve ?? 0) : 'no frames';
  if (over) return { result: null, usage, skipped: 'budget', error: over };
  let raw: string;
  try {
    const c = await complete(cfg, VISION_PROMPT, { text, images: frames }, opts.fetch, PUTT_VISION_SCHEMA, VISION_OUTPUT_TOKENS);
    // Not every server reports usage; count the frames conservatively then.
    const reported = c.usage.inputTokens > 0;
    const inputTokens = reported ? c.usage.inputTokens : next - VISION_OUTPUT_TOKENS;
    const outputTokens = c.usage.outputTokens || estimateTokens(c.text);
    const u: AiUsage = { ...c.usage, inputTokens, outputTokens, visionTokens: inputTokens + outputTokens };
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
    if (u) usage = addUsage(usage, { ...u, visionTokens: u.inputTokens + u.outputTokens });
    const error = e instanceof AiError ? e.message : 'the AI provider failed';
    opts.log?.('ai vision failed', { provider: cfg.provider, model: cfg.model, hole: hole.hole, code: e instanceof AiError ? e.code : 'unknown', error });
    return { result: null, usage, skipped: 'error', error };
  }
  try {
    return { result: countFromFrames(PuttVisionAnswer.parse(parseJson(raw)), hole.roles, hole.otherPutts ?? 0), usage };
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

/** One putt as the frames need it: the strike and where the ball stopped (seconds into the clip). */
export interface PuttMoment {
  t: number;
  end: number | null;
}

/**
 * Frame times anchored to the putts found: each strike, each stop (strike + PUTT_END_GUESS_S
 * when unknown) and 1 s after the last stop (the ball gone into the cup?). At most `max`
 * frames: the last "after" first, then the strikes, then the stops; times inside the clip.
 */
export function puttFrames(putts: PuttMoment[], duration = Infinity, max = VISION_FRAMES): { times: number[]; roles: FrameRole[] } {
  const ordered = [...putts].sort((a, b) => a.t - b.t);
  const n = ordered.length;
  if (!n) return { times: [], roles: [] };
  const endOf = (p: PuttMoment) => Math.max(p.t + 0.3, p.end ?? p.t + PUTT_END_GUESS_S);
  const wanted: { t: number; role: FrameRole }[] = [
    { t: endOf(ordered[n - 1]) + 1, role: { putt: n, at: 'after' } },
    ...ordered.map((p, i) => ({ t: p.t, role: { putt: i + 1, at: 'strike' as const } })),
    ...ordered.map((p, i) => ({ t: endOf(p), role: { putt: i + 1, at: 'end' as const } })),
  ];
  const last = Number.isFinite(duration) && duration > 0 ? duration - 0.05 : Infinity;
  const picked: { t: number; role: FrameRole }[] = [];
  for (const w of wanted) {
    const t = Number(Math.max(0, Math.min(w.t, last)).toFixed(2));
    if (picked.length >= max || picked.some((x) => Math.abs(x.t - t) < 0.15)) continue;
    picked.push({ t, role: w.role });
  }
  picked.sort((a, b) => a.t - b.t);
  return { times: picked.map((x) => x.t), roles: picked.map((x) => x.role) };
}

/** A region of the frame in pixels (even sizes, as ffmpeg's crop wants). */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where to look on the green: around where each ball was struck and where it rolled (the putts'
 * anchors and tracked positions, the cup near the end of a holed one), with room above for the
 * player. Null when nothing is known or the region is most of the frame anyway.
 */
export function puttCrop(shots: Pick<Shot, 'anchor' | 'track'>[], width: number, height: number): Crop | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const at = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    xs.push(x);
    ys.push(y);
  };
  for (const s of shots) {
    at(s.anchor.x, s.anchor.y);
    s.track.u.forEach((u, i) => at(u, s.track.v[i]));
  }
  if (!xs.length || width <= 0 || height <= 0) return null;
  const short = Math.min(width, height);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const margin = Math.max(0.35 * Math.max(x1 - x0, y1 - y0), 0.12 * short);
  x0 -= margin;
  x1 += margin;
  y0 -= margin + 0.2 * height;
  y1 += margin;
  // At least 40 % of the short side, so the player and the cup fit.
  const min = 0.4 * short;
  if (x1 - x0 < min) [x0, x1] = [(x0 + x1 - min) / 2, (x0 + x1 + min) / 2];
  if (y1 - y0 < min) [y0, y1] = [(y0 + y1 - min) / 2, (y0 + y1 + min) / 2];
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const crop = { x: even(x0), y: even(y0), w: even(x1 - x0), h: even(y1 - y0) };
  if (crop.x + crop.w > width) crop.w = even(width - crop.x);
  if (crop.y + crop.h > height) crop.h = even(height - crop.y);
  return crop.w * crop.h > 0.85 * width * height ? null : crop;
}
