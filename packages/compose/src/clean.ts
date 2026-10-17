/**
 * Cuts kept inside each shot's clean window (`shot.clean`, from the analysis): the stretch
 * before someone walks up to the camera, into the picture, or the camera is picked up. The
 * flight always stays whole; where the window forces a cut earlier than planned the picture
 * dips to black instead of jumping.
 */
import { type Layer, type Project, type Shot } from '@golf/schema';
import { layerDefaults, type LayerNames } from './layers';

/** Seconds kept after the landing when the clean window ends before it: the flight wins. */
export const LANDED_PAD_S = 0.4;
/** A cut always keeps at least this much before the launch (the takeaway), whatever the window says; less before a putt. */
const MIN_LEAD_S = 1;
const MIN_PUTT_LEAD_S = 0.6;
/** Length of the dip to black on each side of a cut the clean window forced. */
export const FADE_S = 0.35;

export interface Span {
  a: number;
  b: number;
  /** The end was pulled in by the clean window (a dip to black hides the jump). */
  forced: boolean;
}

/**
 * [a, b] (source seconds) of a cut around a shot launched at `launch` whose ball is down at
 * `land`, kept inside the shot's clean window. `land` may be the end of a putt's roll.
 */
export function cleanSpan(shot: Shot, a: number, b: number, launch: number, land: number): Span {
  const c = shot.clean;
  if (!c) return { a, b, forced: false };
  const from = Math.max(a, Math.min(c.from, launch - (shot.kind === 'putt' ? MIN_PUTT_LEAD_S : MIN_LEAD_S) * shot.slowmo));
  const to = Math.max(Math.min(b, Math.max(c.to, land + LANDED_PAD_S * shot.slowmo)), Math.min(b, from + 0.5));
  return { a: from, b: to, forced: to < b - 0.05 };
}

/** A black frame over the cut at timeline time `t`: fades in before it, out after it (unless it ends the video). */
export function dipToBlack(doc: Project, t: number, last: boolean, names: LayerNames = {}): Layer {
  const l = layerDefaults('shape', names, doc, 0);
  return {
    ...l,
    start: Math.max(0, t - FADE_S),
    end: last ? t : t + FADE_S,
    animIn: { preset: 'fade', duration: FADE_S },
    animOut: last ? { preset: 'none', duration: 0 } : { preset: 'fade', duration: FADE_S },
    props: { ...(l.type === 'shape' ? l.props : {}), shape: 'rect', w: 1.02, h: 1.02, fill: '#000000', fillOpacity: 1, stroke: null, radius: 0 },
  } as Layer;
}
