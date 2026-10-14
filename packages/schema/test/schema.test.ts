import { describe, expect, it } from 'vitest';
import {
  Project,
  clipAt,
  cropAt,
  emptyProject,
  flightTimeAt,
  migrateProject,
  outputSize,
  sourceTimeOfFlight,
  sourceToTimeline,
  timelineDuration,
  type Clip,
} from '../src';

const clips: Clip[] = [
  { id: 'a', kind: 'video', mediaId: 'm', in: 0, out: 4, speed: 1, volume: 1, muted: false },
  { id: 'b', kind: 'video', mediaId: 'm', in: 4, out: 5, speed: 0.25, volume: 1, muted: false },
  { id: 'c', kind: 'freeze', mediaId: 'm', at: 5, duration: 2 },
];

describe('project schema', () => {
  it('fills defaults for an empty project', () => {
    const p = emptyProject('Test');
    expect(p.format.aspect).toBe('original');
    expect(p.clips).toEqual([]);
    expect(Project.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('migrates documents without version', () => {
    expect(migrateProject({ name: 'x' }).schemaVersion).toBe(1);
  });

  it('rejects garbage', () => {
    expect(() => Project.parse({ schemaVersion: 1, clips: [{ kind: 'video' }] })).toThrow();
  });
});

describe('timeline mapping', () => {
  it('computes duration with speed and freeze', () => {
    expect(timelineDuration({ clips })).toBeCloseTo(4 + 4 + 2);
  });

  it('maps timeline to source time', () => {
    expect(clipAt(clips, 2)!.sourceTime).toBeCloseTo(2);
    expect(clipAt(clips, 6)!.sourceTime).toBeCloseTo(4.5);
    const f = clipAt(clips, 9)!;
    expect(f.sourceTime).toBe(5);
    expect(f.tracerTime).toBeCloseTo(6);
    expect(clipAt(clips, 10)!.index).toBe(2);
    expect(clipAt(clips, 10.5)).toBeNull();
  });

  it('maps source to timeline', () => {
    expect(sourceToTimeline(clips, 'm', 4.5)).toEqual([6]);
    expect(sourceToTimeline(clips, 'm', 4)).toEqual([4, 4]);
  });

  it('inverts flight time', () => {
    const shot = { impactTime: 2, timing: { launchOffset: 0.03, speed: 1.5 }, slowmo: 2, params: [0, 0, 0, 0, 0, 0, 0, 0, 0.01] };
    const s = sourceTimeOfFlight(shot, 1.25);
    expect(flightTimeAt(shot, s)).toBeCloseTo(1.25);
  });
});

describe('output and crop', () => {
  it('sizes presets', () => {
    expect(outputSize('9:16', 'shorts', { width: 3840, height: 2160 })).toEqual({ width: 1080, height: 1920 });
    expect(outputSize('16:9', 'youtube4k', { width: 3840, height: 2160 })).toEqual({ width: 3840, height: 2160 });
    expect(outputSize('9:16', 'shorts', { width: 3840, height: 2160 }, 720)).toEqual({ width: 720, height: 1280 });
  });

  it('crops inside the frame', () => {
    const p = emptyProject();
    p.format.aspect = '9:16';
    p.format.reframe = { mode: 'manual', keyframes: [{ t: 0, cx: 0.99, cy: 0.5, zoom: 1 }] };
    const c = cropAt(p, { width: 1920, height: 1080 }, 0);
    expect(c.h).toBe(1080);
    expect(c.w).toBeCloseTo(607.5);
    expect(c.x + c.w).toBeCloseTo(1920);
  });
});
