'use client';

import { layerEnv, placeLayer, screenTransform, type OverlayContext } from '@golf/render';
import { aspectRatio, clipAt, cropAt, primaryMedia, type Layer, type Shot } from '@golf/schema';
import { project as projectFlight } from '@golf/physics';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useI18n } from '@/lib/i18n/client';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import * as ops from './ops';
import { PlayerEngine, loadRendererFonts } from './player';
import { useEditor, useLiveDoc } from './store';

export let player: PlayerEngine | null = null;

interface Size {
  width: number;
  height: number;
}

const SNAP_PX = 6;
/** Grab margin around the video: handles just outside the picture stay reachable there. */
export const GRAB_MARGIN = 24;
/** Handles further out are drawn as markers on the video's edge, this far from its corners. */
const MARKER_CORNER = 10;

type HandleName = 'start' | 'apex' | 'landing';
const DRAW_ORDER: HandleName[] = ['start', 'apex', 'landing'];

/** Fit an aspect ratio into a box. */
function fit(box: Size, r: number): Size {
  const w = Math.min(box.width, box.height * r);
  return { width: Math.floor(w), height: Math.floor(w / r) };
}

export function Preview({ onRequestRetrack }: { onRequestRetrack: (mediaId: string, time: number, ball: { x: number; y: number }) => void }) {
  const { t, f, locale } = useI18n();
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Size>({ width: 640, height: 360 });
  const [fontsOk, setFontsOk] = useState(false);
  const doc = useLiveDoc();
  // The editable overlay (handles, layer boxes, clickable paths) follows the playhead only while
  // paused: during playback the canvas draws every frame and React stays idle.
  const time = useEditor((s) => (s.playing ? -1 : s.time));
  const playing = time < 0;
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);

  const media = primaryMedia(doc);
  const ratio = media ? aspectRatio(doc.format.aspect, media) : 16 / 9;
  const view = fit(box, ratio);
  const viewRef = useRef({ width: view.width, height: view.height, dpr: 1 });
  viewRef.current = { width: view.width, height: view.height, dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1 };

  useEffect(() => {
    if (!host.current || !canvas.current) return;
    player = new PlayerEngine(host.current, canvas.current, locale);
    player.setView(viewRef.current);
    void loadRendererFonts().then(() => setFontsOk(true));
    return () => {
      player?.destroy();
      player = null;
    };
  }, [locale]);

  useEffect(() => {
    player?.setView({ width: view.width, height: view.height, dpr: window.devicePixelRatio || 1 });
  }, [view.width, view.height]);

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Coordinate mapping between source pixels and the on-screen preview.
  const stNow = useMemo(() => (playing ? null : screenTransform({ project: doc, width: view.width }, time)), [doc, view.width, time, playing]);
  // The mapping only changes when the crop or the clip changes, not with every frame: keep it
  // stable so the flight paths are not projected again on each scrub step.
  const stKey = stNow ? `${stNow.mediaId}|${stNow.crop.x}|${stNow.crop.y}|${stNow.tf.scale}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const st = useMemo(() => stNow, [stKey]);
  const toScreen = useCallback((p: { x: number; y: number }) => (st ? { x: (p.x - st.crop.x) * st.tf.scale, y: (p.y - st.crop.y) * st.tf.scale } : p), [st]);
  const toSource = useCallback((p: { x: number; y: number }) => (st ? { x: p.x / st.tf.scale + st.crop.x, y: p.y / st.tf.scale + st.crop.y } : p), [st]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ------------------------------------------------------------------------------------------
  // Shots on screen and their handles

  const shotsHere = useMemo(() => (st ? doc.shots.filter((s) => s.mediaId === st.mediaId && s.visible && s.kind !== 'putt') : []), [doc.shots, st]);
  const selectedShot = selection?.kind === 'shot' ? (doc.shots.find((s) => s.id === selection.id) ?? null) : null;
  const activeShot: Shot | null = selectedShot && st && selectedShot.mediaId === st.mediaId && selectedShot.kind !== 'putt' ? selectedShot : null;
  const handles = activeShot ? ops.handlesFor(activeShot) : null;

  const paths = useMemo(() => {
    return shotsHere.map((s) => {
      const pr = projectFlight(s.params, s.camera, s.constraints.start ?? s.anchor, true);
      if (!pr) return { id: s.id, d: '' };
      let d = '';
      for (let i = 0; i < pr.n; i += 4) {
        const q = toScreen({ x: pr.u[i], y: pr.v[i] });
        d += `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      }
      return { id: s.id, d };
    });
  }, [shotsHere, toScreen]);

  const [dragging, setDragging] = useState<
    | null
    | { kind: 'handle' }
    | { kind: 'layer'; ids: string[]; last: { x: number; y: number } }
    | { kind: 'scale' | 'rotate'; id: string; cx: number; cy: number; base: number; start: { x: number; y: number } }
    | { kind: 'reframe'; last: { x: number; y: number } }
  >(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  function startHandle(e: RPointerEvent, shot: Shot, h: ops.HandleKind, offView = false) {
    e.stopPropagation();
    // Captured by the (stable) wrapper: an edge marker is replaced by the handle as the drag starts.
    (wrap.current ?? (e.target as Element)).setPointerCapture(e.pointerId);
    useEditor.getState().setPlaying(false);
    ops.beginHandleDrag(shot.id, h, offView ? ops.visibleBox(shot) : undefined);
    setDragging({ kind: 'handle' });
    // A handle grabbed at the edge jumps to the pointer at once.
    if (offView) void ops.dragHandle(toSource(local(e)));
  }

  // Off-screen handles: drawn as markers at the edge of the grab margin, pointing at them.
  const offMarkers = useMemo(() => {
    if (!handles) return [];
    const out: { h: HandleName; x: number; y: number; angle: number }[] = [];
    for (const h of DRAW_ORDER) {
      const q = toScreen(handles[h]);
      if (q.x >= -GRAB_MARGIN && q.x <= view.width + GRAB_MARGIN && q.y >= -GRAB_MARGIN && q.y <= view.height + GRAB_MARGIN) continue;
      // On the edge of the video (the arrow points out into the margin, the label in).
      // Beyond a corner, the edge it is further past (relative to the video's size) wins.
      const ox = (q.x < 0 ? -q.x : Math.max(0, q.x - view.width)) / view.width;
      const oy = (q.y < 0 ? -q.y : Math.max(0, q.y - view.height)) / view.height;
      const cx = Math.min(Math.max(q.x, MARKER_CORNER), view.width - MARKER_CORNER);
      const cy = Math.min(Math.max(q.y, MARKER_CORNER), view.height - MARKER_CORNER);
      const x = ox >= oy ? (q.x < 0 ? 0 : view.width) : cx;
      const y = ox >= oy ? cy : q.y < 0 ? 0 : view.height;
      out.push({ h, x, y, angle: (Math.atan2(q.y - y, q.x - x) * 180) / Math.PI });
    }
    return out;
  }, [handles, toScreen, view.width, view.height]);
  const offNames = new Set(offMarkers.map((m) => m.h));

  // "Draw the path": three clicks (start, apex, landing) replace the handles.
  const [drawn, setDrawn] = useState<{ x: number; y: number }[]>([]);
  const drawing = tool === 'drawPath' && !!activeShot;
  useEffect(() => setDrawn([]), [tool, activeShot?.id]);

  // ------------------------------------------------------------------------------------------
  // Layers on screen

  const env = useMemo(() => {
    if (playing) return null;
    const oc: OverlayContext = { project: doc, width: view.width, height: view.height, locale, images: new Map() };
    return layerEnv(oc, time);
    // fontsOk: measuring needs the fonts loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, view.width, view.height, locale, time, fontsOk, playing]);

  const placed = useMemo(() => {
    if (!fontsOk || !env) return [];
    return doc.layers.map((l) => ({ l, p: placeLayer(l, time, env) })).filter((x): x is { l: Layer; p: NonNullable<ReturnType<typeof placeLayer>> } => !!x.p);
  }, [doc.layers, time, env, fontsOk]);

  const selectedLayers = selection?.kind === 'layer' ? selection.ids : [];

  function layerPointerDown(e: RPointerEvent, l: Layer) {
    if (tool !== 'select') return;
    e.stopPropagation();
    useEditor.getState().setPlaying(false);
    const ids = e.shiftKey ? Array.from(new Set([...selectedLayers, l.id])) : selectedLayers.includes(l.id) ? selectedLayers : [l.id];
    useEditor.getState().select({ kind: 'layer', ids });
    if (l.locked) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging({ kind: 'layer', ids, last: local(e) });
  }

  function onPointerMove(e: RPointerEvent) {
    if (!dragging) return;
    const p = local(e);
    if (dragging.kind === 'handle') {
      void ops.dragHandle(toSource(p));
    } else if (dragging.kind === 'layer') {
      let dx = (p.x - dragging.last.x) / view.width;
      let dy = (p.y - dragging.last.y) / view.height;
      // Snapping: centre lines and other layers' centres.
      const gx: number[] = [];
      const gy: number[] = [];
      const first = placed.find((x) => x.l.id === dragging.ids[0]);
      if (first && useEditor.getState().snapping && !e.altKey) {
        const cx = first.p.x + dx * view.width;
        const cy = first.p.y + dy * view.height;
        const others = placed.filter((x) => !dragging.ids.includes(x.l.id));
        const xs = [view.width / 2, ...others.map((o) => o.p.x)];
        const ys = [view.height / 2, ...others.map((o) => o.p.y)];
        for (const x of xs)
          if (Math.abs(cx - x) < SNAP_PX) {
            dx += (x - cx) / view.width;
            gx.push(x);
            break;
          }
        for (const y of ys)
          if (Math.abs(cy - y) < SNAP_PX) {
            dy += (y - cy) / view.height;
            gy.push(y);
            break;
          }
      }
      setGuides({ x: gx, y: gy });
      if (dx || dy) ops.moveLayers(dragging.ids, time, dx, dy, 'drag');
      setDragging({ ...dragging, last: { x: dragging.last.x + dx * view.width, y: dragging.last.y + dy * view.height } });
    } else if (dragging.kind === 'scale') {
      const d0 = Math.hypot(dragging.start.x - dragging.cx, dragging.start.y - dragging.cy);
      const d1 = Math.hypot(p.x - dragging.cx, p.y - dragging.cy);
      const s = Math.max(0.05, Math.min(20, dragging.base * (d1 / Math.max(1, d0))));
      ops.setLayerTransform(dragging.id, time, { scale: Math.round(s * 100) / 100 }, 'scale');
    } else if (dragging.kind === 'rotate') {
      let a = (Math.atan2(p.y - dragging.cy, p.x - dragging.cx) * 180) / Math.PI + 90;
      if (!e.altKey) a = Math.round(a / 5) * 5;
      if (Math.abs(a) < 3) a = 0;
      ops.setLayerTransform(dragging.id, time, { rotation: a }, 'rotate');
    } else if (dragging.kind === 'reframe' && st && media) {
      const dx = (p.x - dragging.last.x) / st.tf.scale / media.width;
      const dy = (p.y - dragging.last.y) / st.tf.scale / media.height;
      const c = cropAt(doc, media, time);
      ops.setReframeAt(time, (c.x + c.w / 2) / media.width - dx, (c.y + c.h / 2) / media.height - dy, 'reframe-drag');
      setDragging({ kind: 'reframe', last: p });
    }
  }

  function onPointerUp() {
    if (dragging?.kind === 'handle') void ops.endHandleDrag();
    setDragging(null);
    setGuides({ x: [], y: [] });
  }

  function onBackgroundDown(e: RPointerEvent) {
    const p = local(e);
    const s = useEditor.getState();
    s.setPlaying(false);
    if (tool === 'drawPath') {
      e.stopPropagation();
      if (!activeShot || !st) return;
      const pts = [...drawn, toSource(p)];
      if (pts.length < 3) {
        setDrawn(pts);
        return;
      }
      ops.drawShot(activeShot.id, pts[0], pts[1], pts[2]);
      setDrawn([]);
      s.setTool('select');
      return;
    }
    if (tool === 'addPoint' && activeShot && st) {
      void ops.addPointConstraint(activeShot.id, stNow?.sourceTime ?? st.sourceTime, toSource(p));
      s.setTool('select');
      return;
    }
    if (tool === 'addShot' && st) {
      onRequestRetrack(st.mediaId, stNow?.sourceTime ?? st.sourceTime, toSource(p));
      s.setTool('select');
      return;
    }
    if (tool === 'reframe' || (e.altKey && doc.format.aspect !== 'original')) {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDragging({ kind: 'reframe', last: p });
      return;
    }
    s.select(null);
  }

  const hasVideo = useEditor((s) => !!clipAt(s.doc.clips, s.time));
  const cursor = tool === 'addPoint' || tool === 'addShot' || tool === 'drawPath' ? 'cursor-crosshair' : tool === 'reframe' ? 'cursor-move' : '';
  const offView = !!activeShot && tool === 'select' && !dragging && (!handles || offMarkers.length > 0);
  const M = GRAB_MARGIN;

  return (
    <div ref={outer} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6" data-testid="preview">
      <div
        ref={wrap}
        className={cn('relative', cursor)}
        style={{ width: view.width, height: view.height }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          ops.cancelHandleDrag();
          setDragging(null);
        }}
      >
        <div ref={host} className="absolute inset-0 overflow-hidden bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          <canvas
            ref={canvas}
            data-testid="preview-canvas"
            className="pointer-events-none absolute inset-0 size-full"
            aria-label={t.editor.panels.properties}
          />
          {!hasVideo ? <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">{t.editor.noVideoTitle}</div> : null}
        </div>
        {/* The overlay reaches GRAB_MARGIN past the video, in the same coordinates as the video. */}
        <svg
          className="absolute touch-none select-none"
          style={{ left: -M, top: -M, width: view.width + 2 * M, height: view.height + 2 * M }}
          viewBox={`${-M} ${-M} ${view.width + 2 * M} ${view.height + 2 * M}`}
          onPointerDown={onBackgroundDown}
          role="application"
          aria-label={t.tracer.editOnVideo}
          data-testid="preview-overlay"
        >
          {/* clickable flight paths */}
          {paths.map((p) =>
            p.d ? (
              <path
                key={p.id}
                d={p.d}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                className="cursor-pointer"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  useEditor.getState().select({ kind: 'shot', id: p.id });
                }}
              />
            ) : null,
          )}
          {activeShot && !drawing ? (
            <path
              d={paths.find((p) => p.id === activeShot.id)?.d}
              fill="none"
              stroke="white"
              strokeOpacity={0.55}
              strokeWidth={1}
              strokeDasharray="4 4"
              pointerEvents="none"
            />
          ) : null}

          {/* layer boxes */}
          {placed.map(({ l, p }) => {
            const sel = selectedLayers.includes(l.id);
            const w = p.box.w * p.scale;
            const h = p.box.h * p.scale;
            return (
              <g key={l.id} transform={`translate(${p.x} ${p.y}) rotate(${p.rotation})`}>
                <rect
                  x={-w / 2}
                  y={-h / 2}
                  width={w}
                  height={h}
                  fill="transparent"
                  stroke={sel ? '#F04438' : 'transparent'}
                  strokeWidth={1.5}
                  className={cn(tool === 'select' && 'cursor-move hover:stroke-white/50')}
                  onPointerDown={(e) => layerPointerDown(e, l)}
                  onDoubleClick={() => document.getElementById(`layer-text-${l.id}`)?.focus()}
                />
                {sel && selectedLayers.length === 1 && !l.locked ? (
                  <>
                    <line x1={0} y1={-h / 2} x2={0} y2={-h / 2 - 22} stroke="#F04438" strokeWidth={1.5} />
                    <circle
                      cx={0}
                      cy={-h / 2 - 26}
                      r={6}
                      fill="white"
                      stroke="#F04438"
                      strokeWidth={1.5}
                      className="cursor-grab"
                      aria-label={t.layers.rotation}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.target as Element).setPointerCapture(e.pointerId);
                        setDragging({ kind: 'rotate', id: l.id, cx: p.x, cy: p.y, base: p.rotation, start: local(e) });
                      }}
                    />
                    <rect
                      x={w / 2 - 5}
                      y={h / 2 - 5}
                      width={10}
                      height={10}
                      fill="white"
                      stroke="#F04438"
                      strokeWidth={1.5}
                      className="cursor-nwse-resize"
                      aria-label={t.layers.scale}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.target as Element).setPointerCapture(e.pointerId);
                        setDragging({ kind: 'scale', id: l.id, cx: p.x, cy: p.y, base: p.scale, start: local(e) });
                      }}
                    />
                  </>
                ) : null}
              </g>
            );
          })}

          {/* snapping guides */}
          {guides.x.map((x) => (
            <line key={`gx${x}`} x1={x} x2={x} y1={0} y2={view.height} stroke="#F04438" strokeWidth={1} strokeDasharray="3 3" />
          ))}
          {guides.y.map((y) => (
            <line key={`gy${y}`} y1={y} y2={y} x1={0} x2={view.width} stroke="#F04438" strokeWidth={1} strokeDasharray="3 3" />
          ))}

          {/* tracer handles */}
          {activeShot && handles && !drawing ? (
            <g>
              {DRAW_ORDER.filter((h) => !offNames.has(h)).map((h) => {
                const q = toScreen(handles[h]);
                const label = t.tracer.handles[h];
                return (
                  <g
                    key={h}
                    data-testid={`handle-${h}`}
                    transform={`translate(${q.x} ${q.y})`}
                    className="cursor-grab"
                    onPointerDown={(e) => startHandle(e, activeShot, h)}
                  >
                    <circle r={14} fill="transparent" />
                    {h === 'apex' ? (
                      <rect x={-6} y={-6} width={12} height={12} transform="rotate(45)" fill="white" stroke="#F04438" strokeWidth={2} />
                    ) : (
                      <circle
                        r={h === 'landing' ? 7 : 6}
                        fill={h === 'start' ? '#F04438' : 'white'}
                        stroke={h === 'start' ? 'white' : '#F04438'}
                        strokeWidth={2}
                      />
                    )}
                    <text y={-14} textAnchor="middle" fontSize={11} fontWeight={600} fill="white" stroke="rgba(0,0,0,.6)" strokeWidth={3} paintOrder="stroke">
                      {label}
                    </text>
                    <title>{label}</title>
                  </g>
                );
              })}
              {activeShot.constraints.points.map((pt, i) => {
                const q = toScreen(pt);
                return (
                  <g
                    key={`pt${i}`}
                    transform={`translate(${q.x} ${q.y})`}
                    className="cursor-grab"
                    onPointerDown={(e) => startHandle(e, activeShot, { point: i })}
                    onDoubleClick={() => void ops.removePointConstraint(activeShot.id, i)}
                  >
                    <circle r={12} fill="transparent" />
                    <rect x={-5} y={-5} width={10} height={10} fill="white" stroke="#F04438" strokeWidth={2} />
                    <title>{t.tracer.handles.point}</title>
                  </g>
                );
              })}
              {offMarkers.map((m) => {
                const label = t.tracer.handles[m.h];
                const name = f(t.tracer.offViewMarker, { name: label });
                // The label sits on the picture side of the marker, opposite its arrow.
                const a = (m.angle * Math.PI) / 180;
                const lx = -Math.cos(a) * 16;
                const ly = -Math.sin(a) * 18 + 4;
                const anchor = Math.cos(a) > 0.5 ? 'end' : Math.cos(a) < -0.5 ? 'start' : 'middle';
                return (
                  <g
                    key={`off-${m.h}`}
                    data-testid={`offscreen-${m.h}`}
                    transform={`translate(${m.x} ${m.y})`}
                    className="cursor-grab"
                    role="button"
                    aria-label={name}
                    onPointerDown={(e) => startHandle(e, activeShot, m.h, true)}
                  >
                    <circle r={16} fill="transparent" />
                    <g transform={`rotate(${m.angle})`}>
                      <path d="M 6 -7 L 17 0 L 6 7 Z" fill="#F04438" stroke="white" strokeWidth={1.5} strokeLinejoin="round" />
                    </g>
                    <circle
                      r={8}
                      fill={m.h === 'start' ? '#F04438' : 'white'}
                      stroke={m.h === 'start' ? 'white' : '#F04438'}
                      strokeWidth={2}
                      strokeDasharray="3 2"
                    />
                    <text
                      x={lx}
                      y={ly}
                      textAnchor={anchor}
                      fontSize={11}
                      fontWeight={600}
                      fill="white"
                      stroke="rgba(0,0,0,.6)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {label}
                    </text>
                    <title>{name}</title>
                  </g>
                );
              })}
            </g>
          ) : null}

          {/* "Draw the path": the clicks so far; a cover takes every click */}
          {drawing ? (
            <g>
              <rect x={-M} y={-M} width={view.width + 2 * M} height={view.height + 2 * M} fill="transparent" data-testid="draw-cover" />
              {drawn.map((p, i) => {
                const q = toScreen(p);
                return (
                  <g key={i} transform={`translate(${q.x} ${q.y})`} pointerEvents="none">
                    <circle r={6} fill={i === 0 ? '#F04438' : 'white'} stroke={i === 0 ? 'white' : '#F04438'} strokeWidth={2} />
                    <text y={-12} textAnchor="middle" fontSize={11} fontWeight={600} fill="white" stroke="rgba(0,0,0,.6)" strokeWidth={3} paintOrder="stroke">
                      {t.tracer.handles[DRAW_ORDER[i]]}
                    </text>
                  </g>
                );
              })}
              {drawn.length > 1 ? (
                <polyline
                  points={drawn.map((p) => `${toScreen(p).x},${toScreen(p).y}`).join(' ')}
                  fill="none"
                  stroke="white"
                  strokeOpacity={0.7}
                  strokeDasharray="4 4"
                  pointerEvents="none"
                />
              ) : null}
            </g>
          ) : null}
        </svg>
        {tool !== 'select' ? (
          <div
            className={cn(
              'pointer-events-none absolute left-1/2 w-max max-w-[calc(100%-16px)] -translate-x-1/2 rounded-sm bg-gray-950/80 px-3 py-1.5 text-center text-[13px] text-white',
              // Drawing: away from the point to click (the start is low, the apex high).
              tool === 'drawPath' && drawn.length > 0 ? 'bottom-3' : 'top-3',
            )}
            data-testid="preview-hint"
          >
            {tool === 'drawPath' ? (
              <>
                <span className="tabular mr-1.5 font-semibold text-red-300">{f(t.tracer.drawStep, { n: Math.min(3, drawn.length + 1) })}</span>
                {t.tracer.drawSteps[DRAW_ORDER[Math.min(2, drawn.length)]]}
                <button
                  type="button"
                  className="pointer-events-auto ml-2 rounded-sm px-1.5 py-0.5 text-white/70 underline-offset-2 hover:bg-white/10 hover:text-white"
                  onClick={() => useEditor.getState().setTool('select')}
                >
                  {t.tracer.drawCancel}
                </button>
              </>
            ) : tool === 'addPoint' ? (
              t.tracer.addPointHint
            ) : tool === 'addShot' ? (
              t.shots.addManualStep1
            ) : (
              t.format.dragToReframe
            )}
          </div>
        ) : null}
        {offView && activeShot ? (
          // Bottom-left: the corner a down-the-line flight (start bottom centre) rarely uses.
          <div
            className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-0.5 rounded-sm bg-gray-950/85 p-1 pl-2 text-[12px] text-white"
            data-testid="offview-bar"
            title={t.tracer.offViewShort}
          >
            <AlertTriangle className="mr-1 size-3.5 shrink-0 text-amber-400" aria-label={t.tracer.offViewShort} />
            <Tooltip label={t.tracer.intoView}>
              <button
                type="button"
                aria-label={t.tracer.intoView}
                className="whitespace-nowrap rounded-sm bg-white/10 px-2 py-1 font-medium hover:bg-white/20"
                onClick={() => ops.bringIntoView(activeShot.id)}
              >
                {t.tracer.intoViewShort}
              </button>
            </Tooltip>
            <Tooltip label={t.tracer.draw}>
              <button
                type="button"
                aria-label={t.tracer.draw}
                className="whitespace-nowrap rounded-sm px-2 py-1 font-medium text-white/80 hover:bg-white/10"
                onClick={() => useEditor.getState().setTool('drawPath')}
              >
                {t.tracer.drawShort}
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}
