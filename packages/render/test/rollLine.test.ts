import { describe, expect, it } from 'vitest';
import { migrateProject, type Project, type Shot } from '@golf/schema';
import { ROLL_FADE_S, ROLL_HOLD_S, Surface, frameBounds, renderOverlay, rollFade, rollGeometry, rollLengthAt, shotRollGeometry, shotsOnScreen } from '../src';
import { scene } from '../../../tests/parity/scene';

const W = 960;
const H = 540;

/** A straight putt rolling 0.3 of the frame width from t=2 to t=4 (source seconds), easing out. */
const PATH = Array.from({ length: 25 }, (_, i) => {
  const e = 1 - (1 - i / 24) ** 2;
  return { t: 2 + (i / 24) * 2, x: 0.3 + 0.3 * e, y: 0.7 };
});

function project(line: boolean, extra: Partial<Project> = {}, clip: Record<string, unknown> = {}): Project {
  const base = scene();
  const putt = base.shots.find((s) => s.kind === 'putt')!;
  return migrateProject({
    ...base,
    layers: [],
    clips: [{ id: 'c', kind: 'video', mediaId: 'm1', in: 0, out: 25, speed: 1, ...clip }],
    shots: [{ ...putt, impactTime: 1.95, putt: { end: 4, holed: true, path: PATH, line } }],
    ...extra,
  } as Project);
}

const tf = { ox: 0, oy: 0, scale: W / 1920 };

describe('roll line', () => {
  const p = project(true);
  const shot = p.shots[0];
  const g = rollGeometry(shot, p.media.m1, tf)!;

  it('maps the path from source fractions to output pixels', () => {
    expect(g.x[0]).toBeCloseTo(0.3 * 1920 * tf.scale, 6);
    expect(g.y[0]).toBeCloseTo(0.7 * 1080 * tf.scale, 6);
    expect(g.x[g.x.length - 1]).toBeCloseTo(0.6 * 1920 * tf.scale, 6);
    expect(g.length).toBeCloseTo(0.3 * 1920 * tf.scale, 1);
  });

  it('grows with the ball: none before the stroke, up to the ball while it rolls, all of it after', () => {
    expect(rollLengthAt(g, 1.9)).toBe(0);
    let last = 0;
    for (let s = 2; s <= 4; s += 0.05) {
      const l = rollLengthAt(g, s);
      expect(l).toBeGreaterThanOrEqual(last - 1e-9);
      last = l;
    }
    // At t=3 (half the time) an easing-out ball has covered 3/4 of the way.
    expect(rollLengthAt(g, 3) / g.length).toBeCloseTo(0.75, 2);
    expect(rollLengthAt(g, 4)).toBeCloseTo(g.length, 6);
    expect(rollLengthAt(g, 4 + ROLL_HOLD_S)).toBeCloseTo(g.length, 6);
  });

  it('is held where the ball stopped, then fades out', () => {
    expect(rollFade(g, 1.9)).toBe(0);
    expect(rollFade(g, 3)).toBe(1);
    expect(rollFade(g, 4 + ROLL_HOLD_S)).toBe(1);
    const mid = rollFade(g, 4 + ROLL_HOLD_S + ROLL_FADE_S / 2);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(rollFade(g, 4 + ROLL_HOLD_S + ROLL_FADE_S)).toBe(0);
  });

  const draw = (pr: Project, t: number) => {
    const s = new Surface(W, H);
    renderOverlay(s, { project: pr, width: W, height: H, locale: 'en', images: new Map() }, t);
    return s.dirty ? s.toRGBA({ x: 0, y: 0, w: W, h: H })!.data : null;
  };
  const alphaAt = (d: Uint8ClampedArray | null, x: number, y: number) => (d ? d[(Math.round(y) * W + Math.round(x)) * 4 + 3] : 0);

  it('is drawn along the path up to the ball, and only when switched on', () => {
    const y = 0.7 * 540;
    const d = draw(p, 3);
    expect(alphaAt(d, 0.4 * W, y)).toBeGreaterThan(200); // behind the ball
    expect(alphaAt(d, 0.55 * W, y)).toBe(0); // ahead of it
    expect(alphaAt(d, 0.4 * W, y - 40)).toBe(0); // off the line
    expect(draw(project(false), 3)).toBeNull();
    // A putt is never traced: off, nothing at all is drawn for it.
    expect(frameBounds({ project: project(false), width: W, height: H, locale: 'en', images: new Map() }, 3)).toBeNull();
  });

  it('fades: fainter while fading, gone after', () => {
    const y = 0.7 * 540;
    const held = alphaAt(draw(p, 4 + ROLL_HOLD_S), 0.45 * W, y);
    const fading = alphaAt(draw(p, 4 + ROLL_HOLD_S + ROLL_FADE_S / 2), 0.45 * W, y);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(held);
    expect(draw(p, 4 + ROLL_HOLD_S + ROLL_FADE_S + 0.01)).toBeNull();
  });

  it('runs on source time: slow clips and trims keep it on the ball', () => {
    // Trimmed to start at 1 s and played at half speed: timeline 2 s is source 2 s.
    const slow = project(true, {}, { in: 1, speed: 0.5 });
    const it0 = shotsOnScreen({ project: slow, width: W }, 2)[0];
    expect(it0.sourceTime).toBeCloseTo(2, 9);
    const it1 = shotsOnScreen({ project: slow, width: W }, 4)[0];
    expect(rollLengthAt(shotRollGeometry(slow, it1.shot, it1.tf)!, it1.sourceTime)).toBeCloseTo(rollLengthAt(g, 3), 6);
  });

  it('follows a 9:16 crop like the tracer', () => {
    const tall = project(true, { format: { ...p.format, aspect: '9:16', reframe: { mode: 'manual', keyframes: [{ t: 0, cx: 0.45, cy: 0.5, zoom: 1 }] } } });
    const [it] = shotsOnScreen({ project: tall, width: 540 }, 3);
    const tg = shotRollGeometry(tall, it.shot as Shot, it.tf)!;
    const cropW = 1080 * (9 / 16);
    const ox = 0.45 * 1920 - cropW / 2;
    expect(it.tf.ox).toBeCloseTo(ox, 6);
    expect(tg.x[0]).toBeCloseTo((0.3 * 1920 - ox) * (540 / cropW), 6);
    expect(tg.w).toBeGreaterThan(g.w); // the line keeps its size relative to the ball
  });
});
