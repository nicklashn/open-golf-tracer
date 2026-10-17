// @vitest-environment happy-dom
/**
 * A tracer the analysis put far outside the picture must always be fixable: edge markers that
 * can be dragged in, "bring the path into view", a reset that does not bring the broken flight
 * back, and drawing the path with three clicks. In a 9:16 crop of a 16:9 clip.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitThrough, inBox, shotHandles } from '@golf/physics';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
// The saved tracer styles list (shot inspector) asks the API; there is none here.
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: () => Promise.resolve({ styles: [] }) }));
vi.mock('@/editor/player', () => ({
  loadRendererFonts: () => Promise.resolve(),
  PlayerEngine: class {
    setView() {}
    destroy() {}
    invalidate() {}
    refreshSources() {}
  },
}));

const { useEditor } = await import('@/editor/store');
const ops = await import('@/editor/ops');
const { Inspector } = await import('@/editor/Inspector');
const { Preview, GRAB_MARGIN } = await import('@/editor/Preview');
const { useShortcuts } = await import('@/editor/shortcuts');
const { bigRound } = await import('./helpers/bigRound');
const { mount } = await import('./helpers/render');

const E = () => useEditor.getState();
const shot = () => E().doc.shots[0];
const W = 1920;
const H = 1080;

/** One clip, one shot whose flight (and auto flight) has its apex 3 frame heights above the
 *  picture and lands 5 frame widths to the right; the project is 9:16. */
function load() {
  const { doc, media } = bigRound({ videos: 1, clipsPerVideo: 1, shotsPerClip: 1, layers: 0 });
  const s = doc.shots[0];
  const opt = { fps: 60, longSide: W };
  const wild = fitThrough(s, s.anchor, { x: 1100, y: -3 * H }, { x: 5 * W, y: 400 }, opt).params;
  const shots = [{ ...s, params: wild, auto: { ...s.auto, params: wild } }];
  E().init({ projectId: 'p', doc: { ...doc, shots, format: { ...doc.format, aspect: '9:16' } }, docVersion: 1, media });
  E().select({ kind: 'shot', id: s.id });
  E().setTime(6); // the clip starts at source 4 s, the shot at 9 s: paused on the shot's video
}

function Keys() {
  useShortcuts({ enabled: true, onHelp: () => undefined, onExport: () => undefined });
  return null;
}

let view: ReturnType<typeof mount>;
beforeEach(async () => {
  load();
  view = mount(
    <>
      <Keys />
      <Preview onRequestRetrack={() => undefined} />
      <Inspector onRetrack={() => undefined} />
    </>,
  );
  await act(async () => undefined);
});
afterEach(() => view.unmount());

const $ = (sel: string) => view.el.querySelector(sel);
const visible = () => ops.visibleBox(shot());
const handles = () => shotHandles(shot())!;
const button = (text: string) => [...view.el.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

function pointer(target: Element, type: string, x: number, y: number) {
  // happy-dom lays nothing out: the preview's top-left corner is at (0, 0), so client = view px.
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
}

/** Screen (preview px) to source px, as Preview maps them. */
function toSource(x: number, y: number) {
  const b = visible();
  const viewW = parseFloat(($('[data-testid="preview-overlay"]') as SVGElement).style.width) - 2 * GRAB_MARGIN;
  const scale = viewW / b.w;
  return { x: x / scale + b.x, y: y / scale + b.y };
}

describe('a tracer far outside the picture (reproduction)', () => {
  it('has its apex and landing outside the 9:16 crop, out of reach of normal handles', () => {
    const b = visible();
    expect(b.w).toBeCloseTo((H * 9) / 16, 0);
    const h = handles();
    expect(inBox(h.apex, b)).toBe(false);
    expect(inBox(h.landing, b)).toBe(false);
    expect(ops.handlesOutside(shot())).toEqual(['apex', 'landing']);
  });
});

describe('edge markers', () => {
  it('draws off-screen handles as markers on the edge of the video, labelled', () => {
    expect($('[data-testid="handle-apex"]')).toBeNull();
    expect($('[data-testid="handle-landing"]')).toBeNull();
    expect($('[data-testid="handle-start"]')).not.toBeNull();
    const svg = $('[data-testid="preview-overlay"]') as SVGElement;
    const w = parseFloat(svg.style.width) - 2 * GRAB_MARGIN;
    const h = parseFloat(svg.style.height) - 2 * GRAB_MARGIN;
    for (const k of ['apex', 'landing']) {
      const m = $(`[data-testid="offscreen-${k}"]`)!;
      expect(m).not.toBeNull();
      expect(m.textContent).toContain(k === 'apex' ? 'Apex' : 'Landing');
      const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(m.getAttribute('transform')!)!.slice(1).map(Number);
      // In the grab margin around the video, never off the overlay.
      expect(x).toBeGreaterThanOrEqual(-GRAB_MARGIN);
      expect(x).toBeLessThanOrEqual(w + GRAB_MARGIN);
      expect(y).toBeGreaterThanOrEqual(-GRAB_MARGIN);
      expect(y).toBeLessThanOrEqual(h + GRAB_MARGIN);
      expect(m.getAttribute('aria-label')).toMatch(/outside the picture/);
    }
    // The apex is above the picture: its marker sits on the top edge of the video.
    const apexY = Number(/translate\([-\d.]+ ([-\d.]+)\)/.exec($('[data-testid="offscreen-apex"]')!.getAttribute('transform')!)![1]);
    expect(apexY).toBe(0);
    expect($('[data-testid="offview-bar"]')).not.toBeNull();
  });

  it('dragging a marker moves the real handle to the pointer, in one undo step', async () => {
    const before = E().past.length;
    const marker = $('[data-testid="offscreen-apex"]')!;
    const wrap = $('[data-testid="preview-overlay"]')!.parentElement!;
    await act(async () => pointer(marker, 'pointerdown', 100, 0));
    await act(async () => pointer(wrap, 'pointermove', 110, 60));
    await act(async () => pointer(wrap, 'pointermove', 120, 80));
    await act(async () => pointer(wrap, 'pointerup', 120, 80));
    await act(async () => undefined);
    const want = toSource(120, 80);
    const s = shot();
    expect(s.constraints.apex!.x).toBeCloseTo(want.x, 3);
    expect(s.constraints.apex!.y).toBeCloseTo(want.y, 3);
    const h = handles();
    expect(Math.hypot(h.apex.x - want.x, h.apex.y - want.y)).toBeLessThan(6);
    // The rescue pulled the landing into view too, so nothing is left at the edge.
    expect(ops.handlesOutside(s)).toEqual([]);
    expect($('[data-testid="offscreen-apex"]')).toBeNull();
    expect($('[data-testid="handle-apex"]')).not.toBeNull();
    expect(E().past.length).toBe(before + 1);
  });
});

describe('bring the path into view', () => {
  it('the inspector says so and its button pulls every handle in, as one undo step', async () => {
    expect($('[data-testid="offview-notice"]')?.textContent).toContain('outside the picture');
    const params = shot().params;
    const before = E().past.length;
    await act(async () => button('Bring the path into view').click());
    expect(ops.handlesOutside(shot())).toEqual([]);
    const b = visible();
    const h = handles();
    expect(inBox(h.start, b) && inBox(h.apex, b) && inBox(h.landing, b)).toBe(true);
    expect(E().past.length).toBe(before + 1);
    expect($('[data-testid="offview-notice"]')).toBeNull();
    expect($('[data-testid="offscreen-apex"]')).toBeNull();
    await act(async () => E().undo());
    expect(shot().params).toEqual(params);
  });

  it('reset to auto does not bring the broken auto flight back', async () => {
    await act(async () => button('Bring the path into view').click());
    await act(async () => button('Reset to auto').click());
    expect(ops.handlesOutside(shot())).toEqual([]);
    expect(shot().anchor).toEqual(shot().auto.anchor);
  });

  it('reset to auto keeps a sane auto flight as it is', () => {
    const { doc, media } = bigRound({ videos: 1, clipsPerVideo: 1, shotsPerClip: 1, layers: 0 });
    act(() => E().init({ projectId: 'p', doc, docVersion: 1, media }));
    const s = shot();
    act(() => ops.setTiming(s.id, { speed: 2 }));
    let r: string | null = null;
    act(() => {
      r = ops.resetShot(s.id);
    });
    expect(r).toBe('auto');
    expect(shot().params).toEqual(s.auto.params);
    expect(shot().constraints.apex).toBeNull();
  });
});

describe('draw the path', () => {
  it('three clicks (start, top, landing) replace the handles; hints say which click is next', async () => {
    await act(async () => button('Draw the path').click());
    expect(E().tool).toBe('drawPath');
    const hint = () => $('[data-testid="preview-hint"]')!.textContent;
    expect(hint()).toContain('1/3');
    expect(hint()).toContain('where the shot starts');
    const cover = $('[data-testid="draw-cover"]')!;
    const before = E().past.length;
    const clicks = [
      [90, 300],
      [70, 60],
      [40, 150],
    ];
    await act(async () => pointer(cover, 'pointerdown', clicks[0][0], clicks[0][1]));
    expect(hint()).toContain('2/3');
    await act(async () => pointer(cover, 'pointerdown', clicks[1][0], clicks[1][1]));
    expect(hint()).toContain('where the ball lands');
    await act(async () => pointer(cover, 'pointerdown', clicks[2][0], clicks[2][1]));
    expect(E().tool).toBe('select');
    expect(E().past.length).toBe(before + 1);
    const h = handles();
    const [start, apex, landing] = clicks.map(([x, y]) => toSource(x, y));
    expect(Math.hypot(h.start.x - start.x, h.start.y - start.y)).toBeLessThan(0.01);
    expect(Math.hypot(h.apex.x - apex.x, h.apex.y - apex.y)).toBeLessThan(6);
    expect(Math.hypot(h.landing.x - landing.x, h.landing.y - landing.y)).toBeLessThan(6);
    expect(ops.handlesOutside(shot())).toEqual([]);
  });

  it('Esc cancels drawing and keeps the shot selected', async () => {
    await act(async () => button('Draw the path').click());
    const params = shot().params;
    await act(async () => pointer($('[data-testid="draw-cover"]')!, 'pointerdown', 90, 300));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(E().tool).toBe('select');
    expect(E().selection).toEqual({ kind: 'shot', id: shot().id });
    expect(shot().params).toEqual(params);
    expect($('[data-testid="draw-cover"]')).toBeNull();
  });

  it('the cancel button in the hint stops drawing too (touch screens have no Esc)', async () => {
    await act(async () => button('Draw the path').click());
    await act(async () => ($('[data-testid="preview-hint"] button') as HTMLButtonElement).click());
    expect(E().tool).toBe('select');
  });
});
