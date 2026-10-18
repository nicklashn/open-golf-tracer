/**
 * Drawing the preview overlay (tracers + graphics) with packages/render – the same pixels the
 * export uses. The rasteriser is plain TypeScript and costs a few to tens of milliseconds per
 * frame, so where the browser can (OffscreenCanvas), it runs on a worker and the main thread
 * stays free for the timeline, dragging and the video; otherwise it runs here.
 */
import { fonts, type ImageData8 } from '@golf/render';
import type { Project } from '@golf/schema';
import { OverlayPainter, type OverlayFrame } from './overlayPaint';

export type { OverlayFrame };

/** Where the player sends overlay frames. */
export interface OverlayOutput {
  resize(w: number, h: number): void;
  /** Latest wins: a frame asked for while one is drawing replaces any older pending one. */
  draw(f: OverlayFrame): void;
  setImage(mediaId: string, img: ImageData8): void;
  onDrawn: ((ms: number) => void) | null;
  release(): void;
}

let fontsReady: Promise<void> | null = null;
export function loadRendererFonts(): Promise<void> {
  fontsReady ??= fonts.loadAll(async (file) => (await fetch(`/fonts/${file}`)).arrayBuffer());
  return fontsReady;
}

class MainThreadOutput implements OverlayOutput {
  private painter: OverlayPainter | null;
  private pending: OverlayFrame | null = null;
  onDrawn: ((ms: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, locale: 'da' | 'en') {
    const ctx = canvas.getContext('2d');
    this.painter = ctx ? new OverlayPainter(ctx, locale) : null;
    void loadRendererFonts().then(() => this.pending && this.draw(this.pending));
  }

  resize(w: number, h: number) {
    this.painter?.resize(w, h);
  }

  draw(f: OverlayFrame) {
    const ms = this.painter?.render(f) ?? null;
    this.pending = ms == null ? f : null;
    if (ms != null) this.onDrawn?.(ms);
  }

  setImage(mediaId: string, img: ImageData8) {
    this.painter?.images.set(mediaId, img);
  }

  release() {
    this.onDrawn = null;
  }
}

class WorkerOutput implements OverlayOutput {
  private lastDoc: Project | null = null;
  private lastLive: OverlayFrame['live'] | null = null;
  private seq = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  onDrawn: ((ms: number) => void) | null = null;

  constructor(
    private worker: Worker,
    private canvas: HTMLCanvasElement,
  ) {
    worker.onmessage = (e: MessageEvent<{ type: 'drawn'; ms: number }>) => {
      if (e.data.type === 'drawn') this.onDrawn?.(e.data.ms);
    };
  }

  acquire(locale: 'da' | 'en') {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    // A new player starts from scratch: send the document again, and the language (a new
    // player for the same canvas follows a language switch).
    this.lastDoc = null;
    this.lastLive = null;
    this.worker.postMessage({ type: 'locale', locale });
  }

  resize(w: number, h: number) {
    this.worker.postMessage({ type: 'size', w, h });
  }

  draw(f: OverlayFrame) {
    // The document is copied to the worker only when it changed; a handle drag changes just the
    // live params of one shot, which go on their own (a few numbers per frame).
    if (f.doc !== this.lastDoc) {
      this.worker.postMessage({ type: 'doc', doc: f.doc });
      this.lastDoc = f.doc;
    }
    if ((f.live ?? null) !== this.lastLive) {
      this.worker.postMessage({ type: 'live', live: f.live ?? {} });
      this.lastLive = f.live ?? null;
    }
    this.worker.postMessage({ type: 'frame', t: f.t, hidden: f.hidden, seq: ++this.seq });
  }

  setImage(mediaId: string, img: ImageData8) {
    this.worker.postMessage({ type: 'image', mediaId, img });
  }

  release() {
    this.onDrawn = null;
    // The canvas can only be handed to a worker once; keep the worker while the canvas is on the
    // page (a new player for it follows, e.g. React's strict-mode remount or a language switch).
    this.releaseTimer = setTimeout(() => {
      if (this.canvas.isConnected) return;
      this.worker.terminate();
      outputs.delete(this.canvas);
    }, 2000);
  }
}

const outputs = new WeakMap<HTMLCanvasElement, OverlayOutput>();

/** The overlay output for a canvas: a worker with OffscreenCanvas where supported. */
export function overlayOutput(canvas: HTMLCanvasElement, locale: 'da' | 'en'): OverlayOutput {
  const existing = outputs.get(canvas);
  if (existing instanceof WorkerOutput) {
    existing.acquire(locale);
    return existing;
  }
  let out: OverlayOutput | null = null;
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && 'transferControlToOffscreen' in canvas) {
    try {
      const worker = new Worker(new URL('./overlay.worker.ts', import.meta.url), { type: 'module' });
      const off = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: off, locale }, [off]);
      out = new WorkerOutput(worker, canvas);
    } catch {
      out = null;
    }
  }
  out ??= new MainThreadOutput(canvas, locale);
  outputs.set(canvas, out);
  return out;
}
