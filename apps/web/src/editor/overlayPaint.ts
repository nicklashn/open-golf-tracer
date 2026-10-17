/**
 * Draws preview overlay frames (tracers + graphics) with packages/render into a 2D context –
 * on the main thread or inside overlay.worker.ts.
 */
import { Surface, fonts, renderOverlay, type ImageData8, type OverlayContext } from '@golf/render';
import type { Project } from '@golf/schema';

export interface OverlayFrame {
  doc: Project;
  t: number;
  hidden: string[];
}

/** Renders frames into a 2D context; used directly or inside the worker. */
export class OverlayPainter {
  private surface: Surface | null = null;
  private lastDirty: { x: number; y: number; w: number; h: number } | null = null;
  readonly images = new Map<string, ImageData8>();

  constructor(
    private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    private locale: 'da' | 'en',
  ) {}

  resize(w: number, h: number): void {
    const c = this.ctx.canvas;
    if (c.width !== w || c.height !== h || !this.surface) {
      c.width = w;
      c.height = h;
      this.surface = new Surface(w, h);
      this.lastDirty = null;
    }
  }

  /** Draws one frame; returns its cost in ms, or null when it could not draw yet (fonts). */
  render(f: OverlayFrame): number | null {
    const surface = this.surface;
    if (!surface || !fonts.size) return null;
    const started = performance.now();
    surface.clear();
    const oc: OverlayContext = {
      project: f.doc,
      width: surface.w,
      height: surface.h,
      locale: this.locale,
      images: this.images,
      hiddenLayerIds: new Set(f.hidden),
    };
    renderOverlay(surface, oc, f.t);
    const d = surface.dirty;
    const ctx = this.ctx;
    if (this.lastDirty) ctx.clearRect(this.lastDirty.x, this.lastDirty.y, this.lastDirty.w, this.lastDirty.h);
    if (d) {
      const out = surface.toRGBA(d)!;
      ctx.putImageData(new ImageData(out.data as unknown as Uint8ClampedArray<ArrayBuffer>, d.w, d.h), d.x, d.y);
    }
    this.lastDirty = d ? { ...d } : null;
    return performance.now() - started;
  }
}
