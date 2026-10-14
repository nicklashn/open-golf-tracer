/**
 * Offline export without the API (benchmarks, debugging):
 *   tsx src/cli.ts project.json --media <id>=<file> [...] --out out.mp4 [--preset shorts] [--max 2160]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runExport } from './run';
import type { MediaFile } from './plan';

export function probeMedia(id: string, path: string): MediaFile {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout || '{}');
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'audio');
  const [n, d] = String(v?.avg_frame_rate ?? '30/1')
    .split('/')
    .map(Number);
  const trc = v?.color_transfer ?? '';
  return {
    id,
    path,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: d ? n / d : 30,
    duration: Number(j.format?.duration ?? 0),
    hdr: trc === 'arib-std-b67' || trc === 'smpte2084',
    hasAudio: !!a,
    color: v
      ? (Object.fromEntries(
          Object.entries({ color_primaries: v.color_primaries, color_trc: v.color_transfer, colorspace: v.color_space }).filter(
            ([, x]) => x && x !== 'unknown',
          ),
        ) as Record<string, string>)
      : undefined,
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      media: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: 'out.mp4' },
      preset: { type: 'string', default: 'original' },
      fps: { type: 'string', default: 'source' },
      hdr: { type: 'string', default: 'keep' },
      max: { type: 'string', default: '2160' },
    },
  });
  const doc = JSON.parse(readFileSync(positionals[0], 'utf8'));
  const media: Record<string, MediaFile> = {};
  for (const m of values.media ?? []) {
    const [id, path] = m.split('=');
    media[id] = probeMedia(id, path);
  }
  const res = await runExport({
    document: doc,
    settings: { preset: values.preset, fps: values.fps === 'source' ? 'source' : Number(values.fps), hdr: values.hdr },
    maxShortSide: Number(values.max),
    media,
    output: values.out!,
    onProgress: (p, msg) => {
      process.stderr.write(`\r${msg} ${(p * 100).toFixed(0)}%   `);
      return true;
    },
  });
  process.stderr.write('\n');
  console.log(JSON.stringify(res));
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
