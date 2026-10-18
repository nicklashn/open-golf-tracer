/** "Looks right", fixing a flight by hand, changing the shot type, and the shot list by hole. */
import { summarize } from '@golf/compose';
import { shotStats } from '@golf/render';
import { migrateProject, type Shot } from '@golf/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { failuresFromJobs, noteAnalysisJob, setFailures, useAnalysisFailures } from '../src/editor/analysisFailures';
import { slowmoOptions } from '../src/editor/Inspector';
import * as ops from '../src/editor/ops';
import { shotList, shotName } from '../src/editor/shotGroups';
import { useEditor } from '../src/editor/store';
import en from '../src/lib/i18n/en';
import { bigRound } from './helpers/bigRound';

const E = () => useEditor.getState();
const shot = (id: string) => E().doc.shots.find((s) => s.id === id)!;

beforeEach(() => {
  const { doc, media } = bigRound({ videos: 2, clipsPerVideo: 1, shotsPerClip: 2, layers: 0 });
  const shots = doc.shots.map((s, i) =>
    i === 0 ? { ...s, confidence: 0.4, visible: false, warnings: [{ code: 'no_track' as const }, { code: 'manual' as const }] } : s,
  );
  E().init({ projectId: 'p', doc: { ...doc, shots }, docVersion: 1, media });
});

describe('Looks right', () => {
  it('clears the warnings, keeps how the shot came to be, and is one undo step', () => {
    const id = E().doc.shots[0].id;
    const steps = E().past.length;
    ops.approveShot(id);
    expect(shot(id).warnings.map((w) => w.code)).toEqual(['manual']);
    expect(shot(id).confidence).toBe(1);
    // A doubtful full shot that was hidden is shown once confirmed.
    expect(shot(id).visible).toBe(true);
    expect(E().past.length).toBe(steps + 1);
    E().undo();
    expect(shot(id).warnings.map((w) => w.code)).toEqual(['no_track', 'manual']);
    expect(shot(id).confidence).toBe(0.4);
  });

  it('happens by itself when the flight is fixed by hand (but a putt question stays)', () => {
    const id = E().doc.shots[0].id;
    E().silently((d) => {
      d.shots[0].warnings.push({ code: 'putt_count_unsure' });
    });
    ops.bringIntoView(id);
    expect(shot(id).warnings.map((w) => w.code)).toEqual(['manual', 'putt_count_unsure']);
    expect(shot(id).confidence).toBe(1);
  });

  it('a drawn path settles the doubts too', () => {
    const id = E().doc.shots[0].id;
    ops.drawShot(id, { x: 900, y: 900 }, { x: 960, y: 300 }, { x: 1000, y: 700 });
    expect(shot(id).warnings.map((w) => w.code)).toEqual(['manual']);
  });
});

describe('shot type', () => {
  it('full → putt drops the tracer and gives the putt an end; the score counts it as a putt', () => {
    const id = E().doc.shots[1].id;
    E().silently((d) => {
      d.shots[1].constraints.carry = 150;
      d.shots[1].warnings.push({ code: 'short_shot' });
    });
    expect(ops.setShotKind(id, 'putt')).toBe(true);
    const s = shot(id);
    expect(s.kind).toBe('putt');
    expect(s.putt!.end).toBeGreaterThan(s.impactTime);
    expect(s.putt!.holed).toBeNull();
    expect(s.constraints.carry).toBeNull();
    expect(s.warnings.some((w) => w.code === 'short_shot')).toBe(false);
    // Still a valid project.
    expect(() => migrateProject(E().doc)).not.toThrow();
    expect(ops.setShotKind(id, 'putt')).toBe(false);
  });

  it('putt → full gets a default flight from where the ball lay, in the picture', () => {
    const id = E().doc.shots[1].id;
    ops.setShotKind(id, 'putt');
    E().silently((d) => {
      d.shots[1].params = [1, 0.01, 0, 0.001, 0, 0, 0, 7, 0]; // what a putt carries: no real flight
      d.shots[1].visible = false;
    });
    ops.setShotKind(id, 'full');
    const s = shot(id);
    expect(s.kind).toBe('full');
    expect(s.putt).toBeUndefined();
    expect(s.visible).toBe(true);
    const st = shotStats(s)!;
    expect(st.carryM).toBeGreaterThan(40);
    expect(st.apexM).toBeGreaterThan(5);
    expect(() => migrateProject(E().doc)).not.toThrow();
    E().undo();
    expect(shot(id).kind).toBe('putt');
  });

  it('the scorecard follows the kinds', () => {
    E().silently((d) => {
      for (const m of Object.values(d.media)) m.place = { course: 'Test GK', hole: '4', par: 4, fromTee: null, toGreen: null, line: [] };
    });
    const putts = () => summarize(E().doc).holes[0]?.putts ?? 0;
    const before = putts();
    ops.setShotKind(E().doc.shots[3].id, 'putt');
    expect(putts()).toBe(before + 1);
  });
});

describe('shot list', () => {
  const doc = (holes: (string | null)[], visible: boolean[]) => {
    const media: Record<string, unknown> = {};
    holes.forEach((h, i) => {
      media[`m${i}`] = {
        id: `m${i}`,
        kind: 'video',
        name: `c${i}`,
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 10,
        place: h ? { course: 'X', hole: h, par: 4 } : null,
      };
    });
    const shots = holes.map((_, i) => ({
      id: `s${i}`,
      mediaId: `m${i}`,
      impactTime: 1,
      visible: visible[i],
      camera: { cx: 960, cy: 540 },
      anchor: { x: 900, y: 900 },
      params: [55, 0.28, 0, 0.0035, 0, 0.05, 0.18, 7.3, 0],
      auto: { params: [55, 0.28, 0, 0.0035, 0, 0.05, 0.18, 7.3, 0], anchor: { x: 900, y: 900 }, impactTime: 1 },
    }));
    return migrateProject({ schemaVersion: 1, media, shots });
  };

  it('groups a round by hole, numbered within the hole, without gaps for hidden shots', () => {
    const l = shotList(doc(['4', '4', '4', '5', '5'], [true, false, true, true, true]));
    expect(l.byHole).toBe(true);
    expect(l.groups.map((g) => [g.hole, g.par, g.shots.map((s) => s.id)])).toEqual([
      ['4', 4, ['s0', 's2']],
      ['5', 4, ['s3', 's4']],
    ]);
    expect([...l.numbers.entries()]).toEqual([
      ['s0', 1],
      ['s2', 2],
      ['s3', 1],
      ['s4', 2],
    ]);
    expect(l.hidden.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps one flat list when no clip has a hole, still without gaps', () => {
    const l = shotList(doc([null, null, null], [true, false, true]));
    expect(l.byHole).toBe(false);
    expect(l.groups).toHaveLength(1);
    expect(l.numbers.get('s2')).toBe(2);
  });

  it('a corrected par wins over the map', () => {
    const d = doc(['4'], [true]);
    expect(shotList({ ...d, scoreEdits: { '4': { par: 5 } } }).groups[0].par).toBe(5);
  });

  it('names: number, putt, or what a hidden one is', () => {
    const s = doc(['4'], [true]).shots[0];
    expect(shotName(s, 3, en)).toBe('Shot 3');
    expect(shotName({ ...s, kind: 'putt' } as Shot, 3, en)).toBe('Putt');
    expect(shotName(s, 0, en)).toBe('Possible shot');
    expect(shotName({ ...s, kind: 'short' } as Shot, 0, en)).toBe('Short shot');
    expect(shotName({ ...s, label: 'Ace' }, 3, en)).toBe('Ace');
  });
});

describe('slow motion choices', () => {
  it('names the phone settings and keeps a value from the analysis', () => {
    expect(slowmoOptions(4, en).map((o) => o.label)).toEqual([
      'No – normal speed',
      '120 fps played back at 60 fps',
      '120 fps played back at 30 fps',
      '240 fps played back at 30 fps',
    ]);
    expect(slowmoOptions(16, en).at(-1)).toEqual({ value: '16', label: '16×' });
  });
});

describe('failed analyses', () => {
  it('remembers the clips whose latest analysis failed, until it runs again', () => {
    const jobs = [
      { id: 'j3', kind: 'analyze', status: 'failed', mediaId: 'a', error: 'boom' },
      { id: 'j2', kind: 'analyze', status: 'succeeded', mediaId: 'b', error: '' },
      { id: 'j1', kind: 'analyze', status: 'failed', mediaId: 'b', error: 'old' },
      { id: 'j0', kind: 'ingest', status: 'failed', mediaId: 'c', error: '' },
    ] as const;
    setFailures(failuresFromJobs([...jobs]));
    expect(Object.keys(useAnalysisFailures.getState().byMedia)).toEqual(['a']);
    noteAnalysisJob({ id: 'j4', status: 'queued', mediaId: 'a', error: '' });
    expect(useAnalysisFailures.getState().byMedia).toEqual({});
    noteAnalysisJob({ id: 'j4', status: 'failed', mediaId: 'a', error: 'again' });
    expect(useAnalysisFailures.getState().byMedia.a).toEqual({ jobId: 'j4', error: 'again' });
  });
});
