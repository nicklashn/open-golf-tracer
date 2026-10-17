/// <reference lib="webworker" />
/* Draws the preview overlay on an OffscreenCanvas, off the main thread (see overlay.ts). */
import { fonts, type ImageData8 } from '@golf/render';
import type { Project } from '@golf/schema';
import { OverlayPainter } from './overlayPaint';

type Msg =
  | { type: 'init'; canvas: OffscreenCanvas; locale: 'da' | 'en' }
  | { type: 'size'; w: number; h: number }
  | { type: 'doc'; doc: Project }
  | { type: 'live'; live: Record<string, number[]> }
  | { type: 'locale'; locale: 'da' | 'en' }
  | { type: 'image'; mediaId: string; img: ImageData8 }
  | { type: 'frame'; t: number; hidden: string[]; seq: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let painter: OverlayPainter | null = null;
let doc: Project | null = null;
let live: Record<string, number[]> = {};
let locale: 'da' | 'en' | null = null;
let want: { t: number; hidden: string[] } | null = null;
let scheduled = false;
let size: { w: number; h: number } | null = null;

void fonts.loadAll(async (file) => (await fetch(`/fonts/${file}`)).arrayBuffer()).then(schedule);

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // After the messages already waiting, so a burst of frames collapses into the newest one.
  setTimeout(run, 0);
}

function run() {
  scheduled = false;
  if (!want || !doc || !painter) return;
  const ms = painter.render({ doc, live, t: want.t, hidden: want.hidden });
  if (ms == null) return; // fonts still loading: drawn once they are
  want = null;
  scope.postMessage({ type: 'drawn', ms });
}

scope.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const ctx = m.canvas.getContext('2d');
      if (!ctx) return;
      painter = new OverlayPainter(ctx, locale ?? m.locale);
      if (size) painter.resize(size.w, size.h);
      break;
    }
    case 'size':
      size = { w: m.w, h: m.h };
      painter?.resize(m.w, m.h);
      break;
    case 'doc':
      doc = m.doc;
      break;
    case 'live':
      live = m.live;
      break;
    case 'locale':
      locale = m.locale;
      painter?.setLocale(m.locale);
      break;
    case 'image':
      painter?.images.set(m.mediaId, m.img);
      break;
    case 'frame':
      want = { t: m.t, hidden: m.hidden };
      schedule();
      break;
  }
};
