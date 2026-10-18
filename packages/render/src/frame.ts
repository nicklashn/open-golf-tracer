/**
 * One overlay frame = tracers + graphics layers, in output pixels, on a
 * transparent Surface. The browser puts it over the video; the exporter pipes it to ffmpeg.
 * Everything is rasterised by this package, so preview and export are pixel-identical.
 */
import { stats as flightStats, type FlightStats } from '@golf/physics';
import { clipAt, cropAt, flightTimeAt, type Crop, type Project, type Shot } from '@golf/schema';
import type { Locale } from './i18n';
import { drawLayer, placeLayer, placementBounds, type LayerEnv } from './layers';
import { Painter, type ImageData8 } from './painter';
import { hasRollLine, renderRollLine, rollGeometry, rollLineBounds, type RollGeometry } from './rollLine';
import { geometry, renderTracer, shotKey, sourcePath, tracerBounds, type Affine, type Geometry } from './tracer';
import { Surface, type Rect } from './vector';

export interface OverlayContext {
  project: Project;
  width: number;
  height: number;
  locale: Locale;
  images: Map<string, ImageData8>;
  /** Skip these layers (e.g. while their text is being edited in place). */
  hiddenLayerIds?: ReadonlySet<string>;
}

const statsCache = new Map<string, FlightStats | null>();

export function shotStats(shot: Shot): FlightStats | null {
  const key = shotKey(shot);
  if (!statsCache.has(key)) {
    if (statsCache.size > 256) statsCache.clear();
    statsCache.set(key, flightStats(shot.params, shot.camera, shot.constraints.start ?? shot.anchor));
  }
  return statsCache.get(key)!;
}

export interface ScreenTransform {
  mediaId: string;
  crop: Crop;
  tf: Affine;
  sourceTime: number;
  tracerTime: number;
}

/** Source crop → output transform for the media on screen at timeline time t. */
export function screenTransform(oc: Pick<OverlayContext, 'project' | 'width'>, t: number): ScreenTransform | null {
  const hit = clipAt(oc.project.clips, t);
  if (!hit) return null;
  const media = oc.project.media[hit.clip.mediaId];
  if (!media) return null;
  const crop = cropAt(oc.project, media, t);
  return { mediaId: media.id, crop, tf: { ox: crop.x, oy: crop.y, scale: oc.width / crop.w }, sourceTime: hit.sourceTime, tracerTime: hit.tracerTime };
}

export interface ShotOnScreen {
  shot: Shot;
  /** Flight seconds since launch. */
  s: number;
  tf: Affine;
  /** Source-video second on screen (putts' roll lines run on it). */
  sourceTime: number;
}

export function shotsOnScreen(oc: Pick<OverlayContext, 'project' | 'width'>, t: number): ShotOnScreen[] {
  const st = screenTransform(oc, t);
  if (!st) return [];
  const out: ShotOnScreen[] = [];
  for (const shot of oc.project.shots) {
    if (!shot.visible || shot.mediaId !== st.mediaId) continue;
    const s = flightTimeAt(shot, st.tracerTime);
    if (s < 0 && shot.kind !== 'putt') continue;
    out.push({ shot, s, tf: st.tf, sourceTime: st.sourceTime });
  }
  return out.sort((a, b) => a.shot.impactTime - b.shot.impactTime);
}

const geomCache = new Map<string, Geometry | null>();
const shiftCache = new WeakMap<object, { dx: number; dy: number; g: unknown }>();

/**
 * Geometry is built and cached at the crop's scale with the crop at the origin, then moved to
 * the crop: a reframe pan changes the offset every frame, and moving is cheap where rebuilding
 * (perspective widths, decimation) is not. Preview and export both go through here.
 */
function shifted<G extends { x: number[]; y: number[] }>(g: G, tf: Affine, extra?: (g: G, dx: number, dy: number) => Partial<G>): G {
  const dx = tf.ox * tf.scale;
  const dy = tf.oy * tf.scale;
  if (dx === 0 && dy === 0) return g;
  const hit = shiftCache.get(g);
  if (hit && hit.dx === dx && hit.dy === dy) return hit.g as G;
  const out: G = { ...g, x: g.x.map((v) => v - dx), y: g.y.map((v) => v - dy), ...extra?.(g, dx, dy) };
  shiftCache.set(g, { dx, dy, g: out });
  return out;
}

const atOrigin = (tf: Affine): Affine => ({ ox: 0, oy: 0, scale: tf.scale });

export function shotGeometry(shot: Shot, tf: Affine): Geometry | null {
  const key = `${shotKey(shot)}|${JSON.stringify(shot.style)}|${tf.scale.toFixed(6)}`;
  let g = geomCache.get(key);
  if (g === undefined) {
    const sp = sourcePath(shot);
    g = sp ? geometry(sp, shot.style, atOrigin(tf), shot.constraints.start ?? shot.anchor) : null;
    if (geomCache.size > 64) geomCache.delete(geomCache.keys().next().value!);
    geomCache.set(key, g);
  }
  return g && shifted(g, tf, (b, dx, dy) => ({ anchor: { x: b.anchor.x - dx, y: b.anchor.y - dy } }));
}

const rollCache = new Map<string, RollGeometry | null>();

/** A putt's roll line in output pixels (null when it has none or it is switched off). */
export function shotRollGeometry(project: Pick<Project, 'media'>, shot: Shot, tf: Affine): RollGeometry | null {
  const media = project.media[shot.mediaId];
  if (!media || !hasRollLine(shot)) return null;
  const p = shot.putt!.path!;
  const key = `${shot.id}|${p.length}|${p[0].t},${p[p.length - 1].t},${p[p.length - 1].x},${p[p.length - 1].y}|${shot.putt!.holed}|${shot.style.width}|${media.width}x${media.height}|${tf.scale.toFixed(6)}`;
  let g = rollCache.get(key);
  if (g === undefined) {
    g = rollGeometry(shot, media, atOrigin(tf));
    if (rollCache.size > 64) rollCache.delete(rollCache.keys().next().value!);
    rollCache.set(key, g);
  }
  return g && shifted(g, tf);
}

/** The shot a stat card without an explicit shot refers to: the latest one launched before t. */
export function currentShot(project: Project, t: number): Shot | null {
  const st = screenTransform({ project, width: 1 }, t);
  const visible = project.shots.filter((s) => s.visible && s.kind === 'full');
  if (!st) return visible[0] ?? null;
  const launched = visible.filter((s) => s.mediaId === st.mediaId && flightTimeAt(s, st.tracerTime) >= 0);
  if (launched.length) return launched.reduce((a, b) => (b.impactTime > a.impactTime ? b : a));
  return visible.find((s) => s.mediaId === st.mediaId) ?? visible[0] ?? null;
}

export function layerEnv(oc: OverlayContext, t: number): LayerEnv {
  return {
    width: oc.width,
    height: oc.height,
    locale: oc.locale,
    units: oc.project.units,
    images: oc.images,
    shotStats: (id) => {
      const shot = id ? oc.project.shots.find((s) => s.id === id) : currentShot(oc.project, t);
      if (!shot) return null;
      const st = shotStats(shot);
      return st ? { stats: st, measured: shot.constraints.carry != null } : null;
    },
    flightProgress: (id) => {
      const shot = id ? oc.project.shots.find((s) => s.id === id) : currentShot(oc.project, t);
      if (!shot) return null;
      const st = screenTransform(oc, t);
      if (!st || st.mediaId !== shot.mediaId) return 1; // another clip is on screen: show the finished shot
      const total = shotStats(shot)?.flightTimeS ?? 0;
      const s = flightTimeAt(shot, st.tracerTime);
      return total > 0 ? Math.min(1, Math.max(0, s / total)) : 1;
    },
  };
}

/** Draws the complete overlay for timeline time t. The caller clears the surface first. */
export function renderOverlay(surface: Surface, oc: OverlayContext, t: number): Rect | null {
  const size = { width: oc.width, height: oc.height };
  for (const it of shotsOnScreen(oc, t)) {
    // Putts are never traced; they may have a roll line on the green instead.
    if (it.shot.kind === 'putt') {
      const rg = shotRollGeometry(oc.project, it.shot, it.tf);
      const r = rg ? renderRollLine(rg, it.shot.style, it.sourceTime, size) : null;
      if (r) surface.blitRGBA(r.x, r.y, r.w, r.h, r.data);
      continue;
    }
    const g = shotGeometry(it.shot, it.tf);
    if (!g) continue;
    const r = renderTracer(g, it.shot.style, it.s, size);
    if (r) surface.blitRGBA(r.x, r.y, r.w, r.h, r.data);
  }
  const p = new Painter(surface);
  const env = layerEnv(oc, t);
  for (const layer of oc.project.layers) {
    if (oc.hiddenLayerIds?.has(layer.id)) continue;
    drawLayer(p, layer, t, env);
  }
  return surface.dirty;
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function clamp(r: Rect | null, W: number, H: number): Rect | null {
  if (!r) return null;
  const x1 = Math.max(0, Math.floor(r.x));
  const y1 = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(W, Math.ceil(r.x + r.w));
  const y2 = Math.min(H, Math.ceil(r.y + r.h));
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/** Conservative bounds of everything drawn at time t, without rasterising (exporter's overlay box). */
export function frameBounds(oc: OverlayContext, t: number): Rect | null {
  let r: Rect | null = null;
  for (const it of shotsOnScreen(oc, t)) {
    if (it.shot.kind === 'putt') {
      const rg = shotRollGeometry(oc.project, it.shot, it.tf);
      if (rg) r = union(r, rollLineBounds(rg, it.sourceTime, { width: oc.width, height: oc.height }));
      continue;
    }
    const g = shotGeometry(it.shot, it.tf);
    if (g) r = union(r, tracerBounds(g, it.shot.style, it.s, { width: oc.width, height: oc.height }));
  }
  const env = layerEnv(oc, t);
  for (const layer of oc.project.layers) {
    const pl = placeLayer(layer, t, env);
    if (pl) r = union(r, placementBounds(pl, env));
  }
  return clamp(r, oc.width, oc.height);
}

export { Surface };
