import type { FontId } from '@golf/schema';
import { STATIC_FONTS } from './text';

/** Curated fonts with licences that allow commercial use (all SIL OFL 1.1, files in assets/fonts). */
export const FONTS: Record<FontId, { family: string; label: string; weights: number[] }> = {
  inter: { family: 'GT Inter', label: 'Inter', weights: [400, 500, 600, 700, 800, 900] },
  oswald: { family: 'GT Oswald', label: 'Oswald', weights: [400, 500, 600, 700] },
  bebas: { family: 'GT Bebas Neue', label: 'Bebas Neue', weights: [400] },
  barlow: { family: 'GT Barlow Condensed', label: 'Barlow Condensed', weights: [500, 600, 700] },
  playfair: { family: 'GT Serif Display', label: 'Serif Display', weights: [400, 600, 700, 800] },
};

/** Nearest weight the font actually has. */
export function fontWeight(id: FontId, wanted: number): number {
  const ws = FONTS[id].weights;
  return ws.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), ws[0]);
}

/** @font-face rules so the editor UI can show font names in their own typeface. */
export function fontFaceCss(base = '/fonts'): string {
  return (Object.keys(STATIC_FONTS) as FontId[])
    .flatMap((id) =>
      Object.entries(STATIC_FONTS[id]).map(
        ([w, file]) => `@font-face{font-family:"${FONTS[id].family}";src:url("${base}/${file}") format("truetype");font-weight:${w};font-display:swap;}`,
      ),
    )
    .join('\n');
}
