'use client';

/**
 * The timeline. Built to stay light in long rounds:
 * - the playhead is moved with a CSS transform from a store subscription (no React render per
 *   frame), and nothing else here subscribes to the time;
 * - tracks and items are memoised, so a drag re-renders only what it changes;
 * - filmstrips, waveforms and ruler ticks are drawn only for the visible stretch (+ a margin).
 */
import { ArrowLeftToLine, ArrowRightToLine, Gauge, Magnet, Music, Scissors, Snowflake, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { shotStats } from '@golf/render';
import { clipDuration, clipStarts, timelineDuration, type AudioClip, type Clip, type Layer, type Project, type Shot } from '@golf/schema';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import * as ops from './ops';
import { snapTime, timelineRemap } from './ripple';
import { onReveal } from './reveal';
import { selectedClipIds, useEditor, type MediaInfo } from './store';

const LABEL_W = 92;
const ROW = { video: 64, tracer: 26, layer: 24, audio: 34 };
const SNAP_PX = 8;
const MIN_ZOOM = 8;
const MAX_ZOOM = 800;
/** Visible-range granularity (px): the window only changes state when it crosses a chunk. */
const CHUNK = 512;

const S = useEditor.getState;

// ---------------------------------------------------------------------------------------------
// Zoom (also used by the keyboard shortcuts)

let scrollerEl: HTMLDivElement | null = null;
/** Where the next zoom change keeps still: a time and its x in the scroller (cursor or playhead). */
let zoomAnchor: { t: number; x: number } | null = null;

export function setZoom(z: number, anchor?: { t: number; x: number }) {
  zoomAnchor = anchor ?? null;
  useEditor.setState({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) });
}

/** Zoom so the whole round fits the window (\ or Shift+Z). */
export function fitTimeline() {
  const w = (scrollerEl?.clientWidth ?? 800) - LABEL_W - 24;
  setZoom(w / Math.max(1, timelineDuration(S().doc)), { t: 0, x: 0 });
}

// ---------------------------------------------------------------------------------------------
// Waveforms: fetched once per media file

const waveCache = new Map<string, Promise<Uint8Array | null>>();

function useWaveform(m: MediaInfo | undefined) {
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  const url = m?.urls.waveform;
  const id = m?.id;
  useEffect(() => {
    if (!url || !id) return;
    let alive = true;
    let p = waveCache.get(id);
    if (!p) {
      p = fetch(url)
        .then((r) => r.json())
        .then((j: { peaks: string }) => {
          const bin = atob(j.peaks);
          const a = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
          return a;
        })
        .catch(() => {
          waveCache.delete(id);
          return null;
        });
      waveCache.set(id, p);
    }
    void p.then((a) => alive && setPeaks(a));
    return () => {
      alive = false;
    };
    // The signed URL changes on refresh; the file does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, !!url]);
  return peaks;
}

/** The waveform of [from, to] source seconds, drawn at `left` px inside its clip. */
const Waveform = memo(function Waveform({
  peaks,
  from,
  to,
  left,
  width,
  height,
}: {
  peaks: Uint8Array;
  from: number;
  to: number;
  left: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const n = c.width;
    for (let x = 0; x < n; x++) {
      const t0 = from + ((to - from) * x) / n;
      const t1 = from + ((to - from) * (x + 1)) / n;
      let v = 0;
      for (let i = Math.floor(t0 * 100); i <= Math.ceil(t1 * 100) && i < peaks.length; i++) if (i >= 0 && peaks[i] > v) v = peaks[i];
      const h = (v / 255) * c.height;
      ctx.fillRect(x, c.height - h, 1, h);
    }
  }, [peaks, from, to, width, height]);
  return <canvas ref={ref} style={{ left, width, height }} className="pointer-events-none absolute bottom-0" aria-hidden />;
});

/** Filmstrip tiles i0..i1 (of `tw` px each) of a clip. */
const Thumbs = memo(function Thumbs({ m, clip, width, i0, i1 }: { m: MediaInfo | undefined; clip: Clip; width: number; i0: number; i1: number }) {
  const th = m?.thumbs;
  const url = m?.urls.thumbs;
  if (!th || !url) return null;
  const scale = (ROW.video - 4) / th.height;
  const tw = th.width * scale;
  const items = [];
  for (let i = i0; i <= i1; i++) {
    const src = clip.kind === 'freeze' ? clip.at : clip.in + ((clip.out - clip.in) * (i * tw + tw / 2)) / Math.max(1, width);
    const idx = Math.min(th.count - 1, Math.max(0, Math.floor(src / th.interval)));
    const col = idx % th.cols;
    const row = Math.floor(idx / th.cols);
    items.push(
      <div
        key={i}
        className="absolute inset-y-0 bg-no-repeat"
        style={{
          left: i * tw,
          width: tw,
          backgroundImage: `url(${url})`,
          backgroundSize: `${th.cols * th.width * scale}px ${th.rows * th.height * scale}px`,
          backgroundPosition: `${-col * tw}px ${-row * th.height * scale}px`,
        }}
      />,
    );
  }
  return <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-80">{items}</div>;
});

// ---------------------------------------------------------------------------------------------
// Pointer targets and drags

type Target =
  | { kind: 'clip'; id: string; index: number }
  | { kind: 'clip-edge'; id: string; index: number; edge: 'in' | 'out' }
  | { kind: 'freeze-len'; id: string; index: number }
  | { kind: 'layer'; id: string; mode: 'move' | 'start' | 'end' }
  | { kind: 'music'; id: string; mode: 'move' | 'start' | 'end' }
  /** The ruler: move the playhead. Empty track space also deselects. */
  | { kind: 'scrub'; deselect?: boolean };

type OnDown = (e: RPointerEvent, target: Target) => void;

type Drag =
  | { kind: 'scrub'; points: number[] }
  | {
      kind: 'clip-trim';
      id: string;
      edge: 'in' | 'out';
      startX: number;
      base: number;
      speed: number;
      edge0: number;
      doc0: Project;
      time0: number;
      points: number[];
    }
  | { kind: 'clip-move'; index: number; startX: number; moved: boolean; drop: number | null }
  | { kind: 'freeze-len'; id: string; startX: number; base: number; doc0: Project; time0: number; edge0: number; points: number[] }
  | { kind: 'layer'; id: string; mode: 'move' | 'start' | 'end'; startX: number; s0: number; e0: number; points: number[] }
  | { kind: 'music'; id: string; mode: 'move' | 'start' | 'end'; startX: number; a: AudioClip; points: number[] };

function shotBarsOf(doc: Project) {
  return doc.shots
    .map((s) => {
      const launch = ops.shotLaunchTime(doc, s);
      if (launch == null) return null;
      const st = shotStats(s);
      const len = s.kind === 'putt' ? Math.max(0.5, (s.putt?.end ?? s.impactTime + 4) - s.impactTime) : ((st?.flightTimeS ?? 4) / s.timing.speed) * s.slowmo;
      return { s, start: launch, end: launch + len };
    })
    .filter((x): x is { s: Shot; start: number; end: number } => !!x);
}

/** Everything a drag can snap to: cuts, shot launches and landings, graphics, music, playhead, in/out. */
function snapPointsOf(doc: Project, exclude: number[] = []): number[] {
  const st = useEditor.getState();
  const total = timelineDuration(doc);
  const pts = [
    0,
    total,
    ...clipStarts(doc.clips),
    ...shotBarsOf(doc).flatMap((b) => [b.start, b.end]),
    ...doc.layers.flatMap((l) => [l.start, l.end]),
    ...doc.audioTracks.flatMap((a) => [a.start, a.start + a.out - a.in]),
    st.time,
    ...(st.inPoint != null ? [st.inPoint] : []),
    ...(st.outPoint != null ? [st.outPoint] : []),
  ];
  return pts.filter((p) => !exclude.some((e) => Math.abs(e - p) < 1e-6));
}

// ---------------------------------------------------------------------------------------------

export function Timeline() {
  const { t, f } = useI18n();
  const doc = useEditor((s) => s.doc);
  const media = useEditor((s) => s.media);
  const zoom = useEditor((s) => s.zoom);
  const snapping = useEditor((s) => s.snapping);
  const selection = useEditor((s) => s.selection);
  const scroller = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lastZoom = useRef(zoom);
  const [moving, setMoving] = useState<{ index: number; drop: number } | null>(null);
  const vp = useViewport(scroller);
  const total = timelineDuration(doc);
  const starts = useMemo(() => clipStarts(doc.clips), [doc.clips]);
  const width = Math.max(total * zoom + 200, 400);
  const shotBars = useMemo(() => shotBarsOf(doc), [doc]);

  // Graphics layers packed into lanes so overlapping layers do not hide each other.
  const lanes = useMemo(() => {
    const out: Layer[][] = [];
    for (const l of [...doc.layers].sort((a, b) => a.start - b.start)) {
      const lane = out.find((ln) => ln.every((x) => x.end <= l.start + 1e-6 || x.start >= l.end - 1e-6));
      if (lane) lane.push(l);
      else out.push([l]);
    }
    return out;
  }, [doc.layers]);

  const selClips = useMemo(() => new Set(selectedClipIds(selection)), [selection]);
  const selShot = selection?.kind === 'shot' ? selection.id : null;
  const selLayerKey = selection?.kind === 'layer' ? selection.ids.join(',') : '';
  const selLayers = useMemo(() => new Set(selLayerKey ? selLayerKey.split(',') : []), [selLayerKey]);
  const selAudio = selection?.kind === 'audio' ? selection.id : null;
  const selectedShot = doc.shots.find((s) => s.id === selShot) ?? null;

  // Zoom keeps a point still: the cursor (ctrl+wheel) or else the playhead.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const before = lastZoom.current;
    lastZoom.current = zoom;
    if (before === zoom) return;
    const a = zoomAnchor ?? { t: S().time, x: S().time * before - el.scrollLeft };
    zoomAnchor = null;
    const x = a.x >= 0 && a.x <= el.clientWidth - LABEL_W ? a.x : (el.clientWidth - LABEL_W) / 2;
    el.scrollLeft = Math.max(0, a.t * zoom - x);
  }, [zoom]);

  // ctrl/⌘ + wheel zooms around the cursor. Native listener: React's wheel listener is passive,
  // so it cannot stop the browser from zooming the page.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    scrollerEl = el;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - LABEL_W;
      const z = S().zoom;
      setZoom(z * Math.exp(-e.deltaY * 0.002), { t: (x + el.scrollLeft) / z, x });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (scrollerEl === el) scrollerEl = null;
    };
  }, []);

  const xToTime = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return (clientX - r.left - LABEL_W + el.scrollLeft) / S().zoom;
  };

  const showGuide = (at: number | null) => {
    const g = guide.current;
    if (!g) return;
    g.style.display = at == null ? 'none' : 'block';
    if (at != null) g.style.transform = `translateX(${LABEL_W + at * S().zoom}px)`;
  };

  /** Snaps t (unless snapping is off or Alt is held) and shows the guide line. */
  const snap = (tt: number, points: number[], e: { altKey: boolean }) => {
    const st = S();
    if (!st.snapping || e.altKey) {
      showGuide(null);
      return tt;
    }
    const r = snapTime(tt, points, SNAP_PX / st.zoom);
    showGuide(r.to);
    return r.t;
  };

  const onDown: OnDown = useCallback((e, target) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const st = S();
    st.setPlaying(false);
    const doc0 = st.doc;
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    switch (target.kind) {
      case 'scrub': {
        if (target.deselect && !multi) st.select(null);
        drag.current = { kind: 'scrub', points: snapPointsOf(doc0).filter((p) => Math.abs(p - st.time) > 1e-6) };
        st.setTime(xToTime(e.clientX));
        break;
      }
      case 'clip': {
        const cur = selectedClipIds(st.selection);
        if (multi) {
          const ids = cur.includes(target.id) ? cur.filter((x) => x !== target.id) : [...cur, target.id];
          st.select(ids.length ? { kind: 'clip', id: ids.includes(target.id) ? target.id : ids[ids.length - 1], ids } : null);
        } else if (!cur.includes(target.id) || cur.length < 2) st.select({ kind: 'clip', id: target.id });
        else st.select({ kind: 'clip', id: target.id, ids: cur });
        drag.current = { kind: 'clip-move', index: target.index, startX: e.clientX, moved: false, drop: null };
        break;
      }
      case 'clip-edge': {
        const c = doc0.clips[target.index];
        if (c?.kind !== 'video') return;
        st.select({ kind: 'clip', id: c.id });
        const s0 = clipStarts(doc0.clips)[target.index];
        const edge0 = target.edge === 'in' ? s0 : s0 + clipDuration(c);
        drag.current = {
          kind: 'clip-trim',
          id: c.id,
          edge: target.edge,
          startX: e.clientX,
          base: target.edge === 'in' ? c.in : c.out,
          speed: c.speed,
          edge0,
          doc0,
          time0: st.time,
          points: snapPointsOf(doc0, [edge0]),
        };
        break;
      }
      case 'freeze-len': {
        const c = doc0.clips[target.index];
        if (c?.kind !== 'freeze') return;
        st.select({ kind: 'clip', id: c.id });
        const edge0 = clipStarts(doc0.clips)[target.index] + c.duration;
        drag.current = { kind: 'freeze-len', id: c.id, startX: e.clientX, base: c.duration, doc0, time0: st.time, edge0, points: snapPointsOf(doc0, [edge0]) };
        break;
      }
      case 'layer': {
        const l = doc0.layers.find((x) => x.id === target.id);
        if (!l) return;
        const cur = st.selection?.kind === 'layer' ? st.selection.ids : [];
        if (target.mode === 'move' && multi) st.select({ kind: 'layer', ids: cur.includes(l.id) ? cur.filter((x) => x !== l.id) : [...cur, l.id] });
        else if (!cur.includes(l.id)) st.select({ kind: 'layer', ids: [l.id] });
        drag.current = { kind: 'layer', id: l.id, mode: target.mode, startX: e.clientX, s0: l.start, e0: l.end, points: snapPointsOf(doc0, [l.start, l.end]) };
        break;
      }
      case 'music': {
        const a = doc0.audioTracks.find((x) => x.id === target.id);
        if (!a) return;
        st.select({ kind: 'audio', id: a.id });
        drag.current = { kind: 'music', id: a.id, mode: target.mode, startX: e.clientX, a, points: snapPointsOf(doc0, [a.start, a.start + a.out - a.in]) };
        break;
      }
    }
    // Stable on purpose (memoised tracks): reads everything from the store at event time.
  }, []);

  function onMove(e: RPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const st = S();
    const z = st.zoom;
    const tt = xToTime(e.clientX);
    const dx = (e.clientX - ('startX' in d ? d.startX : 0)) / z;
    switch (d.kind) {
      case 'scrub':
        st.setTime(snap(tt, d.points, e));
        break;
      case 'clip-trim': {
        // The edge follows the pointer (and snaps); timeline seconds → source seconds at the clip's speed.
        const at = snap(d.edge0 + dx, d.points, e);
        ops.trimClip(d.id, d.edge, d.base + (at - d.edge0) * d.speed, 'trim-drag', { base: d.doc0 });
        // Live preview: show the frame at the edge being trimmed.
        const doc = S().doc;
        const i = doc.clips.findIndex((c) => c.id === d.id);
        if (i >= 0) {
          const s0 = clipStarts(doc.clips)[i];
          const fps = ops.fpsOf(doc.clips[i].mediaId);
          st.setTime(d.edge === 'in' ? s0 : s0 + clipDuration(doc.clips[i]) - 1 / fps);
        }
        break;
      }
      case 'clip-move': {
        if (!d.moved && Math.abs(dx * z) <= 4) break;
        d.moved = true;
        const doc = st.doc;
        const ss = clipStarts(doc.clips);
        let idx = doc.clips.length;
        for (let i = 0; i < doc.clips.length; i++) {
          if (tt < ss[i] + clipDuration(doc.clips[i]) / 2) {
            idx = i;
            break;
          }
        }
        if (idx !== d.drop) {
          d.drop = idx;
          setMoving({ index: d.index, drop: idx });
        }
        break;
      }
      case 'freeze-len': {
        const at = snap(d.edge0 + dx, d.points, e);
        ops.setFreezeDuration(d.id, d.base + (at - d.edge0), { base: d.doc0 });
        st.setTime(Math.max(0, at - 1 / 30));
        break;
      }
      case 'layer': {
        const len = d.e0 - d.s0;
        if (d.mode === 'move') {
          // Snap whichever edge is closer to something.
          const raw = d.s0 + dx;
          const on = st.snapping && !e.altKey;
          const tol = SNAP_PX / z;
          const a = on ? snapTime(raw, d.points, tol) : { t: raw, to: null };
          const b = on ? snapTime(raw + len, d.points, tol) : { t: raw + len, to: null };
          const useEnd = b.to != null && (a.to == null || Math.abs(b.t - (raw + len)) < Math.abs(a.t - raw));
          const s = useEnd ? b.t - len : a.t;
          showGuide(useEnd ? b.to : a.to);
          ops.setLayerTiming(d.id, Math.max(0, s), Math.max(0, s) + len, 'tl-move');
        } else if (d.mode === 'start') ops.setLayerTiming(d.id, snap(d.s0 + dx, d.points, e), d.e0, 'tl-start');
        else ops.setLayerTiming(d.id, d.s0, snap(d.e0 + dx, d.points, e), 'tl-end');
        break;
      }
      case 'music': {
        const a = d.a;
        if (d.mode === 'move') ops.updateMusic(a.id, { start: Math.max(0, snap(a.start + dx, d.points, e)) }, 'tl-move');
        else if (d.mode === 'start') {
          const dd = Math.max(-a.in, Math.min(dx, a.out - a.in - 0.5));
          ops.updateMusic(a.id, { start: Math.max(0, a.start + dd), in: a.in + dd }, 'tl-start');
        } else {
          const m = st.media[a.mediaId];
          const end = snap(a.start + a.out - a.in + dx, d.points, e);
          ops.updateMusic(a.id, { out: Math.min(m?.duration ?? Infinity, Math.max(a.in + 0.5, a.in + end - a.start)) }, 'tl-end');
        }
        break;
      }
    }
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    showGuide(null);
    if (!d) return;
    if (d.kind === 'clip-move' && d.moved && d.drop != null) ops.moveClip(d.index, d.drop > d.index ? d.drop - 1 : d.drop);
    if (d.kind === 'clip-trim' || d.kind === 'freeze-len') {
      // Back to where the playhead was, on the same picture.
      S().setTime(timelineRemap(d.doc0.clips, S().doc.clips)(d.time0));
    }
    setMoving(null);
  }

  const delIds = [...selClips];

  return (
    <section aria-label={t.timeline.title} className="flex min-h-0 flex-col border-t border-border bg-surface" data-testid="timeline">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Tooltip label={t.timeline.split} shortcut="S">
          <Button variant="ghost" size="sm" onClick={() => ops.splitAt(S().time)}>
            <Scissors />
            <span className="hidden xl:inline">{t.timeline.split}</span>
          </Button>
        </Tooltip>
        <Tooltip label={t.timeline.trimStart} shortcut="Q">
          <Button variant="ghost" size="iconSm" aria-label={t.timeline.trimStart} onClick={() => ops.trimToPlayhead('start')}>
            <ArrowLeftToLine />
          </Button>
        </Tooltip>
        <Tooltip label={t.timeline.trimEnd} shortcut="W">
          <Button variant="ghost" size="iconSm" aria-label={t.timeline.trimEnd} onClick={() => ops.trimToPlayhead('end')}>
            <ArrowRightToLine />
          </Button>
        </Tooltip>
        <Tooltip label={t.timeline.freeze}>
          <Button variant="ghost" size="sm" onClick={() => ops.freezeAt(S().time)}>
            <Snowflake />
            <span className="hidden xl:inline">{t.timeline.freeze}</span>
          </Button>
        </Tooltip>
        <Tooltip label={t.timeline.slowmo}>
          <Button variant="ghost" size="sm" disabled={!selectedShot} onClick={() => selectedShot && ops.slowmoAroundShot(selectedShot)}>
            <Gauge />
            <span className="hidden xl:inline">{t.timeline.slowmo}</span>
          </Button>
        </Tooltip>
        <Tooltip label={delIds.length > 1 ? f(t.timeline.deleteMany, { n: delIds.length }) : t.timeline.ripple} shortcut="⌫">
          <Button
            variant="ghost"
            size="iconSm"
            aria-label={delIds.length > 1 ? f(t.timeline.deleteMany, { n: delIds.length }) : t.timeline.ripple}
            disabled={!delIds.length || doc.clips.length - delIds.length < 1}
            onClick={() => ops.deleteClips(delIds)}
          >
            <Trash2 />
          </Button>
        </Tooltip>
        <EditHints />
        <div className="ml-auto flex items-center gap-1">
          <Tooltip label={t.timeline.snapping} shortcut="Alt">
            <Button
              variant="ghost"
              size="iconSm"
              aria-pressed={snapping}
              aria-label={t.timeline.snapping}
              className={cn(snapping && 'text-accent-fg')}
              onClick={() => useEditor.setState({ snapping: !snapping })}
            >
              <Magnet />
            </Button>
          </Tooltip>
          <Tooltip label={t.timeline.zoomOut} shortcut="−">
            <Button variant="ghost" size="iconSm" aria-label={t.timeline.zoomOut} onClick={() => setZoom(zoom / 1.4)}>
              <ZoomOut />
            </Button>
          </Tooltip>
          <Tooltip label={t.timeline.zoomIn} shortcut="+">
            <Button variant="ghost" size="iconSm" aria-label={t.timeline.zoomIn} onClick={() => setZoom(zoom * 1.4)}>
              <ZoomIn />
            </Button>
          </Tooltip>
          <Tooltip label={t.shortcuts.items.fit} shortcut="\">
            <Button variant="ghost" size="sm" onClick={fitTimeline}>
              {t.timeline.fit}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div
        ref={scroller}
        className="scrollbar-thin relative min-h-0 flex-1 overflow-auto"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        data-testid="timeline-scroller"
      >
        <div className="relative" style={{ width: width + LABEL_W }}>
          <Ruler zoom={zoom} total={total} vp={vp} onDown={onDown} />

          <Row label={t.timeline.video} height={ROW.video} onDown={onDown}>
            <VideoTrack clips={doc.clips} starts={starts} media={media} zoom={zoom} selected={selClips} moving={moving} vp={vp} onDown={onDown} />
          </Row>

          <Row label={t.timeline.tracer} height={ROW.tracer} onDown={onDown}>
            <TracerTrack bars={shotBars} zoom={zoom} selected={selShot} />
          </Row>

          {(lanes.length ? lanes : [[]]).map((lane, li) => (
            <Row key={li} label={li === 0 ? t.timeline.graphics : ''} height={ROW.layer} onDown={onDown}>
              <LayerLane lane={lane} zoom={zoom} selected={selLayers} onDown={onDown} />
            </Row>
          ))}

          <Row label={t.timeline.music} height={ROW.audio} onDown={onDown}>
            <MusicTrack tracks={doc.audioTracks} media={media} docMedia={doc.media} zoom={zoom} selected={selAudio} onDown={onDown} />
          </Row>

          <div ref={guide} className="pointer-events-none absolute top-0 bottom-0 left-0 z-30 hidden w-px bg-warning" aria-hidden data-testid="snap-guide" />
          <Playhead scroller={scroller} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

/** The visible stretch of the timeline in content px, in CHUNK steps plus a chunk of margin. */
function useViewport(scroller: React.RefObject<HTMLDivElement | null>): [number, number] {
  const [vp, setVp] = useState<[number, number]>([0, 4 * CHUNK]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const left = el.scrollLeft;
      const w = el.clientWidth || 1600;
      const from = Math.max(0, (Math.floor(left / CHUNK) - 1) * CHUNK);
      const to = (Math.ceil((left + w) / CHUNK) + 1) * CHUNK;
      setVp((v) => (v[0] === from && v[1] === to ? v : [from, to]));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scroller]);
  return vp;
}

/** The playhead: moved by a store subscription, never by a React render. Follows playback. */
function Playhead({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = (time: number, zoom: number, playing: boolean) => {
      const el = ref.current;
      if (!el) return;
      const x = time * zoom;
      el.style.transform = `translateX(${LABEL_W + x}px)`;
      const sc = scroller.current;
      if (sc && playing) {
        const w = sc.clientWidth - LABEL_W;
        if (x > sc.scrollLeft + w - 40 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 40);
      }
    };
    const s0 = S();
    place(s0.time, s0.zoom, false);
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.time !== prev.time || s.zoom !== prev.zoom) place(s.time, s.zoom, s.playing);
    });
    // A jump from a list (a shot, a hole): centre the playhead when it is out of view.
    const unreveal = onReveal((time) => {
      const sc = scroller.current;
      if (!sc) return;
      const x = time * S().zoom;
      const w = sc.clientWidth - LABEL_W;
      if (x < sc.scrollLeft + 8 || x > sc.scrollLeft + w - 40) sc.scrollLeft = Math.max(0, x - w / 2);
    });
    return () => {
      unsub();
      unreveal();
    };
  }, [scroller]);
  return (
    <div ref={ref} className="pointer-events-none absolute top-0 bottom-0 left-0 z-30 w-px bg-red-500 will-change-transform" data-testid="playhead">
      <div className="absolute -left-[5px] top-0 size-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-500" />
    </div>
  );
}

const Ruler = memo(function Ruler({ zoom, total, vp, onDown }: { zoom: number; total: number; vp: [number, number]; onDown: OnDown }) {
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);
  const step = zoom > 160 ? 0.5 : zoom > 60 ? 1 : zoom > 25 ? 5 : zoom > 12 ? 10 : 30;
  const ticks: number[] = [];
  const from = Math.max(0, Math.floor(vp[0] / zoom / step) * step);
  const to = Math.min(total + step, vp[1] / zoom);
  for (let s = from; s <= to; s += step) ticks.push(Math.round(s * 1000) / 1000);
  return (
    <div className="sticky top-0 z-20 flex h-6 cursor-text border-b border-border bg-surface" onPointerDown={(e) => onDown(e, { kind: 'scrub' })}>
      <div className="sticky left-0 z-10 w-[92px] shrink-0 border-r border-border bg-surface" />
      <div className="relative flex-1">
        {ticks.map((s) => (
          <span
            key={s}
            className="tabular absolute top-0 h-full border-l border-border-strong/60 pl-1 text-[10px] leading-6 text-fg-subtle"
            style={{ left: s * zoom }}
          >
            {step < 1 ? s.toFixed(1) : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`}
          </span>
        ))}
        {inPoint != null || outPoint != null ? (
          <div className="absolute top-0 h-full bg-red-500/15" style={{ left: (inPoint ?? 0) * zoom, width: ((outPoint ?? total) - (inPoint ?? 0)) * zoom }} />
        ) : null}
      </div>
    </div>
  );
});

function Row({ label, height, children, onDown }: { label: string; height: number; children: ReactNode; onDown: OnDown }) {
  return (
    <div className="flex border-b border-border/70" style={{ height }}>
      <div className="sticky left-0 z-10 flex w-[92px] shrink-0 items-center border-r border-border bg-surface px-2 text-[11px] font-medium text-fg-muted">
        {label}
      </div>
      {/* Empty track space: deselect and move the playhead. */}
      <div className="relative flex-1" onPointerDown={(e) => e.target === e.currentTarget && onDown(e, { kind: 'scrub', deselect: true })}>
        {children}
      </div>
    </div>
  );
}

const VideoTrack = memo(function VideoTrack({
  clips,
  starts,
  media,
  zoom,
  selected,
  moving,
  vp,
  onDown,
}: {
  clips: Clip[];
  starts: number[];
  media: Record<string, MediaInfo>;
  zoom: number;
  selected: Set<string>;
  moving: { index: number; drop: number } | null;
  vp: [number, number];
  onDown: OnDown;
}) {
  const total = starts.length ? starts[starts.length - 1] + clipDuration(clips[clips.length - 1]) : 0;
  return (
    <>
      {clips.map((c, i) => (
        <ClipItem
          key={c.id}
          clip={c}
          index={i}
          left={starts[i] * zoom}
          width={Math.max(4, clipDuration(c) * zoom)}
          m={media[c.mediaId]}
          selected={selected.has(c.id)}
          dimmed={moving?.index === i}
          vp={vp}
          onDown={onDown}
        />
      ))}
      {moving ? (
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: (moving.drop < clips.length ? starts[moving.drop] : total) * zoom }} />
      ) : null}
    </>
  );
});

const ClipItem = memo(function ClipItem({
  clip: c,
  index,
  left,
  width: w,
  m,
  selected,
  dimmed,
  vp,
  onDown,
}: {
  clip: Clip;
  index: number;
  left: number;
  width: number;
  m: MediaInfo | undefined;
  selected: boolean;
  dimmed: boolean;
  vp: [number, number];
  onDown: OnDown;
}) {
  const { t, f } = useI18n();
  const peaks = useWaveform(c.kind === 'video' && !c.muted ? m : undefined);
  // The part of the clip on screen (px inside the clip).
  const visFrom = Math.max(0, vp[0] - left);
  const visTo = Math.min(w, vp[1] - left);
  const th = m?.thumbs;
  const tw = th ? (th.width * (ROW.video - 4)) / th.height : 0;
  const onKey = (e: RKeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const st = S();
    const cur = selectedClipIds(st.selection);
    if (e.shiftKey) st.select({ kind: 'clip', id: c.id, ids: cur.includes(c.id) ? cur : [...cur, c.id] });
    else st.select({ kind: 'clip', id: c.id });
  };
  const dur = clipDuration(c);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={f(t.timeline.clipLabel, { n: index + 1, s: dur.toFixed(1) })}
      aria-pressed={selected}
      onKeyDown={onKey}
      className={cn(
        'absolute top-1 bottom-1 overflow-hidden rounded-[5px] border bg-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-white',
        selected ? 'border-red-500 ring-1 ring-red-500' : 'border-gray-700',
        dimmed && 'opacity-50',
      )}
      style={{ left, width: w }}
      onPointerDown={(e) => onDown(e, { kind: 'clip', id: c.id, index })}
      data-testid="clip"
    >
      {tw && visTo > visFrom ? <Thumbs m={m} clip={c} width={w} i0={Math.floor(visFrom / tw)} i1={Math.max(0, Math.ceil(visTo / tw) - 1)} /> : null}
      {c.kind === 'video' && peaks && visTo > visFrom ? (
        <Waveform
          peaks={peaks}
          left={visFrom}
          width={visTo - visFrom}
          from={c.in + ((c.out - c.in) * visFrom) / w}
          to={c.in + ((c.out - c.in) * visTo) / w}
          height={18}
        />
      ) : null}
      <div className="absolute left-1.5 top-1 flex items-center gap-1 rounded-[3px] bg-gray-950/70 px-1 text-[10px] font-medium text-white">
        {c.kind === 'freeze' ? <Snowflake className="size-3" /> : null}
        {c.kind === 'video' && c.speed !== 1 ? `${c.speed}×` : null}
      </div>
      {c.kind === 'video' ? (
        <>
          <div
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40"
            aria-label={t.timeline.trimHint}
            onPointerDown={(e) => onDown(e, { kind: 'clip-edge', id: c.id, index, edge: 'in' })}
            data-testid="trim-in"
          />
          <div
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40"
            aria-label={t.timeline.trimHint}
            onPointerDown={(e) => onDown(e, { kind: 'clip-edge', id: c.id, index, edge: 'out' })}
            data-testid="trim-out"
          />
        </>
      ) : (
        <div
          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/40"
          aria-label={t.timeline.trimHint}
          onPointerDown={(e) => onDown(e, { kind: 'freeze-len', id: c.id, index })}
        />
      )}
    </div>
  );
});

const TracerTrack = memo(function TracerTrack({
  bars,
  zoom,
  selected,
}: {
  bars: { s: Shot; start: number; end: number }[];
  zoom: number;
  selected: string | null;
}) {
  const { t } = useI18n();
  return (
    <>
      {bars.map(({ s, start, end }, i) => (
        <button
          key={s.id}
          type="button"
          className={cn(
            'absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-[4px] px-1.5 text-left text-[10px] font-medium text-white',
            !s.visible && 'opacity-40',
            selected === s.id ? 'ring-2 ring-white' : '',
          )}
          style={{
            left: start * zoom,
            width: Math.max(10, (end - start) * zoom),
            background: s.style.color2 ? `linear-gradient(90deg, ${s.style.color}, ${s.style.color2})` : s.style.color,
            color: s.style.color === '#ffffff' ? '#111113' : '#fff',
          }}
          data-shot={s.id}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => ops.jumpToShot(s)}
        >
          {s.confidence < 0.6 ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden /> : null}
          <span className="truncate">{s.label || (s.kind === 'putt' ? t.shots.putt : t.shots.shot.replace('{n}', String(i + 1)))}</span>
        </button>
      ))}
    </>
  );
});

const LayerLane = memo(function LayerLane({ lane, zoom, selected, onDown }: { lane: Layer[]; zoom: number; selected: Set<string>; onDown: OnDown }) {
  const { t } = useI18n();
  return (
    <>
      {lane.map((l) => {
        const sel = selected.has(l.id);
        return (
          <div
            key={l.id}
            role="button"
            tabIndex={0}
            aria-pressed={sel}
            onKeyDown={(e) => e.key === 'Enter' && S().select({ kind: 'layer', ids: [l.id] })}
            className={cn(
              'absolute top-[3px] bottom-[3px] overflow-hidden rounded-[4px] border px-1.5 text-[10px] leading-[16px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-white',
              sel ? 'border-red-500 bg-red-500/25' : 'border-border-strong bg-surface-sunken',
              l.hidden && 'opacity-40',
            )}
            style={{ left: l.start * zoom, width: Math.max(8, (l.end - l.start) * zoom) }}
            onPointerDown={(e) => onDown(e, { kind: 'layer', id: l.id, mode: 'move' })}
          >
            <span className="pointer-events-none truncate">{l.name && l.name !== l.type ? l.name : t.layers.types[l.type]}</span>
            <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => onDown(e, { kind: 'layer', id: l.id, mode: 'start' })} />
            <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => onDown(e, { kind: 'layer', id: l.id, mode: 'end' })} />
          </div>
        );
      })}
    </>
  );
});

const MusicTrack = memo(function MusicTrack({
  tracks,
  media,
  docMedia,
  zoom,
  selected,
  onDown,
}: {
  tracks: AudioClip[];
  media: Record<string, MediaInfo>;
  docMedia: Project['media'];
  zoom: number;
  selected: string | null;
  onDown: OnDown;
}) {
  const { t } = useI18n();
  return (
    <>
      {tracks.map((a) => {
        const sel = selected === a.id;
        return (
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            aria-pressed={sel}
            onKeyDown={(e) => e.key === 'Enter' && S().select({ kind: 'audio', id: a.id })}
            className={cn(
              'absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-[4px] border px-1.5 text-[10px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-white',
              sel ? 'border-red-500 bg-red-500/20' : 'border-border-strong bg-surface-sunken',
            )}
            style={{ left: a.start * zoom, width: Math.max(8, (a.out - a.in) * zoom) }}
            onPointerDown={(e) => onDown(e, { kind: 'music', id: a.id, mode: 'move' })}
          >
            <Music className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{media[a.mediaId]?.name ?? docMedia[a.mediaId]?.name}</span>
            <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => onDown(e, { kind: 'music', id: a.id, mode: 'start' })} />
            <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => onDown(e, { kind: 'music', id: a.id, mode: 'end' })} />
          </div>
        );
      })}
      {!tracks.length ? <span className="pointer-events-none absolute left-2 top-2 text-[11px] text-fg-subtle">{t.timeline.emptyMusic}</span> : null}
    </>
  );
});

/** The shortcuts that apply to what is selected, right in the toolbar. */
function EditHints() {
  const { t } = useI18n();
  const kind = useEditor((s) => s.selection?.kind ?? 'none');
  const h = t.timeline.hints;
  const alt = 'Alt';
  const items: [string[], string][] =
    kind === 'clip'
      ? [
          [['S'], h.split],
          [['Q', 'W'], h.trimTo],
          [['⌫'], h.delete],
          [[alt, '←→'], h.reorder],
          [['Shift', 'click'], h.multi],
        ]
      : kind === 'layer'
        ? [
            [['↑↓←→'], h.nudge],
            [[alt, '←→'], h.shift],
            [['⌫'], h.remove],
            [['Shift', 'click'], h.multi],
          ]
        : kind === 'shot'
          ? [
              [['[', ']'], h.shots],
              [['S'], h.split],
              [['⌫'], h.remove],
            ]
          : [
              [['S'], h.split],
              [['↑', '↓'], h.cuts],
              [['[', ']'], h.shots],
              [['\\'], h.fit],
            ];
  return (
    <div className="ml-3 hidden min-w-0 items-center gap-3 overflow-hidden text-[11px] text-fg-subtle xl:flex" aria-label={h.label} role="note">
      {items.map(([keys, label]) => (
        <span key={label} className="flex shrink-0 items-center gap-1">
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
          <span>{label}</span>
        </span>
      ))}
      <span className="flex shrink-0 items-center gap-1">
        <Kbd>?</Kbd>
        <span>{h.all}</span>
      </span>
    </div>
  );
}
