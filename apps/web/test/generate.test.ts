import { migrateProject, timelineDuration } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { highlightShort, playedShots, youtubeVideo } from '../src/editor/generate';

// A real flight (6.7 s) from the physics parity fixtures, in a 1080x1920 portrait clip.
const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const shot = (id: string, mediaId: string, impactTime: number) => ({
  id,
  mediaId,
  impactTime,
  camera: { cx: 540, cy: 960 },
  anchor: { x: 526, y: 1472 },
  params,
  auto: { params, anchor: { x: 526, y: 1472 }, impactTime },
});
const media = (id: string, recordedAt: string, hole: string) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt,
  place: { course: 'Testbane', hole, par: 4, fromTee: 0, toGreen: 300, line: [] },
});

// Two clips of a round, on the timeline in the wrong order; hole 2 has two shots close together.
const doc = migrateProject({
  schemaVersion: 1,
  name: 'Runde',
  media: { b: media('b', '2026-05-02T11:10:00+0200', '2'), a: media('a', '2026-05-02T10:50:00+0200', '1') },
  clips: [
    { id: 'cb', kind: 'video', mediaId: 'b', in: 0, out: 30 },
    { id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 30 },
  ],
  shots: [shot('s3', 'b', 14), shot('s1', 'a', 10), shot('s2', 'b', 5)],
});

describe('make a video', () => {
  it('orders shots by clip, then time', () => {
    expect(playedShots(doc).map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  it('builds a 16:9 YouTube edit of every shot with titles and hole cards', () => {
    const v = youtubeVideo(doc, 'da', 'Runde – YouTube');
    expect(v.format.aspect).toBe('16:9');
    expect(v.format.fill).toBe('blur'); // vertical clips on a blurred background
    // s2 (5 s) and s3 (14 s) overlap with their flights, so they share one cut of clip b.
    const video = v.clips.filter((c) => c.kind === 'video');
    expect(video.map((c) => c.mediaId)).toEqual(['b', 'a']);
    expect(video[0].in).toBeCloseTo(2, 1); // 3 s before the first swing
    expect(video[0].out).toBeGreaterThan(14 + 6); // past the second landing
    const types = v.layers.map((l) => l.type);
    expect(types.filter((x) => x === 'statCard')).toHaveLength(3);
    expect(types.filter((x) => x === 'holeInfo')).toHaveLength(2); // hole 2, then hole 1
    expect(types).toContain('lowerThird');
    for (const l of v.layers) expect(l.end).toBeLessThanOrEqual(timelineDuration(v) + 1e-6);
  });

  it('builds one vertical highlight short following the ball', () => {
    const v = highlightShort(doc, 'en', 'Highlights');
    expect(v.format.aspect).toBe('9:16');
    expect(v.format.reframe.keyframes.length).toBeGreaterThan(6);
    expect(v.layers.filter((l) => l.type === 'statCard')).toHaveLength(3);
    // Keyframes run forward through the joined shorts.
    const ts = v.format.reframe.keyframes.map((k) => k.t);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  });
});
