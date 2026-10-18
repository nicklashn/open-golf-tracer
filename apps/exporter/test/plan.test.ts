import { describe, expect, it } from 'vitest';
import { cropAt, migrateProject, type Project } from '@golf/schema';
import { atempoChain, audioArgs, buildPlan, concatList, cropExpr, frameRate, frameTime, muxArgs, reframeFilters, segmentArgs } from '../src/plan';

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
  const fn = new Function('t', 'it', 'iff', 'lt', 'clip', `return ${js};`);
  return fn(
    t,
    t,
    (c: unknown, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  );
}

/** Within the export's whole-pixel rounding (its crop is an even number of pixels, the preview's exact). */
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1.5);

describe('export plan', () => {
  it('chains atempo for big speed changes', () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5']);
  });

  it('crop expression follows the preview: the centre is interpolated, then the crop kept in the frame', () => {
    const keys = [
      { t: 1, cx: 0.2, cy: 0.5, zoom: 1 },
      { t: 3, cx: 0.9, cy: 0.5, zoom: 1 },
    ];
    const e = cropExpr(keys, 'cx', 0, 1920, 608);
    const proj = { format: { aspect: '9:16', fill: 'crop', reframe: { mode: 'manual', keyframes: keys } } } as unknown as Project;
    for (const t of [0, 1.5, 2, 2.4, 2.8, 5]) near(evalExpr(e, t), cropAt(proj, { width: 1920, height: 1080 }, t).x);
    expect(evalExpr(e, 0)).toBeCloseTo(0.2 * 1920 - 304);
    expect(evalExpr(e, 5)).toBeCloseTo(1920 - 608);
  });

  it("export crop applies the keys' zoom as the preview does", () => {
    const src = { width: 1920, height: 1080 };
    const at = (keys: { t: number; cx: number; cy: number; zoom: number }[], t: number) =>
      cropAt({ format: { aspect: '9:16', fill: 'crop', reframe: { mode: 'manual', keyframes: keys } } } as unknown as Project, src, t);
    const out = { W: 1080, H: 1920, rate: '30' };
    // One zoom for all keys: a plain crop of the zoomed size.
    const fixed = [
      { t: 0, cx: 0.3, cy: 0.4, zoom: 2 },
      { t: 2, cx: 0.95, cy: 0.6, zoom: 2 },
    ];
    const [crop] = reframeFilters(fixed, 0, src, 606, 1080, out);
    const m = /^crop=w=(\d+):h=(\d+):x='(.*)':y='(.*)':exact=1$/.exec(crop)!;
    expect([Number(m[1]), Number(m[2])]).toEqual([304, 540]);
    for (const t of [0, 0.7, 1.3, 3]) {
      const c = at(fixed, t);
      near(c.w, 304);
      near(evalExpr(m[3], t), c.x);
      near(evalExpr(m[4], t), c.y);
    }
    // A zoom that changes: the zoom-1 crop holds the zoomed one, zoompan cuts that out.
    const moving = [
      { t: 1, cx: 0.1, cy: 0.5, zoom: 1 },
      { t: 3, cx: 0.5, cy: 0.2, zoom: 3 },
      { t: 4, cx: 0.97, cy: 0.9, zoom: 1.5 },
    ];
    const [base, zoompan] = reframeFilters(moving, 0.5, src, 606, 1080, out);
    const b = /^crop=w=606:h=1080:x='(.*)':y='(.*)':exact=1$/.exec(base)!;
    const z = /^zoompan=z='(.*)':x='(.*)':y='(.*)':d=1:s=1080x1920:fps=30$/.exec(zoompan)!;
    expect(b && z).toBeTruthy();
    for (const local of [0, 0.4, 1, 1.5, 2.2, 2.5, 3, 3.3, 4.5]) {
      const want = at(moving, local + 0.5);
      const bx = evalExpr(b[1], local);
      const by = evalExpr(b[2], local);
      const zoom = evalExpr(z[1], local);
      const zx = evalExpr(z[2], local);
      const zy = evalExpr(z[3], local);
      // zoompan shows (iw/zoom)×(ih/zoom) of the zoom-1 crop from (x, y): the preview's crop.
      expect(606 / zoom).toBeCloseTo((want.w * 606) / (1080 * (9 / 16)), 3);
      near(bx + zx, want.x);
      near(by + zy, want.y);
      // ...and it lies inside the zoom-1 crop, which lies inside the frame.
      expect(zx).toBeGreaterThanOrEqual(-1e-6);
      expect(zx + 606 / zoom).toBeLessThanOrEqual(606 + 1e-6);
      expect(zy + 1080 / zoom).toBeLessThanOrEqual(1080 + 1e-6);
      expect(bx).toBeGreaterThanOrEqual(0);
      expect(bx + 606).toBeLessThanOrEqual(1920);
    }
  });

  it('builds clips, HDR, audio and music', () => {
    const plan = buildPlan({
      project,
      settings: { preset: 'original', fps: 'source', hdr: 'keep', range: null },
      media,
      maxShortSide: 2160,
      encoders: enc,
    });
    const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
    const seg = plan.segments.map((sg, i) => segmentArgs(plan, sg, i === 0 ? { box: { x: 10, y: 20, w: 300, h: 400 }, runs: [[0, 240]] } : null, `/s${i}.mp4`));
    const audio = audioArgs(plan, '/a.m4a');
    expect(plan.width).toBe(1920);
    expect(plan.hdr).toBe(true);
    expect(plan.mixedHdr).toBe(false);
    expect(plan.rate).toEqual({ num: 60000, den: 1001 });
    expect(plan.segments.map((sg) => sg.frames)).toEqual([240, 240, 89]); // 4 s, 4 s and 1.5 s on the 59.94 grid: frames 0, 240, 480 (479.5), 569 (569.4)
    expect(plan.duration).toBeCloseTo((569 * 1001) / 60000);
    expect(graphOf(seg[1])).toContain('setpts=(PTS-STARTPTS)/0.25');
    expect(graphOf(seg[2])).toContain('trim=end_frame=1');
    expect(graphOf(seg[0])).toContain('trim=start_frame=0:end_frame=240');
    expect(graphOf(seg[0])).toContain('overlay=x=10:y=20');
    expect(graphOf(seg[1])).not.toContain('overlay');
    expect(seg[0]).toContain('pipe:0');
    expect(seg[1]).not.toContain('pipe:0');
    expect(graphOf(audio)).toContain('atempo=0.5,atempo=0.5');
    expect(graphOf(audio)).toContain('concat=n=3:v=0:a=1');
    expect(graphOf(audio)).toContain('amix=inputs=2');
    expect(graphOf(audio)).toContain('adelay=48000S');
    expect(seg.join(' ')).not.toContain('TONEMAP');
    expect(seg[0]).toContain('libx265');
    expect(seg[0]).toContain('arib-std-b67');
    expect(muxArgs(plan, '/l.txt', '/a.m4a', '/o.mp4')).toContain('hvc1');
  });

  it('tone-maps HDR to SDR, forces 9:16 for Shorts and respects the resolution cap', () => {
    const plan = buildPlan({
      project,
      settings: { preset: 'shorts', fps: 30, hdr: 'sdr', range: { start: 1, end: 5 } },
      media,
      maxShortSide: 720,
      encoders: enc,
    });
    const graphs = plan.segments.map((sg) => {
      const a = segmentArgs(plan, sg, null, '/s.mp4');
      return a[a.indexOf('-filter_complex') + 1];
    });
    expect(plan.width).toBe(720);
    expect(plan.height).toBe(1280);
    expect(plan.aspect).toBe('9:16');
    expect(graphs[0]).toContain('TONEMAP');
    expect(graphs[0]).toContain('crop=w=606:h=1080');
    // Timeline 1–5 s: the last 3 s of clip a (skipping its first 30 frames), 1 s of clip b.
    expect(plan.segments).toEqual([
      { clip: 0, start: 0, frames: 90, skip: 30 },
      { clip: 1, start: 90, frames: 30, skip: 0 },
    ]);
    expect(graphs[0]).toContain('trim=start_frame=30:end_frame=120');
    expect(plan.frames).toBe(120);
    expect(frameTime(plan, 0)).toBeCloseTo(1);
    expect(graphOfAudio(plan)).toContain('atrim=start_sample=48000:end_sample=192000');
    expect(segmentArgs(plan, plan.segments[0], null, '/s.mp4')).toContain('libx264');
  });

  it('puts every clip boundary on the output frame grid (many short cuts at 59.94)', () => {
    // 30 clips of 0.41 s: 24.58 frames each. Rounding each clip up would make 750 frames.
    const clips = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, kind: 'video', mediaId: 'm1', in: i * 0.5, out: i * 0.5 + 0.41, speed: 1 }));
    const p = migrateProject({ schemaVersion: 1, media: project.media, clips });
    const plan = buildPlan({ project: p, settings: { preset: 'original', fps: 'source', hdr: 'sdr', range: null }, media, encoders: enc });
    const F = 60000 / 1001;
    expect(plan.frames).toBe(Math.round(30 * 0.41 * F));
    expect(plan.segments.reduce((n, sg) => n + sg.frames, 0)).toBe(plan.frames);
    plan.segments.forEach((sg, i) => expect(sg.start).toBe(Math.round(i * 0.41 * F)));
    // Overlay frame k is drawn at the time the picture of frame k shows: its clip's start plus
    // the frames since then.
    for (const sg of plan.segments) {
      expect(frameTime(plan, sg.start)).toBeCloseTo(sg.clip * 0.41, 9);
      expect(frameTime(plan, sg.start + sg.frames - 1)).toBeLessThan((sg.clip + 1) * 0.41);
    }
    // Sound is cut at the same frame boundaries.
    const audio = graphOfAudio(plan);
    expect(audio).toContain(`atrim=end_sample=${Math.round((plan.frames * 48000 * 1001) / 60000)}[afinal]`);
  });

  it('keeps HDR only when every clip is HDR of the same kind', () => {
    const mixed = migrateProject({
      schemaVersion: 1,
      media: { ...project.media, s1: { ...project.media.m1, id: 's1', hdr: false } },
      clips: [
        { id: 'a', kind: 'video', mediaId: 'm1', in: 2, out: 6, speed: 1 },
        { id: 'b', kind: 'video', mediaId: 's1', in: 0, out: 2, speed: 1 },
      ],
    });
    const sdr = { ...media.m1, id: 's1', path: '/v/s.mp4', hdr: false, color: { color_trc: 'bt709' } };
    const plan = buildPlan({
      project: mixed,
      settings: { preset: 'original', fps: 30, hdr: 'keep', range: null },
      media: { ...media, s1: sdr },
      encoders: enc,
    });
    expect(plan.hdr).toBe(false);
    expect(plan.mixedHdr).toBe(true);
    const hdrSeg = segmentArgs(plan, plan.segments[0], null, '/s.mp4');
    expect(hdrSeg.join(' ')).toContain('TONEMAP');
    expect(hdrSeg).toContain('libx264');
    expect(hdrSeg).toContain('bt709');
    // HLG next to PQ cannot share one set of tags either.
    const pq = { ...media.m1, id: 's1', path: '/v/p.mov', color: { color_trc: 'smpte2084' } };
    expect(
      buildPlan({ project: mixed, settings: { preset: 'original', fps: 30, hdr: 'keep', range: null }, media: { ...media, s1: pq }, encoders: enc }).hdr,
    ).toBe(false);
  });

  it('pipes only the overlay frames that draw, and places them on their frames', () => {
    const plan = buildPlan({ project, settings: { preset: 'original', fps: 30, hdr: 'sdr', range: null }, media, encoders: enc });
    const args = segmentArgs(
      plan,
      plan.segments[0],
      {
        box: { x: 0, y: 0, w: 64, h: 32 },
        runs: [
          [10, 20],
          [50, 60],
        ],
      },
      '/s.mp4',
    );
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain("setpts='round((if(lt(N,10),N+10,N+40))*1/(30*TB))'");
    expect(graph).toContain("enable='between(t,0.316667,0.65)+between(t,1.65,1.983333)'");
  });

  it('knows the NTSC rates and quotes paths for the concat list', () => {
    expect(frameRate(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(frameRate(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(frameRate(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(frameRate(25)).toEqual({ num: 25, den: 1 });
    expect(concatList(["/x/it's.mp4"])).toBe("file '/x/it'\\''s.mp4'\n");
  });
});

function graphOfAudio(plan: ReturnType<typeof buildPlan>): string {
  const a = audioArgs(plan, '/a.m4a');
  return a[a.indexOf('-filter_complex') + 1];
}
