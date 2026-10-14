/**
 * Text as vector outlines (opentype.js), so glyphs rasterise identically everywhere.
 * Fonts are static, Latin-subset instances in assets/fonts/static (SIL OFL 1.1).
 */
import * as ot from 'opentype.js';
import type { FontId } from '@golf/schema';
import { Path, type Mat } from './vector';

// ESM bundlers expose the functions directly, Node's CJS interop under `default`.
// The key is computed so bundlers don't warn about a missing static default export.
const CJS_DEFAULT = ['de', 'fault'].join('');
const opentype = ((ot as unknown as { parse?: unknown }).parse ? ot : (ot as unknown as Record<string, typeof ot>)[CJS_DEFAULT]) as typeof ot;

export const STATIC_FONTS: Record<FontId, Record<number, string>> = {
  inter: { 400: 'Inter-400.ttf', 500: 'Inter-500.ttf', 600: 'Inter-600.ttf', 700: 'Inter-700.ttf', 800: 'Inter-800.ttf', 900: 'Inter-900.ttf' },
  oswald: { 400: 'Oswald-400.ttf', 500: 'Oswald-500.ttf', 600: 'Oswald-600.ttf', 700: 'Oswald-700.ttf' },
  bebas: { 400: 'BebasNeue-400.ttf' },
  barlow: { 500: 'BarlowCondensed-500.ttf', 600: 'BarlowCondensed-600.ttf', 700: 'BarlowCondensed-700.ttf' },
  playfair: { 400: 'SerifDisplay-400.ttf', 600: 'SerifDisplay-600.ttf', 700: 'SerifDisplay-700.ttf', 800: 'SerifDisplay-800.ttf' },
};

export function allFontFiles(): string[] {
  return Object.values(STATIC_FONTS).flatMap((w) => Object.values(w));
}

interface Glyph {
  index: number;
  advance: number;
  cmds: opentype.PathCommand[];
}

class LoadedFont {
  readonly upm: number;
  readonly ascender: number;
  readonly descender: number;
  private glyphs = new Map<string, Glyph[]>();
  private kern = new Map<string, number>();
  constructor(readonly font: opentype.Font) {
    this.upm = font.unitsPerEm;
    this.ascender = font.ascender;
    this.descender = font.descender;
  }

  layout(text: string): Glyph[] {
    let g = this.glyphs.get(text);
    if (!g) {
      g = this.font.stringToGlyphs(text).map((gl) => ({ index: gl.index ?? 0, advance: gl.advanceWidth ?? 0, cmds: gl.path?.commands ?? [] }));
      if (this.glyphs.size > 2000) this.glyphs.clear();
      this.glyphs.set(text, g);
    }
    return g;
  }

  kerning(a: number, b: number): number {
    const key = `${a}:${b}`;
    let v = this.kern.get(key);
    if (v === undefined) {
      v = this.font.getKerningValue(a, b) || 0;
      this.kern.set(key, v);
    }
    return v;
  }
}

export class FontBook {
  private fonts = new Map<string, LoadedFont>();

  add(id: FontId, weight: number, data: ArrayBuffer): void {
    this.fonts.set(`${id}-${weight}`, new LoadedFont(opentype.parse(data)));
  }

  has(id: FontId, weight: number): boolean {
    return this.fonts.has(`${id}-${weight}`);
  }

  get size(): number {
    return this.fonts.size;
  }

  /** The loaded weight nearest to the wanted one. */
  get(id: FontId, weight: number): LoadedFont {
    const ws = Object.keys(STATIC_FONTS[id]).map(Number);
    const sorted = ws.sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a);
    for (const w of sorted) {
      const f = this.fonts.get(`${id}-${w}`);
      if (f) return f;
    }
    const any = this.fonts.get('inter-400') ?? this.fonts.values().next().value;
    if (!any) throw new Error('No fonts loaded');
    return any;
  }

  /** Loads every static font through `read` (fetch in the browser, fs in Node). */
  async loadAll(read: (file: string) => Promise<ArrayBuffer>): Promise<void> {
    await Promise.all(
      (Object.entries(STATIC_FONTS) as [FontId, Record<number, string>][]).flatMap(([id, ws]) =>
        Object.entries(ws).map(async ([w, file]) => {
          if (!this.has(id, Number(w))) this.add(id, Number(w), await read(file));
        }),
      ),
    );
  }
}

/** Process-wide font book used by the renderer. */
export const fonts = new FontBook();

export interface TextStyle {
  font: FontId;
  weight: number;
  size: number;
  letterSpacing?: number;
}

export function measureText(text: string, st: TextStyle, book: FontBook = fonts): number {
  const f = book.get(st.font, st.weight);
  const s = st.size / f.upm;
  const gl = f.layout(text);
  let w = 0;
  for (let i = 0; i < gl.length; i++) {
    w += gl[i].advance * s;
    if (i < gl.length - 1) w += f.kerning(gl[i].index, gl[i + 1].index) * s + (st.letterSpacing ?? 0);
  }
  return w;
}

export function fontMetrics(st: TextStyle, book: FontBook = fonts): { ascent: number; descent: number } {
  const f = book.get(st.font, st.weight);
  return { ascent: (f.ascender / f.upm) * st.size, descent: (-f.descender / f.upm) * st.size };
}

/** Outline of `text` with its baseline starting at (x, y), in the coordinate frame `m`. */
export function textPath(text: string, x: number, y: number, st: TextStyle, m: Mat, book: FontBook = fonts, into?: Path): Path {
  const f = book.get(st.font, st.weight);
  const s = st.size / f.upm;
  const path = into ?? new Path(m);
  const gl = f.layout(text);
  let pen = x;
  for (let i = 0; i < gl.length; i++) {
    const g = gl[i];
    for (const c of g.cmds) {
      switch (c.type) {
        case 'M':
          path.moveTo(pen + c.x * s, y - c.y * s);
          break;
        case 'L':
          path.lineTo(pen + c.x * s, y - c.y * s);
          break;
        case 'Q':
          path.quadTo(pen + c.x1 * s, y - c.y1 * s, pen + c.x * s, y - c.y * s);
          break;
        case 'C':
          path.cubicTo(pen + c.x1 * s, y - c.y1 * s, pen + c.x2 * s, y - c.y2 * s, pen + c.x * s, y - c.y * s);
          break;
        case 'Z':
          path.close();
          break;
      }
    }
    pen += g.advance * s;
    if (i < gl.length - 1) pen += f.kerning(g.index, gl[i + 1].index) * s + (st.letterSpacing ?? 0);
  }
  return path;
}
