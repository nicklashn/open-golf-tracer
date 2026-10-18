/**
 * One export: find where the overlay draws, render each clip's segment with ffmpeg on the
 * originals while streaming the overlay frames rendered by packages/render (the same code as
 * the browser preview), mix the sound, and join it all into the finished file. The file only
 * appears under its name when it is complete; a failed or cancelled export leaves nothing.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Surface, frameBounds, renderOverlay, type ImageData8, type OverlayContext, type Rect } from '@golf/render';
import { ExportSettings, migrateProject, type Project } from '@golf/schema';
import { loadFonts, loadImages } from './canvas';
import { encoders } from './ffmpeg';
import { audioArgs, buildPlan, concatList, frameTime, muxArgs, segmentArgs, type Box, type MediaFile, type Plan, type SegmentOverlay } from './plan';

export interface ExportJob {
  document: unknown;
  settings: unknown;
  /** Optional resolution cap (short side, px) for benchmarks and previews; default: none. */
  maxShortSide?: number;
  media: Record<string, MediaFile>;
  output: string;
  locale?: 'da' | 'en';
  /**
   * Called with progress 0..1 and a stable English message (the web translates it, see
   * apps/web/src/lib/jobMessage.ts); return false to cancel.
   */
  onProgress?: (p: number, message: string) => Promise<boolean> | boolean;
}

export interface ExportResult {
  width: number;
  height: number;
  duration: number;
  frames: number;
  /** Union of the segments' overlay boxes (null = nothing drawn). */
  overlay: Rect | null;
  /** Overlay frames piped to ffmpeg (frames that draw nothing are not sent). */
  overlayFrames: number;
  /** HDR was asked for but the clips mix HDR and SDR, so the export is SDR. */
  mixedHdr: boolean;
  seconds: number;
}

export class Canceled extends Error {
  constructor() {
    super('Canceled by the user');
  }
}

/** More separate runs than this in one segment are joined (the gaps are sent as blank frames). */
const MAX_RUNS = 12;

function overlayContext(project: Project, plan: Pick<Plan, 'width' | 'height'>, images: Map<string, ImageData8>, job: ExportJob): OverlayContext {
  return { project, width: plan.width, height: plan.height, locale: job.locale ?? 'en', images };
}

function union(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Even offsets and sizes for chroma-subsampled video. */
function evenBox(box: Box, W: number, H: number): Box {
  const x = box.x & ~1;
  const y = box.y & ~1;
  return { x, y, w: Math.min(W - x, (box.w + (box.x - x) + 1) & ~1), h: Math.min(H - y, (box.h + (box.y - y) + 1) & ~1) };
}

/** Runs of drawn frames from per-frame flags; the closest runs are joined down to MAX_RUNS. */
export function drawnRuns(empty: readonly boolean[], maxRuns = MAX_RUNS): [number, number][] {
  const runs: [number, number][] = [];
  for (let j = 0; j < empty.length; j++) {
    if (empty[j]) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === j) last[1] = j + 1;
    else runs.push([j, j + 1]);
  }
  while (runs.length > maxRuns) {
    let best = 1;
    for (let r = 2; r < runs.length; r++) if (runs[r][0] - runs[r - 1][1] < runs[best][0] - runs[best - 1][1]) best = r;
    runs[best - 1][1] = runs[best][1];
    runs.splice(best, 1);
  }
  return runs;
}

/** Runs ffmpeg; `feed` writes its stdin (the overlay). Kills it when the export stops. */
async function ffmpeg(args: string[], feed?: (stdin: NodeJS.WritableStream, alive: () => boolean) => Promise<void>): Promise<void> {
  const ff = spawn('ffmpeg', args, { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr!.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-6000);
  });
  const exited = once(ff, 'close');
  try {
    if (feed) {
      ff.stdin!.on('error', () => undefined); // ffmpeg may close early on error; reported below
      await feed(ff.stdin!, () => ff.exitCode === null);
      ff.stdin!.end();
    }
    const [code] = (await exited) as [number | null];
    // Short enough that the API keeps the "ffmpeg failed" the web recognises (it stores the end).
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-6).join('\n').slice(-200)}`);
  } catch (e) {
    ff.kill('SIGKILL');
    throw e;
  }
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
  const plan = buildPlan({ project, settings, media: job.media, maxShortSide: job.maxShortSide, encoders: encoders() });
  const oc = overlayContext(project, plan, images, job);
  const report = async (p: number, message: string) => {
    if (job.onProgress && !(await job.onProgress(p, message))) throw new Canceled();
  };

  // Pass 1: geometry only – per segment, the box around everything drawn and the frames that draw.
  const empty: boolean[] = [];
  const overlays: (SegmentOverlay | null)[] = [];
  let all: Box | null = null;
  for (const seg of plan.segments) {
    let box: Box | null = null;
    const flags: boolean[] = [];
    for (let j = 0; j < seg.frames; j++) {
      const k = seg.start + j;
      const r = frameBounds(oc, frameTime(plan, k));
      flags.push(!r);
      if (r) box = union(box, r);
      if (k % 30 === 0) await report(0.03 * (k / plan.frames), 'Preparing graphics');
    }
    empty.push(...flags);
    if (box) {
      const b = evenBox(box, plan.width, plan.height);
      overlays.push({ box: b, runs: drawnRuns(flags) });
      all = union(all, b);
    } else overlays.push(null);
  }

  const dir = dirname(job.output);
  const work = join(dir, `.${basename(job.output)}.work`);
  const partial = join(dir, `.${basename(job.output)}.partial`);
  let piped = 0;
  try {
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const files: string[] = [];
    const surface = new Surface(plan.width, plan.height);
    let lastReport = 0;
    for (const [n, seg] of plan.segments.entries()) {
      const ov = overlays[n];
      const file = join(work, `seg-${String(n).padStart(4, '0')}.mp4`);
      files.push(file);
      await ffmpeg(
        segmentArgs(plan, seg, ov, file),
        ov
          ? async (stdin, alive) => {
              const { box } = ov;
              const blank = Buffer.alloc(box.w * box.h * 4);
              const frame = new Uint8ClampedArray(box.w * box.h * 4);
              for (const [a, b] of ov.runs) {
                for (let j = a; j < b; j++) {
                  const k = seg.start + j;
                  let buf: Buffer = blank;
                  if (!empty[k]) {
                    surface.clear();
                    renderOverlay(surface, oc, frameTime(plan, k));
                    surface.toRGBA(box, frame);
                    // Copy: the stream may still hold the previous chunk when we render the next frame.
                    buf = Buffer.from(frame);
                  }
                  piped++;
                  if (!stdin.write(buf)) await once(stdin, 'drain');
                  const now = performance.now();
                  if (now - lastReport > 500) {
                    lastReport = now;
                    await report(0.03 + 0.92 * (k / plan.frames), 'Exporting');
                  }
                  if (!alive()) return;
                }
              }
            }
          : undefined,
      );
      await report(0.03 + 0.92 * ((seg.start + seg.frames) / plan.frames), 'Exporting');
    }
    await report(0.95, 'Mixing the sound');
    const audio = join(work, 'audio.m4a');
    await ffmpeg(audioArgs(plan, audio));
    await report(0.98, 'Finishing the video');
    const list = join(work, 'segments.txt');
    await writeFile(list, concatList(files));
    await ffmpeg(muxArgs(plan, list, audio, partial));
    await rename(partial, job.output);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return {
    width: plan.width,
    height: plan.height,
    duration: plan.duration,
    frames: plan.frames,
    overlay: all,
    overlayFrames: piped,
    mixedHdr: plan.mixedHdr,
    seconds: (performance.now() - started) / 1000,
  };
}
