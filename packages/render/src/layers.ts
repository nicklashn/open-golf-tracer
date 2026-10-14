/**
 * Graphics layers (text, stat cards, shapes, arrows, images, lower thirds, hole info,
 * distance markers, course maps), drawn with the deterministic Painter. Every layer is positioned by its
 * centre; sizes are fractions of the output frame.
 */
import type { FlightStats } from '@golf/physics';
import type { CourseFeatureKind, FontId, Layer, LayerOf, Project, StatField } from '@golf/schema';
import { M_TO_YD, MPS_TO_MPH } from '@golf/schema';
import { animState, applyAnim, poseAt } from './anim';
import { fontWeight } from './fonts';
import { labels, type Locale } from './i18n';
import type { ImageData8, Painter, Shadow } from './painter';
import { measureText, textPath } from './text';
import type { Path } from './vector';

export interface LayerEnv {
  width: number;
  height: number;
  locale: Locale;
  units: Project['units'];
  images: Map<string, ImageData8>;
  /** Stats for stat cards and distance markers; `measured` = carry given by the user. */
  shotStats: (shotId: string | null) => { stats: FlightStats; measured: boolean } | null;
  /** How far the shot's flight has come at this frame (0 = not launched, 1 = landed); null = no shot. */
  flightProgress?: (shotId: string | null) => number | null;
}

export interface Box {
  w: number;
  h: number;
}

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const T = (font: FontId, weight: number, size: number, letterSpacing = 0) => ({ font, weight: fontWeight(font, weight), size, letterSpacing });

// ---------------------------------------------------------------------------------------------
// Stats formatting

export function formatStat(field: StatField, st: FlightStats, units: Project['units'], locale: Locale): { label: string; value: string } {
  const L = labels(locale);
  const loc = locale === 'da' ? 'da-DK' : 'en-US';
  const n0 = (v: number) => Math.round(v).toLocaleString(loc);
  const n1 = (v: number) => v.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const dist = (m: number) => (units === 'yd' ? `${n0(m * M_TO_YD)} yd` : `${n0(m)} m`);
  switch (field) {
    case 'carry':
      return { label: L.carry, value: dist(st.carryM) };
    case 'apex':
      return { label: L.apex, value: dist(st.apexM) };
    case 'ballSpeed':
      // Always mph: the unit golfers know ball speed in, whatever the distance unit.
      return { label: L.ballSpeed, value: `${n0(st.ballSpeedMps * MPS_TO_MPH)} mph` };
    case 'launch':
      return { label: L.launch, value: `${n1(st.launchAngleDeg)}°` };
    case 'flightTime':
      return { label: L.flightTime, value: `${n1(st.flightTimeS)} s` };
    case 'curve':
      return { label: L.curve, value: `${dist(Math.abs(st.curveM))} ${st.curveM >= 0 ? L.right : L.left}` };
  }
}

function statLabel(f: StatField, locale: Locale): string {
  const L = labels(locale);
  return { carry: L.carry, apex: L.apex, ballSpeed: L.ballSpeed, launch: L.launch, flightTime: L.flightTime, curve: L.curve }[f];
}

// ---------------------------------------------------------------------------------------------
// Text layer helpers

function textLines(layer: LayerOf<'text'>, reveal = 1): string[] {
  let s = layer.props.uppercase ? layer.props.text.toLocaleUpperCase() : layer.props.text;
  if (reveal < 1) {
    const chars = Array.from(s);
    s = chars.slice(0, Math.ceil(chars.length * reveal)).join('');
  }
  return s.split('\n');
}

function textStyle(layer: LayerOf<'text'>, env: LayerEnv) {
  const p = layer.props;
  const px = p.size * env.height;
  return T(p.font, p.weight, px, p.letterSpacing * px);
}

// ---------------------------------------------------------------------------------------------
// Measuring (unscaled size around the centre, output px)

export function measureLayer(layer: Layer, env: LayerEnv): Box {
  const W = env.width;
  const H = env.height;
  switch (layer.type) {
    case 'text': {
      const st = textStyle(layer, env);
      const lines = textLines(layer);
      const w = Math.max(1, ...lines.map((l) => measureText(l, st)));
      const lh = st.size * 1.18;
      const pad = layer.props.background ? st.size * 0.45 : 0;
      return { w: w + pad * 2, h: lh * (lines.length - 1) + st.size * 1.05 + pad * 2 };
    }
    case 'statCard': {
      const w = layer.props.width * W;
      const unit = w / 11;
      const title = layer.props.title ? unit * 1.25 : 0;
      return { w, h: unit * (1.1 + layer.props.fields.length * 1.55 + 0.9) + title };
    }
    case 'shape':
      return {
        w: Math.max(1, layer.props.w * W),
        h: layer.props.shape === 'line' ? Math.max(2, layer.props.strokeWidth * H * 2) : Math.max(1, layer.props.h * H),
      };
    case 'arrow': {
      const dx = layer.props.dx * W;
      const dy = layer.props.dy * H;
      const extra = layer.props.width * H * 4;
      const bow = Math.hypot(dx, dy) * Math.abs(layer.props.bend) * 0.5;
      return { w: Math.max(8, Math.abs(dx) + extra + bow), h: Math.max(8, Math.abs(dy) + extra + bow) };
    }
    case 'image': {
      const img = env.images.get(layer.props.mediaId);
      const w = layer.props.w * W;
      return { w, h: img && img.width ? (w * img.height) / img.width : w * 0.5 };
    }
    case 'lowerThird':
      return lowerThirdMetrics(layer, env);
    case 'holeInfo':
      return holeInfoMetrics(layer, env);
    case 'distance':
      return distanceMetrics(layer, env);
    case 'courseMap':
      return courseMapBox(layer, env);
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing

export interface LayerPlacement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  wipe: number;
  reveal: number;
  box: Box;
}

/** Where (and whether) a layer is drawn at timeline time t. */
export function placeLayer(layer: Layer, t: number, env: LayerEnv): LayerPlacement | null {
  if (layer.hidden || t < layer.start || t > layer.end) return null;
  const { pose, wipe, reveal } = applyAnim(poseAt(layer.keyframes, t - layer.start), animState(layer, t));
  if (pose.opacity <= 0.001 || pose.scale <= 0.001) return null;
  return {
    x: pose.x * env.width,
    y: pose.y * env.height,
    scale: pose.scale,
    rotation: pose.rotation,
    opacity: Math.min(1, pose.opacity),
    wipe,
    reveal,
    box: measureLayer(layer, env),
  };
}

/** Axis-aligned device bounds of a placed layer, with room for shadows. */
export function placementBounds(pl: LayerPlacement, env: LayerEnv): { x: number; y: number; w: number; h: number } {
  const a = (pl.rotation * Math.PI) / 180;
  const hw = (pl.box.w / 2) * pl.scale;
  const hh = (pl.box.h / 2) * pl.scale;
  const ex = Math.abs(hw * Math.cos(a)) + Math.abs(hh * Math.sin(a));
  const ey = Math.abs(hw * Math.sin(a)) + Math.abs(hh * Math.cos(a));
  const pad = Math.min(env.width, env.height) * 0.03 * Math.max(1, pl.scale);
  return { x: pl.x - ex - pad, y: pl.y - ey - pad, w: 2 * (ex + pad), h: 2 * (ey + pad) };
}

export function drawLayer(p: Painter, layer: Layer, t: number, env: LayerEnv): void {
  const pl = placeLayer(layer, t, env);
  if (!pl) return;
  const box = pl.box;
  p.save();
  p.translate(pl.x, pl.y);
  if (pl.rotation) p.rotate((pl.rotation * Math.PI) / 180);
  if (pl.scale !== 1) p.scale(pl.scale);
  p.alpha *= pl.opacity;
  if (pl.wipe < 1) p.clipRect(-box.w / 2 - 4, -box.h / 2 - 4, (box.w + 8) * pl.wipe, box.h + 8);
  switch (layer.type) {
    case 'text':
      drawText(p, layer, env, box, pl.reveal);
      break;
    case 'statCard':
      drawStatCard(p, layer, env, box);
      break;
    case 'shape':
      drawShape(p, layer, env, box);
      break;
    case 'arrow':
      drawArrow(p, layer, env);
      break;
    case 'image':
      drawImage(p, layer, env, box);
      break;
    case 'lowerThird':
      drawLowerThird(p, layer, env);
      break;
    case 'holeInfo':
      drawHoleInfo(p, layer, env);
      break;
    case 'distance':
      drawDistance(p, layer, env);
      break;
    case 'courseMap':
      drawCourseMap(p, layer, env, box);
      break;
  }
  p.restore();
}

const softShadow = (H: number, k = 1): Shadow => ({ color: `rgba(0,0,0,${0.5 * k})`, blur: H * 0.014, dy: H * 0.003 });

function drawText(p: Painter, layer: LayerOf<'text'>, env: LayerEnv, box: Box, reveal: number): void {
  const pr = layer.props;
  const st = textStyle(layer, env);
  const full = textLines(layer);
  const lines = textLines(layer, reveal);
  const pad = pr.background ? st.size * 0.45 : 0;
  const lh = st.size * 1.18;
  if (pr.background) {
    p.fill(p.path().roundRect(-box.w / 2, -box.h / 2, box.w, box.h, st.size * 0.22), rgba(pr.background, pr.backgroundOpacity));
  }
  const shadow = pr.shadow && !pr.background ? softShadow(env.height) : undefined;
  const top = -box.h / 2 + pad;
  // One path for all lines so the shadow is a single soft halo.
  const path = p.path();
  lines.forEach((line, i) => {
    const fullW = measureText(full[i] ?? line, st);
    let x = -fullW / 2;
    if (pr.align === 'left') x = -box.w / 2 + pad;
    else if (pr.align === 'right') x = box.w / 2 - pad - fullW;
    textPathInto(path, line, x, top + st.size * 0.84 + i * lh, st);
  });
  p.fill(path, pr.color, { shadow });
}

function textPathInto(path: Path, text: string, x: number, y: number, st: ReturnType<typeof T>): void {
  textPath(text, x, y, st, path.m, undefined, path);
}

function drawStatCard(p: Painter, layer: LayerOf<'statCard'>, env: LayerEnv, box: Box): void {
  const pr = layer.props;
  const data = env.shotStats(pr.shotId);
  const L = labels(env.locale);
  const w = box.w;
  const unit = w / 11;
  const x0 = -box.w / 2;
  const y0 = -box.h / 2;
  const theme =
    pr.theme === 'light'
      ? { bg: 'rgba(250,250,250,0.95)', label: '#52525B', value: '#111113', foot: '#71717A' }
      : pr.theme === 'accent'
        ? { bg: rgba(pr.accent, 0.96), label: 'rgba(255,255,255,0.8)', value: '#FFFFFF', foot: 'rgba(255,255,255,0.75)' }
        : { bg: 'rgba(17,17,19,0.88)', label: '#A1A1AA', value: '#FAFAFA', foot: '#8B8B94' };
  p.fill(p.path().roundRect(x0, y0, w, box.h, unit * 0.45), theme.bg);
  if (pr.theme !== 'accent') p.fill(p.path().roundRect(x0, y0 + unit * 0.5, unit * 0.16, box.h - unit, unit * 0.08), pr.accent);
  let y = y0 + unit * 0.7;
  const left = x0 + unit * 0.8;
  const right = x0 + w - unit * 0.8;
  if (pr.title) {
    p.text(pr.title.toLocaleUpperCase(), left, y + unit * 0.6, { ...T('inter', 700, unit * 0.62), color: theme.value });
    y += unit * 1.25;
  }
  for (const f of pr.fields) {
    const v = data ? formatStat(f, data.stats, env.units, env.locale) : { label: statLabel(f, env.locale), value: '–' };
    p.text(v.label.toLocaleUpperCase(), left, y + unit * 0.95, { ...T('inter', 600, unit * 0.48, unit * 0.02), color: theme.label });
    p.text(v.value, right, y + unit * 1.05, { ...T('inter', 700, unit * 0.88), color: theme.value, align: 'right' });
    y += unit * 1.55;
  }
  const foot = !data ? L.noShot : data.measured ? L.fromCarry : L.estimate;
  p.text(foot, left, y + unit * 0.6, { ...T('inter', 500, unit * 0.4), color: theme.foot });
}

function drawShape(p: Painter, layer: LayerOf<'shape'>, env: LayerEnv, box: Box): void {
  const pr = layer.props;
  const sw = Math.max(1, pr.strokeWidth * env.height);
  if (pr.shape === 'line') {
    p.stroke(
      p
        .path()
        .moveTo(-box.w / 2, 0)
        .lineTo(box.w / 2, 0),
      sw,
      pr.stroke ?? pr.fill ?? '#ffffff',
    );
    return;
  }
  const path =
    pr.shape === 'ellipse' ? p.path().ellipse(0, 0, box.w / 2, box.h / 2) : p.path().roundRect(-box.w / 2, -box.h / 2, box.w, box.h, pr.radius * env.height);
  if (pr.fill) p.fill(path, rgba(pr.fill, pr.fillOpacity));
  if (pr.stroke) p.stroke(path, sw, pr.stroke, { closed: true });
}

function drawArrow(p: Painter, layer: LayerOf<'arrow'>, env: LayerEnv): void {
  const pr = layer.props;
  const dx = pr.dx * env.width;
  const dy = pr.dy * env.height;
  const x0 = -dx / 2;
  const y0 = -dy / 2;
  const x1 = dx / 2;
  const y1 = dy / 2;
  const len = Math.hypot(dx, dy) || 1;
  const cx = ((-dy / len) * pr.bend * len) / 2;
  const cy = ((dx / len) * pr.bend * len) / 2;
  const lw = Math.max(1.5, pr.width * env.height);
  const head = pr.head ? lw * 3.4 : 0;
  const tx = x1 - cx;
  const ty = y1 - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ex = x1 - (tx / tl) * head * 0.6;
  const ey = y1 - (ty / tl) * head * 0.6;
  const shaft = p.path().moveTo(x0, y0).quadTo(cx, cy, ex, ey);
  const parts: Parameters<Painter['group']>[0] = [{ path: shaft, stroke: { width: lw, color: pr.color, dash: pr.dashed ? [lw * 2.2, lw * 1.8] : undefined } }];
  if (pr.head) {
    const ang = Math.atan2(ty, tx);
    parts.push({
      path: p
        .path()
        .moveTo(x1, y1)
        .lineTo(x1 - head * Math.cos(ang - 0.45), y1 - head * Math.sin(ang - 0.45))
        .lineTo(x1 - head * Math.cos(ang + 0.45), y1 - head * Math.sin(ang + 0.45))
        .close(),
      fill: pr.color,
    });
  }
  p.group(parts, softShadow(env.height, 0.7));
}

function drawImage(p: Painter, layer: LayerOf<'image'>, env: LayerEnv, box: Box): void {
  const img = env.images.get(layer.props.mediaId);
  if (!img) {
    p.stroke(p.path().rect(-box.w / 2, -box.h / 2, box.w, box.h), 2, 'rgba(255,255,255,0.6)', { dash: [6, 6], closed: true });
    return;
  }
  p.image(img, -box.w / 2, -box.h / 2, box.w, box.h, layer.props.radius * Math.min(box.w, box.h));
}

function frameUnit(env: LayerEnv): number {
  return Math.min(env.height, env.width * 1.2);
}

function lowerThirdMetrics(layer: LayerOf<'lowerThird'>, env: LayerEnv) {
  const pr = layer.props;
  const U = frameUnit(env);
  const titlePx = U * 0.052;
  const subPx = U * 0.03;
  const tw = measureText(pr.title.toLocaleUpperCase(), T(pr.font, 700, titlePx));
  const sw = pr.subtitle ? measureText(pr.subtitle.toLocaleUpperCase(), T(pr.font, 500, subPx)) : 0;
  const padX = titlePx * 0.55;
  const bar = titlePx * 0.16;
  const w = Math.max(tw, sw) + padX * 2 + bar;
  const h = titlePx * 1.35 + (pr.subtitle ? subPx * 1.6 : 0);
  return { titlePx, subPx, w, h, padX, bar };
}

function drawLowerThird(p: Painter, layer: LayerOf<'lowerThird'>, env: LayerEnv): void {
  const pr = layer.props;
  const m = lowerThirdMetrics(layer, env);
  const x0 = -m.w / 2;
  const y0 = -m.h / 2;
  const titleH = m.titlePx * 1.35;
  const minimal = pr.style === 'minimal';
  if (!minimal) {
    p.fill(p.path().roundRect(x0, y0, m.w, titleH, m.titlePx * 0.12), pr.style === 'tv' ? 'rgba(255,255,255,0.97)' : 'rgba(17,17,19,0.9)');
    if (pr.subtitle) p.fill(p.path().roundRect(x0, y0 + titleH, m.w * 0.82, m.h - titleH, m.titlePx * 0.1), pr.accent);
  }
  p.fill(p.path().rect(x0, y0, m.bar, titleH), pr.accent);
  const shadow = minimal ? softShadow(env.height) : undefined;
  p.text(pr.title.toLocaleUpperCase(), x0 + m.bar + m.padX, y0 + titleH * 0.5 + m.titlePx * 0.36, {
    ...T(pr.font, 700, m.titlePx),
    color: pr.style === 'tv' ? '#111113' : '#FFFFFF',
    shadow,
  });
  if (pr.subtitle) {
    p.text(pr.subtitle.toLocaleUpperCase(), x0 + m.bar + m.padX, y0 + titleH + (m.h - titleH) * 0.5 + m.subPx * 0.36, {
      ...T(pr.font, 500, m.subPx),
      color: '#FFFFFF',
      shadow,
    });
  }
}

function holeInfoMetrics(layer: LayerOf<'holeInfo'>, env: LayerEnv) {
  const pr = layer.props;
  const L = labels(env.locale);
  const U = frameUnit(env);
  const big = U * 0.075;
  const small = U * 0.026;
  const holeTxt = String(pr.hole);
  const parts = [
    `${L.par} ${pr.par}`,
    ...(pr.length > 0 ? [`${Math.round(pr.length)} ${pr.unit === 'yd' ? 'YD' : 'M'}`] : []),
    ...(pr.club ? [pr.club] : []),
  ].map((s) => s.toLocaleUpperCase());
  const hw = measureText(holeTxt, T(pr.font, 700, big));
  const pw = Math.max(...parts.map((s) => measureText(s, T(pr.font, 600, small * 1.25))));
  const lw = measureText(L.hole.toLocaleUpperCase(), T(pr.font, 600, small));
  const pad = big * 0.32;
  const left = Math.max(hw, lw) + pad * 2;
  const w = left + pw + pad * 2.2;
  const h = Math.max(big * 1.45, parts.length * small * 1.55 + pad * 1.4);
  return { big, small, holeTxt, parts, left, w, h, pad, L };
}

function drawHoleInfo(p: Painter, layer: LayerOf<'holeInfo'>, env: LayerEnv): void {
  const pr = layer.props;
  const m = holeInfoMetrics(layer, env);
  const x0 = -m.w / 2;
  const y0 = -m.h / 2;
  const r = m.big * 0.14;
  p.fill(p.path().roundRect(x0, y0, m.w, m.h, r), 'rgba(17,17,19,0.9)');
  p.fill(p.path().roundRect(x0, y0, m.left, m.h, r), pr.accent);
  p.fill(p.path().rect(x0 + m.left - r, y0, r, m.h), pr.accent);
  p.text(m.L.hole.toLocaleUpperCase(), x0 + m.left / 2, y0 + m.h * 0.3, { ...T(pr.font, 600, m.small), color: '#FFFFFF', align: 'center' });
  p.text(m.holeTxt, x0 + m.left / 2, y0 + m.h * 0.3 + m.big * 0.92, { ...T(pr.font, 700, m.big), color: '#FFFFFF', align: 'center' });
  const lineH = m.small * 1.55;
  const top = -((m.parts.length - 1) * lineH) / 2;
  m.parts.forEach((s, i) => {
    p.text(s, x0 + m.left + m.pad * 1.1, top + i * lineH + m.small * 0.45, { ...T(pr.font, 600, m.small * 1.25), color: i === 0 ? '#FFFFFF' : '#D4D4D8' });
  });
}

function distanceMetrics(layer: LayerOf<'distance'>, env: LayerEnv) {
  const pr = layer.props;
  const U = frameUnit(env);
  const px = U * 0.045;
  const data = env.shotStats(pr.shotId);
  const metres = pr.value != null ? (pr.unit === 'yd' ? pr.value / M_TO_YD : pr.value) : data ? data.stats.carryM : 0;
  const est = pr.value == null && !!data && !data.measured;
  const value = (pr.unit === 'yd' ? `${Math.round(metres * M_TO_YD)} yd` : `${Math.round(metres)} m`) + (est ? '*' : '');
  const vw = measureText(value, T('barlow', 700, px));
  const lw = pr.label ? measureText(pr.label.toLocaleUpperCase(), T('barlow', 600, px * 0.5)) : 0;
  const dot = px * 0.42;
  const pad = px * 0.4;
  const w = dot * 2 + pad * 3 + Math.max(vw, lw);
  const h = px * 1.3 + (pr.label ? px * 0.62 : 0);
  return { px, value, w, h, dot, pad };
}

function drawDistance(p: Painter, layer: LayerOf<'distance'>, env: LayerEnv): void {
  const pr = layer.props;
  const m = distanceMetrics(layer, env);
  const x0 = -m.w / 2;
  const y0 = -m.h / 2;
  p.fill(p.path().roundRect(x0, y0, m.w, m.h, m.h / 2), 'rgba(17,17,19,0.88)');
  p.fill(p.path().ellipse(x0 + m.pad + m.dot, 0, m.dot, m.dot), pr.accent);
  const tx = x0 + m.pad * 2 + m.dot * 2;
  if (pr.label) {
    p.text(pr.label.toLocaleUpperCase(), tx, y0 + m.px * 0.72, { ...T('barlow', 600, m.px * 0.5), color: '#A1A1AA' });
    p.text(m.value, tx, y0 + m.px * 0.62 + m.px * 0.95, { ...T('barlow', 700, m.px), color: pr.color });
  } else {
    p.text(m.value, tx, m.px * 0.34, { ...T('barlow', 700, m.px), color: pr.color });
  }
}

// ---------------------------------------------------------------------------------------------
// Course map (top-down, tee at the bottom, landing straight up)

const COURSE_COLORS: Record<CourseFeatureKind, string> = {
  woods: '#1f4026',
  rough: '#3b6e3a',
  fairway: '#5a9e4b',
  tee: '#66ad55',
  green: '#7cc96a',
  bunker: '#e6d9a8',
  water: '#3f82bf',
};
const COURSE_ORDER: CourseFeatureKind[] = ['woods', 'rough', 'fairway', 'tee', 'green', 'water', 'bunker'];

function courseMapBox(layer: LayerOf<'courseMap'>, env: LayerEnv): Box {
  const h = layer.props.size * env.height;
  return { w: h * 0.72, h };
}

function drawCourseMap(p: Painter, layer: LayerOf<'courseMap'>, env: LayerEnv, box: Box): void {
  const pr = layer.props;
  const dark = pr.theme === 'dark';
  const x0 = -box.w / 2;
  const y0 = -box.h / 2;
  const u = box.h / 40;
  const pad = u * 1.2;
  const titleH = pr.title ? u * 3 : 0;
  const footH = u * 1.6;
  const mx = x0 + pad;
  const my = y0 + pad + titleH;
  const mw = box.w - pad * 2;
  const mh = box.h - pad * 2 - titleH - footH;
  p.fill(p.path().roundRect(x0, y0, box.w, box.h, u * 1.1), dark ? 'rgba(17,17,19,0.9)' : 'rgba(250,250,250,0.95)', { shadow: softShadow(env.height, 0.8) });
  if (pr.title) p.text(pr.title.toLocaleUpperCase(), x0 + pad, y0 + pad + u * 2, { ...T('barlow', 700, u * 2), color: dark ? '#FAFAFA' : '#111113' });

  // Metres -> card pixels: the shot fills ~80 % of the map height, centred sideways.
  const L = Math.max(1, Math.hypot(pr.landing.x, pr.landing.y));
  const s = Math.min(mh / (pr.landing.y > 0 ? pr.landing.y * 1.25 + 25 : 60), mw / (Math.abs(pr.landing.x) * 2 + 60));
  const tx = mx + mw / 2 - (pr.landing.x / 2) * s;
  const ty = my + mh - mh * 0.08;
  const X = (xm: number) => tx + xm * s;
  const Y = (ym: number) => ty - ym * s;

  p.save();
  p.clipRect(mx, my, mw, mh);
  p.fill(p.path().rect(mx, my, mw, mh), COURSE_COLORS.rough);
  for (const kind of COURSE_ORDER) {
    const path = p.path();
    let any = false;
    for (const f of pr.features) {
      if (f.k !== kind) continue;
      path.moveTo(X(f.p[0]), Y(f.p[1]));
      for (let i = 2; i + 1 < f.p.length; i += 2) path.lineTo(X(f.p[i]), Y(f.p[i + 1]));
      path.close();
      any = true;
    }
    if (any) p.fill(path, COURSE_COLORS[kind]);
  }

  // The shot: faint full line, solid line up to the ball, then the landing marker.
  const q = Math.min(1, Math.max(0, env.flightProgress?.(pr.shotId) ?? 1));
  const lx = X(pr.landing.x);
  const ly = Y(pr.landing.y);
  const lw = Math.max(1.5, u * 0.55);
  p.stroke(p.path().moveTo(X(0), Y(0)).lineTo(lx, ly), lw * 0.7, 'rgba(255,255,255,0.45)', { dash: [lw * 1.6, lw * 1.4] });
  p.fill(p.path().ellipse(X(0), Y(0), lw * 1.3, lw * 1.3), '#FFFFFF');
  if (q > 0) {
    const bx = X(pr.landing.x * q);
    const by = Y(pr.landing.y * q);
    p.stroke(p.path().moveTo(X(0), Y(0)).lineTo(bx, by), lw, pr.accent, { shadow: softShadow(env.height, 0.6) });
    if (q < 1) p.fill(p.path().ellipse(bx, by, lw * 1.25, lw * 1.25), '#FFFFFF', { shadow: softShadow(env.height, 0.6) });
  }
  if (q >= 1) {
    p.stroke(p.path().ellipse(lx, ly, lw * 2.4, lw * 2.4), lw * 0.6, '#FFFFFF', { closed: true });
    p.fill(p.path().ellipse(lx, ly, lw * 1.2, lw * 1.2), pr.accent);
  }
  if (pr.showDistance && q >= 1) {
    const txt = pr.unit === 'yd' ? `${Math.round(L * M_TO_YD)} YD` : `${Math.round(L)} M`;
    const st = T('barlow', 700, u * 2.1);
    const tw = measureText(txt, st);
    const bw = tw + u * 1.6;
    const bh = u * 2.8;
    const bxp = Math.min(mx + mw - bw - u * 0.5, Math.max(mx + u * 0.5, lx - bw / 2));
    const byp = Math.max(my + u * 0.5, ly - lw * 3 - bh);
    p.fill(p.path().roundRect(bxp, byp, bw, bh, bh / 2), 'rgba(17,17,19,0.88)');
    p.text(txt, bxp + bw / 2, byp + bh * 0.5 + u * 0.75, { ...st, color: '#FFFFFF', align: 'center' });
  }
  p.restore();
  p.text(pr.attribution, x0 + box.w - pad, y0 + box.h - pad * 0.55, { ...T('inter', 500, u * 0.85), color: dark ? '#8B8B94' : '#71717A', align: 'right' });
}
