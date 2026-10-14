/** Node environment for packages/render: fonts from assets/fonts/static, image decoding. */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fonts, type ImageData8 } from '@golf/render';

const here = dirname(fileURLToPath(import.meta.url));
export const FONT_DIR = resolve(here, '../../../assets/fonts/static');

export async function loadFonts(dir = FONT_DIR): Promise<void> {
  await fonts.loadAll(async (file) => {
    const b = await readFile(resolve(dir, file));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
}

/** Decodes images (logos) to straight-alpha RGBA, capped to a sensible size. */
export async function loadImages(paths: Map<string, string>, maxSide = 2048): Promise<Map<string, ImageData8>> {
  const out = new Map<string, ImageData8>();
  for (const [id, p] of paths) {
    try {
      const img = await loadImage(p);
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k));
      const h = Math.max(1, Math.round(img.height * k));
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      out.set(id, { width: w, height: h, data: new Uint8ClampedArray(d.data) });
    } catch {
      // A broken logo must not fail the export; the layer is drawn as a placeholder.
    }
  }
  return out;
}
