'use client';

import { Gauge, Magnet, Music, Scissors, Snowflake, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { shotStats } from '@golf/render';
import { clipDuration, clipStarts, timelineDuration, type AudioClip, type Clip, type Layer, type Shot } from '@golf/schema';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import * as ops from './ops';
import { useEditor, type MediaInfo } from './store';

const LABEL_W = 92;
const ROW = { video: 64, tracer: 26, layer: 24, audio: 34 };
const SNAP_PX = 8;

function useWaveform(m: MediaInfo | undefined) {
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  const url = m?.urls.waveform;
  const id = m?.id;
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url)
      .then((r) => r.json())
      .then((j: { peaks: string }) => {
        if (!alive) return;
        const bin = atob(j.peaks);
        const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        setPeaks(a);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // The signed URL changes on refresh; the file does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, !!url]);
  return peaks;
}

const Waveform = memo(function Waveform({
  peaks,
  from,
  to,
  width,
  height,
  color,
}: {
  peaks: Uint8Array;
  from: number;
  to: number;
  width: number;
  height: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = color;
    const n = c.width;
    for (let x = 0; x < n; x++) {
      const t0 = from + ((to - from) * x) / n;
      const t1 = from + ((to - from) * (x + 1)) / n;
      let v = 0;
      for (let i = Math.floor(t0 * 100); i <= Math.ceil(t1 * 100) && i < peaks.length; i++) if (i >= 0 && peaks[i] > v) v = peaks[i];
      const h = (v / 255) * c.height;
      ctx.fillRect(x, c.height - h, 1, h);
    }
  }, [peaks, from, to, width, height, color]);
  return <canvas ref={ref} style={{ width, height }} className="pointer-events-none absolute bottom-0 left-0" aria-hidden />;
});

function Thumbs({ m, clip, width }: { m: MediaInfo | undefined; clip: Clip; width: number }) {
  const th = m?.thumbs;
  const url = m?.urls.thumbs;
  if (!th || !url) return null;
  const scale = (ROW.video - 4) / th.height;
  const tw = th.width * scale;
  const n = Math.max(1, Math.ceil(width / tw));
  const items = [];
  for (let i = 0; i < n; i++) {
    const src = clip.kind === 'freeze' ? clip.at : clip.in + ((clip.out - clip.in) * (i * tw + tw / 2)) / Math.max(1, width);
    const idx = Math.min(th.count - 1, Math.max(0, Math.floor(src / th.interval)));
    const col = idx % th.cols;
    const row = Math.floor(idx / th.cols);
    items.push(
      <div
        key={i}
        className="h-full shrink-0 bg-no-repeat"
        style={{
          width: tw,
          backgroundImage: `url(${url})`,
          backgroundSize: `${th.cols * th.width * scale}px ${th.rows * th.height * scale}px`,
          backgroundPosition: `${-col * tw}px ${-row * th.height * scale}px`,
        }}
      />,
    );
  }
  return <div className="pointer-events-none absolute inset-0 flex overflow-hidden opacity-80">{items}</div>;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'clip-trim'; id: string; edge: 'in' | 'out'; startX: number; base: number; speed: number }
  | { kind: 'clip-move'; index: number; startX: number; moved: boolean }
  | { kind: 'freeze-len'; id: string; startX: number; base: number }
  | { kind: 'layer'; id: string; mode: 'move' | 'start' | 'end'; startX: number; s0: number; e0: number }
  | { kind: 'music'; id: string; mode: 'move' | 'start' | 'end'; startX: number; a: AudioClip };

export function Timeline() {
  const { t } = useI18n();
  const doc = useEditor((s) => s.doc);
  const media = useEditor((s) => s.media);
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.zoom);
  const snapping = useEditor((s) => s.snapping);
  const selection = useEditor((s) => s.selection);
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const total = timelineDuration(doc);
  const starts = clipStarts(doc.clips);
  const width = Math.max(total * zoom + 200, 400);
  const S = useEditor.getState;

  const firstVideo = doc.clips[0] ? media[doc.clips[0].mediaId] : undefined;
  const peaks = useWaveform(firstVideo);

  const shotBars = useMemo(
    () =>
      doc.shots
        .map((s) => {
          const launch = ops.shotLaunchTime(doc, s);
          if (launch == null) return null;
          const st = shotStats(s);
          const len = ((st?.flightTimeS ?? 4) / s.timing.speed) * s.slowmo;
          return { s, start: launch, end: launch + len };
        })
        .filter((x): x is { s: Shot; start: number; end: number } => !!x),
    [doc],
  );

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

  const snapPoints = useMemo(() => {
    const pts = [0, total, ...starts, ...shotBars.flatMap((b) => [b.start, b.end]), ...doc.layers.flatMap((l) => [l.start, l.end])];
    return pts;
  }, [total, starts, shotBars, doc.layers]);

  const snapT = useCallback(
    (tt: number, exclude?: number[]) => {
      if (!snapping) return tt;
      let best = tt;
      let bestD = SNAP_PX / zoom;
      for (const p of [...snapPoints, S().time]) {
        if (exclude?.some((e) => Math.abs(e - p) < 1e-6)) continue;
        const d = Math.abs(p - tt);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    },
    [snapping, zoom, snapPoints, S],
  );

  const xToTime = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return (clientX - r.left - LABEL_W + scroller.current!.scrollLeft) / zoom;
  };

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !S().playing) return;
    const x = time * zoom + LABEL_W;
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - LABEL_W - 40;
  }, [time, zoom, S]);

  function onWheel(e: React.WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const z = Math.min(800, Math.max(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    useEditor.setState({ zoom: z });
  }

  function onMove(e: RPointerEvent) {
    if (!drag) return;
    const tt = xToTime(e.clientX);
    const dx = (e.clientX - ('startX' in drag ? drag.startX : 0)) / zoom;
    switch (drag.kind) {
      case 'scrub':
        S().setTime(snapping ? snapT(tt) : tt);
        break;
      case 'clip-trim': {
        // dx timeline seconds → source seconds at the clip's speed.
        ops.trimClip(drag.id, drag.edge, drag.base + dx * drag.speed, 'trim-drag');
        break;
      }
      case 'clip-move': {
        let idx = doc.clips.length;
        for (let i = 0; i < doc.clips.length; i++) {
          const mid = starts[i] + clipDuration(doc.clips[i]) / 2;
          if (tt < mid) {
            idx = i;
            break;
          }
        }
        setDropIndex(idx);
        if (Math.abs(dx * zoom) > 4 && !drag.moved) setDrag({ ...drag, moved: true });
        break;
      }
      case 'freeze-len':
        ops.setFreezeDuration(drag.id, drag.base + dx);
        break;
      case 'layer': {
        const len = drag.e0 - drag.s0;
        if (drag.mode === 'move') {
          let s = snapT(drag.s0 + dx, [drag.s0, drag.e0]);
          const e2 = snapT(s + len, [drag.s0, drag.e0]);
          if (Math.abs(e2 - (s + len)) < Math.abs(s - (drag.s0 + dx))) s = e2 - len;
          ops.setLayerTiming(drag.id, Math.max(0, s), Math.max(0, s) + len, 'tl-move');
        } else if (drag.mode === 'start') ops.setLayerTiming(drag.id, snapT(drag.s0 + dx, [drag.s0]), drag.e0, 'tl-start');
        else ops.setLayerTiming(drag.id, drag.s0, snapT(drag.e0 + dx, [drag.e0]), 'tl-end');
        break;
      }
      case 'music': {
        const a = drag.a;
        if (drag.mode === 'move') ops.updateMusic(a.id, { start: Math.max(0, snapT(a.start + dx, [a.start])) }, 'tl-move');
        else if (drag.mode === 'start') {
          const d = Math.max(-a.in, Math.min(dx, a.out - a.in - 0.5));
          ops.updateMusic(a.id, { start: Math.max(0, a.start + d), in: a.in + d }, 'tl-start');
        } else {
          const m = media[a.mediaId];
          ops.updateMusic(a.id, { out: Math.min(m?.duration ?? Infinity, Math.max(a.in + 0.5, a.out + dx)) }, 'tl-end');
        }
        break;
      }
    }
  }

  function onUp() {
    if (drag?.kind === 'clip-move' && drag.moved && dropIndex != null) {
      const to = dropIndex > drag.index ? dropIndex - 1 : dropIndex;
      ops.moveClip(drag.index, to);
    }
    setDrag(null);
    setDropIndex(null);
  }

  function capture(e: RPointerEvent) {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    S().setPlaying(false);
  }

  const selClip = selection?.kind === 'clip' ? selection.id : null;
  const selShot = selection?.kind === 'shot' ? selection.id : null;
  const selLayers = selection?.kind === 'layer' ? selection.ids : [];
  const selAudio = selection?.kind === 'audio' ? selection.id : null;
  const selectedShot = doc.shots.find((s) => s.id === selShot) ?? null;

  const ticks = useMemo(() => {
    const step = zoom > 160 ? 0.5 : zoom > 60 ? 1 : zoom > 25 ? 5 : 10;
    const out: number[] = [];
    for (let s = 0; s <= total + step; s += step) out.push(s);
    return { step, out };
  }, [zoom, total]);

  return (
    <section aria-label={t.timeline.title} className="flex min-h-0 flex-col border-t border-border bg-surface" data-testid="timeline">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Tooltip label={t.timeline.split} shortcut="S">
          <Button variant="ghost" size="sm" onClick={() => ops.splitAt(S().time)}>
            <Scissors />
            <span className="hidden xl:inline">{t.timeline.split}</span>
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
        <Tooltip label={t.timeline.delete} shortcut="⌫">
          <Button variant="ghost" size="sm" disabled={!selClip || doc.clips.length < 2} onClick={() => selClip && ops.deleteClip(selClip)}>
            <Trash2 />
          </Button>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip label={t.timeline.snapping}>
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
          <Tooltip label={t.timeline.zoomOut}>
            <Button variant="ghost" size="iconSm" aria-label={t.timeline.zoomOut} onClick={() => useEditor.setState({ zoom: Math.max(8, zoom / 1.4) })}>
              <ZoomOut />
            </Button>
          </Tooltip>
          <Tooltip label={t.timeline.zoomIn}>
            <Button variant="ghost" size="iconSm" aria-label={t.timeline.zoomIn} onClick={() => useEditor.setState({ zoom: Math.min(800, zoom * 1.4) })}>
              <ZoomIn />
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const w = (scroller.current?.clientWidth ?? 800) - LABEL_W - 24;
              useEditor.setState({ zoom: Math.max(8, Math.min(800, w / Math.max(1, total))) });
            }}
          >
            {t.timeline.fit}
          </Button>
        </div>
      </div>

      <div ref={scroller} className="scrollbar-thin relative min-h-0 flex-1 overflow-auto" onWheel={onWheel} onPointerMove={onMove} onPointerUp={onUp}>
        <div className="relative" style={{ width: width + LABEL_W }}>
          {/* ruler */}
          <div
            className="sticky top-0 z-20 flex h-6 cursor-text border-b border-border bg-surface"
            onPointerDown={(e) => {
              capture(e);
              setDrag({ kind: 'scrub' });
              S().setTime(xToTime(e.clientX));
            }}
          >
            <div className="sticky left-0 z-10 w-[92px] shrink-0 border-r border-border bg-surface" />
            <div className="relative flex-1">
              {ticks.out.map((s) => (
                <span
                  key={s}
                  className="tabular absolute top-0 h-full border-l border-border-strong/60 pl-1 text-[10px] leading-6 text-fg-subtle"
                  style={{ left: s * zoom }}
                >
                  {ticks.step < 1 ? s.toFixed(1) : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`}
                </span>
              ))}
              {inPoint != null || outPoint != null ? (
                <div
                  className="absolute top-0 h-full bg-red-500/15"
                  style={{ left: (inPoint ?? 0) * zoom, width: ((outPoint ?? total) - (inPoint ?? 0)) * zoom }}
                />
              ) : null}
            </div>
          </div>

          {/* video track */}
          <Row label={t.timeline.video} height={ROW.video}>
            {doc.clips.map((c, i) => {
              const d = clipDuration(c);
              const left = starts[i] * zoom;
              const w = Math.max(4, d * zoom);
              const m = media[c.mediaId];
              const sel = selClip === c.id;
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.timeline.video} ${i + 1}`}
                  aria-pressed={sel}
                  onKeyDown={(e) => e.key === 'Enter' && S().select({ kind: 'clip', id: c.id })}
                  className={cn(
                    'absolute top-1 bottom-1 overflow-hidden rounded-[5px] border bg-gray-800',
                    sel ? 'border-red-500 ring-1 ring-red-500' : 'border-gray-700',
                    drag?.kind === 'clip-move' && drag.index === i && drag.moved && 'opacity-50',
                  )}
                  style={{ left, width: w }}
                  onPointerDown={(e) => {
                    capture(e);
                    S().select({ kind: 'clip', id: c.id });
                    setDrag({ kind: 'clip-move', index: i, startX: e.clientX, moved: false });
                  }}
                >
                  <Thumbs m={m} clip={c} width={w} />
                  {c.kind === 'video' && peaks && !c.muted ? (
                    <Waveform peaks={peaks} from={c.in} to={c.out} width={w} height={18} color="rgba(255,255,255,0.45)" />
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
                        onPointerDown={(e) => {
                          capture(e);
                          S().select({ kind: 'clip', id: c.id });
                          setDrag({ kind: 'clip-trim', id: c.id, edge: 'in', startX: e.clientX, base: c.in, speed: c.speed });
                        }}
                      />
                      <div
                        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40"
                        aria-label={t.timeline.trimHint}
                        onPointerDown={(e) => {
                          capture(e);
                          S().select({ kind: 'clip', id: c.id });
                          setDrag({ kind: 'clip-trim', id: c.id, edge: 'out', startX: e.clientX, base: c.out, speed: c.speed });
                        }}
                      />
                    </>
                  ) : (
                    <div
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/40"
                      onPointerDown={(e) => {
                        capture(e);
                        setDrag({ kind: 'freeze-len', id: c.id, startX: e.clientX, base: c.duration });
                      }}
                    />
                  )}
                </div>
              );
            })}
            {dropIndex != null && drag?.kind === 'clip-move' && drag.moved ? (
              <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: (dropIndex < doc.clips.length ? starts[dropIndex] : total) * zoom }} />
            ) : null}
          </Row>

          {/* tracer track */}
          <Row label={t.timeline.tracer} height={ROW.tracer}>
            {shotBars.map(({ s, start, end }, i) => (
              <button
                key={s.id}
                type="button"
                className={cn(
                  'absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-[4px] px-1.5 text-left text-[10px] font-medium text-white',
                  !s.visible && 'opacity-40',
                  selShot === s.id ? 'ring-2 ring-white' : '',
                )}
                style={{
                  left: start * zoom,
                  width: Math.max(10, (end - start) * zoom),
                  background: s.style.color2 ? `linear-gradient(90deg, ${s.style.color}, ${s.style.color2})` : s.style.color,
                  color: s.style.color === '#ffffff' ? '#111113' : '#fff',
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => ops.jumpToShot(s)}
              >
                {s.confidence < 0.6 ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden /> : null}
                <span className="truncate">{s.label || `${t.shots.shot.replace('{n}', String(i + 1))}`}</span>
              </button>
            ))}
          </Row>

          {/* graphics lanes */}
          {(lanes.length ? lanes : [[]]).map((lane, li) => (
            <Row key={li} label={li === 0 ? t.timeline.graphics : ''} height={ROW.layer}>
              {lane.map((l) => {
                const sel = selLayers.includes(l.id);
                return (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    className={cn(
                      'absolute top-[3px] bottom-[3px] overflow-hidden rounded-[4px] border px-1.5 text-[10px] leading-[16px] text-fg',
                      sel ? 'border-red-500 bg-red-500/25' : 'border-border-strong bg-surface-sunken',
                      l.hidden && 'opacity-40',
                    )}
                    style={{ left: l.start * zoom, width: Math.max(8, (l.end - l.start) * zoom) }}
                    onPointerDown={(e) => {
                      capture(e);
                      S().select({ kind: 'layer', ids: e.shiftKey ? Array.from(new Set([...selLayers, l.id])) : [l.id] });
                      setDrag({ kind: 'layer', id: l.id, mode: 'move', startX: e.clientX, s0: l.start, e0: l.end });
                    }}
                  >
                    <span className="pointer-events-none truncate">{l.name && l.name !== l.type ? l.name : t.layers.types[l.type]}</span>
                    <div
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
                      onPointerDown={(e) => {
                        capture(e);
                        setDrag({ kind: 'layer', id: l.id, mode: 'start', startX: e.clientX, s0: l.start, e0: l.end });
                      }}
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
                      onPointerDown={(e) => {
                        capture(e);
                        setDrag({ kind: 'layer', id: l.id, mode: 'end', startX: e.clientX, s0: l.start, e0: l.end });
                      }}
                    />
                  </div>
                );
              })}
            </Row>
          ))}

          {/* music */}
          <Row label={t.timeline.music} height={ROW.audio}>
            {doc.audioTracks.map((a) => {
              const sel = selAudio === a.id;
              return (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel}
                  className={cn(
                    'absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-[4px] border px-1.5 text-[10px] text-fg',
                    sel ? 'border-red-500 bg-red-500/20' : 'border-border-strong bg-surface-sunken',
                  )}
                  style={{ left: a.start * zoom, width: Math.max(8, (a.out - a.in) * zoom) }}
                  onPointerDown={(e) => {
                    capture(e);
                    S().select({ kind: 'audio', id: a.id });
                    setDrag({ kind: 'music', id: a.id, mode: 'move', startX: e.clientX, a });
                  }}
                >
                  <Music className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{media[a.mediaId]?.name ?? doc.media[a.mediaId]?.name}</span>
                  <div
                    className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
                    onPointerDown={(e) => {
                      capture(e);
                      setDrag({ kind: 'music', id: a.id, mode: 'start', startX: e.clientX, a });
                    }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
                    onPointerDown={(e) => {
                      capture(e);
                      setDrag({ kind: 'music', id: a.id, mode: 'end', startX: e.clientX, a });
                    }}
                  />
                </div>
              );
            })}
            {!doc.audioTracks.length ? <span className="absolute left-2 top-2 text-[11px] text-fg-subtle">{t.timeline.emptyMusic}</span> : null}
          </Row>

          {/* playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500" style={{ left: LABEL_W + time * zoom }}>
            <div className="absolute -left-[5px] top-0 size-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-500" />
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div className="flex border-b border-border/70" style={{ height }}>
      <div className="sticky left-0 z-10 flex w-[92px] shrink-0 items-center border-r border-border bg-surface px-2 text-[11px] font-medium text-fg-muted">
        {label}
      </div>
      <div className="relative flex-1">{children}</div>
    </div>
  );
}
