/** Keeping flights in view: the sanity rule, pulling a flight back in, and drawing one through three points. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFF_FRAME, fitThrough, frameBox, inBox, intoView, offFrameReason, shotHandles, type Box } from '../src';

const C = { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null };
const demo = JSON.parse(readFileSync(new URL('../../../assets/demo/demo.analysis.json', import.meta.url), 'utf8')) as {
  shots: { params: number[]; camera: { cx: number; cy: number }; anchor: { x: number; y: number }; impactTime: number; kind: string }[];
};
const shots = demo.shots.map((s) => ({
  ...s,
  track: { t: [], u: [], v: [] },
  slowmo: 1,
  timing: { launchOffset: 0, speed: 1 },
  constraints: C,
  club: 'auto' as const,
}));
const W = 1920;
const H = 1080;
const opt = { fps: 30, longSide: W };
const full: Box = { x: 0, y: 0, w: W, h: H };
const portrait: Box = { x: 700, y: 0, w: 607.5, h: H }; // a 9:16 crop of the 16:9 frame

/** A flight fitted to absurd handles, like a bad track can give. */
function wild(apex = { x: 1100, y: -3 * H }, landing = { x: 5 * W, y: 400 }) {
  const s = shots[1];
  return { ...s, params: fitThrough(s, s.anchor, apex, landing, opt).params };
}

describe('sanity rule', () => {
  it('leaves the demo (real) flights alone', () => {
    for (const s of shots) expect(offFrameReason(s)).toBeNull();
  });

  it('catches handles more than a frame outside the picture', () => {
    const w = wild();
    const h = shotHandles(w)!;
    expect(h.apex.y < -H * OFF_FRAME.slack || h.landing.x > W * (1 + OFF_FRAME.slack) || h.landingT > OFF_FRAME.maxFlightS).toBe(true);
    expect(offFrameReason(w, frameBox(w))).not.toBeNull();
  });

  it('catches a flight that cannot be drawn at all', () => {
    const s = shots[0];
    // The camera pitched far up: the address ball lies above the horizon, no projection.
    const p = [...s.params];
    p[5] = (-25 * Math.PI) / 180;
    expect(shotHandles({ ...s, params: p, anchor: { x: 1000, y: 100 } })).toBeNull();
    expect(offFrameReason({ ...s, params: p, anchor: { x: 1000, y: 100 } })).toBe('invalid flight');
  });
});

describe('intoView', () => {
  it.each([
    ['the whole frame', full],
    ['a 9:16 crop', portrait],
  ])('pulls a wild flight into %s from the same start, as a plausible shot', (_, box) => {
    const w = wild();
    const r = intoView(w, box, opt);
    const h = shotHandles({ ...w, params: r.params, constraints: r.constraints })!;
    expect(inBox(h.start, box)).toBe(true);
    expect(inBox(h.apex, box)).toBe(true);
    expect(inBox(h.landing, box)).toBe(true);
    expect(h.start).toEqual(w.anchor);
    expect(h.apex.y).toBeLessThan(h.landing.y);
    expect(h.landing.y).toBeLessThan(h.start.y);
    // The handles are stored, so later refits keep them.
    expect(Math.hypot(h.apex.x - r.constraints.apex!.x, h.apex.y - r.constraints.apex!.y)).toBeLessThan(3);
    expect(offFrameReason({ ...w, params: r.params, constraints: r.constraints })).toBeNull();
  });

  it('moves a start outside the crop into it', () => {
    const w = { ...wild(), anchor: { x: 200, y: 950 } };
    const r = intoView(w, portrait, opt);
    expect(inBox(r.constraints.start!, portrait)).toBe(true);
    const h = shotHandles({ ...w, params: r.params, constraints: r.constraints })!;
    expect(inBox(h.apex, portrait) && inBox(h.landing, portrait)).toBe(true);
  });

  it('keeps visible handles where they are', () => {
    const s = shots[0];
    const before = shotHandles(s)!;
    const r = intoView(s, full, opt);
    const h = shotHandles({ ...s, params: r.params, constraints: r.constraints })!;
    expect(Math.hypot(h.apex.x - before.apex.x, h.apex.y - before.apex.y)).toBeLessThan(3);
    expect(Math.hypot(h.landing.x - before.landing.x, h.landing.y - before.landing.y)).toBeLessThan(3);
  });

  it('recovers a flight that cannot be drawn', () => {
    const s = shots[0];
    const p = [...s.params];
    p[5] = (-25 * Math.PI) / 180;
    const r = intoView({ ...s, params: p }, full, opt);
    const h = shotHandles({ ...s, params: r.params, constraints: r.constraints })!;
    expect(inBox(h.apex, full) && inBox(h.landing, full)).toBe(true);
  });
});

describe('fitThrough (draw the path)', () => {
  it('meets three clicked points', () => {
    const s = wild();
    const start = { x: 900, y: 950 };
    const apex = { x: 700, y: 150 };
    const landing = { x: 600, y: 520 };
    const r = fitThrough(s, start, apex, landing, opt);
    const h = shotHandles({ ...s, params: r.params, constraints: { ...C, start } })!;
    expect(Math.hypot(h.apex.x - apex.x, h.apex.y - apex.y)).toBeLessThan(4);
    expect(Math.hypot(h.landing.x - landing.x, h.landing.y - landing.y)).toBeLessThan(4);
  });
});
