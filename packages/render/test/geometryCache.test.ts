import { describe, expect, it, vi } from 'vitest';
import { scene } from '../../../tests/parity/scene';

// Count how often the expensive geometry is rebuilt behind shotGeometry's cache.
const built = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/tracer', async (orig) => {
  const m = await orig<typeof import('../src/tracer')>();
  return {
    ...m,
    geometry: (...a: Parameters<typeof m.geometry>) => {
      built.n++;
      return m.geometry(...a);
    },
  };
});

const { shotGeometry } = await import('../src/frame');
const { geometry, sourcePath } = await import('../src/tracer');

describe('tracer geometry cache', () => {
  const shot = scene().shots.find((s) => s.kind === 'full')!;
  const scale = 960 / 1920;

  it('is not rebuilt every frame while the reframe pans', () => {
    built.n = 0;
    for (let k = 0; k < 120; k++) shotGeometry(shot, { ox: 300 + k * 1.7, oy: 20 + k * 0.3, scale });
    expect(built.n).toBe(1);
  });

  it('draws the same line as building it at the crop offset', () => {
    const tf = { ox: 417.3, oy: 61.9, scale };
    const cached = shotGeometry(shot, tf)!;
    const direct = geometry(sourcePath(shot)!, shot.style, tf, shot.constraints.start ?? shot.anchor);
    expect(cached.x.length).toBe(direct.x.length);
    for (let i = 0; i < direct.x.length; i++) {
      expect(cached.x[i]).toBeCloseTo(direct.x[i], 9);
      expect(cached.y[i]).toBeCloseTo(direct.y[i], 9);
    }
    expect(cached.w).toEqual(direct.w);
    expect(cached.anchor.x).toBeCloseTo(direct.anchor.x, 9);
    expect(cached.anchor.y).toBeCloseTo(direct.anchor.y, 9);
    // The same frame asked twice (bounds pass, then render) gets the same object.
    expect(shotGeometry(shot, tf)).toBe(cached);
  });
});
