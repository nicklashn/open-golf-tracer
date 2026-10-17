import { shotStats } from '@golf/render';
import { migrateProject, timelineDuration, type Project, type Shot } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { FADE_S, LANDED_PAD_S, cleanSpan, highlightShort, puttCuts, shortFor, youtubeVideo } from '../src';
import { roundProject } from './fixtures';

/** The round fixture with only shot s1 (clip a, struck at 10 s), given a clean window. */
function oneShot(clean?: { from: number; to: number }): Project {
  const doc = roundProject();
  return migrateProject({ ...doc, shots: doc.shots.filter((s) => s.id === 's1').map((s) => ({ ...s, clean })) });
}
const landOf = (s: Shot) => s.impactTime + shotStats(s)!.flightTimeS;
const video = (p: Project) => p.clips.filter((c) => c.kind === 'video');
const fades = (p: Project) => p.layers.filter((l) => l.type === 'shape' && l.props.fill === '#000000' && l.props.w > 1);

describe('cuts stay inside the clean window', () => {
  it('leaves shots without a window alone', () => {
    const s = oneShot().shots[0];
    expect(cleanSpan(s, 7, 20, 10, 16.7)).toEqual({ a: 7, b: 20, forced: false });
  });

  it('YouTube: starts after the golfer settled and ends before someone walks in, with a dip to black', () => {
    const doc = oneShot({ from: 8.4, to: 18.5 });
    const land = landOf(doc.shots[0]);
    expect(land).toBeLessThan(18.5);
    const v = youtubeVideo(doc, 'en', 'YT');
    const [c] = video(v);
    expect(c.in).toBeCloseTo(8.4, 6);
    expect(c.out).toBeCloseTo(18.5, 6); // 3.2 s after the landing would be later
    const [f] = fades(v);
    expect(f).toBeDefined();
    expect(f.start + FADE_S).toBeCloseTo(c.out - c.in, 6); // black at the forced cut
  });

  it('YouTube: a window that ends during the flight still keeps the flight', () => {
    const doc = oneShot({ from: 0, to: 12 });
    const land = landOf(doc.shots[0]);
    const [c] = video(youtubeVideo(doc, 'en', 'YT'));
    expect(c.out).toBeCloseTo(land + LANDED_PAD_S, 6);
    expect(c.in).toBeCloseTo(7, 6); // the window starts earlier than the 3 s pad
  });

  it('YouTube: a wide window changes nothing, and no fade', () => {
    const doc = oneShot({ from: 0, to: 30 });
    const v = youtubeVideo(doc, 'en', 'YT');
    const [c] = video(v);
    expect(c.out).toBeCloseTo(landOf(doc.shots[0]) + 3.2, 6);
    expect(fades(v)).toHaveLength(0);
  });

  it('YouTube: without a window the tail after the landing is a little shorter', () => {
    const doc = oneShot();
    const [c] = video(youtubeVideo(doc, 'en', 'YT'));
    expect(c.out).toBeCloseTo(landOf(doc.shots[0]) + 2.6, 6);
  });

  it('never keeps less than a second before the strike, whatever the window says', () => {
    const doc = oneShot({ from: 9.8, to: 30 });
    const [c] = video(youtubeVideo(doc, 'en', 'YT'));
    expect(c.in).toBeCloseTo(9, 6);
  });

  it('shorts and the highlight short end inside the window and fade out', () => {
    const doc = oneShot({ from: 8.4, to: landOf(oneShot().shots[0]) + 0.6 });
    const s = shortFor(doc, doc.shots[0], 'Short', 'en');
    const clips = video(s);
    expect(clips[0].in).toBeGreaterThanOrEqual(8.4);
    expect(clips[clips.length - 1].out).toBeCloseTo(doc.shots[0].clean!.to, 6);
    const [f] = fades(s);
    expect(f.end).toBeCloseTo(timelineDuration(s), 6);
    expect(f.animOut.preset).toBe('none');

    const h = highlightShort(doc, 'en', 'HL');
    expect(video(h)[video(h).length - 1].out).toBeCloseTo(doc.shots[0].clean!.to, 6);
    expect(fades(h)).toHaveLength(1);
  });

  it('putting cuts are clamped to the window but keep the roll', () => {
    const doc = roundProject();
    const media = doc.media.a;
    const putt = (impactTime: number, end: number, clean?: { from: number; to: number }) =>
      ({ ...doc.shots[0], kind: 'putt', impactTime, putt: { end, holed: true }, clean }) as Shot;
    const [c] = puttCuts([putt(10, 14, { from: 9.35, to: 14.2 })], media);
    expect(c.a).toBeCloseTo(9.35, 6);
    expect(c.b).toBeCloseTo(14.4, 6); // the roll plus the pad after landing, not the full second
    expect(c.forced).toBe(true);
    const [plain] = puttCuts([putt(10, 14)], media);
    expect([plain.a, plain.b, plain.forced]).toEqual([9.3, 15, false]);
  });
});
