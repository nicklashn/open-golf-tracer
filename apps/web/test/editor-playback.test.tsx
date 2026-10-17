// @vitest-environment happy-dom
/**
 * Playback internals: refits are latest-wins per shot, the overlay worker follows a language
 * switch and gets only live params while dragging, the player keeps a few <video>s and renews
 * expired media URLs, frame steps land on the frame grid, number fields commit only changes and
 * speak Danish decimals, and live-event handlers never fail silently.
 */
import type { Shot } from '@golf/schema';
import { act, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from './helpers/render';

const apiCalls: string[] = [];
let apiRespond: (path: string) => unknown = () => ({});
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    api: async (path: string) => {
      apiCalls.push(path);
      return apiRespond(path);
    },
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: Record<string, unknown>[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(d: Record<string, unknown>) {
    this.posted.push(d);
  }
  terminate() {}
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}

const realWorker = globalThis.Worker;
beforeEach(() => {
  FakeWorker.all = [];
  apiCalls.length = 0;
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
});
afterEach(() => {
  (globalThis as { Worker: unknown }).Worker = realWorker;
});

const { useEditor } = await import('../src/editor/store');
const { bigRound } = await import('./helpers/bigRound');
const E = () => useEditor.getState();

function load(videos = 2) {
  const { doc, media } = bigRound({ videos, clipsPerVideo: 1, shotsPerClip: 1, layers: 0 });
  E().init({ projectId: 'p', doc, docVersion: 1, media });
}

describe('refit queue', () => {
  it('a fit of another shot does not cancel a waiting one; the same shot is latest-wins', async () => {
    load();
    const { Refitter } = await import('../src/editor/refit');
    const r = new Refitter();
    const [a, b] = E().doc.shots as Shot[];
    const opts = { fps: 60, longSide: 1920 };
    const a1 = r.request(a, opts);
    const w = FakeWorker.all[0];
    const bReq = r.request(b, opts);
    const a2 = r.request(a, opts);
    const a3 = r.request(a, opts);
    expect(await a2).toBeNull(); // superseded by a3 (same shot)
    const ok = (id: number) => ({ id, ok: true, params: [1], ms: 1, rmsPx: 0, lambda: 1, converged: true });
    w.reply(ok(w.posted[0].id as number));
    expect(await a1).not.toBeNull();
    // Next in line: b – it was not cancelled by a's newer request.
    expect((w.posted[1].shot as Shot).id).toBe(b.id);
    w.reply(ok(w.posted[1].id as number));
    expect(await bReq).not.toBeNull();
    expect((w.posted[2].shot as Shot).id).toBe(a.id);
    w.reply(ok(w.posted[2].id as number));
    expect(await a3).not.toBeNull();
  });
});

describe('overlay worker', () => {
  it('a reused worker gets the new language, and a drag sends live params, not the document', async () => {
    load();
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {};
    const { overlayOutput } = await import('../src/editor/overlay');
    const canvas = document.createElement('canvas');
    Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
    document.body.appendChild(canvas);
    const first = overlayOutput(canvas, 'da');
    const w = FakeWorker.all.at(-1)!;
    expect(w.posted[0]).toMatchObject({ type: 'init', locale: 'da' });
    first.release();
    const out = overlayOutput(canvas, 'en');
    expect(out).toBe(first);
    expect(w.posted.at(-1)).toEqual({ type: 'locale', locale: 'en' });

    w.posted.length = 0;
    const doc = E().doc;
    out.draw({ doc, t: 0, hidden: [] });
    for (let i = 0; i < 5; i++) out.draw({ doc, live: { [doc.shots[0].id]: [i, 0, 0, 0, 0, 0, 0, 0, 0] }, t: 0, hidden: [] });
    const types = w.posted.map((m) => m.type);
    expect(types.filter((x) => x === 'doc')).toHaveLength(1);
    expect(types.filter((x) => x === 'live')).toHaveLength(5);
    canvas.remove();
  });

  it('the painter draws live params over the document', async () => {
    load();
    const { withLive } = await import('../src/editor/overlayPaint');
    const doc = E().doc;
    const live = { [doc.shots[1].id]: [9, 9, 9, 9, 9, 9, 9, 9, 9] };
    const out = withLive(doc, live);
    expect(out.shots[1].params[0]).toBe(9);
    expect(out.shots[0]).toBe(doc.shots[0]);
    expect(withLive(doc, live)).toBe(out); // same frame, same object
    expect(withLive(doc, {})).toBe(doc);
  });
});

describe('player', () => {
  it('keeps the videos around the playhead only, loads the next one, and renews an expired URL', async () => {
    vi.doMock('../src/editor/overlay', () => ({
      loadRendererFonts: () => Promise.resolve(),
      overlayOutput: () => ({ resize() {}, draw() {}, setImage() {}, release() {}, onDrawn: null }),
    }));
    const { PlayerEngine, mediaToKeep } = await import('../src/editor/player');
    const { resetMediaRefresh } = await import('../src/editor/mediaUrls');
    resetMediaRefresh();
    load(6);
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    document.body.appendChild(host);
    const p = new PlayerEngine(host, canvas, 'en');
    const { clipStarts } = await import('@golf/schema');
    const starts = clipStarts(E().doc.clips);
    for (const s of starts) p.seek(s + 1);
    const ids = () => [...host.querySelectorAll('video')].map((v) => v.dataset.media);
    // At the last clip: it and the one before.
    expect(ids().sort()).toEqual(mediaToKeep(E().doc.clips, 5).sort());
    p.seek(starts[2] + 1);
    // m3: the next clip, loaded ahead; m4 and m5 are dropped (m1 is kept once it exists).
    expect(ids().sort()).toEqual(['m2', 'm3']);
    p.seek(starts[1] + 1);
    p.seek(starts[2] + 1);
    expect(ids().sort()).toEqual(['m1', 'm2', 'm3']);

    // The signed URL of the video on screen expired: fresh URLs, same position.
    apiRespond = (path) => (path === '/media/m2' ? { ...E().media.m2, urls: { proxy: 'http://x/fresh-proxy' } } : {});
    const v = host.querySelector<HTMLVideoElement>('video[data-media="m2"]')!;
    v.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(v.src).toContain('fresh-proxy'));
    expect(apiCalls).toContain('/media/m2');
    expect(E().media.m2.urls.proxy).toBe('http://x/fresh-proxy');
    p.destroy();
    host.remove();
    vi.doUnmock('../src/editor/overlay');
  });
});

describe('frame step', () => {
  it('lands on the 59.94 fps frame grid of the source video', async () => {
    load();
    const m0 = { ...E().media.m0, fps: 59.94 };
    E().setMedia(m0);
    const { exactFps, frameStep } = await import('../src/editor/Transport');
    const { clipAt } = await import('@golf/schema');
    const fps = exactFps(59.94);
    expect(fps).toBeCloseTo(60000 / 1001, 9);
    E().setTime(1.2345); // between two frames
    frameStep(1);
    const onGrid = () => {
      const f = clipAt(E().doc.clips, E().time)!.sourceTime * fps;
      return Math.abs(f - Math.round(f)) < 1e-3;
    };
    expect(onGrid()).toBe(true);
    const at = clipAt(E().doc.clips, E().time)!.sourceTime;
    for (let i = 0; i < 100; i++) frameStep(1);
    expect(onGrid()).toBe(true);
    expect(Math.round((clipAt(E().doc.clips, E().time)!.sourceTime - at) * fps)).toBe(100);
    frameStep(-1, 10);
    expect(onGrid()).toBe(true);
  });
});

describe('number field', () => {
  it('commits only a changed number, and reads and shows a Danish decimal comma', async () => {
    const { NumberField, parseNumber, formatNumber } = await import('@/components/ui/controls');
    const { I18nProvider } = await import('@/lib/i18n/client');
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('abc')).toBeNaN();
    expect(formatNumber(1.25, 0.01, 'da')).toBe('1,25');
    expect(formatNumber(1.25, 0.01, 'en')).toBe('1.25');
    const changes: (number | null)[] = [];
    const { el, unmount } = mount(
      <I18nProvider locale="da">
        <NumberField label="Carry" value={1.5} step={0.1} onChange={(v) => changes.push(v)} />
      </I18nProvider>,
    );
    const input = el.querySelector('input')!;
    expect(input.value).toBe('1,5');
    act(() => {
      input.focus();
      input.blur();
    });
    expect(changes).toEqual([]);
    const type = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('1,50');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(changes).toEqual([]); // the same number
    type('2,4');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(changes).toEqual([2.4]);
    unmount();
  });
});

describe('live events', () => {
  class FakeES {
    static all: FakeES[] = [];
    listeners: Record<string, ((m: { data: string }) => void)[]> = {};
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeES.all.push(this);
    }
    addEventListener(k: string, f: (m: { data: string }) => void) {
      (this.listeners[k] ??= []).push(f);
    }
    close() {}
    emit(data: string) {
      for (const f of this.listeners.job ?? []) f({ data });
    }
  }

  it('subscribes nothing before the project is ready, and reports a failing handler', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    const { useJobEvents } = await import('@/lib/events');
    const reported: unknown[] = [];
    const g = globalThis as { reportError?: (e: unknown) => void };
    const had = g.reportError;
    g.reportError = (e) => void reported.push(e);
    function Probe({ id }: { id: string | null }) {
      useJobEvents(() => {
        throw new Error('merge failed');
      }, id);
      useEffect(() => undefined);
      return null;
    }
    const a = mount(<Probe id={null} />);
    expect(FakeES.all).toHaveLength(0);
    a.unmount();
    const b = mount(<Probe id="p1" />);
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0].url).toContain('project_id=p1');
    FakeES.all[0].emit('{"type":"job","job":{}}');
    expect(reported).toHaveLength(1);
    FakeES.all[0].emit('not json'); // malformed: skipped
    expect(reported).toHaveLength(1);
    b.unmount();
    g.reportError = had;
  });
});
