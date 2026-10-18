/**
 * Real ffmpeg: the export's crop follows the reframe keys' zoom as the preview's cropAt() does,
 * also while the zoom changes between keys (zoompan), on the clip's own frame grid.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cropAt, migrateProject, reframeAt } from '@golf/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMedia } from '../src/cli';
import { runExport } from '../src/run';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ogt-reframe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SRC = { w: 640, h: 360 };
const BOX = 20; // white square in the middle of the source

function source(): string {
  const file = join(dir, 'src.mp4');
  const x = SRC.w / 2 - BOX / 2;
  const y = SRC.h / 2 - BOX / 2;
  const r = spawnSync('ffmpeg', [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${SRC.w}x${SRC.h}:r=30`],
    ...['-vf', `drawbox=x=${x}:y=${y}:w=${BOX}:h=${BOX}:c=white:t=fill`, '-frames:v', '90'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file],
  ]);
  expect(r.status, String(r.stderr)).toBe(0);
  return file;
}

function size(file: string): { w: number; h: number; frames: number } {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', file],
    {
      encoding: 'utf8',
    },
  );
  const s = JSON.parse(r.stdout).streams[0];
  return { w: s.width, h: s.height, frames: Number(s.nb_read_frames) };
}

/** Width of the white run across the middle row, per frame. */
function boxWidths(file: string, w: number, h: number): number[] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const n = r.stdout.length / (w * h);
  return Array.from({ length: n }, (_, f) => {
    const row = r.stdout.subarray(f * w * h + Math.floor(h / 2) * w, f * w * h + Math.floor(h / 2) * w + w);
    return row.filter((v) => v > 128).length;
  });
}

describe.skipIf(!ffmpeg)('export reframe zoom', () => {
  it('zooms like the preview, also while the zoom changes', { timeout: 120_000 }, async () => {
    const file = source();
    const media = { m1: probeMedia('m1', file) };
    const keyframes = [
      { t: 0, cx: 0.5, cy: 0.5, zoom: 1 },
      { t: 2, cx: 0.5, cy: 0.5, zoom: 3 },
    ];
    const doc = {
      schemaVersion: 1,
      format: { aspect: '9:16', fill: 'crop', reframe: { mode: 'manual', keyframes } },
      media: { m1: { id: 'm1', kind: 'video', name: 'src', width: SRC.w, height: SRC.h, fps: 30, duration: media.m1.duration, hdr: false, hasAudio: false } },
      clips: [{ id: 'c', kind: 'video', mediaId: 'm1', in: 0, out: 3, speed: 1 }],
    };
    const project = migrateProject(doc);
    expect(project.format.reframe.keyframes.map((k) => k.zoom)).toEqual([1, 3]);
    const out = join(dir, 'out.mp4');
    const res = await runExport({ document: doc, settings: { preset: 'shorts', fps: 'source', hdr: 'keep' }, media, output: out });
    const s = size(out);
    expect(s.frames).toBe(90);
    expect(res.frames).toBe(90);
    expect(s.h).toBeGreaterThan(s.w);
    const widths = boxWidths(out, s.w, s.h);
    for (const f of [0, 15, 30, 45, 60, 89]) {
      const t = f / 30;
      const want = (BOX / cropAt(project, { width: SRC.w, height: SRC.h }, t).w) * s.w;
      expect(reframeAt(keyframes, t).zoom).toBeGreaterThanOrEqual(1);
      // Within a few output pixels (edge blur of the scaled square, even crop sizes).
      expect(Math.abs(widths[f] - want), `frame ${f}: ${widths[f]} vs ${want.toFixed(1)}`).toBeLessThan(Math.max(4, want * 0.08));
    }
    expect(widths[89]).toBeGreaterThan(2.5 * widths[0]);
  });

  it('applies one zoom for all keys as a plain crop', { timeout: 120_000 }, async () => {
    const file = source();
    const media = { m1: probeMedia('m1', file) };
    const keyframes = [{ t: 0, cx: 0.5, cy: 0.5, zoom: 2 }];
    const doc = {
      schemaVersion: 1,
      format: { aspect: '9:16', fill: 'crop', reframe: { mode: 'manual', keyframes } },
      media: { m1: { id: 'm1', kind: 'video', name: 'src', width: SRC.w, height: SRC.h, fps: 30, duration: media.m1.duration, hdr: false, hasAudio: false } },
      clips: [{ id: 'c', kind: 'video', mediaId: 'm1', in: 0, out: 1, speed: 1 }],
    };
    const out = join(dir, 'fixed.mp4');
    await runExport({ document: doc, settings: { preset: 'shorts', fps: 'source', hdr: 'keep' }, media, output: out });
    const s = size(out);
    const want = (BOX / cropAt(migrateProject(doc), { width: SRC.w, height: SRC.h }, 0).w) * s.w;
    for (const w of boxWidths(out, s.w, s.h)) expect(Math.abs(w - want)).toBeLessThan(Math.max(4, want * 0.08));
  });
});
