import { migrateProject, type MediaRef } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { byHole, clipSlot, goPro, holeConflict, nameKey, roundOrder } from '../src';

// The same cases as apps/api/tests/test_chronology.py: both sides must order a round alike.
const media = (name: string, recordedAt: string | null = null, extra: Partial<MediaRef> & { hole?: string } = {}) => {
  const { hole, ...rest } = extra;
  return {
    id: name,
    kind: 'video' as const,
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 10,
    hdr: false,
    hasAudio: true,
    geo: null,
    place: hole ? { course: 'Testbane', hole, par: 4, fromTee: 0, toGreen: 300, line: [] } : null,
    recordedAt,
    ...rest,
  } satisfies MediaRef;
};
const names = (ms: { name: string }[]) => ms.map((m) => m.name);
const byName = (list: string[]) => names([...list].sort((a, b) => (nameKey(a) < nameKey(b) ? -1 : 1)).map((name) => ({ name })));

describe('file names', () => {
  it('reads GoPro recordings and chapters', () => {
    expect(goPro('GX010123.MP4')).toEqual({ rec: 123, chapter: 1 });
    expect(goPro('GH020123.MP4')).toEqual({ rec: 123, chapter: 2 });
    expect(goPro('GOPR0123.MP4')).toEqual({ rec: 123, chapter: 0 });
    expect(goPro('GP010123.MP4')).toEqual({ rec: 123, chapter: 1 });
    expect(goPro('GX0101234.MP4')).toBeNull();
    expect(goPro('IMG_0123.MOV')).toBeNull();
  });

  it('sorts numbers by value and GoPro chapters with their recording', () => {
    expect(byName(['clip10.mp4', 'clip9.mp4', 'Clip1.mp4'])).toEqual(['Clip1.mp4', 'clip9.mp4', 'clip10.mp4']);
    expect(byName(['GX010124.MP4', 'GX020123.MP4', 'GX010123.MP4'])).toEqual(['GX010123.MP4', 'GX020123.MP4', 'GX010124.MP4']);
    expect(byName(['GP010123.MP4', 'GOPR0123.MP4'])).toEqual(['GOPR0123.MP4', 'GP010123.MP4']);
    expect(byName(['VID-20261016-WA0010.mp4', 'VID-20261016-WA0003.mp4', 'VID-20261015-WA0042.mp4'])).toEqual([
      'VID-20261015-WA0042.mp4',
      'VID-20261016-WA0003.mp4',
      'VID-20261016-WA0010.mp4',
    ]);
  });
});

describe('roundOrder', () => {
  it('orders sure times across time zones, keeping GoPro chapters together', () => {
    const o = roundOrder([
      media('b.mov', '2026-10-16T12:30:00+0200'),
      media('a.mp4', '2026-10-16T10:00:00Z', { recordedAtSource: 'filename' }),
      media('GX020123.MP4', '2026-10-16T10:40:00Z'),
      media('c.mov', '2026-10-16T10:20:00Z'),
      media('GX010123.MP4', '2026-10-16T10:10:00Z'),
    ]);
    expect(o.by).toBe('time');
    expect(names(o.media)).toEqual(['a.mp4', 'GX010123.MP4', 'GX020123.MP4', 'c.mov', 'b.mov']);
  });

  it('falls back to holes when no time is sure, and puts clips without a hole last', () => {
    const file = { recordedAtSource: 'file' as const };
    const o = roundOrder([
      media('x.mp4', '2026-10-16T08:00:00Z', { ...file }),
      media('h3.mp4', '2026-10-16T08:00:01Z', { ...file, hole: '3' }),
      media('h1.mp4', '2026-10-16T08:00:02Z', { ...file, hole: '1' }),
    ]);
    expect(o).toMatchObject({ by: 'hole', unsure: ['x.mp4'] });
    expect(names(o.media)).toEqual(['h1.mp4', 'h3.mp4', 'x.mp4']);
  });

  it('mixes sure and missing times as before: timed first, the rest by name', () => {
    const o = roundOrder([media('b.mp4'), media('z.mov', '2026-10-16T10:00:00Z'), media('a.mp4')]);
    expect(o).toMatchObject({ by: 'mixed', unsure: ['b.mp4', 'a.mp4'] });
    expect(names(o.media)).toEqual(['z.mov', 'a.mp4', 'b.mp4']);
  });
});

describe('holes', () => {
  const holes = (hs: string[]) => hs.map((h) => media(`h${h}`, null, { hole: h }));
  it('starts after the biggest gap: a round from hole 10 wraps 18 → 1', () => {
    expect(names(byHole(holes(['3', '18', '10', '1', '12'])))).toEqual(['h10', 'h12', 'h18', 'h1', 'h3']);
    expect(names(byHole(holes(['9', '1', '5'])))).toEqual(['h1', 'h5', 'h9']);
    // Every hole filmed: no gap, start at 1.
    const all = Array.from({ length: 18 }, (_, i) => String(18 - i));
    expect(names(byHole(holes(all)))[0]).toBe('h1');
  });

  it('finds strong contradictions only', () => {
    const timed = (hs: string[]) => hs.map((h, i) => media(`h${h}`, `2026-10-16T${String(8 + i).padStart(2, '0')}:00:00Z`, { hole: h }));
    expect(holeConflict(timed(['1', '7', '3', '4']))?.map((m) => m.name)).toEqual(['h7', 'h3']);
    expect(holeConflict(timed(['10', '14', '18', '1', '5']))).toBeNull();
    expect(holeConflict(timed(['1', '3', '2', '4']))).toBeNull(); // one hole back: a tee by the last green
    expect(holeConflict(timed(['1', '1', '2']))).toBeNull();
    // File dates are not sure enough to contradict anything.
    expect(holeConflict(holes(['5', '1', '9']))).toBeNull();
  });
});

describe('clipSlot (where the timeline puts a new clip)', () => {
  it('goes before the first clip that comes later in the round', () => {
    const doc = migrateProject({
      schemaVersion: 1,
      name: 'R',
      media: {
        a: media('a', '2026-10-16T10:00:00Z'),
        c: media('c', '2026-10-16T10:20:00Z'),
        b: media('b', '2026-10-16T10:10:00Z'),
        n: media('n'),
      },
      clips: [
        { id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 10 },
        { id: 'cc', kind: 'video', mediaId: 'c', in: 0, out: 10 },
      ],
    });
    expect(clipSlot(doc, 'b')).toBe(1);
    expect(clipSlot(doc, 'n')).toBe(2);
  });
});
