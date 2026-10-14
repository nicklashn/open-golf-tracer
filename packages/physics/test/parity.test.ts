import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitConstrained, launchPrior, project, stats, type Club } from '../src';

interface Case {
  params: number[];
  camera: { cx: number; cy: number };
  anchor: { x: number; y: number };
  size: [number, number];
  projection: { n: number; idx: number[]; u: number[]; v: number[]; z: number[] } | null;
  stats?: { carry_m: number; apex_m: number; flight_time_s: number };
  fit?: { landing: [number, number]; fps: number; result_landing: [number, number] | null };
  launch_prior: Record<string, [number, number, number]>;
}

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8')) as { cases: Case[] };

describe('physics parity with Python', () => {
  it('has fixtures', () => expect(cases.length).toBeGreaterThan(10));

  it.each(cases.map((c, i) => [i, c] as const))('case %i projects within 0.5 px', (_, c) => {
    const pr = project(c.params, c.camera, c.anchor, true);
    if (c.projection === null) {
      expect(pr).toBeNull();
      return;
    }
    expect(pr).not.toBeNull();
    expect(pr!.n).toBe(c.projection.n);
    let worst = 0;
    c.projection.idx.forEach((j, k) => {
      worst = Math.max(worst, Math.abs(pr!.u[j] - c.projection!.u[k]), Math.abs(pr!.v[j] - c.projection!.v[k]));
    });
    expect(worst).toBeLessThan(0.5);
    const st = stats(c.params, c.camera, c.anchor)!;
    expect(st.carryM).toBeCloseTo(c.stats!.carry_m, 0);
    expect(st.flightTimeS).toBeCloseTo(c.stats!.flight_time_s, 2);
  });

  it.each(cases.map((c, i) => [i, c] as const))('case %i has the same club priors', (_, c) => {
    for (const [club, want] of Object.entries(c.launch_prior)) {
      launchPrior(c.params, club as Club).forEach((x, k) => expect(x).toBeCloseTo(want[k], 9));
    }
  });

  it.each(cases.filter((c) => c.fit?.result_landing).map((c, i) => [i, c] as const))('constrained fit %i lands where Python lands', (_, c) => {
    const res = fitConstrained({
      params: c.params,
      camera: c.camera,
      anchor: c.anchor,
      longSide: Math.max(...c.size),
      fps: c.fit!.fps,
      sigmaPx: 3,
      constraints: { landing: { x: c.fit!.landing[0], y: c.fit!.landing[1] } },
    });
    const pr = project(res.params, c.camera, c.anchor, true)!;
    const end = pr.n - 1;
    // Both satisfy the handle; tolerance is the handle's own softness.
    expect(Math.hypot(pr.u[end] - c.fit!.landing[0], pr.v[end] - c.fit!.landing[1])).toBeLessThan(4);
    expect(Math.hypot(pr.u[end] - c.fit!.result_landing![0], pr.v[end] - c.fit!.result_landing![1])).toBeLessThan(6);
  });
});
