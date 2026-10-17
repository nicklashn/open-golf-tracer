/**
 * The plan for an automatic video: small enough for a language model to write (≤ 800 tokens),
 * strict enough to validate. It names shots and choices; `compose` turns it into projects.
 */
import { TEMPLATES } from '@golf/render';
import { z } from 'zod';

export const PLAN_KINDS = ['youtube', 'highlight', 'shorts'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
/** Which putts a video shows (never traced): none, only those that went in, or each hole's putting. */
export const PUTT_MODES = ['none', 'holed', 'all'] as const;
export type PuttMode = (typeof PUTT_MODES)[number];
/**
 * Putts shown when the wish says nothing: a mode, or `best` – only holed putts the analysis is
 * sure of that are worth a look (a long roll), see `shownPutts`.
 */
export type PuttShow = PuttMode | 'best';
/**
 * Without a choice the videos stay light on putting: the YouTube video shows the holed putt of
 * each hole, the highlight only notable holed putts, and shorts none (no short per putt). The
 * wish ("alle putts", "putts der går i", "uden putts") or the plan's `putts` overrides this.
 */
export const defaultPutts = (kind: PlanKind): PuttShow => (kind === 'youtube' ? 'holed' : kind === 'highlight' ? 'best' : 'none');

const shortText = (max: number) => z.string().trim().max(max);

/**
 * Why a shot is asked about, as codes the apps turn into plain words: the analysis' warnings,
 * plus `practice_swing` (no ball in the air and low confidence), `retake`, `same_shot`,
 * `next_shot_distance` (the next stroke was filmed much closer than the flight says) and
 * `putt_count_unsure`.
 */
export const REASON_CODES = [
  'no_track',
  'implausible',
  'carry_mismatch',
  'default_path',
  'off_frame',
  'short_shot',
  'low_confidence',
  'few_points',
  'start_extrapolated',
  'hole_limit',
  'practice_swing',
  'retake',
  'same_shot',
  'next_shot_distance',
  'putt_count_unsure',
] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** One shot a question is about, with where to find it in the video. */
export const PlanItem = z.object({
  shotId: z.string().max(64),
  mediaId: z.string().max(64),
  /** The clip's position in the round (1-based) and its file name. */
  clip: z.number().int().min(0).max(9999),
  clipName: shortText(200),
  /** Seconds into the clip's video file at the strike: the file's own clock, as a player shows it (not real time for slow motion). */
  t: z.number().min(0),
  reasons: z.array(ReasonCode).max(12).default([]),
  /** With `next_shot_distance`: metres to where the next stroke was filmed, and the flight's carry. */
  nextM: z.number().min(0).optional(),
  carryM: z.number().min(0).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanQuestion = z.object({
  id: z.string().min(1).max(80),
  text: shortText(300).min(1),
  options: z
    .array(z.object({ id: z.string().min(1).max(80), label: shortText(120).min(1) }))
    .min(2)
    .max(6),
  /** The option used when the user does not answer (or runs with --yes). */
  default: z.string().min(1).max(80),
  shotIds: z.array(z.string().max(64)).max(200).default([]),
  clipIds: z.array(z.string().max(64)).max(200).default([]),
  /** The shots asked about, shown as cards; each can be kept or removed on its own. */
  items: z.array(PlanItem).max(200).optional(),
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const VideoPlan = z
  .object({
    kind: z.enum(PLAN_KINDS),
    /** A template's tracer look (see packages/render templates), or null for the default. */
    template: z
      .string()
      .max(40)
      .nullable()
      .default(null)
      .refine((t) => t === null || TEMPLATES.some((x) => x.id === t), { message: 'unknown template' }),
    includeShotIds: z.array(z.string().max(64)).max(500),
    /** Playing order as shot ids; clips follow the first shot of each. Omitted = as filmed. */
    order: z.array(z.string().max(64)).max(500).optional(),
    title: shortText(120).min(1),
    /** Putts shown; omitted = `defaultPutts(kind)`. */
    putts: z.enum(PUTT_MODES).optional(),
    /** A line of text shown with a shot (e.g. "Birdie putt"), by shot id. */
    shotTexts: z.record(z.string().max(64), shortText(80)).optional(),
    /** Description for YouTube or social posts. */
    description: shortText(2000).optional(),
    questions: z.array(PlanQuestion).max(12).default([]),
    /** Things the user should know (assumptions made, fallbacks used). */
    notes: z.array(shortText(300)).max(10).default([]),
  })
  .superRefine((p, ctx) => {
    for (const q of p.questions)
      if (!q.options.some((o) => o.id === q.default))
        ctx.addIssue({ code: 'custom', path: ['questions'], message: `question ${q.id}: default is not an option` });
  });
export type VideoPlan = z.infer<typeof VideoPlan>;

/** Answers by question id: the chosen option id; `shot:<shotId>` → 'keep' | 'drop' for one shot. */
export const PlanAnswers = z.record(z.string().max(80), z.string().max(80));
export type PlanAnswers = z.infer<typeof PlanAnswers>;

export const ShotChoice = z.enum(['keep', 'drop']);
export type ShotChoice = z.infer<typeof ShotChoice>;
export const shotAnswerKey = (shotId: string) => `shot:${shotId}`;
/** The question about a hole's putts (options in rules.ts). */
export const puttQuestionId = (hole: string) => `putts:${hole}`;

/** Per-shot choices for shots shown as items of a question; they win over the question's answer. */
export function shotChoices(plan: VideoPlan, answers: PlanAnswers | null | undefined): Map<string, ShotChoice> {
  const out = new Map<string, ShotChoice>();
  for (const q of plan.questions)
    for (const item of q.items ?? []) {
      const c = ShotChoice.safeParse(answers?.[shotAnswerKey(item.shotId)]);
      if (c.success) out.set(item.shotId, c.data);
    }
  return out;
}

/** The chosen option for every question: the user's answer when it is one of the options, else the default. */
export function resolveAnswers(plan: VideoPlan, answers: PlanAnswers | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of plan.questions) {
    const a = answers?.[q.id];
    out[q.id] = a && q.options.some((o) => o.id === a) ? a : q.default;
  }
  return out;
}
