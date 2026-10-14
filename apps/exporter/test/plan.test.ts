import { describe, expect, it } from 'vitest';
import { migrateProject } from '@golf/schema';
import { atempoChain, buildPlan, cropExpr } from '../src/plan';

const enc = { h264: 'libx264', hevc: 'libx265', tonemap: 'TONEMAP' } as const;
const media = {
  m1: { id: 'm1', path: '/v/a.mov', width: 1920, height: 1080, fps: 59.94, duration: 20, hdr: true, hasAudio: true, color: { color_trc: 'arib-std-b67' } },
  mu: { id: 'mu', path: '/v/song.mp3', width: 0, height: 0, fps: 0, duration: 120, hdr: false, hasAudio: true },
};
const project = migrateProject({
  schemaVersion: 1,
  media: { m1: { id: 'm1', kind: 'video', name: 'a', width: 1920, height: 1080, fps: 59.94, duration: 20, hdr: true, hasAudio: true } },
  clips: [
    { id: 'a', kind: 'video', mediaId: 'm1', in: 2, out: 6, speed: 1 },
    { id: 'b', kind: 'video', mediaId: 'm1', in: 6, out: 7, speed: 0.25 },
    { id: 'c', kind: 'freeze', mediaId: 'm1', at: 7, duration: 1.5 },
  ],
  audioTracks: [{ id: 'x', mediaId: 'mu', start: 1, in: 10, out: 40, volume: 0.5, fadeIn: 1, fadeOut: 2 }],
});

function evalExpr(expr: string, t: number): number {
  const js = expr
    .replace(/if\(/g, 'iff(')
    .replace(/lt\(/g, 'lt(')
    .replace(/clip\(/g, 'clip(');
  const fn = new Function('t', 'iff', 'lt', 'clip', `return ${js};`);
  return fn(
    t,
    (c: unknown, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  );
}

describe('export plan', () => {
  it('chains atempo for big speed changes', () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5']);
  });

  it('crop expression interpolates between reframe keys and stays in the frame', () => {
    const keys = [
      { t: 1, cx: 0.2, cy: 0.5, zoom: 1 },
      { t: 3, cx: 0.9, cy: 0.5, zoom: 1 },
    ];
    const e = cropExpr(keys, 'cx', 0, 1920, 608);
    expect(evalExpr(e, 0)).toBeCloseTo(0.2 * 1920 - 304);
    expect(evalExpr(e, 2)).toBeCloseTo((0.2 * 1920 - 304 + (1920 - 608)) / 2);
    expect(evalExpr(e, 5)).toBeCloseTo(1920 - 608);
  });

  it('builds clips, HDR, audio and music', () => {
    const plan = buildPlan({
      project,
      settings: { preset: 'original', fps: 'source', hdr: 'keep', range: null },
      media,
      maxShortSide: 2160,
      encoders: enc,
      output: '/o.mp4',
      overlay: { x: 10, y: 20, w: 300, h: 400 },
    });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(plan.width).toBe(1920);
    expect(plan.hdr).toBe(true);
    expect(plan.duration).toBeCloseTo(4 + 4 + 1.5);
    expect(graph).toContain('setpts=(PTS-STARTPTS)/0.25');
    expect(graph).toContain('atempo=0.5,atempo=0.5');
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=1.5');
    expect(graph).toContain('concat=n=3:v=1:a=1');
    expect(graph).toContain('amix=inputs=2');
    expect(graph).toContain('adelay=1000');
    expect(graph).toContain('overlay=x=10:y=20');
    expect(graph).not.toContain('TONEMAP');
    expect(plan.args).toContain('libx265');
    expect(plan.args).toContain('arib-std-b67');
  });

  it('tone-maps HDR to SDR, forces 9:16 for Shorts and respects the resolution cap', () => {
    const plan = buildPlan({
      project,
      settings: { preset: 'shorts', fps: 30, hdr: 'sdr', range: { start: 1, end: 5 } },
      media,
      maxShortSide: 720,
      encoders: enc,
      output: '/o.mp4',
      overlay: null,
    });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(plan.width).toBe(720);
    expect(plan.height).toBe(1280);
    expect(plan.aspect).toBe('9:16');
    expect(graph).toContain('TONEMAP');
    expect(graph).toContain('crop=w=606:h=1080');
    expect(graph).toContain('trim=start=1:end=5');
    expect(plan.frames).toBe(120);
    expect(plan.args).toContain('libx264');
  });
});
