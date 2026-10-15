/**
 * The plan for an automatic video: small enough for a language model to write (≤ 800 tokens),
 * strict enough to validate. It names shots and choices; `compose` turns it into projects.
 */
import { TEMPLATES } from '@golf/render';
import { z } from 'zod';

export const PLAN_KINDS = ['youtube', 'highlight', 'shorts'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

const shortText = (max: number) => z.string().trim().max(max);

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

/** Answers by question id: the chosen option id. */
export const PlanAnswers = z.record(z.string().max(80), z.string().max(80));
export type PlanAnswers = z.infer<typeof PlanAnswers>;

/** The chosen option for every question: the user's answer when it is one of the options, else the default. */
export function resolveAnswers(plan: VideoPlan, answers: PlanAnswers | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of plan.questions) {
    const a = answers?.[q.id];
    out[q.id] = a && q.options.some((o) => o.id === a) ? a : q.default;
  }
  return out;
}
