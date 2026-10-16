'use client';

import { layerEnv, placeLayer, screenTransform, type OverlayContext } from '@golf/render';
import { aspectRatio, clipAt, cropAt, primaryMedia, type Layer, type Shot } from '@golf/schema';
import { project as projectFlight } from '@golf/physics';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useI18n } from '@/lib/i18n/client';
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

/** Fit an aspect ratio into a box. */
function fit(box: Size, r: number): Size {
  const w = Math.min(box.width, box.height * r);
  return { width: Math.floor(w), height: Math.floor(w / r) };
}

export function Preview({ onRequestRetrack }: { onRequestRetrack: (mediaId: string, time: number, ball: { x: number; y: number }) => void }) {
  const { t, locale } = useI18n();
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Size>({ width: 640, height: 360 });
  const [fontsOk, setFontsOk] = useState(false);
  const doc = useLiveDoc();
  const time = useEditor((s) => s.time);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);

  const media = primaryMedia(doc);
  const ratio = media ? aspectRatio(doc.format.aspect, media) : 16 / 9;
  const view = fit(box, ratio);

  useEffect(() => {
    if (!host.current || !canvas.current) return;
    player = new PlayerEngine(host.current, canvas.current, locale);
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
  const st = useMemo(() => screenTransform({ project: doc, width: view.width }, time), [doc, view.width, time]);
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

  function startHandle(e: RPointerEvent, shot: Shot, h: ops.HandleKind) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    useEditor.getState().setPlaying(false);
    ops.beginHandleDrag(shot.id, h);
    setDragging({ kind: 'handle' });
  }

  // ------------------------------------------------------------------------------------------
  // Layers on screen

  const env = useMemo(() => {
    const oc: OverlayContext = { project: doc, width: view.width, height: view.height, locale, images: new Map() };
    return layerEnv(oc, time);
    // fontsOk: measuring needs the fonts loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, view.width, view.height, locale, time, fontsOk]);

  const placed = useMemo(() => {
    if (!fontsOk) return [];
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
    if (tool === 'addPoint' && activeShot && st) {
      void ops.addPointConstraint(activeShot.id, st.sourceTime, toSource(p));
      s.setTool('select');
      return;
    }
    if (tool === 'addShot' && st) {
      onRequestRetrack(st.mediaId, st.sourceTime, toSource(p));
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

  const hasVideo = !!clipAt(doc.clips, time);
  const cursor = tool === 'addPoint' || tool === 'addShot' ? 'cursor-crosshair' : tool === 'reframe' ? 'cursor-move' : '';

  return (
    <div ref={outer} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4" data-testid="preview">
      <div
        ref={host}
        className={cn('relative overflow-hidden bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.06)]', cursor)}
        style={{ width: view.width, height: view.height }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          ops.cancelHandleDrag();
          setDragging(null);
        }}
      >
        <canvas ref={canvas} data-testid="preview-canvas" className="pointer-events-none absolute inset-0 size-full" aria-label={t.editor.panels.properties} />
        <svg
          className="absolute inset-0 size-full touch-none select-none"
          onPointerDown={onBackgroundDown}
          role="application"
          aria-label={t.tracer.editOnVideo}
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
          {activeShot ? (
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
          {activeShot && handles ? (
            <g>
              {(['start', 'apex', 'landing'] as const).map((h) => {
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
            </g>
          ) : null}
        </svg>
        {!hasVideo ? <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">{t.editor.noVideoTitle}</div> : null}
        {tool !== 'select' ? (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-sm bg-gray-950/80 px-3 py-1.5 text-[13px] text-white">
            {tool === 'addPoint' ? t.tracer.addPointHint : tool === 'addShot' ? t.shots.addManualStep1 : t.format.dragToReframe}
          </div>
        ) : null}
      </div>
    </div>
  );
}
