/**
 * Still frames for the AI's look at the green (see packages/compose vision.ts): JPEGs straight
 * from ffmpeg's stdout into memory – never written to disk.
 */
import { spawn } from 'node:child_process';
import { encoders } from './ffmpeg';

export interface FrameOptions {
  /** Longest side in pixels. */
  maxSide?: number;
  /** ffmpeg's JPEG quality scale (2 best … 31 worst); 5 is about quality 70. */
  q?: number;
  hdr?: boolean;
  timeoutMs?: number;
  /** Only this region of the frame (pixels of the file), scaled up to `maxSide` at most. */
  crop?: { x: number; y: number; w: number; h: number } | null;
}

function grab(path: string, t: number, vf: string, q: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-ss',
      t.toFixed(3),
      '-i',
      path,
      '-frames:v',
      '1',
      '-an',
      '-vf',
      vf,
      '-c:v',
      'mjpeg',
      '-q:v',
      String(q),
      '-f',
      'image2pipe',
      'pipe:1',
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg could not read a frame at ${t.toFixed(1)} s: ${err.trim().slice(0, 200)}`));
    });
  });
}

/** One base64 JPEG per time that has a picture (times past the end are skipped). */
export async function grabFrames(path: string, times: number[], opts: FrameOptions = {}): Promise<string[]> {
  const side = opts.maxSide ?? 768;
  const c = opts.crop;
  const crop = c ? `crop=${Math.round(c.w)}:${Math.round(c.h)}:${Math.round(c.x)}:${Math.round(c.y)},` : '';
  const scale = `${crop}scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`;
  const vf = opts.hdr ? `${encoders().tonemap},${scale},format=yuvj420p` : `${scale},format=yuvj420p`;
  const frames: string[] = [];
  for (const t of times) {
    const jpeg = await grab(path, Math.max(0, t), vf, opts.q ?? 5, opts.timeoutMs ?? 20_000);
    if (jpeg.length) frames.push(jpeg.toString('base64'));
  }
  return frames;
}
