// @vitest-environment happy-dom
/** The timeline and keyboard in a DOM: select, multi-select, trim by dragging (snapping, live
 *  preview), ripple delete, reorder, cuts and shots navigation, zoom, undo. */
import { act } from 'react';
import { clipDuration, clipStarts, timelineDuration, type Clip } from '@golf/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

const { useEditor, selectedClipIds } = await import('@/editor/store');
const { Timeline } = await import('@/editor/Timeline');
const { useShortcuts } = await import('@/editor/shortcuts');
const ops = await import('@/editor/ops');
const { bigRound } = await import('./helpers/bigRound');
const { mount } = await import('./helpers/render');

const E = () => useEditor.getState();
const video = (i: number) => E().doc.clips[i] as Extract<Clip, { kind: 'video' }>;
const LABEL_W = 92;

function Keys() {
  useShortcuts({ enabled: true, onHelp: () => undefined, onExport: () => undefined });
  return null;
}

let view: ReturnType<typeof mount>;
beforeEach(() => {
  const { doc, media } = bigRound({ videos: 3, clipsPerVideo: 2, shotsPerClip: 1, layers: 0 });
  E().init({ projectId: 'p', doc, docVersion: 1, media });
  E().set({ zoom: 10, snapping: true });
  view = mount(
    <>
      <Timeline />
      <Keys />
    </>,
  );
});
afterEach(() => view.unmount());

const clips = () => [...view.el.querySelectorAll<HTMLElement>('[data-testid="clip"]')];
function pointer(el: Element, type: string, clientX: number, init: PointerEventInit = {}) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0, pointerId: 1, ...init }));
  });
}
function key(k: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}
/** Client x of a timeline time (the scroller sits at 0 and is not scrolled in happy-dom). */
const x = (t: number) => LABEL_W + t * E().zoom;

describe('selection', () => {
  it('click selects one clip, shift-click adds, delete ripple-deletes them, undo restores', () => {
    const [a, , c] = clips();
    pointer(a, 'pointerdown', x(5));
    pointer(a, 'pointerup', x(5));
    expect(selectedClipIds(E().selection)).toEqual(['c0_0']);
    pointer(c, 'pointerdown', x(45), { shiftKey: true });
    pointer(c, 'pointerup', x(45));
    expect(selectedClipIds(E().selection)).toEqual(['c0_0', 'c1_0']);
    expect(clips()[2].getAttribute('aria-pressed')).toBe('true');
    key('Delete');
    expect(E().doc.clips.map((x) => x.id)).toEqual(['c0_1', 'c1_1', 'c2_0', 'c2_1']);
    expect(clips()).toHaveLength(4);
    key('z', { ctrlKey: true });
    expect(E().doc.clips).toHaveLength(6);
  });

  it('clicking empty track space deselects and moves the playhead; Escape deselects', () => {
    E().select({ kind: 'clip', id: 'c0_0' });
    const row = view.el.querySelectorAll('[data-testid="timeline"] .relative.flex-1')[2]; // the tracer row's track area
    pointer(row, 'pointerdown', x(33));
    pointer(row, 'pointerup', x(33));
    expect(E().selection).toBeNull();
    expect(E().time).toBeCloseTo(33);
    E().select({ kind: 'clip', id: 'c0_0' });
    key('Escape');
    expect(E().selection).toBeNull();
  });
});

describe('trimming by dragging', () => {
  it('drags the out edge with a live preview of the edge frame, then puts the playhead back', () => {
    E().setTime(50);
    const out = clips()[0].querySelector('[data-testid="trim-out"]')!;
    pointer(out, 'pointerdown', x(20));
    pointer(out, 'pointermove', x(17), { altKey: true });
    expect(E().doc.clips[0]).toMatchObject({ in: 4, out: 21 });
    expect(E().time).toBeCloseTo(17 - 1 / 60); // last frame before the edge
    pointer(out, 'pointermove', x(15), { altKey: true });
    pointer(out, 'pointerup', x(15));
    expect(video(0).out).toBeCloseTo(19);
    expect(E().time).toBeCloseTo(45); // same picture as before the trim, 5 s earlier
    expect(E().past).toHaveLength(1);
  });

  it('snaps the edge to the playhead and shows the guide', () => {
    E().setTime(12.3);
    const out = clips()[0].querySelector('[data-testid="trim-out"]')!;
    pointer(out, 'pointerdown', x(20));
    pointer(out, 'pointermove', x(12.6)); // 3 px from the playhead at zoom 10
    expect(clipDuration(E().doc.clips[0])).toBeCloseTo(12.3);
    expect((view.el.querySelector('[data-testid="snap-guide"]') as HTMLElement).style.display).toBe('block');
    pointer(out, 'pointerup', x(12.6));
    expect((view.el.querySelector('[data-testid="snap-guide"]') as HTMLElement).style.display).toBe('none');
  });

  it('snaps the in edge to a shot moment', () => {
    // The shot of clip 2 launches at source 39 s (+ launch offset) = timeline 25 s.
    const launch = ops.shotLaunchTime(E().doc, E().doc.shots[1])!;
    const inEdge = clips()[1].querySelector('[data-testid="trim-in"]')!;
    pointer(inEdge, 'pointerdown', x(20));
    pointer(inEdge, 'pointermove', x(launch + 0.4));
    pointer(inEdge, 'pointerup', x(launch + 0.4));
    expect(video(1).in).toBeCloseTo(34 + (launch - 20));
  });
});

describe('reordering', () => {
  it('drags a clip to another place', () => {
    const a = clips()[0];
    pointer(a, 'pointerdown', x(5));
    pointer(a, 'pointermove', x(45));
    pointer(a, 'pointermove', x(52));
    pointer(a, 'pointerup', x(52));
    expect(
      E()
        .doc.clips.map((c) => c.id)
        .slice(0, 3),
    ).toEqual(['c0_1', 'c1_0', 'c0_0']);
  });

  it('Alt+arrows move the selected clip one place', () => {
    E().select({ kind: 'clip', id: 'c0_1' });
    key('ArrowRight', { altKey: true });
    expect(
      E()
        .doc.clips.map((c) => c.id)
        .slice(0, 3),
    ).toEqual(['c0_0', 'c1_0', 'c0_1']);
    key('ArrowLeft', { altKey: true });
    key('ArrowLeft', { altKey: true });
    expect(E().doc.clips[0].id).toBe('c0_1');
  });
});

describe('keyboard editing and navigation', () => {
  it('S splits, Q and W trim to the playhead, ↑/↓ jump between cuts', () => {
    E().setTime(30);
    key('s');
    expect(E().doc.clips).toHaveLength(7);
    key('ArrowDown');
    expect(E().time).toBe(40);
    key('ArrowUp');
    key('ArrowUp');
    expect(E().time).toBe(20);
    E().setTime(23);
    key('q');
    expect(clipStarts(E().doc.clips)[1]).toBe(20);
    expect(E().doc.clips[1]).toMatchObject({ in: 37 });
    expect(E().time).toBe(20);
    E().setTime(22);
    key('w');
    expect(E().doc.clips[1]).toMatchObject({ in: 37, out: 39 });
    expect(timelineDuration(E().doc)).toBeCloseTo(20 + 2 + 10 + 80);
  });

  it('] and [ go to the next and previous shot and select it', () => {
    key(']');
    const first = E().selection;
    expect(first?.kind).toBe('shot');
    const t1 = E().time;
    key(']');
    expect(E().time).toBeGreaterThan(t1);
    key('[');
    expect(E().time).toBeCloseTo(t1);
    expect(E().selection).toEqual(first);
  });

  it('K + L steps one frame, ctrl+A selects all clips', () => {
    E().setTime(10);
    key('k');
    key('l');
    expect(E().time).toBeCloseTo(10 + 1 / 60);
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'k' })));
    expect(E().playing).toBe(false);
    key('a', { ctrlKey: true });
    expect(selectedClipIds(E().selection)).toHaveLength(6);
  });
});

describe('zoom', () => {
  it('ctrl+wheel zooms the timeline, \\ fits the round', () => {
    const scroller = view.el.querySelector('[data-testid="timeline-scroller"]')!;
    const ev = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 300, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'ctrlKey', { value: true }); // happy-dom drops modifier keys on wheel events
    act(() => {
      scroller.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(E().zoom).toBeGreaterThan(10);
    key('\\');
    expect(E().zoom).toBeGreaterThanOrEqual(8);
    expect(E().zoom).toBeLessThan(20);
  });
});
