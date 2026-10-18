'use client';

/**
 * Preview engine. Plays the timeline (clips with speed, freezes, cuts) over the proxy
 * videos, positions the video with a CSS transform for the current crop, and draws the
 * overlay (tracers + graphics) with packages/render – the same pixels the export uses – on a
 * worker where the browser allows (overlay.ts).
 */
import type { ImageData8 } from '@golf/render';
import { clipAt, clipStarts, clipDuration, cropAt, timelineDuration } from '@golf/schema';
import { refreshMedia } from './mediaUrls';
import { loadRendererFonts, overlayOutput, type OverlayOutput } from './overlay';
import { useEditor, type MediaInfo } from './store';

export { loadRendererFonts };

export interface PlayerView {
  /** Output-frame size in CSS pixels as shown on screen. */
  width: number;
  height: number;
  /** Output size in project terms (aspect); overlay is rendered at the canvas resolution. */
  dpr: number;
}

const MAX_OVERLAY_LONG_SIDE = 1920;

/** The media files whose <video> is kept: the clip under the playhead and its neighbours (a
 *  round has dozens of videos; each element holds decoder memory and buffered data). */
export function mediaToKeep(clips: { mediaId: string }[], index: number): string[] {
  const out: string[] = [];
  for (const i of [index, index + 1, index - 1]) {
    const id = clips[i]?.mediaId;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export class PlayerEngine {
  private videos = new Map<string, HTMLVideoElement>();
  private music = new Map<string, HTMLAudioElement>();
  private out: OverlayOutput;
  private raf = 0;
  private playing = false;
  private freezeStart: { wall: number; t: number } | null = null;
  private activeMedia: string | null = null;
  private activeIndex = -1;
  private lastRenderKey = '';
  private lastDoc: unknown = null;
  private lastLive: unknown = null;
  private unsub: (() => void) | null = null;
  private view: PlayerView = { width: 640, height: 360, dpr: 1 };
  /** Blurred copy of the video behind it ("fill: blur"), drawn small and scaled up by CSS. */
  private backdrop: HTMLCanvasElement | null = null;
  private backdropOn = false;
  hiddenLayerIds: Set<string> = new Set();
  onFrame: ((ms: number) => void) | null = null;

  constructor(
    private host: HTMLDivElement,
    private canvas: HTMLCanvasElement,
    locale: 'da' | 'en',
  ) {
    this.out = overlayOutput(canvas, locale);
    this.out.onDrawn = (ms) => {
      // Marker for tests and the benchmark: first frame with video and overlay on screen.
      if (!this.canvas.dataset.ready && [...this.videos.values()].some((v) => v.readyState >= 2)) this.canvas.dataset.ready = 'true';
      this.onFrame?.(ms);
    };
    this.unsub = useEditor.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        if (s.playing) this.play();
        else this.pause();
      }
      if (!s.playing && (s.time !== prev.time || s.doc !== prev.doc)) this.seek(s.time);
      if (s.doc !== prev.doc || s.live !== prev.live || s.media !== prev.media) this.invalidate();
    });
    void loadRendererFonts().then(() => this.invalidate());
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.out.release();
    for (const v of this.videos.values()) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
    for (const a of this.music.values()) a.pause();
  }

  setView(v: PlayerView): void {
    this.view = v;
    const ratio = Math.min(v.dpr, MAX_OVERLAY_LONG_SIDE / Math.max(v.width, v.height));
    const w = Math.max(2, Math.round(v.width * ratio));
    const h = Math.max(2, Math.round(v.height * ratio));
    this.out.resize(w, h);
    this.invalidate();
    this.positionVideo(useEditor.getState().time);
  }

  invalidate(): void {
    this.lastRenderKey = '';
  }

  // ------------------------------------------------------------------------------------------
  // Video elements

  private video(m: MediaInfo): HTMLVideoElement {
    let v = this.videos.get(m.id);
    if (!v) {
      v = document.createElement('video');
      v.muted = false;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.disablePictureInPicture = true;
      v.setAttribute('aria-hidden', 'true');
      v.style.position = 'absolute';
      v.style.left = '0';
      v.style.top = '0';
      v.style.transformOrigin = '0 0';
      v.style.maxWidth = 'none';
      v.style.pointerEvents = 'none';
      v.style.visibility = 'hidden';
      v.src = m.urls.proxy ?? m.urls.original ?? '';
      const redraw = () => {
        if (this.activeMedia === m.id) this.drawBackdrop(v!);
      };
      v.addEventListener('seeked', redraw);
      v.addEventListener('loadeddata', redraw);
      this.host.prepend(v);
      this.videos.set(m.id, v);
      v.addEventListener('loadeddata', () => {
        this.positionVideo(useEditor.getState().time);
        this.invalidate();
      });
      v.addEventListener('seeked', () => this.invalidate());
      // Its signed URL expired (an editor open for hours): fetch fresh ones and carry on.
      v.addEventListener('error', () => void this.recover(m.id));
      v.dataset.variant = m.urls.proxy ? 'proxy' : 'original';
      v.dataset.media = m.id;
    }
    return v;
  }

  private async recover(id: string): Promise<void> {
    const fresh = await refreshMedia(id);
    const v = this.videos.get(id);
    const src = fresh?.urls.proxy ?? fresh?.urls.original;
    if (!v || !src) return;
    const t = v.currentTime;
    const resume = this.playing && this.activeMedia === id;
    v.dataset.variant = fresh?.urls.proxy ? 'proxy' : 'original';
    v.src = src;
    v.currentTime = t;
    if (resume) void v.play().catch(() => undefined);
  }

  /** Drops the <video> of files away from the playhead; loads the next clip's ahead of time. */
  private prune(index: number): void {
    const { doc, media } = useEditor.getState();
    const keep = mediaToKeep(doc.clips, index);
    for (const [id, v] of this.videos) {
      if (keep.includes(id)) continue;
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      this.videos.delete(id);
    }
    const next = doc.clips[index + 1];
    if (next && next.mediaId !== doc.clips[index]?.mediaId && media[next.mediaId] && !this.videos.has(next.mediaId)) {
      this.video(media[next.mediaId]).currentTime = next.kind === 'video' ? next.in : next.at;
    }
  }

  /** Swap a video to its proxy once the proxy exists (it may be created after opening). */
  refreshSources(): void {
    const media = useEditor.getState().media;
    for (const [id, v] of this.videos) {
      const m = media[id];
      // Signed URLs change with every refresh; only switch when the proxy appears.
      if (m?.urls.proxy && v.dataset.variant !== 'proxy') {
        const t = v.currentTime;
        v.dataset.variant = 'proxy';
        v.src = m.urls.proxy;
        v.currentTime = t;
      }
    }
  }

  private positionVideo(t: number): void {
    const { doc, media } = useEditor.getState();
    if (!doc) return;
    const hit = clipAt(doc.clips, t);
    const mediaId = hit?.clip.mediaId ?? null;
    for (const [id, v] of this.videos) v.style.visibility = id === mediaId ? 'visible' : 'hidden';
    if (!hit || !mediaId) return;
    const m = media[mediaId] ?? doc.media[mediaId];
    if (!m) return;
    const v = this.video(m as MediaInfo);
    if (this.activeMedia !== mediaId || this.activeIndex !== hit.index) {
      this.activeIndex = hit.index;
      this.activeMedia = mediaId;
      this.prune(hit.index);
    }
    const crop = cropAt(doc, m, t);
    const scale = this.view.width / crop.w;
    v.style.width = `${m.width}px`;
    v.style.height = `${m.height}px`;
    v.style.transform = `translate(${-crop.x * scale}px, ${-crop.y * scale}px) scale(${scale})`;
    v.style.visibility = 'visible';
    this.activeMedia = mediaId;
    this.backdropOn = crop.x < -0.5 || crop.y < -0.5;
    this.drawBackdrop(v);
  }

  private drawBackdrop(v: HTMLVideoElement): void {
    if (!this.backdropOn) {
      if (this.backdrop) this.backdrop.style.display = 'none';
      return;
    }
    if (!this.backdrop) {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', filter: 'blur(14px) brightness(0.94) saturate(0.85)' });
      this.host.prepend(c);
      this.backdrop = c;
    }
    const c = this.backdrop;
    c.style.display = 'block';
    c.style.width = `${this.view.width}px`;
    c.style.height = `${this.view.height}px`;
    const ratio = this.view.width / Math.max(1, this.view.height);
    c.width = 96;
    c.height = Math.max(8, Math.round(96 / ratio));
    const ctx = c.getContext('2d');
    if (!ctx || v.readyState < 2 || !v.videoWidth) return;
    // Cover: scale the video to fill the small canvas, centred.
    const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
    const w = v.videoWidth * s;
    const h = v.videoHeight * s;
    ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }

  // ------------------------------------------------------------------------------------------
  // Transport

  seek(t: number): void {
    const { doc, media } = useEditor.getState();
    if (!doc) return;
    const hit = clipAt(doc.clips, t);
    this.positionVideo(t);
    if (!hit) return;
    const m = media[hit.clip.mediaId];
    if (!m) return;
    const v = this.video(m);
    if (Math.abs(v.currentTime - hit.sourceTime) > 0.001) v.currentTime = hit.sourceTime;
    this.syncMusic(t, false);
    this.invalidate();
  }

  private play(): void {
    const s = useEditor.getState();
    const total = timelineDuration(s.doc);
    let t = s.time;
    if (t >= total - 0.02) t = 0;
    this.playing = true;
    this.startClip(t);
  }

  private pause(): void {
    this.playing = false;
    this.freezeStart = null;
    for (const v of this.videos.values()) v.pause();
    for (const a of this.music.values()) a.pause();
  }

  private startClip(t: number): void {
    const { doc, media } = useEditor.getState();
    const hit = clipAt(doc.clips, t);
    if (!hit) {
      useEditor.getState().setPlaying(false);
      return;
    }
    this.positionVideo(t);
    for (const v of this.videos.values()) v.pause();
    useEditor.setState({ time: t });
    if (hit.clip.kind === 'freeze') {
      this.freezeStart = { wall: performance.now(), t };
      const m = media[hit.clip.mediaId];
      if (m) this.video(m).currentTime = hit.sourceTime;
    } else {
      this.freezeStart = null;
      const m = media[hit.clip.mediaId];
      if (!m) return;
      const v = this.video(m);
      v.currentTime = hit.sourceTime;
      v.playbackRate = hit.clip.speed;
      v.volume = Math.min(1, hit.clip.muted || doc.audio.muted ? 0 : hit.clip.volume * doc.audio.originalVolume);
      void v.play().catch(() => useEditor.getState().setPlaying(false));
    }
    this.syncMusic(t, true);
  }

  private tick(): void {
    const s = useEditor.getState();
    const { doc, media } = s;
    const total = timelineDuration(doc);
    const t0 = s.time;
    const hit = clipAt(doc.clips, Math.min(t0, total));
    if (!hit) return void s.setPlaying(false);
    const starts = clipStarts(doc.clips);
    const clipStart = starts[hit.index];
    const clipEnd = clipStart + clipDuration(hit.clip);
    let t: number;
    if (hit.clip.kind === 'freeze') {
      const f = this.freezeStart ?? { wall: performance.now(), t: t0 };
      this.freezeStart = f;
      t = f.t + (performance.now() - f.wall) / 1000;
    } else {
      const m = media[hit.clip.mediaId];
      const v = m ? this.video(m) : null;
      if (!v) return;
      t = clipStart + (v.currentTime - hit.clip.in) / hit.clip.speed;
      if (v.ended) t = clipEnd;
    }
    const stopAt = s.outPoint != null && s.outPoint > (s.inPoint ?? 0) && t0 < s.outPoint ? s.outPoint : total;
    if (t >= stopAt - 1e-3) {
      s.setPlaying(false);
      useEditor.setState({ time: Math.min(stopAt, total) });
      return;
    }
    if (t >= clipEnd - 1e-3) {
      this.startClip(clipEnd + 1e-4);
      return;
    }
    if (Math.abs(t - t0) > 1e-4) useEditor.setState({ time: t });
    this.syncMusic(t, false);
  }

  private syncMusic(t: number, force: boolean): void {
    const { doc, media } = useEditor.getState();
    for (const a of doc.audioTracks) {
      const m = media[a.mediaId];
      if (!m?.urls.original) continue;
      let el = this.music.get(a.id);
      if (!el) {
        const audio = new Audio(m.urls.original);
        audio.preload = 'auto';
        audio.addEventListener(
          'error',
          () =>
            void refreshMedia(a.mediaId).then((fresh) => {
              if (!fresh?.urls.original) return;
              const at = audio.currentTime;
              audio.src = fresh.urls.original;
              audio.currentTime = at;
            }),
        );
        el = audio;
        this.music.set(a.id, el);
      }
      const len = a.out - a.in;
      const local = t - a.start;
      const inside = local >= 0 && local < len;
      if (!inside || !this.playing) {
        if (!el.paused) el.pause();
        continue;
      }
      const fade = Math.min(1, a.fadeIn > 0 ? local / a.fadeIn : 1, a.fadeOut > 0 ? (len - local) / a.fadeOut : 1);
      el.volume = Math.max(0, Math.min(1, a.volume * fade));
      const want = a.in + local;
      if (force || Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
      if (el.paused) void el.play().catch(() => undefined);
    }
    for (const [id, el] of this.music) if (!doc.audioTracks.some((a) => a.id === id)) el.pause();
  }

  // ------------------------------------------------------------------------------------------
  // Overlay

  setImage(mediaId: string, img: ImageData8): void {
    this.out.setImage(mediaId, img);
    this.invalidate();
  }

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    if (this.playing) this.tick();
    const s = useEditor.getState();
    if (!s.doc) return;
    // Re-render only when something visible changed.
    const key = `${s.time.toFixed(4)}|${this.view.width}x${this.view.height}|${[...this.hiddenLayerIds].join(',')}`;
    if (key === this.lastRenderKey && s.doc === this.lastDoc && s.live === this.lastLive) return;
    this.lastRenderKey = key;
    this.lastDoc = s.doc;
    this.lastLive = s.live;
    if (this.playing || this.activeMedia === null) this.positionVideo(s.time);
    else if (this.backdropOn && this.activeMedia) {
      const v = this.videos.get(this.activeMedia);
      if (v) this.drawBackdrop(v);
    }
    this.out.draw({ doc: s.doc, live: s.live, t: s.time, hidden: [...this.hiddenLayerIds] });
  }
}
