/**
 * Undo/redo by id: server merges (new shots re-sorted in, a round's next clip inserted
 * mid-timeline) happen without an undo step, and must not shift an undo onto another item.
 */
import { byTimeline, type Shot } from '@golf/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOps, diff } from '../src/editor/history';
import * as ops from '../src/editor/ops';
import { useEditor, type MediaInfo } from '../src/editor/store';
import { bigRound } from './helpers/bigRound';

const E = () => useEditor.getState();
const shot = (id: string) => E().doc.shots.find((s) => s.id === id)!;

function load() {
  const { doc, media } = bigRound({ videos: 3, clipsPerVideo: 1, shotsPerClip: 2, layers: 2 });
  E().init({ projectId: 'p', doc, docVersion: 1, media });
  return { doc, media };
}

/** A shot of `mediaId` found by the analysis (as an SSE merge brings it). */
function serverShot(base: Shot, id: string, impactTime: number): Shot {
  return { ...base, id, impactTime, label: '' };
}

beforeEach(() => {
  load();
});

describe('id-addressed history', () => {
  it('undo after shots were merged in front changes the shot that was edited', () => {
    const [a, b] = E().doc.shots;
    ops.setShotVisible(b.id, false);
    expect(shot(b.id).visible).toBe(false);
    // Analysis finds two shots earlier in the same clip: indices of a and b move by two.
    E().silently((d) => {
      d.shots = [...d.shots, serverShot(a, 'early1', 0.1), serverShot(a, 'early2', 0.2)].sort(byTimeline(d.clips)) as typeof d.shots;
    });
    expect(E().doc.shots.findIndex((s) => s.id === b.id)).toBeGreaterThan(1);
    E().undo();
    expect(shot(b.id).visible).toBe(true);
    // The merged shots are untouched.
    expect(shot('early1').visible).toBe(true);
    expect(shot('early2').visible).toBe(true);
    expect(shot(a.id).visible).toBe(true);
    E().redo();
    expect(shot(b.id).visible).toBe(false);
    expect(E().doc.shots).toHaveLength(6 + 2);
  });

  it('undo after a clip was attached mid-timeline trims the clip that was trimmed', () => {
    const c2 = E().doc.clips[2];
    const out = c2.kind === 'video' ? c2.out : 0;
    ops.setClipProps(c2.id, { volume: 0.3 });
    // The round's next video lands between the first two (attachVideo uses clipSlot).
    const m: MediaInfo = { ...E().media.m0, id: 'mNew', name: 'IMG_0999.mov', recordedAt: '2000-01-01T00:00:00Z' };
    E().setMedia(m);
    ops.attachVideo(m);
    expect(E().doc.clips.findIndex((c) => c.id === c2.id)).not.toBe(2);
    E().undo();
    const after = E().doc.clips.find((c) => c.id === c2.id)!;
    expect(after.kind === 'video' && after.volume).toBe(1);
    expect(after.kind === 'video' && after.out).toBe(out);
    // The attached clip stays (it was not an undo step) and keeps its own volume.
    const added = E().doc.clips.find((c) => c.mediaId === 'mNew')!;
    expect(added.kind === 'video' && added.volume).toBe(1);
  });

  it('undoing a delete puts the shot back after its neighbour, merged shots stay', () => {
    const [a, b] = E().doc.shots;
    ops.deleteShot(b.id);
    E().silently((d) => {
      d.shots.unshift(serverShot(a, 'first', 0.05) as (typeof d.shots)[number]);
    });
    E().undo();
    const ids = E().doc.shots.map((s) => s.id);
    expect(ids.indexOf(b.id)).toBe(ids.indexOf(a.id) + 1);
    expect(ids).toContain('first');
    E().redo();
    expect(E().doc.shots.some((s) => s.id === b.id)).toBe(false);
    expect(E().doc.shots.some((s) => s.id === 'first')).toBe(true);
  });

  it('an item a merge removed meanwhile is skipped, not replaced by its neighbour', () => {
    const [a, b] = E().doc.shots;
    ops.setShotVisible(a.id, false);
    E().silently((d) => {
      d.shots = d.shots.filter((s) => s.id !== a.id) as typeof d.shots;
    });
    E().undo();
    expect(E().doc.shots.some((s) => s.id === a.id)).toBe(false);
    expect(shot(b.id).visible).toBe(true);
  });

  it('merged drag steps undo in one go, through a merge in between', () => {
    const layerId = E().doc.layers[0].id;
    const before = E().doc.layers[0].keyframes[0].x;
    ops.setLayerTransform(layerId, 0, { x: 0.2 }, 'k');
    E().silently((d) => {
      d.layers.unshift({ ...d.layers[1], id: 'merged' });
    });
    ops.setLayerTransform(layerId, 0, { x: 0.3 }, 'k');
    expect(E().past).toHaveLength(1);
    E().undo();
    expect(E().doc.layers.find((l) => l.id === layerId)!.keyframes[0].x).toBe(before);
    expect(E().doc.layers[0].id).toBe('merged');
  });

  it('reordering replays among the items it moved', () => {
    const a = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    const b = { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] };
    const ch = diff(a, b);
    expect(applyOps(a, ch.forward)).toEqual(b);
    expect(applyOps(b, ch.inverse)).toEqual(a);
    // With an item merged in at the front, the moved ones still swap among themselves.
    const merged = { list: [{ id: 'x' }, ...b.list] };
    expect(applyOps(merged, ch.inverse).list.map((x) => x.id)).toEqual(['x', 'a', 'b', 'c']);
  });

  it('lists without ids and changed shapes are replaced whole', () => {
    const a = { k: [1, 2, 3], o: { p: 1 } as unknown };
    const b = { k: [1, 3], o: null as unknown };
    const ch = diff(a, b);
    expect(applyOps(a, ch.forward)).toEqual(b);
    expect(applyOps(b, ch.inverse)).toEqual(a);
  });

  it('the automatic "Round …" to course rename is no undo step', () => {
    useEditor.setState({ doc: { ...E().doc, name: 'Round 2 May' } });
    ops.setShotVisible(E().doc.shots[0].id, false);
    ops.nameAfterCourse('Old Course', 'en');
    expect(E().doc.name).toMatch(/^Old Course – /);
    expect(E().past).toHaveLength(1);
    E().undo();
    // The user's own edit is undone; the name stays.
    expect(E().doc.shots[0].visible).toBe(true);
    expect(E().doc.name).toMatch(/^Old Course – /);
    // A name the user typed is never replaced.
    ops.rename('My round');
    ops.nameAfterCourse('Other Course', 'en');
    expect(E().doc.name).toBe('My round');
  });

  it('undo and redo keep a conflict open (the dialog must not vanish)', () => {
    ops.setShotVisible(E().doc.shots[0].id, false);
    useEditor.setState({ saveState: 'conflict' });
    E().undo();
    expect(E().saveState).toBe('conflict');
    E().redo();
    expect(E().saveState).toBe('conflict');
  });
});
