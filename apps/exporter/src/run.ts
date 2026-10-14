/**
 * One export: compute the overlay box, start ffmpeg on the originals and stream overlay
 * frames rendered by packages/render (the same code as the browser preview).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Surface, frameBounds, renderOverlay, type ImageData8, type OverlayContext, type Rect } from '@golf/render';
import { ExportSettings, migrateProject, type Project } from '@golf/schema';
import { loadFonts, loadImages } from './canvas';
import { encoders } from './ffmpeg';
import { buildPlan, frameTime, type MediaFile, type Plan } from './plan';

export interface ExportJob {
  document: unknown;
  settings: unknown;
  /** Optional resolution cap (short side, px) for benchmarks and previews; default: none. */
  maxShortSide?: number;
  media: Record<string, MediaFile>;
  output: string;
  locale?: 'da' | 'en';
  /** Called with progress 0..1; return false to cancel. */
  onProgress?: (p: number, message: string) => Promise<boolean> | boolean;
}

export interface ExportResult {
  width: number;
  height: number;
  duration: number;
  frames: number;
  overlay: Rect | null;
  seconds: number;
}

export class Canceled extends Error {}

function overlayContext(project: Project, plan: Pick<Plan, 'width' | 'height'>, images: Map<string, ImageData8>, job: ExportJob): OverlayContext {
  return { project, width: plan.width, height: plan.height, locale: job.locale ?? 'en', images };
}

export async function runExport(job: ExportJob): Promise<ExportResult> {
  const started = performance.now();
  await loadFonts();
  let project = migrateProject(job.document);
  const settings = ExportSettings.parse(job.settings ?? {});
  if (settings.preset === 'shorts' && project.format.aspect !== '9:16') {
    project = { ...project, format: { ...project.format, aspect: '9:16' } };
  }
  const images = await loadImages(
    new Map(
      project.layers.flatMap((l) =>
        l.type === 'image' && job.media[l.props.mediaId] ? [[l.props.mediaId, job.media[l.props.mediaId].path] as [string, string]] : [],
      ),
    ),
  );
  const enc = encoders();
  // Pass 1: geometry only – the union of everything drawn over the whole export.
  const probe = buildPlan({ project, settings, media: job.media, maxShortSide: job.maxShortSide, encoders: enc, output: job.output, overlay: null });
  const oc = overlayContext(project, probe, images, job);
  let box: Rect | null = null;
  const empty: boolean[] = [];
  for (let k = 0; k < probe.frames; k++) {
    const r = frameBounds(oc, frameTime(probe, k));
    empty.push(!r);
    if (r) {
      if (!box) box = { ...r };
      else {
        const x = Math.min(box.x, r.x);
        const y = Math.min(box.y, r.y);
        box = { x, y, w: Math.max(box.x + box.w, r.x + r.w) - x, h: Math.max(box.y + box.h, r.y + r.h) - y };
      }
    }
    if (k % 30 === 0 && job.onProgress && !(await job.onProgress(0.03 * (k / probe.frames), 'Forbereder grafik'))) throw new Canceled();
  }
  if (box) {
    // Even offsets and sizes for chroma-subsampled video.
    const x = box.x & ~1;
    const y = box.y & ~1;
    box = { x, y, w: Math.min(probe.width - x, (box.w + (box.x - x) + 1) & ~1), h: Math.min(probe.height - y, (box.h + (box.y - y) + 1) & ~1) };
  }
  const plan = buildPlan({ project, settings, media: job.media, maxShortSide: job.maxShortSide, encoders: enc, output: job.output, overlay: box });

  const ff = spawn('ffmpeg', plan.args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-6000);
  });
  const exited = once(ff, 'close');
  ff.stdin.on('error', () => undefined); // ffmpeg may close early on error; reported below

  try {
    if (box) {
      const surface = new Surface(plan.width, plan.height);
      const blank = Buffer.alloc(box.w * box.h * 4);
      const frame = new Uint8ClampedArray(box.w * box.h * 4);
      let lastReport = 0;
      for (let k = 0; k < plan.frames; k++) {
        let buf: Buffer = blank;
        if (!empty[k]) {
          surface.clear();
          renderOverlay(surface, oc, frameTime(plan, k));
          surface.toRGBA(box, frame);
          // Copy: the stream may still hold the previous chunk when we render the next frame.
          buf = Buffer.from(frame);
        }
        if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
        const now = performance.now();
        if (job.onProgress && now - lastReport > 500) {
          lastReport = now;
          if (!(await job.onProgress(0.03 + 0.95 * (k / plan.frames), 'Eksporterer'))) throw new Canceled();
        }
        if (ff.exitCode !== null) break;
      }
    }
    ff.stdin.end();
    const [code] = (await exited) as [number | null];
    if (code !== 0) throw new Error(`ffmpeg fejlede (${code}): ${stderr.trim().split('\n').slice(-6).join('\n')}`);
  } catch (e) {
    ff.kill('SIGKILL');
    throw e;
  }
  return { width: plan.width, height: plan.height, duration: plan.duration, frames: plan.frames, overlay: box, seconds: (performance.now() - started) / 1000 };
}
