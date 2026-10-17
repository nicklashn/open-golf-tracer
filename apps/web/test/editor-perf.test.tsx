// @vitest-environment happy-dom
/**
 * Editor performance: how much React work the playhead, scrubbing and dragging cause in a long
 * round (30 clips, 60 shots, 24 layers). Thresholds are render counts and DOM sizes (stable),
 * not milliseconds (machine dependent); timings are printed for the report.
 */
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
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
const { Timeline } = await import('@/editor/Timeline');
const { Transport } = await import('@/editor/Transport');
const { Inspector } = await import('@/editor/Inspector');
const { Preview } = await import('@/editor/Preview');
const { ShotsPanel } = await import('@/editor/LeftPanels');
const { bigRound } = await import('./helpers/bigRound');
const { Count, counter, mount } = await import('./helpers/render');

const report: string[] = [];
afterAll(() => console.log(`\n[editor perf]\n${report.join('\n')}\n`));

describe('editor rendering, long round', () => {
  const c = counter();
  let view: ReturnType<typeof mount>;
  beforeAll(async () => {
    const { doc, media } = bigRound();
    useEditor.getState().init({ projectId: 'p', doc, docVersion: 1, media });
    useEditor.getState().select({ kind: 'layer', ids: ['l3'] });
    view = mount(
      <>
        <Count id="timeline" c={c}>
          <Timeline />
        </Count>
        <Count id="transport" c={c}>
          <Transport />
        </Count>
        <Count id="inspector" c={c}>
          <Inspector onRetrack={() => undefined} />
        </Count>
        <Count id="preview" c={c}>
          <Preview onRequestRetrack={() => undefined} />
        </Count>
        <Count id="shots" c={c}>
          <ShotsPanel />
        </Count>
      </>,
    );
    await act(async () => undefined); // fonts promise
  });
  afterAll(() => view.unmount());

  it('keeps the timeline DOM small', () => {
    const n = view.el.querySelector('[data-testid="timeline"]')!.querySelectorAll('*').length;
    report.push(`timeline DOM nodes (zoom 80): ${n}`);
    act(() => useEditor.setState({ zoom: 400 }));
    const n2 = view.el.querySelector('[data-testid="timeline"]')!.querySelectorAll('*').length;
    report.push(`timeline DOM nodes (zoom 400): ${n2}`);
    act(() => useEditor.setState({ zoom: 80 }));
    // Before: 1522 / 3892 (every filmstrip tile and ruler tick of the whole round).
    expect(n).toBeLessThan(800);
    expect(n2).toBeLessThan(800);
  });

  it('playback: 120 playhead ticks', () => {
    c.reset();
    act(() => useEditor.setState({ playing: true }));
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) act(() => useEditor.setState({ time: 30 + i / 60 }));
    const wall = performance.now() - t0;
    act(() => useEditor.setState({ playing: false }));
    report.push(`playback 120 ticks: wall ${wall.toFixed(0)} ms, commits ${JSON.stringify(c.commits)}, render ms ${fmt(c.ms)}`);
    // Before: timeline, inspector and preview re-rendered on every tick (120 each).
    expect(c.commits.timeline ?? 0).toBe(0);
    expect(c.commits.inspector ?? 0).toBe(0);
    expect(c.commits.shots ?? 0).toBe(0);
    expect(c.commits.preview ?? 0).toBeLessThanOrEqual(2); // play and pause
    // The playhead still moves (CSS transform from a store subscription).
    expect((view.el.querySelector('[data-testid="playhead"]') as HTMLElement).style.transform).toContain(`${92 + (30 + 119 / 60) * 80}px`);
  });

  it('scrubbing: 120 paused seeks', () => {
    c.reset();
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) act(() => useEditor.getState().setTime(100 + i / 10));
    const wall = performance.now() - t0;
    report.push(`scrub 120 seeks: wall ${wall.toFixed(0)} ms, commits ${JSON.stringify(c.commits)}, render ms ${fmt(c.ms)}`);
    expect(c.commits.timeline ?? 0).toBe(0);
    expect(c.commits.inspector ?? 0).toBe(0);
  });

  it('trim drag: 60 pointer moves, then undo', () => {
    c.reset();
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) act(() => ops.trimClip('c4_1', 'out', 54 - i * 0.1, 'trim-drag'));
    const wall = performance.now() - t0;
    const steps = useEditor.getState().past.length;
    act(() => useEditor.getState().undo());
    report.push(`trim drag 60 moves: wall ${wall.toFixed(0)} ms, commits ${JSON.stringify(c.commits)}, render ms ${fmt(c.ms)}, undo steps ${steps}`);
    expect(steps).toBe(1);
    expect(useEditor.getState().doc.clips.find((x) => x.id === 'c4_1')).toMatchObject({ out: 54 });
  });
});

function fmt(o: Record<string, number>) {
  return JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])));
}
