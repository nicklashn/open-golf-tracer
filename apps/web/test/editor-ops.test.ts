/** Editing the main track: trim, ripple, snapping, reorder, multi-select delete and undo. */
import { clipDuration, clipStarts, timelineDuration, type Clip } from '@golf/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import * as ops from '../src/editor/ops';
import { editPoints, snapTime, stepTo, timelineRemap } from '../src/editor/ripple';
import { selectedClipIds, useEditor } from '../src/editor/store';
import { bigRound } from './helpers/bigRound';

const E = () => useEditor.getState();
type Video = Extract<Clip, { kind: 'video' }>;
const clip = (id: string) => E().doc.clips.find((c) => c.id === id) as Video;
const startOf = (id: string) => clipStarts(E().doc.clips)[E().doc.clips.findIndex((c) => c.id === id)];
const layer = (id: string) => E().doc.layers.find((l) => l.id === id)!;

/** 3 videos × 2 clips of 20 s (source 4–24 s and 34–54 s), a layer in each clip, music at 0. */
function load() {
  const { doc, media } = bigRound({ videos: 3, clipsPerVideo: 2, shotsPerClip: 1, layers: 0 });
  const starts = clipStarts(doc.clips);
  const layers = doc.clips.map((c, i) => ({
    id: `L${i}`,
    type: 'text' as const,
    name: '',
    start: starts[i] + 5,
    end: starts[i] + 8,
    keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, easing: 'easeInOut' as const }],
    animIn: { preset: 'fade' as const, duration: 0.4 },
    animOut: { preset: 'fade' as const, duration: 0.4 },
    locked: false,
    hidden: false,
    props: { text: `T${i}` },
  }));
  const parsed = { ...doc, layers: layers as unknown as typeof doc.layers };
  E().init({ projectId: 'p', doc: parsed, docVersion: 1, media });
}

beforeEach(load);

describe('timelineRemap', () => {
  const v = (id: string, a: number, b: number, speed = 1): Clip => ({ id, kind: 'video', mediaId: 'm', in: a, out: b, speed, volume: 1, muted: false });

  it('moves times after a deleted clip back and lands deleted footage on the cut', () => {
    const map = timelineRemap([v('a', 0, 10), v('b', 20, 30), v('c', 40, 50)], [v('a', 0, 10), v('c', 40, 50)]);
    expect(map(5)).toBe(5);
    expect(map(15)).toBe(10);
    expect(map(25)).toBeCloseTo(15);
  });

  it('follows trims at the clip speed, and footage trimmed away clamps to the edge', () => {
    const map = timelineRemap([v('a', 0, 10, 2), v('b', 0, 10)], [v('a', 4, 10, 2), v('b', 0, 10)]);
    expect(map(1)).toBe(0); // source 2 s – trimmed away
    expect(map(3)).toBeCloseTo(1); // source 6 s → (6 − 4) / 2
    expect(map(6)).toBeCloseTo(4); // b starts at 3 instead of 5
  });

  it('follows a clip that moved, and a part split off it', () => {
    const map = timelineRemap([v('a', 0, 10), v('b', 0, 10)], [v('b', 0, 10), v('a', 0, 4), v('a2', 4, 10)]);
    expect(map(2)).toBeCloseTo(12);
    expect(map(7)).toBeCloseTo(17);
    expect(map(12)).toBeCloseTo(2);
  });

  it('reads the end of a span as belonging to the clip that ends there', () => {
    const map = timelineRemap([v('a', 0, 10), v('b', 0, 10)], [v('b', 0, 10), v('a', 0, 10)]);
    expect(map(10, true)).toBeCloseTo(20);
    expect(map(10)).toBeCloseTo(0);
  });
});

describe('snapping and stepping', () => {
  it('snaps within tolerance to the nearest point', () => {
    expect(snapTime(10.04, [0, 10, 10.1], 0.1)).toEqual({ t: 10, to: 10 });
    expect(snapTime(12, [0, 10], 0.1)).toEqual({ t: 12, to: null });
  });

  it('steps to the next and previous cut', () => {
    const pts = editPoints(E().doc.clips);
    expect(pts).toEqual([0, 20, 40, 60, 80, 100, 120]);
    expect(stepTo(pts, 25, 1)).toBe(40);
    expect(stepTo(pts, 25, -1)).toBe(20);
    expect(stepTo(pts, 120, 1)).toBeNull();
  });
});

describe('clip edits ripple the graphics', () => {
  it('trims the out edge: later clips and their layers move up, one undo step', () => {
    const before = E().past.length;
    ops.trimClip('c0_0', 'out', 14); // 20 s → 10 s
    expect(clipDuration(clip('c0_0'))).toBe(10);
    expect(startOf('c0_1')).toBe(10);
    expect(layer('L0')).toMatchObject({ start: 5, end: 8 });
    expect(layer('L1').start).toBeCloseTo(15);
    expect(layer('L5').start).toBeCloseTo(95);
    expect(E().past.length).toBe(before + 1);
    E().undo();
    expect(startOf('c0_1')).toBe(20);
    expect(layer('L1').start).toBeCloseTo(25);
  });

  it('trims the in edge: the picture inside the clip moves with it', () => {
    ops.trimClip('c0_1', 'in', 37); // in 34 → 37: 3 s gone from the start of clip 2
    expect(layer('L1').start).toBeCloseTo(22);
    expect(layer('L2').start).toBeCloseTo(42);
  });

  it('a drag computes from its start, so dragging back restores everything', () => {
    const base = E().doc;
    for (const out of [20, 16, 9, 6, 12, 24]) ops.trimClip('c0_0', 'out', out, 'trim-drag', { base });
    expect(clip('c0_0').out).toBe(24);
    expect(layer('L0')).toMatchObject({ start: 5, end: 8 });
    expect(layer('L1').start).toBeCloseTo(25);
    expect(E().past.length).toBe(1); // merged into one step
  });

  it('ripple deletes several selected clips; layers inside them go too, undo brings all back', () => {
    E().select({ kind: 'clip', id: 'c1_0', ids: ['c0_1', 'c1_0'] });
    expect(selectedClipIds(E().selection)).toEqual(['c0_1', 'c1_0']);
    expect(ops.deleteClips(selectedClipIds(E().selection))).toBe(true);
    expect(E().doc.clips.map((c) => c.id)).toEqual(['c0_0', 'c1_1', 'c2_0', 'c2_1']);
    expect(timelineDuration(E().doc)).toBe(80);
    expect(E().doc.layers.map((l) => l.id)).toEqual(['L0', 'L3', 'L4', 'L5']);
    expect(layer('L3').start).toBeCloseTo(25);
    expect(E().selection).toBeNull();
    E().undo();
    expect(E().doc.clips).toHaveLength(6);
    expect(E().doc.layers).toHaveLength(6);
    expect(layer('L3').start).toBeCloseTo(65);
  });

  it('never deletes the last clip', () => {
    expect(ops.deleteClips(E().doc.clips.map((c) => c.id))).toBe(false);
    expect(E().doc.clips).toHaveLength(6);
  });

  it('moves a clip and its layer together', () => {
    ops.moveClip(0, 2);
    expect(
      E()
        .doc.clips.map((c) => c.id)
        .slice(0, 3),
    ).toEqual(['c0_1', 'c1_0', 'c0_0']);
    expect(layer('L0').start).toBeCloseTo(45);
    expect(layer('L1').start).toBeCloseTo(5);
    E().undo();
    expect(layer('L0').start).toBe(5);
  });

  it('split at the playhead keeps everything in place', () => {
    expect(ops.splitAt(30)).toBe(true);
    expect(E().doc.clips).toHaveLength(7);
    expect(timelineDuration(E().doc)).toBe(120);
    expect(layer('L1').start).toBeCloseTo(25);
    expect(E().doc.clips[1]).toMatchObject({ id: 'c0_1', in: 34, out: 44 });
    expect(E().doc.clips[2]).toMatchObject({ in: 44, out: 54 });
  });

  it('trims to the playhead (Q / W) and the playhead stays on the picture', () => {
    E().setTime(30);
    expect(ops.trimToPlayhead('start')).toBe(true); // clip 2 now starts with source 44
    expect(clip('c0_1').in).toBeCloseTo(44);
    expect(E().time).toBeCloseTo(20);
    expect(layer('L2').start).toBeCloseTo(35);
    E().setTime(25);
    expect(ops.trimToPlayhead('end')).toBe(true);
    expect(clip('c0_1').out).toBeCloseTo(49);
    expect(timelineDuration(E().doc)).toBeCloseTo(105);
  });

  it('a freeze frame is one undo step and pushes later graphics on', () => {
    const steps = E().past.length;
    ops.freezeAt(30, 2);
    expect(E().past.length).toBe(steps + 1);
    expect(E().doc.clips.map((c) => c.kind)).toContain('freeze');
    expect(timelineDuration(E().doc)).toBe(122);
    expect(layer('L2').start).toBeCloseTo(47);
    expect(layer('L1').start).toBeCloseTo(25);
  });

  it('slower clips push the rest later', () => {
    ops.setClipProps('c0_0', { speed: 0.5 });
    expect(startOf('c0_1')).toBe(40);
    expect(layer('L0').start).toBeCloseTo(10);
    expect(layer('L1').start).toBeCloseTo(45);
  });

  it('shifts layers in time keeping their length (Alt+arrows)', () => {
    ops.shiftLayers(['L0'], 1);
    ops.shiftLayers(['L0'], 1);
    expect(layer('L0')).toMatchObject({ start: 7, end: 10 });
    expect(E().past.length).toBe(1);
  });
});
