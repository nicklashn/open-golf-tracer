import { readFileSync } from 'node:fs';
import { migrateProject, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { sound } from './fixtures';
import { clockOffsets, compareShots, geoDistance, sameShotPairs, soundSimilarity, summarize, type RoundSummary } from '../src';

const sounds = JSON.parse(readFileSync(new URL('./fixtures/sound.json', import.meta.url), 'utf8'));

const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const shot = (id: string, mediaId: string, impactTime: number, extra: Record<string, unknown> = {}) => ({
  id,
  mediaId,
  impactTime,
  camera: { cx: 540, cy: 960 },
  anchor: { x: 526, y: 1472 },
  params,
  auto: { params, anchor: { x: 526, y: 1472 }, impactTime },
  ...extra,
});
const media = (id: string, recordedAt: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 60,
  recordedAt,
  geo: { lat: 56.2, lon: 9.7 },
  place: { course: 'Testbane', hole: '1', par: 4, fromTee: 0, toGreen: 300, line: [] },
  ...extra,
});
function project(medias: ReturnType<typeof media>[], shots: ReturnType<typeof shot>[]): Project {
  return migrateProject({
    schemaVersion: 1,
    name: 'Runde',
    media: Object.fromEntries(medias.map((m) => [m.id, m])),
    clips: medias.map((m) => ({ id: `c_${m.id}`, kind: 'video', mediaId: m.id, in: 0, out: 60 })),
    shots,
  });
}
const compare = (s: RoundSummary, x: string, y: string, offsets: number[] = []) => {
  const a = s.shots.find((q) => q.id === x)!;
  const b = s.shots.find((q) => q.id === y)!;
  const clip = (id: string) => s.clips.find((c) => c.id === id)!;
  return compareShots(a, b, clip(a.clipId), clip(b.clipId), offsets);
};

describe('sound signatures', () => {
  it('compares like the analysis does (shottracer/audio.py)', () => {
    expect(soundSimilarity(sounds.a, sounds.b)).toBeCloseTo(sounds.ab, 3);
    expect(soundSimilarity(sounds.a, sounds.c)).toBeCloseTo(sounds.ac, 3);
    expect(sounds.ab).toBeGreaterThan(0.9);
    expect(sounds.ac).toBeLessThan(0.4);
  });

  it('allows a small time shift and some hiss; two strikes differ', () => {
    expect(soundSimilarity(sound(1), sound(1))).toBeCloseTo(1, 6);
    expect(soundSimilarity(sound(1), sound(1, 0.4, 3))).toBeGreaterThan(0.85);
    expect(soundSimilarity(sound(1), sound(2))).toBeLessThan(0.4);
  });

  it('measures GPS distances', () => {
    expect(geoDistance({ lat: 56.2, lon: 9.7 }, { lat: 56.2001, lon: 9.7 })).toBeCloseTo(11.1, 0);
  });
});

describe('two shots from different clips', () => {
  it('one strike, two phones with the right clocks: sure', () => {
    const s = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:03+0200', { width: 1920, height: 1080 })],
        [shot('sa', 'a', 7, { sound: sound(1) }), shot('sb', 'b', 4.05, { sound: sound(1, 0.4, 2) })],
      ),
    );
    const m = compare(s, 'sa', 'sb');
    expect(m).toMatchObject({ verdict: 'same', sure: true });
    expect(m.score).toBeGreaterThan(0.95);
    expect(m.distM).toBe(0);
  });

  it('a phone clock 40 s off: one pair is asked, two pairs agreeing on the offset are sure', () => {
    const one = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:40+0200')],
        [shot('sa', 'a', 7, { sound: sound(1) }), shot('sb', 'b', 7, { sound: sound(1, 0.3) })],
      ),
    );
    expect(clockOffsets(one)).toEqual([]);
    expect(compare(one, 'sa', 'sb')).toMatchObject({ verdict: 'same', sure: false });

    const two = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:40+0200')],
        [
          shot('sa1', 'a', 7, { sound: sound(1) }),
          shot('sb1', 'b', 7, { sound: sound(1, 0.3) }),
          shot('sa2', 'a', 50, { sound: sound(2) }),
          shot('sb2', 'b', 50.1, { sound: sound(2, 0.3) }),
        ],
      ),
    );
    const [offset] = clockOffsets(two);
    expect(offset).toBeCloseTo(40, 0);
    expect(compare(two, 'sa1', 'sb1', [offset])).toMatchObject({ verdict: 'same', sure: true });
    expect(compare(two, 'sa1', 'sb2', [offset]).verdict).not.toBe('same');
    expect(sameShotPairs(two).map((m) => [m.a.id, m.b.id, m.sure])).toEqual([
      ['sa1', 'sb1', true],
      ['sa2', 'sb2', true],
    ]);
  });

  it('a partner teeing off after the player, filmed from the same spot: different', () => {
    const s = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:45+0200')],
        [shot('me', 'a', 7, { sound: sound(1) }), shot('partner', 'b', 7, { sound: sound(2), anchor: { x: 700, y: 1500 } })],
      ),
    );
    const m = compare(s, 'me', 'partner');
    expect(m.verdict).toBe('different');
    expect(m.score).toBeLessThan(0.1);
  });

  it('the same player again from the same spot, minutes later: a retake', () => {
    const s = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:01:00+0200')],
        [shot('first', 'a', 7, { sound: sound(1) }), shot('again', 'b', 9, { sound: sound(3) })],
      ),
    );
    expect(compare(s, 'first', 'again').verdict).toBe('retake');
  });

  it('without sound only matching clocks make it the same shot, and then it is asked', () => {
    const s = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:02+0200'), media('c', '2026-06-16T10:00:05+0200')],
        [shot('sa', 'a', 7), shot('sb', 'b', 5.5), shot('sc', 'c', 4.5)],
      ),
    );
    expect(compare(s, 'sa', 'sb')).toMatchObject({ verdict: 'same', sure: false });
    expect(compare(s, 'sa', 'sc').verdict).not.toBe('same'); // 2.5 s apart
  });

  it('different holes are never the same shot', () => {
    const s = summarize(
      project(
        [media('a', '2026-06-16T10:00:00+0200'), media('b', '2026-06-16T10:00:00+0200', { place: { course: 'Testbane', hole: '2', par: 4, line: [] } })],
        [shot('sa', 'a', 7, { sound: sound(1) }), shot('sb', 'b', 7, { sound: sound(1) })],
      ),
    );
    expect(sameShotPairs(s)).toEqual([]);
  });
});
