import { migrateProject, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { chapterClock, chapterTitle, compose, planFromRules, publishText, rulesDescription, summarize, timelineChapters } from '../src';
import { roundProject } from './fixtures';

/** A made video's timeline: clips of `seconds` each on the given holes (blank = no hole, e.g. a mood shot). */
function made(holes: [string, number][], titles: Record<string, string> = {}): Project {
  const media = Object.fromEntries(
    holes.map(([hole], i) => [
      `m${i}`,
      {
        id: `m${i}`,
        kind: 'video',
        name: `m${i}.mov`,
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 600,
        ...(hole ? { place: { course: 'Testbane', hole, par: 4, fromTee: 0, toGreen: 300, line: [] } } : {}),
      },
    ]),
  );
  const all = new Set(holes.map(([h]) => h).filter(Boolean));
  return migrateProject({
    schemaVersion: 1,
    name: 'Video',
    media,
    clips: holes.map(([, s], i) => ({ id: `c${i}`, kind: 'video', mediaId: `m${i}`, in: 0, out: s })),
    publish: { description: 'En runde.', holes: Object.fromEntries([...all].map((h) => [h, titles[h] ?? `Hul ${h}`])) },
  });
}

describe('chapters from the timeline (YouTube)', () => {
  it('one where each hole starts, "Intro" first when the first hole starts later, times as YouTube reads them', () => {
    const doc = made([
      ['', 12],
      ['1', 30],
      ['1', 42],
      ['2', 50],
      ['3', 3600],
    ]);
    expect(timelineChapters(doc)).toEqual([
      { t: 0, title: 'Intro' },
      { t: 12, title: 'Hul 1' },
      { t: 84, title: 'Hul 2' },
      { t: 134, title: 'Hul 3' },
    ]);
    expect(publishText(doc)).toBe('En runde.\n\n0:00 Intro\n0:12 Hul 1\n1:24 Hul 2\n2:14 Hul 3');
    expect(chapterClock(3725.9)).toBe('1:02:05');
  });

  it('keeps each chapter at least 10 s: a short intro gives way to the first hole, a short hole to the one before', () => {
    const doc = made([
      ['', 4],
      ['1', 30],
      ['2', 6],
      ['3', 30],
      ['4', 30],
    ]);
    expect(timelineChapters(doc).map((c) => [c.t, c.title])).toEqual([
      [0, 'Hul 1'],
      [34, 'Hul 2'],
      [70, 'Hul 4'],
    ]);
  });

  it('none when YouTube would not show them (fewer than 3), or for a video without publish text', () => {
    expect(
      timelineChapters(
        made([
          ['1', 60],
          ['2', 60],
        ]),
      ),
    ).toEqual([]);
    expect(
      publishText(
        made([
          ['1', 60],
          ['2', 60],
        ]),
      ),
    ).toBe('En runde.');
    expect(
      timelineChapters({
        ...made([
          ['1', 60],
          ['2', 60],
          ['3', 60],
        ]),
        publish: undefined,
      }),
    ).toEqual([]);
  });

  it('an export of part of the video counts from its start', () => {
    const doc = made([
      ['1', 60],
      ['2', 60],
      ['3', 60],
      ['4', 60],
    ]);
    expect(timelineChapters(doc, { start: 70, end: 240 }).map((c) => [c.t, c.title])).toEqual([
      [0, 'Hul 2'],
      [50, 'Hul 3'],
      [110, 'Hul 4'],
    ]);
  });

  it('follows the timeline when the video is trimmed in the editor', () => {
    const doc = made([
      ['1', 60],
      ['2', 60],
      ['3', 60],
    ]);
    const trimmed = { ...doc, clips: doc.clips.map((c, i) => (i === 0 && c.kind === 'video' ? { ...c, out: 20 } : c)) };
    expect(timelineChapters(trimmed).map((c) => c.t)).toEqual([0, 20, 80]);
  });
});

describe('the description without AI', () => {
  it('course, day, score and highlights – only facts', () => {
    const s = summarize(roundProject());
    const holes = [
      { hole: '1', par: 4, strokes: 3 },
      { hole: '2', par: 4, strokes: null },
    ].map((h) => ({ ...h, counted: 0, putts: 0, why: [], puttsUnsure: false, edited: [], shotIds: [] }));
    const da = rulesDescription(s, holes, ['s1'], 'da');
    expect(da).toBe('Golfrunde på Testbane, 16. juni 2026. Score på det hul, hvor alle slag er filmet: 3 (par 4, −1). Højdepunkter: Birdie på hul 1.');
    expect(rulesDescription(s, holes.slice(0, 1), ['s1'], 'en')).toBe(
      'A round of golf at Testbane, 16 June 2026. Score: 3 over one hole (par 4, −1). Highlights: Birdie on hole 1.',
    );
    expect(chapterTitle(holes[0], 'da')).toBe('Hul 1 – par 4 – birdie');
    expect(chapterTitle(holes[1], 'en')).toBe('Hole 2 – par 4');
  });

  it('a made video carries it (the AI description wins when there is one)', () => {
    const src = roundProject();
    const plan = planFromRules(summarize(src), '', 'da', { kind: 'youtube' });
    const [v] = compose(src, plan, null, { locale: 'da' });
    expect(v.document.publish?.description).toMatch(/^Golfrunde på Testbane/);
    expect(v.document.publish?.holes).toMatchObject({ '1': expect.stringMatching(/^Hul 1 – par 4/), '2': expect.stringMatching(/^Hul 2/) });
    const [w] = compose(src, { ...plan, description: 'Fra AI.' }, null, { locale: 'da' });
    expect(w.document.publish?.description).toBe('Fra AI.');
  });
});
