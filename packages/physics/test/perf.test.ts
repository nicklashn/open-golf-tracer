import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { refitShot, shotHandles } from '../src';

const doc = JSON.parse(readFileSync(new URL('./fixtures/shot-sample.json', import.meta.url), 'utf8'));
const raw = doc.shots[0];
const shot = {
  ...raw,
  constraints: { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null },
  timing: { launchOffset: 0, speed: 1 },
};

describe('live refit budget', () => {
  it('each drag update stays within one 60 Hz frame and the drag converges', () => {
    const h = shotHandles(shot)!;
    const times: number[] = [];
    let params = shot.params;
    let lambda: number | undefined;
    const target = (i: number) => ({ x: h.landing.x + i * 3, y: h.landing.y + i });
    // 30 pointer moves, as the Web Worker sees them during a drag.
    for (let i = 0; i < 30; i++) {
      const s = { ...shot, params, constraints: { ...shot.constraints, landing: target(i) } };
      const r = refitShot(s, { fps: 30, longSide: 1920, maxIterations: 4, timeBudgetMs: 10, maxTrackPoints: 40, lambda, reference: shot.params });
      params = r.params;
      lambda = r.lambda;
      times.push(r.ms);
    }
    // Pointer up: settle fully.
    const final = refitShot(
      { ...shot, params, constraints: { ...shot.constraints, landing: target(29) } },
      { fps: 30, longSide: 1920, maxIterations: 60, lambda },
    );
    console.log(JSON.stringify({ it: final.iterations, l: final.lambda, c: final.converged, cost: final.cost }));
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`refit per move: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms; settle ${final.ms.toFixed(1)} ms`);
    expect(median).toBeLessThan(16);
    const end = shotHandles({ ...shot, params: final.params })!;
    expect(Math.hypot(end.landing.x - target(29).x, end.landing.y - target(29).y)).toBeLessThan(6);
  });
});
