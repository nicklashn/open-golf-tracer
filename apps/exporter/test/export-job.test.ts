/**
 * The export job as the worker runs it: the user's language from the job payload reaches the
 * renderer (stat cards and hole cards are drawn in it), and the file is reported back.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Surface, renderOverlay } from '@golf/render';
import { migrateProject } from '@golf/schema';
import { loadFonts } from '../src/canvas';
import { handleExport, type ExportApi } from '../src/export-job';
import type { ExportJob, ExportResult } from '../src/run';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ogt-job-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const W = 640;
const H = 360;

const doc = {
  schemaVersion: 1,
  media: { m1: { id: 'm1', kind: 'video', name: 'src', width: W, height: H, fps: 30, duration: 2, hdr: false, hasAudio: false } },
  clips: [{ id: 'c', kind: 'video', mediaId: 'm1', in: 0, out: 1, speed: 1 }],
  layers: [
    {
      id: 'hole',
      type: 'holeInfo',
      start: 0,
      end: 1,
      keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 3 }],
      animIn: { preset: 'none', duration: 0 },
      animOut: { preset: 'none', duration: 0 },
      props: { hole: 7, par: 4, length: 365, club: 'Driver' },
    },
  ],
};

function fakeApi(path: string, calls: string[]): ExportApi {
  return {
    media: async (id: string) => ({
      id,
      kind: 'video',
      path: join(dir, 'black.mp4'),
      probe: { width: W, height: H, fps: 30, duration: 2, hdr: false, hasAudio: false },
      derived: {},
    }),
    exportStart: async () => ({ path }),
    exportDone: async () => (calls.push('done'), {}),
    complete: async () => (calls.push('complete'), {}),
    progress: async (_id: string, _p: number | null, message?: string) => (calls.push(`progress:${message}`), { continue: true }),
  } as unknown as ExportApi;
}

describe('export job', () => {
  it('passes the language of the request to the renderer (English for old jobs)', async () => {
    const seen: (string | undefined)[] = [];
    const run = async (j: ExportJob): Promise<ExportResult> => {
      seen.push(j.locale);
      return { width: W, height: H, duration: 1, frames: 30, overlay: null, overlayFrames: 0, mixedHdr: false, seconds: 0 };
    };
    for (const locale of ['da', 'en', undefined]) {
      await handleExport(fakeApi('/x.mp4', []), { id: 'j', payload: { export_id: 'e', document: doc, settings: {}, locale } }, run);
    }
    expect(seen).toEqual(['da', 'en', 'en']);
  });

  it.skipIf(!ffmpeg)('draws the graphics in Danish when the user asked in Danish', { timeout: 60_000 }, async () => {
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30`, '-t', '2', '-pix_fmt', 'yuv420p', join(dir, 'black.mp4')]);
    const out = join(dir, 'da.mp4');
    const calls: string[] = [];
    await handleExport(fakeApi(out, calls), { id: 'j', payload: { export_id: 'e', document: doc, settings: { preset: 'original' }, locale: 'da' } });
    expect(statSync(out).size).toBeGreaterThan(0);
    expect(calls.slice(-2)).toEqual(['done', 'complete']);
    // Progress goes out as stable English keys; the web puts them in the user's language.
    expect(new Set(calls.filter((c) => c.startsWith('progress:')))).toEqual(
      new Set(['progress:Preparing graphics', 'progress:Exporting', 'progress:Mixing the sound', 'progress:Finishing the video']),
    );

    // Compare frame 15 of the file with the overlay drawn in each language over black.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'select=eq(n\\,15),format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], {
      maxBuffer: 1 << 26,
    });
    const got = r.stdout;
    await loadFonts();
    const project = migrateProject(doc);
    const err = (locale: 'da' | 'en') => {
      const s = new Surface(W, H);
      renderOverlay(s, { project, width: W, height: H, locale, images: new Map() }, 0.5);
      const px = s.toRGBA({ x: 0, y: 0, w: W, h: H })!.data;
      let e = 0;
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) e += Math.abs(got[i * 3 + c] - (px[i * 4 + c] * px[i * 4 + 3]) / 255);
      return e;
    };
    expect(err('da')).toBeLessThan(err('en') * 0.9);
  });
});
