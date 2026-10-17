/** Real ffmpeg: HDR is kept only when every clip is HDR; a mix of HDR and SDR comes out as proper SDR. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMedia } from '../src/cli';
import { runExport } from '../src/run';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ogt-hdr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(name: string, hdr: boolean): string {
  const file = join(dir, name);
  const codec = hdr
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  const tags = hdr
    ? ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']
    : ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-t', '1', ...codec, ...tags, file]);
  expect(r.status, String(r.stderr)).toBe(0);
  return file;
}

function videoStream(file: string): { codec_name: string; color_transfer?: string; color_primaries?: string } {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,color_transfer,color_primaries', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(r.stdout).streams[0];
}

describe.skipIf(!ffmpeg)('HDR and SDR clips', () => {
  const ref = (id: string, hdr: boolean) => ({ id, kind: 'video', name: id, width: 320, height: 180, fps: 30, duration: 1, hdr, hasAudio: false });

  it('exports a mix as SDR (HDR clips tone-mapped), and all-HDR as HDR', { timeout: 120_000 }, async () => {
    const media = { h: probeMedia('h', make('hlg.mp4', true)), s: probeMedia('s', make('sdr.mp4', false)) };
    expect(media.h.hdr).toBe(true);
    const mixed = {
      schemaVersion: 1,
      media: { h: ref('h', true), s: ref('s', false) },
      clips: [
        { id: 'a', kind: 'video', mediaId: 'h', in: 0, out: 0.5, speed: 1 },
        { id: 'b', kind: 'video', mediaId: 's', in: 0, out: 0.5, speed: 1 },
      ],
    };
    const out = join(dir, 'mixed.mp4');
    const res = await runExport({ document: mixed, settings: { preset: 'original', hdr: 'keep' }, media, output: out });
    expect(res.mixedHdr).toBe(true);
    expect(videoStream(out)).toMatchObject({ codec_name: 'h264', color_transfer: 'bt709', color_primaries: 'bt709' });

    const allHdr = { ...mixed, clips: [mixed.clips[0], { ...mixed.clips[0], id: 'c', in: 0.5, out: 1 }] };
    const out2 = join(dir, 'hdr.mp4');
    const res2 = await runExport({ document: allHdr, settings: { preset: 'original', hdr: 'keep' }, media, output: out2 });
    expect(res2.mixedHdr).toBe(false);
    expect(videoStream(out2)).toMatchObject({ codec_name: 'hevc', color_transfer: 'arib-std-b67', color_primaries: 'bt2020' });
  });
});
