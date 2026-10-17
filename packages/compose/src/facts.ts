/**
 * The fact guard: a number the model writes in a title, a shot text or the description must be
 * a fact of the round (a measured carry, a hole, a score …), never a `~` guess or something
 * made up. A text with any other number is dropped (a sentence of the description, a shot's
 * line) or replaced (the title goes back to the rule plan's).
 */
import type { VideoPlan } from './plan';
import type { RoundSummary } from './summary';

const NUMBER = /\d+(?:[.,]\d+)?/g;

/** The numbers in a text ("4,2" and "4.2" are the same). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)].map((m) => Number(m[0].replace(',', '.')));
}

/** Every number the summary states as a fact (guesses such as `carrySuggestM` are left out). */
export function factNumbers(s: RoundSummary, ...texts: string[]): Set<number> {
  const out = new Set<number>();
  const add = (v: number | null | undefined) => {
    if (v !== null && v !== undefined && Number.isFinite(v)) out.add(Math.abs(v));
  };
  const addText = (t: string) => numbersIn(t).forEach(add);
  [s.name, s.course, ...texts].forEach(addText);
  if (s.date) {
    const [y, m, d] = s.date.split('-').map(Number);
    [y, m, d, y % 100].forEach(add);
  }
  add(s.clips.length);
  add(s.shots.length);
  add(s.putts.length);
  add(s.chips.length);
  add(new Set(s.clips.map((c) => c.hole).filter(Boolean)).size);
  for (const c of s.clips) {
    add(c.n);
    addText(c.hole);
    add(c.par);
  }
  for (const x of s.shots) {
    add(x.n);
    addText(x.hole);
    add(x.par);
    add(x.carryM);
    add(x.apexM);
    add(x.flightS);
    add(x.nextM);
  }
  const done = s.putts.length ? s.holes.filter((h) => h.strokes !== null) : [];
  for (const h of done) {
    add(h.strokes);
    add(h.putts);
    add(h.par);
    add(h.strokes! - h.par!);
  }
  if (done.length) {
    const strokes = done.reduce((n, h) => n + h.strokes!, 0);
    const par = done.reduce((n, h) => n + (h.par ?? 0), 0);
    [done.length, strokes, par, strokes - par].forEach(add);
  }
  // How many holes have each highlight ("3 birdies").
  const holesWith = new Map<string, Set<string>>();
  for (const x of [...s.shots, ...s.putts]) for (const t of x.tags ?? []) holesWith.set(t, (holesWith.get(t) ?? new Set()).add(`${x.hole}|${x.id}`));
  for (const [t, set] of holesWith) {
    add(set.size);
    if (t === 'eagle' || t === 'birdie') add(new Set([...set].map((k) => k.split('|')[0])).size);
  }
  return out;
}

/** True when every number in the text is a fact. */
export const factual = (text: string, facts: Set<number>) => numbersIn(text).every((n) => facts.has(n));

export interface GuardOptions {
  /** The user's own words: a number they wrote (a title in quotes, "hole 7") may be used. */
  preference?: string;
  /** The title to use when the model's has a number that is not a fact. */
  fallbackTitle: string;
}

/** The plan with the model's texts checked; `dropped` lists what was removed (for the log). */
export function guardFacts(plan: VideoPlan, s: RoundSummary, opts: GuardOptions): { plan: VideoPlan; dropped: string[] } {
  const facts = factNumbers(s, opts.preference ?? '', opts.fallbackTitle);
  const dropped: string[] = [];
  let title = plan.title;
  if (!factual(title, facts)) {
    dropped.push(`title: ${title}`);
    title = opts.fallbackTitle;
  }
  let shotTexts: Record<string, string> | undefined;
  for (const [id, text] of Object.entries(plan.shotTexts ?? {})) {
    if (factual(text, facts)) (shotTexts ??= {})[id] = text;
    else dropped.push(`shotText ${id}: ${text}`);
  }
  let description = plan.description;
  if (description) {
    const sentences = description.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((x) => factual(x, facts));
    if (kept.length < sentences.length) {
      dropped.push(...sentences.filter((x) => !kept.includes(x)).map((x) => `description: ${x}`));
      description = kept.join(' ').trim() || undefined;
    }
  }
  if (!dropped.length) return { plan, dropped };
  return { plan: { ...plan, title, shotTexts, description }, dropped };
}
