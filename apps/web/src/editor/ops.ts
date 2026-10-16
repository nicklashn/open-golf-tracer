'use client';

/** Editor commands. Each one is a single undoable step (see store.edit). */
import { CLUBS, shotHandles, type Vec2 } from '@golf/physics';
import { clipSlot, layerDefaults } from '@golf/compose';
import { applyTemplate, currentShot, relayoutTemplate, shotStats } from '@golf/render';
import {
  TRACER_PRESETS,
  byTimeline,
  clipAt,
  clipDuration,
  clipStarts,
  newId,
  sourceToTimeline,
  timelineDuration,
  type AudioClip,
  type Clip,
  type Club,
  type GeoPoint,
  type Keyframe,
  type Layer,
  type Project,
  type ReframeKey,
  type Shot,
  type TracerStyle,
} from '@golf/schema';
import type { Draft } from 'immer';
import { courseMapGeometry, haversine, type CourseData } from './course';
import { refitter } from './refit';
import { useEditor, type MediaInfo } from './store';

const E = () => useEditor.getState();

export function fpsOf(mediaId: string): number {
  const m = E().media[mediaId] ?? E().doc.media[mediaId];
  return m?.fps || 30;
}

function longSide(shot: Shot): number {
  return Math.max(shot.camera.cx * 2, shot.camera.cy * 2);
}

// ---------------------------------------------------------------------------------------------
// Shots

export function shotLaunchTime(doc: Project, shot: Shot): number | null {
  const t = sourceToTimeline(doc.clips, shot.mediaId, Math.max(0, shot.impactTime + shot.timing.launchOffset));
  return t.length ? t[0] : null;
}

export function jumpToShot(shot: Shot): void {
  const t = shotLaunchTime(E().doc, shot);
  E().select({ kind: 'shot', id: shot.id });
  if (t != null) {
    E().setPlaying(false);
    E().setTime(Math.max(0, t - 0.6));
  }
}

function updateShot(label: string, id: string, fn: (s: Draft<Shot>) => void, key?: string) {
  E().edit(
    label,
    (d) => {
      const s = d.shots.find((x) => x.id === id);
      if (s) fn(s);
    },
    { key },
  );
}

export function setShotVisible(id: string, visible: boolean) {
  updateShot(visible ? 'Vis slag' : 'Skjul slag', id, (s) => {
    s.visible = visible;
  });
}

export function deleteShot(id: string) {
  E().edit(
    'Delete shot',
    (d) => {
      const s = d.shots.find((x) => x.id === id);
      if (s?.source === 'auto' && !d.dismissedShots.includes(id)) d.dismissedShots.push(id);
      d.shots = d.shots.filter((x) => x.id !== id);
      for (const l of d.layers) if ('shotId' in l.props && l.props.shotId === id) (l.props as { shotId: string | null }).shotId = null;
    },
    { select: null },
  );
}

export function resetShot(id: string) {
  updateShot('Reset shot', id, (s) => {
    s.params = [...s.auto.params];
    s.anchor = { ...s.auto.anchor };
    s.impactTime = s.auto.impactTime;
    s.constraints = { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null };
    s.timing = { launchOffset: 0, speed: 1 };
  });
}

export function setShotStyle(id: string, patch: Partial<TracerStyle>, key = 'style') {
  updateShot('Tracer style', id, (s) => Object.assign(s.style, patch), `${key}:${id}`);
}

export function applyStyleToAll(style: TracerStyle) {
  E().edit('Style on all shots', (d) => {
    for (const s of d.shots) s.style = { ...style };
  });
}

export function applyPreset(id: string, preset: keyof typeof TRACER_PRESETS) {
  updateShot('Preset', id, (s) => {
    s.style = { ...TRACER_PRESETS[preset] };
  });
}

export function setTiming(id: string, patch: Partial<Shot['timing']>, key = 'timing') {
  updateShot('Timing', id, (s) => Object.assign(s.timing, patch), `${key}:${id}`);
}

export function nudgeLaunch(id: string, frames: number) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  const dt = frames / fpsOf(shot.mediaId);
  setTiming(id, { launchOffset: Math.max(-2, Math.min(2, shot.timing.launchOffset + dt)) }, 'nudge');
}

export function setSlowmo(id: string, slowmo: number) {
  updateShot('Slow motion', id, (s) => {
    s.slowmo = slowmo;
  });
}

/** Changes a fit constraint and refits the flight (carry, curve, flight time). */
export async function setConstraint(id: string, patch: Partial<Shot['constraints']>) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  const next: Shot = { ...shot, constraints: { ...shot.constraints, ...patch } };
  const res = await refitter.request(next, { fps: fpsOf(shot.mediaId), longSide: longSide(shot), maxIterations: 60 });
  updateShot('Fix flight', id, (s) => {
    Object.assign(s.constraints, patch);
    if (res) s.params = res.params;
  });
}

/** Choosing a club refits from that club's typical launch, so the fit can leave the old basin
 *  (a short track fits a 90 m wedge and a 140 m 7-iron almost equally well). */
export async function setClub(id: string, club: Club) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  const from = [...shot.params];
  if (club !== 'auto') {
    const [V, th, kl] = CLUBS[club];
    from[0] = V;
    from[1] = (th * Math.PI) / 180;
    from[3] = kl;
  }
  const next: Shot = { ...shot, club };
  const res = await refitter.request(next, { fps: fpsOf(shot.mediaId), longSide: longSide(shot), maxIterations: 80, from, reference: from });
  updateShot('Club', id, (s) => {
    s.club = club;
    if (res) s.params = res.params;
  });
}

/**
 * Tee and landing picked on the map: their distance becomes the carry (the fit then scales the
 * flight to it), and optionally a course-map graphic follows the shot.
 */
export async function setShotGeo(id: string, tee: GeoPoint, landing: GeoPoint, graphic: { course: CourseData | null; title: string } | null) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  const carry = Math.min(450, Math.max(1, Math.round(haversine(tee, landing) * 10) / 10));
  const constraints = { ...shot.constraints, carry };
  const res = await refitter.request({ ...shot, constraints }, { fps: fpsOf(shot.mediaId), longSide: longSide(shot), maxIterations: 80 });
  const geom = graphic ? courseMapGeometry(graphic.course, tee, landing) : null;
  E().edit('Measure on map', (d) => {
    const s = d.shots.find((x) => x.id === id);
    if (!s) return;
    s.geo = { tee, landing };
    s.constraints.carry = carry;
    if (res) s.params = res.params;
    if (!geom || !graphic) return;
    const existing = d.layers.find((l) => l.type === 'courseMap' && l.props.shotId === id);
    if (existing && existing.type === 'courseMap') {
      Object.assign(existing.props, geom, { title: graphic.title });
      return;
    }
    const layer = layerDefaults('courseMap', {}, d as Project, shotTimelineStart(d as Project, s as Shot));
    if (layer.type === 'courseMap') {
      Object.assign(layer.props, geom, { shotId: id, title: graphic.title, unit: d.units });
      // Stay until a few seconds after the ball has landed on the map.
      const flight = ((shotStats(s as Shot)?.flightTimeS ?? 5) * s.slowmo) / s.timing.speed;
      layer.end = Math.min(timelineDuration(d as Project), layer.start + 0.5 + flight + 3);
      d.layers.push(layer as Draft<Layer>);
    }
  });
}

/** Crop the video to the frame, or show all of it on a blurred copy of itself. */
export function setFill(fill: 'crop' | 'blur') {
  E().edit('Fill', (d) => {
    d.format.fill = fill;
  });
}

/**
 * Adds another video of the project (a round) to the timeline: a clip of the whole video,
 * placed among the other clips in the planner's round order (clipSlot, like attach_video on
 * the server).
 */
export function attachVideo(m: MediaInfo) {
  E().silently((d) => {
    if (d.media[m.id]) return;
    d.media[m.id] = {
      id: m.id,
      kind: 'video',
      name: m.name.slice(0, 255),
      width: m.width,
      height: m.height,
      fps: m.fps,
      duration: m.duration,
      hdr: m.hdr,
      hasAudio: m.hasAudio,
      geo: m.geo ?? null,
      place: null,
      recordedAt: m.recordedAt ?? null,
      recordedAtSource: m.recordedAtSource ?? null,
    };
    const clip = { id: newId('c_'), kind: 'video' as const, mediaId: m.id, in: 0, out: m.duration, speed: 1, volume: 1, muted: false };
    d.clips.splice(clipSlot(d, m.id), 0, clip as Draft<Clip>);
  });
}

/** Timeline seconds a little before the shot's launch (where its graphics start). */
function shotTimelineStart(doc: Project, shot: Shot): number {
  const t = sourceToTimeline(doc.clips, shot.mediaId, shot.impactTime)[0] ?? 0;
  return Math.max(0, t - 0.5);
}

// --- handle dragging -----------------------------------------------------------------------

export type HandleKind = 'start' | 'apex' | 'landing' | { point: number };

interface DragState {
  shotId: string;
  handle: HandleKind;
  base: Shot;
  lambda?: number;
  constraints: Shot['constraints'];
}
let drag: DragState | null = null;

export function beginHandleDrag(shotId: string, handle: HandleKind) {
  const base = E().doc.shots.find((s) => s.id === shotId);
  if (!base) return;
  drag = { shotId, handle, base, constraints: base.constraints };
}

function withHandle(c: Shot['constraints'], h: HandleKind, p: Vec2): Shot['constraints'] {
  if (h === 'start') return { ...c, start: p };
  if (h === 'apex') return { ...c, apex: p };
  if (h === 'landing') return { ...c, landing: p };
  const points = c.points.map((q, i) => (i === h.point ? { ...q, x: p.x, y: p.y } : q));
  return { ...c, points };
}

/** Pointer moved: refit live on the worker and show the result immediately. */
export async function dragHandle(p: Vec2) {
  const d = drag;
  if (!d) return;
  d.constraints = withHandle(d.constraints, d.handle, p);
  const shot: Shot = { ...d.base, constraints: d.constraints, params: E().live[d.shotId] ?? d.base.params };
  const res = await refitter.request(shot, {
    fps: fpsOf(shot.mediaId),
    longSide: longSide(shot),
    maxIterations: 4,
    timeBudgetMs: 12,
    maxTrackPoints: 40,
    lambda: d.lambda,
    reference: d.base.params,
  });
  if (res && drag === d) {
    d.lambda = res.lambda;
    E().setLive(d.shotId, res.params);
  }
}

/** Pointer up: settle the fit fully and commit one undo step. */
export async function endHandleDrag() {
  const d = drag;
  drag = null;
  if (!d) return;
  const live = E().live[d.shotId];
  const shot: Shot = { ...d.base, constraints: d.constraints, params: live ?? d.base.params };
  const res = await refitter.request(shot, {
    fps: fpsOf(shot.mediaId),
    longSide: longSide(shot),
    maxIterations: 60,
    lambda: d.lambda,
    reference: d.base.params,
  });
  updateShot('Move handle', d.shotId, (s) => {
    s.constraints = d.constraints as Draft<Shot['constraints']>;
    s.params = res?.params ?? live ?? s.params;
  });
  E().setLive(d.shotId, null);
}

export function cancelHandleDrag() {
  if (drag) E().setLive(drag.shotId, null);
  drag = null;
}

/** Adds an extra ball position at the current source time. */
export async function addPointConstraint(id: string, sourceTime: number, p: Vec2) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  const points = [...shot.constraints.points.filter((q) => Math.abs(q.t - sourceTime) > 1e-3), { t: sourceTime, x: p.x, y: p.y }].sort((a, b) => a.t - b.t);
  await setConstraint(id, { points });
}

export async function removePointConstraint(id: string, index: number) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  await setConstraint(id, { points: shot.constraints.points.filter((_, i) => i !== index) });
}

export function handlesFor(shot: Shot) {
  return shotHandles(shot);
}

// ---------------------------------------------------------------------------------------------
// Clips (main track is always sequential: removing a clip ripples the rest)

function clipIndexAt(doc: Project, t: number) {
  const hit = clipAt(doc.clips, t);
  return hit ? { hit, i: hit.index, start: clipStarts(doc.clips)[hit.index] } : null;
}

export function splitAt(t: number): boolean {
  const doc = E().doc;
  const c = clipIndexAt(doc, t);
  if (!c) return false;
  const { hit, i, start } = c;
  const local = t - start;
  const d = clipDuration(hit.clip);
  if (local < 0.05 || d - local < 0.05) return false;
  E().edit('Cut', (draft) => {
    const clip = draft.clips[i];
    if (clip.kind === 'video') {
      const cut = clip.in + local * clip.speed;
      const second = { ...clip, id: newId('c_'), in: cut };
      clip.out = cut;
      draft.clips.splice(i + 1, 0, second);
    } else {
      const second = { ...clip, id: newId('c_'), duration: d - local };
      clip.duration = local;
      draft.clips.splice(i + 1, 0, second);
    }
  });
  return true;
}

export function deleteClip(id: string) {
  const doc = E().doc;
  if (doc.clips.length <= 1) return;
  E().edit(
    'Delete clip',
    (d) => {
      d.clips = d.clips.filter((c) => c.id !== id);
    },
    { select: null },
  );
  E().setTime(Math.min(E().time, timelineDuration(E().doc)));
}

export function trimClip(id: string, edge: 'in' | 'out', sourceTime: number, key = 'trim') {
  const media = E().media;
  E().edit(
    'Trim',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (!c || c.kind !== 'video') return;
      const dur = media[c.mediaId]?.duration ?? d.media[c.mediaId]?.duration ?? Infinity;
      if (edge === 'in') c.in = Math.max(0, Math.min(sourceTime, c.out - 0.1));
      else c.out = Math.min(dur, Math.max(sourceTime, c.in + 0.1));
    },
    { key: `${key}:${id}:${edge}` },
  );
}

export function setFreezeDuration(id: string, duration: number) {
  E().edit(
    'Freeze length',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (c?.kind === 'freeze') c.duration = Math.max(0.1, Math.min(60, duration));
    },
    { key: `freeze:${id}` },
  );
}

export function setClipProps(id: string, patch: Partial<{ speed: number; volume: number; muted: boolean }>, key = 'clip') {
  E().edit(
    'Cut',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (c?.kind === 'video') Object.assign(c, patch);
    },
    { key: `${key}:${id}` },
  );
}

export function moveClip(from: number, to: number) {
  if (from === to) return;
  E().edit('Move clip', (d) => {
    const [c] = d.clips.splice(from, 1);
    d.clips.splice(Math.max(0, Math.min(d.clips.length, to)), 0, c);
  });
}

/** Slow motion around a shot with one click: split before launch and after landing, slow the middle. */
export function slowmoAroundShot(shot: Shot, speed = 0.4) {
  const doc = E().doc;
  const launch = shotLaunchTime(doc, shot);
  if (launch == null) return false;
  const st = shotStats(shot);
  const before = 0.35;
  const after = Math.min(1.6, (st?.flightTimeS ?? 3) * shot.slowmo * 0.35);
  const a = Math.max(0, launch - before);
  const b = launch + after;
  E().edit('Slow-mo around the shot', (d) => {
    // Operate on source times so the edit is independent of existing splits.
    const cutAt = (t: number) => {
      const hit = clipAt(d.clips as Clip[], t);
      if (!hit || hit.clip.kind !== 'video') return;
      const start = clipStarts(d.clips as Clip[])[hit.index];
      const local = t - start;
      if (local < 0.02 || clipDuration(hit.clip) - local < 0.02) return;
      const c = d.clips[hit.index];
      if (c.kind !== 'video') return;
      const cut = c.in + local * c.speed;
      d.clips.splice(hit.index + 1, 0, { ...c, id: newId('c_'), in: cut });
      c.out = cut;
    };
    cutAt(b);
    cutAt(a);
    const mid = clipAt(d.clips as Clip[], a + 0.01);
    if (mid && mid.clip.kind === 'video') {
      const c = d.clips[mid.index];
      if (c.kind === 'video') c.speed = speed;
    }
  });
  return true;
}

/** Freeze frame at the playhead (the tracer keeps flying over the frozen picture). */
export function freezeAt(t: number, duration = 2) {
  const doc = E().doc;
  const hit = clipAt(doc.clips, t);
  if (!hit) return;
  splitAt(t);
  const after = E().doc;
  const idx = clipAt(after.clips, t + 1e-3)?.index ?? hit.index + 1;
  E().edit('Freeze frame', (d) => {
    d.clips.splice(idx, 0, { id: newId('c_'), kind: 'freeze', mediaId: hit.clip.mediaId, at: hit.sourceTime, duration });
  });
}

// ---------------------------------------------------------------------------------------------
// Layers

export { layerDefaults } from '@golf/compose';

export function addLayer(layer: Layer) {
  E().edit(
    'Add layer',
    (d) => {
      d.layers.push(layer as Draft<Layer>);
    },
    { select: { kind: 'layer', ids: [layer.id] } },
  );
}

export function updateLayer(id: string, fn: (l: Draft<Layer>) => void, key?: string) {
  E().edit(
    'Edit layer',
    (d) => {
      const l = d.layers.find((x) => x.id === id);
      if (l) fn(l);
    },
    { key: key ? `${key}:${id}` : undefined },
  );
}

export function updateLayerProps(id: string, patch: Record<string, unknown>, key = 'props') {
  updateLayer(id, (l) => Object.assign(l.props, patch), `${key}:${Object.keys(patch).join(',')}`);
}

export function deleteLayers(ids: string[]) {
  E().edit(
    'Delete layer',
    (d) => {
      d.layers = d.layers.filter((l) => !ids.includes(l.id));
    },
    { select: null },
  );
}

export function duplicateLayers(ids: string[]) {
  const copies: string[] = [];
  E().edit('Duplicate layer', (d) => {
    for (const id of ids) {
      const l = d.layers.find((x) => x.id === id);
      if (!l) continue;
      const c = JSON.parse(JSON.stringify(l)) as Layer;
      c.id = newId('l_');
      c.keyframes = c.keyframes.map((k) => ({ ...k, x: k.x + 0.02, y: k.y + 0.02 }));
      d.layers.push(c as Draft<Layer>);
      copies.push(c.id);
    }
  });
  E().select({ kind: 'layer', ids: copies });
}

export function reorderLayer(id: string, dir: 1 | -1) {
  E().edit('Order', (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.layers.length) return;
    [d.layers[i], d.layers[j]] = [d.layers[j], d.layers[i]];
  });
}

/** The keyframe a transform edit should change at timeline time t (adds one if keyframes are in use). */
function keyAt(l: Draft<Layer>, t: number): Draft<Keyframe> {
  const lt = Math.max(0, t - l.start);
  if (l.keyframes.length === 1) return l.keyframes[0];
  const exact = l.keyframes.find((k) => Math.abs(k.t - lt) < 1 / 60);
  if (exact) return exact;
  const prev =
    [...l.keyframes]
      .sort((a, b) => a.t - b.t)
      .filter((k) => k.t <= lt)
      .pop() ?? l.keyframes[0];
  const k = { ...prev, t: lt } as Draft<Keyframe>;
  l.keyframes.push(k);
  l.keyframes.sort((a, b) => a.t - b.t);
  return l.keyframes.find((x) => x.t === lt)!;
}

export function setLayerTransform(id: string, t: number, patch: Partial<Pick<Keyframe, 'x' | 'y' | 'scale' | 'rotation' | 'opacity'>>, key = 'transform') {
  updateLayer(id, (l) => Object.assign(keyAt(l, t), patch), key);
}

export function moveLayers(ids: string[], t: number, dx: number, dy: number, key = 'move') {
  E().edit(
    'Move layer',
    (d) => {
      for (const id of ids) {
        const l = d.layers.find((x) => x.id === id);
        if (!l || l.locked) continue;
        if (l.keyframes.length === 1) {
          l.keyframes[0].x += dx;
          l.keyframes[0].y += dy;
        } else {
          const k = keyAt(l, t);
          k.x += dx;
          k.y += dy;
        }
      }
    },
    { key: `${key}:${ids.join(',')}` },
  );
}

export function addKeyframe(id: string, t: number) {
  updateLayer(id, (l) => {
    const lt = Math.max(0, Math.min(l.end - l.start, t - l.start));
    if (l.keyframes.some((k) => Math.abs(k.t - lt) < 1 / 60)) return;
    const src =
      [...l.keyframes]
        .sort((a, b) => a.t - b.t)
        .filter((k) => k.t <= lt)
        .pop() ?? l.keyframes[0];
    l.keyframes.push({ ...src, t: lt });
    l.keyframes.sort((a, b) => a.t - b.t);
  });
}

export function removeKeyframe(id: string, index: number) {
  updateLayer(id, (l) => {
    if (l.keyframes.length > 1) l.keyframes.splice(index, 1);
  });
}

export function setLayerTiming(id: string, start: number, end: number, key = 'timing') {
  const dur = timelineDuration(E().doc);
  updateLayer(
    id,
    (l) => {
      l.start = Math.max(0, Math.min(start, dur - 0.1));
      l.end = Math.max(l.start + 0.1, Math.min(end, dur));
    },
    key,
  );
}

export function alignLayers(
  ids: string[],
  how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
  boxes: Record<string, { w: number; h: number }>,
  t: number,
) {
  const doc = E().doc;
  const layers = doc.layers.filter((l) => ids.includes(l.id));
  if (!layers.length) return;
  E().edit('Align', (d) => {
    for (const l0 of layers) {
      const l = d.layers.find((x) => x.id === l0.id)!;
      const k = keyAt(l, t);
      const b = boxes[l.id] ?? { w: 0, h: 0 };
      if (how === 'left') k.x = b.w / 2 + 0.04;
      if (how === 'center') k.x = 0.5;
      if (how === 'right') k.x = 1 - b.w / 2 - 0.04;
      if (how === 'top') k.y = b.h / 2 + 0.04;
      if (how === 'middle') k.y = 0.5;
      if (how === 'bottom') k.y = 1 - b.h / 2 - 0.04;
    }
  });
}

export function distributeLayers(ids: string[], axis: 'x' | 'y', t: number) {
  const doc = E().doc;
  const ls = doc.layers.filter((l) => ids.includes(l.id));
  if (ls.length < 3) return;
  E().edit('Distribute', (d) => {
    const ks = ls
      .map((l0) =>
        keyAt(
          d.layers.find((x) => x.id === l0.id)!,
          t,
        ),
      )
      .sort((a, b) => a[axis] - b[axis]);
    const a = ks[0][axis];
    const b = ks[ks.length - 1][axis];
    ks.forEach((k, i) => (k[axis] = a + ((b - a) * i) / (ks.length - 1)));
  });
}

// ---------------------------------------------------------------------------------------------
// Format and reframing

export function setAspect(aspect: Project['format']['aspect'], locale: 'da' | 'en') {
  const before = E().doc;
  const after = relayoutTemplate(before, { ...before, format: { ...before.format, aspect } }, locale);
  E().edit('Format', (d) => {
    d.format.aspect = aspect;
    if (after.layers !== before.layers) d.layers = after.layers as Draft<Layer>[];
  });
}

export function setReframeMode(mode: Project['format']['reframe']['mode']) {
  E().edit('Crop', (d) => {
    d.format.reframe.mode = mode;
  });
}

export function setReframeAt(t: number, cx: number, cy: number, key = 'reframe') {
  E().edit(
    'Crop',
    (d) => {
      const ks = d.format.reframe.keyframes;
      d.format.reframe.mode = 'manual';
      const k = ks.find((x) => Math.abs(x.t - t) < 0.05);
      const v = { cx: Math.min(1, Math.max(0, cx)), cy: Math.min(1, Math.max(0, cy)) };
      if (k) Object.assign(k, v);
      else if (ks.length === 0) ks.push({ t: 0, zoom: 1, ...v });
      else {
        ks.push({ t, zoom: 1, ...v });
        ks.sort((a, b) => a.t - b.t);
      }
    },
    { key },
  );
}

export function clearReframe() {
  E().edit('Clear crop', (d) => {
    d.format.reframe = { mode: 'center', keyframes: [] };
  });
}

/** Auto reframe: frame the golfer/ball before each shot, then follow the ball, with smooth pans. */
export function autoReframe() {
  const doc = E().doc;
  const keys: ReframeKey[] = [];
  const dur = timelineDuration(doc);
  const shots = doc.shots.filter((s) => s.visible && s.kind === 'full');
  for (const s of shots) {
    const launch = shotLaunchTime(doc, s);
    if (launch == null) continue;
    const m = doc.media[s.mediaId];
    if (!m) continue;
    const h = shotHandles(s);
    const ax = (s.constraints.start ?? s.anchor).x / m.width;
    const ay = (s.constraints.start ?? s.anchor).y / m.height;
    // The golfer stands beside the ball; keep both in frame before the strike.
    keys.push({ t: Math.max(0, launch - 1.2), cx: ax, cy: ay - 0.1, zoom: 1 });
    keys.push({ t: launch + 0.15, cx: ax, cy: ay - 0.1, zoom: 1 });
    if (h) {
      keys.push({ t: launch + (h.apexT / s.timing.speed) * s.slowmo * 0.9, cx: h.apex.x / m.width, cy: h.apex.y / m.height + 0.15, zoom: 1 });
      keys.push({ t: launch + (h.landingT / s.timing.speed) * s.slowmo, cx: h.landing.x / m.width, cy: h.landing.y / m.height, zoom: 1 });
    }
  }
  const clean = keys.filter((k) => k.t <= dur).sort((a, b) => a.t - b.t);
  E().edit('Auto-reframe', (d) => {
    d.format.reframe = { mode: 'auto', keyframes: clean.map((k) => ({ ...k, cx: Math.min(1, Math.max(0, k.cx)), cy: Math.min(1, Math.max(0, k.cy)) })) };
  });
}

// ---------------------------------------------------------------------------------------------
// Audio, templates, project

export function setOriginalAudio(patch: Partial<Project['audio']>, key = 'audio') {
  E().edit('Audio', (d) => Object.assign(d.audio, patch), { key });
}

export function addMusic(m: MediaInfo) {
  const doc = E().doc;
  const dur = timelineDuration(doc);
  const track: AudioClip = { id: newId('a_'), mediaId: m.id, start: 0, in: 0, out: Math.min(m.duration, Math.max(1, dur)), volume: 0.6, fadeIn: 1, fadeOut: 2 };
  E().edit(
    'Add music',
    (d) => {
      d.media[m.id] = {
        id: m.id,
        kind: 'audio',
        name: m.name,
        width: 0,
        height: 0,
        fps: 0,
        duration: m.duration,
        hdr: false,
        hasAudio: true,
        geo: null,
        place: null,
        recordedAt: null,
      };
      d.audioTracks.push(track);
    },
    { select: { kind: 'audio', id: track.id } },
  );
}

export function updateMusic(id: string, patch: Partial<AudioClip>, key = 'music') {
  E().edit(
    'Music',
    (d) => {
      const a = d.audioTracks.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
    },
    { key: `${key}:${id}` },
  );
}

export function removeMusic(id: string) {
  E().edit(
    'Remove music',
    (d) => {
      d.audioTracks = d.audioTracks.filter((a) => a.id !== id);
    },
    { select: null },
  );
}

export function addImageMedia(m: MediaInfo) {
  E().edit('Add image', (d) => {
    d.media[m.id] = {
      id: m.id,
      kind: 'image',
      name: m.name,
      width: m.width,
      height: m.height,
      fps: 0,
      duration: 0,
      hdr: false,
      hasAudio: false,
      geo: null,
      place: null,
      recordedAt: null,
    };
  });
}

export function applyProjectTemplate(id: string, locale: 'da' | 'en') {
  const doc = E().doc;
  const next = applyTemplate(doc, id, locale);
  E().edit('Template', (d) => {
    d.shots = next.shots as Draft<Shot>[];
    d.layers = next.layers as Draft<Layer>[];
    d.template = next.template;
  });
}

export function rename(name: string) {
  E().edit(
    'Rename',
    (d) => {
      d.name = name.slice(0, 120);
    },
    { key: 'rename' },
  );
}

export function setUnits(units: 'm' | 'yd') {
  E().edit('Units', (d) => {
    d.units = units;
  });
}

export function statsForSelection(t: number) {
  return currentShot(E().doc, t);
}

/** Adds a manual shot from the server's retrack result. */
export function insertShot(shot: Shot) {
  E().edit(
    'Add shot',
    (d) => {
      const i = d.shots.findIndex((s) => s.id === shot.id);
      if (i >= 0) d.shots[i] = shot as Draft<Shot>;
      else d.shots.push(shot as Draft<Shot>);
      d.shots.sort(byTimeline(d.clips));
    },
    { select: { kind: 'shot', id: shot.id } },
  );
}
