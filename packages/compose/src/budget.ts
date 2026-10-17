/**
 * How many tokens "Make a video for me" uses, before it runs: for the round at hand (the video
 * dialog) or for a typical 18-hole round (Settings → AI). Estimates, from the same counting the
 * job uses before each call (ai.ts planCallEstimate, vision.ts visionCallEstimate).
 */
import { estimateTokens, OUTPUT_TOKENS, planCallEstimate, SYSTEM_PROMPT, userMessage } from './ai';
import { resolveAnswers, VideoPlan, type PlanKind } from './plan';
import type { ClipSummary, RoundSummary, ShotSummary } from './summary';
import { puttsHoleOf, VISION_FRAMES, VISION_MAX_CALLS, visionAllowance, visionCallEstimate } from './vision';

/** What a plan answer usually costs (the plan is small; the budget check counts OUTPUT_TOKENS). */
const TYPICAL_OUT = 600;

export interface TokenEstimate {
  /** About what the plan calls use (one, or two with questions). */
  plan: number;
  /** At most what looking at still frames uses (its own allowance). */
  vision: number;
  /** plan + vision: "≈ N tokens per video". */
  total: number;
  /** The AI_MAX_TOKENS the plan calls need to pass the budget check; below it the rules' plan is used. */
  needed: number;
}

export interface EstimateOptions {
  vision?: boolean;
  /** --yes: no questions, so no second call. */
  yes?: boolean;
  visionMaxTokens?: number;
  /** The format the user picked (sent to the model as its own line). */
  kind?: PlanKind | null;
}

/** The tokens one video of this round will about use, with the rule plan the job starts from. */
export function videoTokenEstimate(summary: RoundSummary, preference: string, rulePlan: VideoPlan, opts: EstimateOptions = {}): TokenEstimate {
  const in1 = planCallEstimate(summary, preference, rulePlan, null, opts.kind) - OUTPUT_TOKENS;
  const asks = !opts.yes && rulePlan.questions.length > 0;
  const in2 = asks ? estimateTokens(SYSTEM_PROMPT, userMessage(summary, preference, rulePlan, resolveAnswers(rulePlan, null), opts.kind)) : 0;
  const plan = in1 + TYPICAL_OUT + (asks ? in2 + TYPICAL_OUT : 0);
  const needed = asks ? in1 + TYPICAL_OUT + in2 + OUTPUT_TOKENS : in1 + OUTPUT_TOKENS;
  const holes = rulePlan.questions.filter((q) => puttsHoleOf(q) !== null).length;
  const vision = opts.vision ? Math.min(visionAllowance(opts), Math.min(holes, VISION_MAX_CALLS) * visionCallEstimate(VISION_FRAMES, ' '.repeat(400))) : 0;
  return { plan, vision, total: plan + vision, needed };
}

/**
 * A made-up round as large as a full one usually is: 18 holes, `clips` clips and `shots`
 * traced shots, a couple of questions (unsure putts on `puttHoles` holes).
 */
export function typicalRound(clips = 40, shots = 45, puttHoles = 3): { summary: RoundSummary; plan: VideoPlan } {
  const id = (p: string, i: number) => `${p}${(1e15 + i * 7919).toString(36).slice(0, 16)}`;
  const clipList: ClipSummary[] = Array.from({ length: clips }, (_, i) => ({
    id: id('med_', i),
    n: i + 1,
    name: `IMG_${String(4000 + i)}.MOV`,
    recordedAt: '2026-06-16T10:50:00+0200',
    seconds: 31.4,
    portrait: true,
    gps: true,
    geo: null,
    width: 1080,
    height: 1920,
    course: 'Golfklub',
    hole: String(1 + Math.floor((i * 18) / clips)),
    par: 4,
    fromTee: 12,
    shots: 1,
  }));
  const shotList: ShotSummary[] = Array.from({ length: shots }, (_, i) => {
    const c = clipList[Math.min(clips - 1, Math.floor((i * clips) / shots))];
    return {
      id: id('shot_', i),
      n: i + 1,
      clipId: c.id,
      clip: c.n,
      t: 12.4,
      at: '2026-06-16T08:51:12.400Z',
      hole: c.hole,
      par: 4,
      club: 'driver',
      carryM: 187,
      apexM: 24,
      flightS: 5.2,
      trackPts: 41,
      confidence: 0.83,
      flags: i % 6 === 0 ? ['few_points'] : [],
      x: 0.49,
      y: 0.77,
      sound: null,
      nextM: 142,
    };
  });
  const summary: RoundSummary = {
    name: 'Runde',
    course: 'Golfklub',
    date: '2026-06-16',
    clips: clipList,
    shots: shotList,
    chips: [],
    putts: [],
    holes: [],
    order: { by: 'time', unsure: [], conflict: null },
  };
  const doubtful = shotList.filter((_, i) => i % 9 === 4).map((x) => x.id);
  const plan = VideoPlan.parse({
    kind: 'youtube',
    includeShotIds: shotList.map((x) => x.id),
    title: 'Golfklub · 16. juni 2026',
    questions: [
      {
        id: 'doubtful',
        text: `${doubtful.length} slag har en usikker bane: slag 5 (hul 2), slag 14 (hul 6), slag 23 (hul 9), slag 32 (hul 13) …. Skal de med?`,
        options: [
          { id: 'keep', label: 'Ja, tag dem med' },
          { id: 'drop', label: 'Nej, udelad dem' },
        ],
        default: 'keep',
        shotIds: doubtful,
      },
      ...Array.from({ length: puttHoles }, (_, i) => ({
        id: `putts:${3 + i * 5}`,
        text: `Hul ${3 + i * 5}: analysen fandt 2 putts, men er usikker. Hvor mange putts var der?`,
        options: [...['1', '2', '3', '4'].map((n) => ({ id: n, label: `${n} putts, i hul` })), { id: 'notHoled', label: 'Ikke i hul / ikke filmet til ende' }],
        default: '2',
      })),
    ],
  });
  return { summary, plan };
}

/** A large round: every shot filmed, retakes included (what DEFAULT_AI_MAX_TOKENS is sized for). */
export const largeRound = () => typicalRound(90, 100, 4);

/** The estimate for a typical 18-hole round (Settings → AI). */
export function typicalTokenEstimate(opts: EstimateOptions = {}): TokenEstimate {
  const { summary, plan } = typicalRound();
  return videoTokenEstimate(summary, '', plan, opts);
}
