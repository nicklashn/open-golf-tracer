/**
 * Real ffmpeg: a round with many cuts at NTSC rates must come out with exactly the frames the
 * timeline has, the picture and the overlay on the same frame at the end of it, and sound as
 * long as the picture.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMedia } from '../src/cli';
import { runExport } from '../src/run';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ogt-timing-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIZE = { w: 128, h: 72 };
const MARKER = 1100; // the one white source frame
const MARKER_CLIP = 33;

/** Black video with sound, white only at source frame MARKER. */
function source(rate: string): string {
  const file = join(dir, `src-${rate.replace('/', '_')}.mp4`);
  const r = spawnSync('ffmpeg', [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${SIZE.w}x${SIZE.h}:r=${rate}`],
    ...['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-vf', `drawbox=c=white:t=fill:enable='eq(n,${MARKER})'`],
    ...['-frames:v', '1300', '-t', '45', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
  ]);
  expect(r.status, String(r.stderr)).toBe(0);
  return file;
}

/** 40 clips of odd lengths (some slowed down, one freeze); clip 33 holds the marker. */
function clips(F: number) {
  return Array.from({ length: 40 }, (_, i) => {
    if (i === MARKER_CLIP) return { id: `c${i}`, kind: 'video', mediaId: 'm1', in: (MARKER - 7.5) / F, out: (MARKER + 20.3) / F, speed: 1 };
    if (i === 12) return { id: `c${i}`, kind: 'freeze', mediaId: 'm1', at: 3, duration: 0.437 };
    const a = i * 25 + 0.5;
    return { id: `c${i}`, kind: 'video', mediaId: 'm1', in: a / F, out: (a + 12.3 + (i % 4) * 3.17) / F, speed: i % 7 === 3 ? 0.5 : 1 };
  });
}

const duration = (c: ReturnType<typeof clips>[number]) => (c.kind === 'freeze' ? c.duration! : (c.out! - c.in!) / c.speed!);

/** Per frame: is the left of the picture white (video marker), is the right red (overlay)? */
function frames(file: string): { white: boolean; red: boolean }[] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=16:9:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const px = (f: number, x: number, y: number) => r.stdout.subarray(f * 432 + (y * 16 + x) * 3, f * 432 + (y * 16 + x) * 3 + 3);
  return Array.from({ length: r.stdout.length / 432 }, (_, f) => {
    const [lr, lg, lb] = px(f, 2, 4);
    const [rr, rg, rb] = px(f, 13, 4);
    return { white: lr > 200 && lg > 200 && lb > 200, red: rr > 180 && rg < 90 && rb < 90 };
  });
}

function streams(file: string): { video: number; audio: number; frames: number } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,duration,nb_read_frames', '-of', 'json', file], {
    encoding: 'utf8',
  });
  const s = JSON.parse(r.stdout).streams as { codec_type: string; duration: string; nb_read_frames?: string }[];
  const v = s.find((x) => x.codec_type === 'video')!;
  return { video: Number(v.duration), audio: Number(s.find((x) => x.codec_type === 'audio')!.duration), frames: Number(v.nb_read_frames) };
}

describe.skipIf(!ffmpeg)('export timing on the frame grid', () => {
  for (const [label, rate, F] of [
    ['59.94', '60000/1001', 60000 / 1001],
    ['29.97', '30000/1001', 30000 / 1001],
  ] as const) {
    it(`${label} fps: frame count, marker frame, overlay frame and sound length`, { timeout: 180_000 }, async () => {
      const file = source(rate);
      const media = { m1: probeMedia('m1', file) };
      const cs = clips(F);
      const starts: number[] = [];
      let total = 0;
      for (const c of cs) {
        starts.push(total);
        total += duration(c);
      }
      // Where the marker must land: clip 33 starts at frame round(start·fps), and its 8th frame
      // (source frames 1093…) is the white one.
      const markerFrame = Math.round(starts[MARKER_CLIP] * F) + (MARKER - Math.ceil(MARKER - 7.5));
      const markerTime = starts[MARKER_CLIP] + (MARKER - Math.ceil(MARKER - 7.5)) / F;
      const doc = {
        schemaVersion: 1,
        media: { m1: { id: 'm1', kind: 'video', name: 'src', width: SIZE.w, height: SIZE.h, fps: F, duration: media.m1.duration, hdr: false, hasAudio: true } },
        clips: cs,
        layers: [
          {
            id: 'mark',
            type: 'shape',
            start: markerTime - 0.25 / F,
            end: markerTime + 0.3,
            keyframes: [{ t: 0, x: 0.8, y: 0.5 }],
            animIn: { preset: 'none', duration: 0 },
            animOut: { preset: 'none', duration: 0 },
            props: { shape: 'rect', w: 0.3, h: 0.6, fill: '#ff0000', stroke: null, radius: 0 },
          },
        ],
      };

      const out = join(dir, `out-${label}.mp4`);
      const res = await runExport({ document: doc, settings: { preset: 'original', fps: 'source', hdr: 'keep' }, media, output: out });
      expect(res.frames).toBe(Math.round(total * F));
      const s = streams(out);
      expect(s.frames).toBe(Math.round(total * F));
      expect(Math.abs(s.audio - s.video)).toBeLessThan(0.03);
      const fr = frames(out);
      expect(fr.length).toBe(Math.round(total * F));
      expect(fr.flatMap((f, i) => (f.white ? [i] : []))).toEqual([markerFrame]);
      expect(fr.findIndex((f) => f.red)).toBe(markerFrame);
      // Only the frames that draw something are piped.
      expect(res.overlayFrames).toBeLessThan(0.3 * F + 3);

      // A range cut out of the middle starts on the grid too.
      const range = { start: starts[20] + 0.123, end: starts[36] + 0.05 };
      const outR = join(dir, `range-${label}.mp4`);
      const r2 = await runExport({ document: doc, settings: { preset: 'original', fps: 'source', hdr: 'keep', range }, media, output: outR });
      const want = Math.round(range.end * F) - Math.round(range.start * F);
      expect(r2.frames).toBe(want);
      const s2 = streams(outR);
      expect(s2.frames).toBe(want);
      expect(Math.abs(s2.audio - s2.video)).toBeLessThan(0.03);
      const fr2 = frames(outR);
      expect(fr2.flatMap((f, i) => (f.white ? [i] : []))).toEqual([markerFrame - Math.round(range.start * F)]);
      expect(fr2.findIndex((f) => f.red)).toBe(markerFrame - Math.round(range.start * F));
      // Nothing but the finished files is left next to them.
      expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
    });
  }

  it('leaves no file behind when the export is cancelled', { timeout: 60_000 }, async () => {
    const file = source('60000/1001');
    const media = { m1: probeMedia('m1', file) };
    const doc = {
      schemaVersion: 1,
      media: { m1: { id: 'm1', kind: 'video', name: 'src', width: SIZE.w, height: SIZE.h, fps: 59.94, duration: 20, hdr: false, hasAudio: true } },
      clips: clips(60000 / 1001),
    };
    const out = join(dir, 'cancelled.mp4');
    let calls = 0;
    await expect(
      runExport({ document: doc, settings: { preset: 'original' }, media, output: out, onProgress: (_p, msg) => !(msg === 'Exporting' && ++calls > 3) }),
    ).rejects.toThrow('Canceled by the user');
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.startsWith('.') || f.startsWith('cancelled'))).toEqual([]);
  });
});
