'use client';

/** Editor commands. Each one is a single undoable step (see store.edit). */
import { CLUBS, fitThrough, frameBox, intoView, offFrameReason, outsideBy, shotHandles, type Box, type Vec2 } from '@golf/physics';
import { clipSlot, layerDefaults } from '@golf/compose';
import { applyTemplate, currentShot, relayoutTemplate, shotStats } from '@golf/render';
import {
  TRACER_PRESETS,
  byTimeline,
  clipAt,
  clipDuration,
  clipStarts,
  cropAt,
  newId,
  sourceToTimeline,
  timelineDuration,
  type AudioClip,
  type Clip,
  type Club,
  type GeoPoint,
  type HoleEdit,
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
import { revealTime } from './reveal';
import { rippleLinked, timelineRemap } from './ripple';
import { useEditor, type MediaInfo, type Selection } from './store';

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

/** Seconds shown before a shot's launch when jumping to it. */
export const SHOT_LEAD_S = 0.6;

/**
 * Where a jump to the shot lands: SHOT_LEAD_S before its launch, but never before the start of
 * the clip that shows the launch – a lead-in reaching back into the previous clip would show
 * another video (often another hole). Null when no clip on the timeline shows the launch.
 */
export function shotCueTime(doc: Project, shot: Shot): number | null {
  const launch = Math.max(0, shot.impactTime + shot.timing.launchOffset);
  let start = 0;
  for (const c of doc.clips) {
    if (c.mediaId === shot.mediaId && c.kind === 'video' && launch >= c.in - 1e-6 && launch <= c.out + 1e-6) {
      const t = start + (launch - c.in) / c.speed;
      return Math.max(start, t - SHOT_LEAD_S);
    }
    start += clipDuration(c);
  }
  return null;
}

/** Called when a shot to show is not on the timeline (its clip was removed or trimmed away). */
let onMissing: ((shot: Shot) => void) | null = null;
export function onShotMissing(fn: ((shot: Shot) => void) | null): void {
  onMissing = fn;
}

/**
 * Shows a shot: selects it and moves the playhead (and the preview) to just before its launch,
 * scrolling the timeline to it. Playback keeps going from there when it was playing. Returns
 * false when the shot is not on the timeline (the editor then offers to put it back).
 */
export function jumpToShot(shot: Shot): boolean {
  const s = E();
  s.select({ kind: 'shot', id: shot.id });
  const t = shotCueTime(s.doc, shot);
  if (t == null) {
    onMissing?.(shot);
    return false;
  }
  seekTo(t);
  return true;
}

/** Moves the playhead to `t` and the timeline to the playhead; playing goes on from there. */
export function seekTo(t: number): void {
  const s = E();
  const playing = s.playing;
  // The player follows `time` only while paused: stop, seek, and start again from there.
  if (playing) s.setPlaying(false);
  s.setTime(t);
  revealTime(E().time);
  if (playing) E().setPlaying(true);
}

/**
 * Puts a shot that is not on the timeline back: its whole video as a clip when none of it is
 * there (in round order), else the nearest clip of its video trimmed open to show it. One undo step.
 */
export function restoreShot(shot: Shot): boolean {
  const doc = E().doc;
  const m = E().media[shot.mediaId] ?? doc.media[shot.mediaId];
  if (!m || m.kind !== 'video') return false;
  const launch = Math.max(0, shot.impactTime + shot.timing.launchOffset);
  const flight = (shotStats(shot)?.flightTimeS ?? 3) * shot.slowmo;
  const end = shot.kind === 'putt' ? (shot.putt?.end ?? launch) : launch + flight;
  const own = doc.clips.filter((c): c is Extract<Clip, { kind: 'video' }> => c.kind === 'video' && c.mediaId === shot.mediaId);
  if (!own.length) {
    editTimeline('Add clip', (d) => {
      if (!d.media[m.id]) return;
      d.clips.splice(clipSlot(d, m.id), 0, { id: newId('c_'), kind: 'video', mediaId: m.id, in: 0, out: m.duration, speed: 1, volume: 1, muted: false });
    });
  } else {
    const dist = (c: { in: number; out: number }) => (launch < c.in ? c.in - launch : launch - c.out);
    const c = own.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    editTimeline('Trim', (d) => {
      const x = d.clips.find((y) => y.id === c.id);
      if (!x || x.kind !== 'video') return;
      if (launch < x.in) x.in = Math.max(0, launch - 1.5);
      else x.out = Math.min(m.duration, Math.max(x.out, end + 1.5));
    });
  }
  return shotCueTime(E().doc, shot) != null;
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

export function setPuttHoled(id: string, holed: boolean | null) {
  updateShot('Putt', id, (s) => {
    if (s.putt) s.putt.holed = holed;
  });
}

export function setPuttLine(id: string, line: boolean) {
  updateShot('Roll line', id, (s) => {
    if (s.putt) s.putt.line = line;
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

const NO_CONSTRAINTS: Shot['constraints'] = { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null };

/**
 * Back to what the analysis found. An auto flight that lies far outside the picture (older
 * analyses did not catch it) would be unreachable again, so it is pulled into view in the same
 * undo step. Returns 'inView' then, else 'auto'.
 */
export function resetShot(id: string): 'auto' | 'inView' | null {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return null;
  const auto: Shot = {
    ...shot,
    params: [...shot.auto.params],
    anchor: { ...shot.auto.anchor },
    impactTime: shot.auto.impactTime,
    constraints: NO_CONSTRAINTS,
    timing: { launchOffset: 0, speed: 1 },
  };
  const fixed = offFrameReason(auto, frameBox(auto)) ? intoView(auto, visibleBox(auto), { fps: fpsOf(shot.mediaId), longSide: longSide(shot) }) : null;
  updateShot('Reset shot', id, (s) => {
    s.params = fixed ? fixed.params : auto.params;
    s.anchor = auto.anchor;
    s.impactTime = auto.impactTime;
    s.constraints = fixed ? fixed.constraints : { ...NO_CONSTRAINTS };
    s.timing = { ...auto.timing };
  });
  return fixed ? 'inView' : 'auto';
}

/** The source frame of a shot's video. */
function frameOf(shot: Shot): Box {
  const m = E().doc.media[shot.mediaId];
  return m ? { x: 0, y: 0, w: m.width, h: m.height } : frameBox(shot);
}

/**
 * The part of the source frame the preview shows for a shot: the crop (9:16 etc.) at the
 * playhead when it is on the shot's video, else at the shot's launch; never beyond the frame.
 */
export function visibleBox(shot: Shot): Box {
  const doc = E().doc;
  const frame = frameOf(shot);
  const m = doc.media[shot.mediaId];
  if (!m) return frame;
  const now = E().time;
  const hit = clipAt(doc.clips, now);
  const t = hit && hit.clip.mediaId === shot.mediaId ? now : (shotLaunchTime(doc, shot) ?? now);
  const c = cropAt(doc, m, t);
  const x0 = Math.max(frame.x, c.x);
  const y0 = Math.max(frame.y, c.y);
  const x1 = Math.min(frame.x + frame.w, c.x + c.w);
  const y1 = Math.min(frame.y + frame.h, c.y + c.h);
  return x1 - x0 > 1 && y1 - y0 > 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : frame;
}

/** Handles (start, apex, landing) of a shot that lie outside `box` – what the preview cannot show. */
export function handlesOutside(shot: Shot, box: Box = visibleBox(shot)): ('start' | 'apex' | 'landing')[] {
  const h = shotHandles(shot);
  if (!h) return ['apex', 'landing'];
  return (['start', 'apex', 'landing'] as const).filter((k) => outsideBy(h[k], box) > 0);
}

/**
 * Pulls the whole flight into the visible picture as one undo step: start, apex and landing stay
 * where they can be seen, the others take a default shot's place from the start point.
 */
export function bringIntoView(id: string): boolean {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return false;
  const r = intoView(shot, visibleBox(shot), { fps: fpsOf(shot.mediaId), longSide: longSide(shot) });
  updateShot('Bring into view', id, (s) => {
    s.params = r.params;
    s.constraints = r.constraints as Draft<Shot['constraints']>;
  });
  return true;
}

/** Replaces the flight by one through three clicked points (source pixels), as one undo step. */
export function drawShot(id: string, start: Vec2, apex: Vec2, landing: Vec2) {
  const shot = E().doc.shots.find((s) => s.id === id);
  if (!shot) return;
  // Clicked points replace the old handles and extra points; carry, curve and flight time stay.
  const base: Shot = { ...shot, constraints: { ...shot.constraints, start, apex: null, landing: null, points: [] } };
  const r = fitThrough(base, start, apex, landing, { fps: fpsOf(shot.mediaId), longSide: longSide(shot) });
  updateShot('Draw path', id, (s) => {
    s.params = r.params;
    // The user drew what happened: later refits leave the tracked points out.
    s.constraints = { ...base.constraints, apex, landing, ignoreTrack: true } as Draft<Shot['constraints']>;
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
  const base = E().doc;
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
    // Graphics of the clips after it move along.
    rippleLinked(base, d);
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

/**
 * Starts dragging a handle. `rescue` is the visible box when the handle was grabbed at the edge
 * (it lies outside the picture): the flight is first pulled into view, so the drag starts from a
 * sane flight instead of one the fit would need many steps to bring back.
 */
export function beginHandleDrag(shotId: string, handle: HandleKind, rescue?: Box) {
  let base = E().doc.shots.find((s) => s.id === shotId);
  if (!base) return;
  if (rescue) {
    const r = intoView(base, rescue, { fps: fpsOf(base.mediaId), longSide: longSide(base) });
    base = { ...base, params: r.params, constraints: r.constraints };
    E().setLive(shotId, r.params);
  }
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
// Clips. The main track is always sequential: removing or shortening a clip ripples the rest,
// and graphics, music and crop keyframes move with the picture they belong to (rippleLinked).

/**
 * One undoable change to the main track. `base` is the document the linked items are computed
 * from (the drag's start for drags, else the current one); the playhead follows its picture
 * unless the caller drives it (`keepTime`, e.g. the live trim preview).
 */
function editTimeline(
  label: string,
  recipe: (d: Draft<Project>) => void,
  opts: { key?: string; select?: Selection; base?: Project; dropInside?: boolean; keepTime?: boolean } = {},
) {
  const base = opts.base ?? E().doc;
  const before = E().doc.clips;
  E().edit(
    label,
    (d) => {
      recipe(d);
      rippleLinked(base, d, { dropInside: opts.dropInside });
    },
    { key: opts.key, select: opts.select },
  );
  const after = E().doc.clips;
  if (opts.keepTime || after === before) return;
  const map = timelineRemap(before, after);
  const s = E();
  s.set({ inPoint: s.inPoint == null ? null : map(s.inPoint), outPoint: s.outPoint == null ? null : map(s.outPoint, true) });
  s.setTime(map(s.time));
}

/** Cuts the clip under timeline time t in two; returns the index of the clip that starts at t. */
function cutDraft(d: Draft<Project>, t: number, minLen = 0.05): number | null {
  const hit = clipAt(d.clips as Clip[], t);
  if (!hit) return null;
  const start = clipStarts(d.clips as Clip[])[hit.index];
  const local = t - start;
  const dur = clipDuration(hit.clip);
  if (local < minLen) return hit.index;
  if (dur - local < minLen) return hit.index + 1;
  const c = d.clips[hit.index];
  if (c.kind === 'video') {
    const cut = c.in + local * c.speed;
    d.clips.splice(hit.index + 1, 0, { ...c, id: newId('c_'), in: cut });
    c.out = cut;
  } else {
    d.clips.splice(hit.index + 1, 0, { ...c, id: newId('c_'), duration: dur - local });
    c.duration = local;
  }
  return hit.index + 1;
}

export function splitAt(t: number): boolean {
  const doc = E().doc;
  const hit = clipAt(doc.clips, t);
  if (!hit) return false;
  const local = t - clipStarts(doc.clips)[hit.index];
  if (local < 0.05 || clipDuration(hit.clip) - local < 0.05) return false;
  E().edit('Cut', (d) => {
    cutDraft(d, t);
  });
  return true;
}

/** Ripple delete: the clips go, everything after closes the gap. One clip always stays. */
export function deleteClips(ids: string[]): boolean {
  const doc = E().doc;
  const keep = doc.clips.filter((c) => !ids.includes(c.id));
  if (!keep.length || keep.length === doc.clips.length) return false;
  editTimeline(
    ids.length > 1 ? 'Delete clips' : 'Delete clip',
    (d) => {
      d.clips = d.clips.filter((c) => !ids.includes(c.id));
    },
    { select: null, dropInside: true },
  );
  return true;
}

export function deleteClip(id: string) {
  deleteClips([id]);
}

/**
 * Trims a video clip's edge to a source time. During a drag, pass the document from the drag's
 * start as `base` (linked items are placed from it) and `keepTime` (the caller shows the edge).
 */
export function trimClip(id: string, edge: 'in' | 'out', sourceTime: number, key = 'trim', drag?: { base: Project }) {
  const media = E().media;
  editTimeline(
    'Trim',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (!c || c.kind !== 'video') return;
      const dur = media[c.mediaId]?.duration ?? d.media[c.mediaId]?.duration ?? Infinity;
      if (edge === 'in') c.in = Math.max(0, Math.min(sourceTime, c.out - 0.1));
      else c.out = Math.min(dur, Math.max(sourceTime, c.in + 0.1));
    },
    { key: `${key}:${id}:${edge}`, base: drag?.base, keepTime: !!drag },
  );
}

/**
 * Ripple trim to the playhead (Q / W): drops the part of the clip under the playhead before it
 * (start) or after it (end).
 */
export function trimToPlayhead(edge: 'start' | 'end'): boolean {
  const { doc, time } = E();
  const hit = clipAt(doc.clips, time);
  if (!hit) return false;
  const start = clipStarts(doc.clips)[hit.index];
  const local = time - start;
  const dur = clipDuration(hit.clip);
  if (local < 0.05 || dur - local < 0.05) return false;
  const c = hit.clip;
  if (c.kind === 'video') trimClip(c.id, edge === 'start' ? 'in' : 'out', hit.sourceTime, 'trim-playhead');
  else if (edge === 'end') setFreezeDuration(c.id, local);
  else setFreezeDuration(c.id, dur - local);
  return true;
}

export function setFreezeDuration(id: string, duration: number, drag?: { base: Project }) {
  editTimeline(
    'Freeze length',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (c?.kind === 'freeze') c.duration = Math.max(0.1, Math.min(60, duration));
    },
    { key: `freeze:${id}`, base: drag?.base, keepTime: !!drag },
  );
}

export function setClipProps(id: string, patch: Partial<{ speed: number; volume: number; muted: boolean }>, key = 'clip') {
  editTimeline(
    'Cut',
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (c?.kind === 'video') Object.assign(c, patch);
    },
    { key: `${key}:${id}` },
  );
}

/** Moves a clip to another place in the order; its graphics go with it. */
export function moveClip(from: number, to: number) {
  const n = E().doc.clips.length;
  const dest = Math.max(0, Math.min(n - 1, to));
  if (from === dest || from < 0 || from >= n) return;
  editTimeline('Move clip', (d) => {
    const [c] = d.clips.splice(from, 1);
    d.clips.splice(dest, 0, c);
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
  editTimeline('Slow-mo around the shot', (d) => {
    const at = (t: number) => {
      const hit = clipAt(d.clips as Clip[], t);
      return hit && hit.clip.kind === 'video' ? cutDraft(d, t, 0.02) : null;
    };
    at(b);
    at(a);
    const mid = clipAt(d.clips as Clip[], a + 0.01);
    if (mid && mid.clip.kind === 'video') {
      const c = d.clips[mid.index];
      if (c.kind === 'video') c.speed = speed;
    }
  });
  return true;
}

/** Freeze frame at the playhead (the tracer keeps flying over the frozen picture). One undo step. */
export function freezeAt(t: number, duration = 2) {
  const doc = E().doc;
  const hit = clipAt(doc.clips, t);
  if (!hit) return;
  editTimeline('Freeze frame', (d) => {
    const idx = cutDraft(d, t) ?? hit.index + 1;
    d.clips.splice(idx, 0, { id: newId('c_'), kind: 'freeze', mediaId: hit.clip.mediaId, at: hit.sourceTime, duration });
  });
}

/** Shifts layers in time (Alt+arrows), keeping their length. */
export function shiftLayers(ids: string[], dt: number) {
  const dur = timelineDuration(E().doc);
  E().edit(
    'Move layer',
    (d) => {
      for (const l of d.layers) {
        if (!ids.includes(l.id) || l.locked) continue;
        const len = l.end - l.start;
        const s = Math.max(0, Math.min(dur - Math.min(len, dur), l.start + dt));
        l.start = s;
        l.end = s + len;
      }
    },
    { key: `shift:${ids.join(',')}` },
  );
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

// ---------------------------------------------------------------------------------------------
// Score

/**
 * Corrects one hole on the scorecard: a number sets it, null goes back to what the clips say.
 * Stored in `scoreEdits` (used by the scorecard, the made videos and the AI summary).
 */
export function setHoleEdit(hole: string, patch: Partial<Record<keyof HoleEdit, number | null>>) {
  E().edit(
    'Score',
    (d) => {
      const e: HoleEdit = { ...(d.scoreEdits?.[hole] ?? {}) };
      for (const [k, v] of Object.entries(patch) as [keyof HoleEdit, number | null | undefined][]) {
        if (v == null) delete e[k];
        else e[k] = v;
      }
      const all = { ...(d.scoreEdits ?? {}) };
      if (Object.keys(e).length) all[hole] = e;
      else delete all[hole];
      if (Object.keys(all).length) d.scoreEdits = all;
      else delete d.scoreEdits;
    },
    { key: `score:${hole}:${Object.keys(patch).join()}` },
  );
}

/** Sets the hole a clip was filmed on by hand (no GPS, or GPS off the course); '' clears it. */
export function setClipHole(mediaId: string, hole: string) {
  E().edit('Hole', (d) => {
    const m = d.media[mediaId];
    if (!m) return;
    if (m.place) m.place.hole = hole;
    else if (hole) m.place = { course: '', hole, par: null, fromTee: null, toGreen: null, line: [] };
  });
}

/** Moves the playhead to where a video first appears on the timeline. */
export function jumpToMedia(mediaId: string): boolean {
  const doc = E().doc;
  const i = doc.clips.findIndex((c) => c.mediaId === mediaId);
  if (i < 0) return false;
  seekTo(clipStarts(doc.clips)[i]);
  return true;
}
