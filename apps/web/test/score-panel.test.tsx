// @vitest-environment happy-dom
/** The scorecard panel and showing a shot: rows per hole, unsure values, corrections stored in
 *  the project, clicks that move the playhead (also into a later clip, and while playing), and
 *  shots whose clip is not on the timeline. */
import { act } from 'react';
import { migrateProject, type Project } from '@golf/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

const { useEditor } = await import('@/editor/store');
const { ScorePanel } = await import('@/editor/ScorePanel');
const ops = await import('@/editor/ops');
const { mount } = await import('./helpers/render');

const E = () => useEditor.getState();

// A real flight from the physics parity fixtures, tracked: a measured carry.
const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const shot = (id: string, mediaId: string, impactTime: number, extra: Record<string, unknown> = {}) => ({
  id,
  mediaId,
  impactTime,
  camera: { cx: 540, cy: 960 },
  anchor: { x: 526, y: 1472 },
  params,
  auto: { params, anchor: { x: 526, y: 1472 }, impactTime },
  track: { t: [...Array(10).keys()].map((i) => impactTime + i * 0.1), u: Array(10).fill(526), v: [...Array(10).keys()].map((i) => 1400 - i * 40) },
  ...extra,
});
const putt = (id: string, mediaId: string, impactTime: number, holed: boolean | null, extra: Record<string, unknown> = {}) =>
  shot(id, mediaId, impactTime, { kind: 'putt', putt: { end: impactTime + 3, holed }, ...extra });

const M_PER_DEG = 111195;
const media = (id: string, minute: number, north: number, place: Record<string, unknown> | null, geo = true) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt: `2026-06-16T10:${String(minute).padStart(2, '0')}:00+0200`,
  geo: geo ? { lat: 56.2 + north / M_PER_DEG, lon: 9.7, acc: 5 } : null,
  place,
});
const hole = (n: string, par: number, fromTee: number) => ({ course: 'Testbane', hole: n, par, fromTee, toGreen: 300, line: [] });

function load(medias: ReturnType<typeof media>[], shots: ReturnType<typeof shot>[], clips?: unknown[]): Project {
  const doc = migrateProject({
    schemaVersion: 1,
    name: 'Runde',
    media: Object.fromEntries(medias.map((m) => [m.id, m])),
    clips: clips ?? medias.map((m) => ({ id: `c_${m.id}`, kind: 'video', mediaId: m.id, in: 0, out: 30 })),
    shots,
  });
  E().init({
    projectId: 'p',
    doc,
    docVersion: 1,
    media: medias.map((m) => ({ ...m, hdr: false, hasAudio: false, status: 'ready', urls: {} })) as never,
  });
  return doc;
}

/** Hole 7 (par 4) filmed from tee to a holed putt, and hole 8 (par 3) whose putts the analysis is unsure of. */
function round() {
  // Where the drive came down, so the next clip fits the flight.
  const carry = 222;
  return load(
    [
      media('tee', 0, 0, hole('7', 4, 0)),
      media('fw', 5, carry, hole('7', 4, carry)),
      media('green', 9, 2 * carry, hole('7', 4, 2 * carry)),
      media('t8', 20, 0, hole('8', 3, 0)),
    ],
    [
      shot('drive', 'tee', 5),
      shot('approach', 'fw', 5),
      putt('p1', 'green', 5, false),
      putt('p2', 'green', 20, true),
      shot('t8s', 't8', 5),
      putt('p8', 't8', 15, true, { confidence: 0.4 }),
    ],
  );
}

let view: ReturnType<typeof mount> | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  ops.onShotMissing(null);
});
const show = () => (view = mount(<ScorePanel />));
const rows = () => [...view!.el.querySelectorAll<HTMLElement>('[data-testid="score-hole"]')];
const click = (el: Element) => act(() => (el as HTMLElement).click());
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
  });
}

describe('the scorecard', () => {
  it('has a row per hole in playing order: par, strokes, putts, to par, and the total', () => {
    round();
    show();
    expect(rows().map((r) => r.dataset.hole)).toEqual(['7', '8']);
    const [h7, h8] = rows().map((r) => r.querySelector('button')!.getAttribute('aria-label'));
    expect(h7).toBe('Hole 7: par 4, 4 strokes, 2 putts – Par');
    // Hole 8: the putt is in doubt, so the hole has no score yet.
    expect(h8).toBe('Hole 8: par 3, 2 (unsure) strokes, 1 (unsure) putts');
    expect(rows()[1].textContent).toContain('?');
    expect(view!.el.querySelector('[data-testid="score-status"]')!.textContent).toBe('1 of 2 holes have a score');
    expect(view!.el.querySelector('[data-testid="score-total"]')!.textContent).toBe('4±0');
  });

  it('corrects a hole: stored in the project, used for the score, and undone with "use what was found"', () => {
    round();
    show();
    click(rows()[1].querySelector('button')!);
    const editor = view!.el.querySelector('[data-testid="score-editor"]')!;
    expect(editor.textContent).toContain('Unsure how many putts there were');
    const [, , putts] = [...editor.querySelectorAll('input')];
    type(putts, '2');
    expect(E().doc.scoreEdits).toEqual({ '8': { putts: 2 } });
    expect(rows()[1].querySelector('button')!.getAttribute('aria-label')).toBe('Hole 8: par 3, 3 strokes, 2 putts – Par (corrected by you)');
    expect(view!.el.querySelector('[data-testid="score-total"]')!.textContent).toBe('7±0');
    // Strokes win over everything the clips say; one undo step per field.
    const strokes = view!.el.querySelectorAll<HTMLInputElement>('[data-testid="score-editor"] input')[1];
    type(strokes, '2');
    expect(E().doc.scoreEdits).toEqual({ '8': { putts: 2, strokes: 2 } });
    expect(view!.el.querySelector('[data-testid="score-total"]')!.textContent).toBe('6−1');
    click(view!.el.querySelector('[data-testid="score-reset"]')!);
    expect(E().doc.scoreEdits).toBeUndefined();
    act(() => E().undo());
    expect(E().doc.scoreEdits).toEqual({ '8': { putts: 2, strokes: 2 } });
  });

  it("shows a hole's first shot when the hole is clicked, also in a later clip", () => {
    round();
    show();
    click(rows()[1].querySelector('button')!);
    expect(E().selection).toEqual({ kind: 'shot', id: 't8s' });
    // Clip 4 starts at 90 s; the shot is struck 5 s in, shown from 0.6 s before.
    expect(E().time).toBeCloseTo(90 + 5 - ops.SHOT_LEAD_S);
  });

  it('without GPS: says how holes are found, and a hole set on a clip makes a row', () => {
    load([media('a', 0, 0, null, false), media('b', 5, 0, null, false)], [shot('s1', 'a', 5), putt('pa', 'b', 4, true)]);
    show();
    expect(view!.el.querySelector('[data-testid="score-empty"]')!.textContent).toContain('GPS position');
    const inputs = view!.el.querySelectorAll<HTMLInputElement>('[data-testid="score-clips"] input');
    expect(inputs).toHaveLength(2);
    type(inputs[0], '5');
    type(view!.el.querySelectorAll<HTMLInputElement>('[data-testid="score-clips"] input')[0], '5');
    expect(E().doc.media.a.place).toMatchObject({ hole: '5', par: null });
    expect(E().doc.media.b.place).toMatchObject({ hole: '5' });
    expect(rows().map((r) => r.dataset.hole)).toEqual(['5']);
    // No par from a map: asked for, and the hole has no score until it is set.
    expect(rows()[0].querySelector('button')!.getAttribute('aria-label')).toBe('Hole 5: par ?, 2 (unsure) strokes, 1 putts');
  });

  it('a range session (GPS, no course): no holes, no score to keep', () => {
    load([media('r', 0, 0, null)], [shot('s1', 'r', 5)]);
    show();
    expect(view!.el.querySelector('[data-testid="score-empty"]')!.textContent).toContain('range');
    expect(rows()).toHaveLength(0);
  });
});

describe('showing a shot', () => {
  it('stays in the clip that shows the launch: the lead-in never reaches into the previous video', () => {
    const doc = load(
      [media('a', 0, 0, null), media('b', 5, 0, null)],
      [shot('s1', 'a', 5), shot('s2', 'b', 1.2)],
      [
        { id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 10 },
        { id: 'cb', kind: 'video', mediaId: 'b', in: 1, out: 10 },
      ],
    );
    expect(ops.shotCueTime(doc, doc.shots[0])).toBeCloseTo(5 - ops.SHOT_LEAD_S);
    // 0.2 s into clip b: the cue is the clip's first frame (10 s), not 9.8 s of clip a.
    expect(ops.shotCueTime(doc, doc.shots[1])).toBeCloseTo(10);
    ops.jumpToShot(doc.shots[1]);
    expect(E().time).toBeCloseTo(10);
  });

  it('keeps playing from the shot when the video was playing', () => {
    const doc = round();
    act(() => E().setPlaying(true));
    const seen: [boolean, number][] = [];
    const off = useEditor.subscribe((s, p) => s.playing !== p.playing && seen.push([s.playing, s.time]));
    ops.jumpToShot(doc.shots[1]);
    off();
    expect(E().playing).toBe(true);
    expect(E().time).toBeCloseTo(30 + 5 - ops.SHOT_LEAD_S);
    // Paused for the seek, then played on from the new time.
    expect(seen).toEqual([
      [false, 0],
      [true, E().time],
    ]);
    act(() => E().setPlaying(false));
  });

  it('says so when the shot is not on the timeline, and puts it back', () => {
    const doc = load(
      [media('a', 0, 0, null), media('b', 5, 0, null)],
      [shot('s1', 'a', 5), shot('s2', 'b', 20)],
      [
        { id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 10 },
        { id: 'cb', kind: 'video', mediaId: 'b', in: 0, out: 10 },
      ],
    );
    const missing: string[] = [];
    ops.onShotMissing((s) => missing.push(s.id));
    // Trimmed away: the clip of b ends before the strike.
    expect(ops.jumpToShot(doc.shots[1])).toBe(false);
    expect(missing).toEqual(['s2']);
    expect(E().selection).toEqual({ kind: 'shot', id: 's2' });
    expect(ops.restoreShot(doc.shots[1])).toBe(true);
    expect(E().doc.clips[1]).toMatchObject({ mediaId: 'b', in: 0 });
    expect((E().doc.clips[1] as { out: number }).out).toBeGreaterThan(20);
    expect(ops.jumpToShot(E().doc.shots[1])).toBe(true);
    // Removed: its whole video comes back in round order.
    act(() => E().edit('x', (d) => void d.clips.splice(1, 1)));
    expect(ops.jumpToShot(E().doc.shots[1])).toBe(false);
    ops.restoreShot(E().doc.shots[1]);
    expect(E().doc.clips.map((c) => c.mediaId)).toEqual(['a', 'b']);
    expect(ops.jumpToShot(E().doc.shots[1])).toBe(true);
    expect(E().time).toBeCloseTo(10 + 20 - ops.SHOT_LEAD_S);
  });
});
