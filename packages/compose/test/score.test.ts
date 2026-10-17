import { migrateProject, timelineDuration, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import {
  compose,
  highlightShort,
  holeScores,
  mergeAiPlan,
  planFromRules,
  prepare,
  PUTT_HOLE_MAX_S,
  puttCuts,
  puttsUnsure,
  readPreference,
  reasonText,
  scoreName,
  summarize,
  summaryText,
  youtubeVideo,
  type StrokeSummary,
} from '../src';

// A real flight (6.7 s) from the physics parity fixtures, in a 1080x1920 portrait clip.
const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const shot = (id: string, mediaId: string, impactTime: number, extra: Record<string, unknown> = {}) => ({
  id,
  mediaId,
  impactTime,
  camera: { cx: 540, cy: 960 },
  anchor: { x: 526, y: 1472 },
  params,
  auto: { params, anchor: { x: 526, y: 1472 }, impactTime },
  // Ten tracked ball positions: a measured flight.
  track: { t: [...Array(10).keys()].map((i) => impactTime + i * 0.1), u: Array(10).fill(526), v: [...Array(10).keys()].map((i) => 1400 - i * 40) },
  ...extra,
});
const putt = (id: string, mediaId: string, impactTime: number, end: number, holed: boolean | null, extra: Record<string, unknown> = {}) =>
  shot(id, mediaId, impactTime, { kind: 'putt', putt: { end, holed }, ...extra });

const LAT = 56.2;
const M_PER_DEG = 111195;
/** A clip `north` metres up the hole from the tee, on hole 7 (par 4). */
const media = (id: string, minute: number, north: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt: `2026-06-16T10:${String(minute).padStart(2, '0')}:00+0200`,
  geo: { lat: LAT + north / M_PER_DEG, lon: 9.7, acc: 5 },
  place: { course: 'Testbane', hole: '7', par: 4, fromTee: north, toGreen: 380 - north, line: [] },
  ...extra,
});

function project(medias: ReturnType<typeof media>[], shots: ReturnType<typeof shot>[]): Project {
  return migrateProject({
    schemaVersion: 1,
    name: 'Runde',
    media: Object.fromEntries(medias.map((m) => [m.id, m])),
    clips: medias.map((m) => ({ id: `c_${m.id}`, kind: 'video', mediaId: m.id, in: 0, out: 30 })),
    shots,
  });
}

/** The fixture flight's carry in metres. */
const CARRY = summarize(project([media('x', 0, 0)], [shot('x1', 'x', 5)])).shots[0].carryM!;

/** Hole 7: drive, approach (both the fixture flight) and two putts, the second holed: a par. */
const fullHole = (holed: boolean | null = true, putts: Record<string, unknown> = {}) =>
  project(
    [media('tee', 0, 0), media('fw', 5, CARRY), media('green', 9, 2 * CARRY)],
    [shot('drive', 'tee', 5), shot('approach', 'fw', 5), putt('p1', 'green', 5, 9, false, putts), putt('p2', 'green', 20, 23, holed, putts)],
  );

const texts = (doc: Project) => doc.layers.flatMap((l) => (l.type === 'text' ? [l.props.text] : l.type === 'lowerThird' ? [l.props.title] : []));

const greenCuts = (doc: Project) => doc.clips.flatMap((c) => (c.kind === 'video' && c.mediaId === 'green' ? [[c.in, c.out]] : []));

// Expected cuts changed deliberately with the "fewer putts" defaults: 0.7 s before a stroke and
// 1 s after the ball stops (was 1 s / 1 s), waits over 2.5 s cut out (was 4 s), 1.5 s hold for
// the score (was 2.5 s), and only the holed putt of each hole unless the wish asks for all.
describe('putts in the videos', () => {
  it('cuts the putting tight around each stroke, waits cut out', () => {
    const doc = fullHole();
    const putts = doc.shots.filter((s) => s.kind === 'putt');
    expect(puttCuts(putts, doc.media.green)).toMatchObject([
      { a: 4.3, b: 10 },
      { a: 19.3, b: 24 },
    ]);
    // A short wait stays in one cut; `whole` keeps the wait.
    expect(puttCuts([putts[0], { ...putts[1], impactTime: 11 }], doc.media.green)).toHaveLength(1);
    expect(puttCuts([putts[0], { ...putts[1], impactTime: 12, putt: { end: 15, holed: true } }], doc.media.green)).toHaveLength(2);
    // Kept whole, the green is still capped: its end stays.
    expect(puttCuts(putts, doc.media.green, true)).toMatchObject([{ a: 12, b: 24 }]);
  });

  it('keeps at most PUTT_HOLE_MAX_S of one green, the last putt always', () => {
    const doc = fullHole();
    const p = doc.shots.find((s) => s.kind === 'putt')!;
    // Five putts of 3 s, a long wait before each: 5 × 4.7 s of footage.
    const five = [0, 1, 2, 3, 4].map((i) => ({ ...p, id: `q${i}`, impactTime: 2 + 10 * i, putt: { end: 5 + 10 * i, holed: i === 4 } }));
    const cuts = puttCuts(five, { ...doc.media.green, duration: 60 });
    expect(cuts.reduce((n, c) => n + c.b - c.a, 0)).toBeLessThanOrEqual(PUTT_HOLE_MAX_S + 1e-9);
    expect(cuts[cuts.length - 1].putts.map((x) => x.id)).toEqual(['q4']);
    expect(cuts.flatMap((c) => c.putts.map((x) => x.id))).toEqual(['q3', 'q4']);
  });

  it('shows only the holed putt of each hole in the YouTube video by default, all with "alle putts"', () => {
    const doc = fullHole();
    const v = youtubeVideo(doc, 'da', 'YT');
    expect(greenCuts(v)).toEqual([[19.3, 24.5]]);
    const cards = v.layers.flatMap((l) => (l.type === 'statCard' ? [l.props.shotId] : []));
    expect(cards).toEqual(['drive', 'approach']);
    for (const l of v.layers) expect(l.end).toBeLessThanOrEqual(timelineDuration(v) + 1e-6);
    expect(greenCuts(youtubeVideo(doc, 'da', 'YT', {}, { putts: 'all' }))).toEqual([
      [4.3, 10],
      [19.3, 24.5],
    ]);
    const all = compose(doc, planFromRules(summarize(doc), 'YouTube med alle putts', 'da'), null, { locale: 'da' })[0].document;
    expect(greenCuts(all)).toHaveLength(2);
    expect(greenCuts(compose(doc, planFromRules(summarize(doc), 'YouTube uden putts', 'da'), null, { locale: 'da' })[0].document)).toEqual([]);
  });

  it('leaves out the putting of a hole the analysis is unsure of, until the putts question is answered', () => {
    const doc = fullHole(true, { confidence: 0.4 });
    const plan = planFromRules(summarize(doc), 'all putts', 'en');
    expect(greenCuts(youtubeVideo(doc, 'en', 'YT', {}, { putts: 'all' }))).toEqual([]);
    // Defaults are not answers: still left out, but the score counts them.
    const auto = compose(doc, plan, null, { locale: 'en' })[0].document;
    expect(greenCuts(auto)).toEqual([]);
    expect(texts(auto)).toContain('Hole 7 · Par 4 · Par');
    const answered = compose(doc, plan, { 'putts:7': '2' }, { locale: 'en' })[0].document;
    expect(greenCuts(answered)).toHaveLength(2);
  });

  it('keeps putts the analysis hid hidden, and their strokes in the score', () => {
    const doc = fullHole(true);
    doc.shots.find((s) => s.id === 'p1')!.visible = false;
    const plan = planFromRules(summarize(doc), 'alle putts', 'da');
    const { doc: ready } = prepare(doc, plan, null);
    expect(ready.shots.filter((s) => s.kind === 'putt').map((s) => s.visible)).toEqual([false, true]);
    expect(summarize(doc).holes[0]).toMatchObject({ putts: 2, strokes: 4 });
    expect(greenCuts(compose(doc, plan, null, { locale: 'da' })[0].document)).toEqual([[19.3, 24.5]]);
  });

  it('puts only notable holed putts in the highlight, and none when the wish says so', () => {
    const doc = fullHole();
    const hl = highlightShort(doc, 'en', 'HL');
    expect(greenCuts(hl)).toEqual([[19.3, 24]]);
    expect(hl.layers.filter((l) => l.type === 'statCard')).toHaveLength(2);
    // A tap-in (1 s roll) is not notable: only with "putts der går i".
    const tap = fullHole(true);
    tap.shots.find((s) => s.id === 'p2')!.putt = { end: 21, holed: true };
    expect(greenCuts(highlightShort(tap, 'en', 'HL'))).toEqual([]);
    expect(greenCuts(compose(tap, planFromRules(summarize(tap), 'short med putts der går i', 'da'), null, { locale: 'da' })[0].document)).toEqual([[19.3, 22]]);
    const none = compose(doc, planFromRules(summarize(doc), 'TikTok uden putts', 'da'), null, { locale: 'da' })[0].document;
    expect(none.clips.some((c) => c.mediaId === 'green')).toBe(false);
    const all = compose(doc, planFromRules(summarize(doc), 'a short with all putts'), null, { locale: 'en' })[0].document;
    expect(all.clips.filter((c) => c.mediaId === 'green')).toHaveLength(2);
  });

  it('makes no short per putt unless the wish asks for putts', () => {
    const doc = fullHole();
    const names = (wish: string) => compose(doc, planFromRules(summarize(doc), wish, 'en'), null, { locale: 'en' }).map((v) => v.document.shots[0].id);
    expect(names('one short per shot')).toEqual(['drive', 'approach']);
    expect(names('one short per shot, putts that go in')).toEqual(['drive', 'approach', 'p2']);
    expect(names('one short per shot with all putts')).toEqual(['drive', 'approach', 'p1', 'p2']);
    // Nothing to ask about putts when none are shown.
    const unsure = fullHole(true, { confidence: 0.4 });
    expect(planFromRules(summarize(unsure), 'one short per shot').questions.some((q) => q.id.startsWith('putts:'))).toBe(false);
  });

  it('reads putts in the wish', () => {
    expect(readPreference('YouTube uden putts').putts).toBe('none');
    expect(readPreference('no putts please').putts).toBe('none');
    expect(readPreference('kun putts der går i').putts).toBe('holed');
    expect(readPreference('only holed putts').putts).toBe('holed');
    expect(readPreference('med alle putts').putts).toBe('all');
    expect(readPreference('all putts').putts).toBe('all');
    expect(readPreference('a video of the round').putts).toBeNull();
    expect(planFromRules(summarize(fullHole()), 'uden putts').putts).toBe('none');
    expect(planFromRules(summarize(fullHole()), '').putts).toBeUndefined();
    // The AI may choose putts too; null keeps the default.
    const rule = planFromRules(summarize(fullHole()), '');
    expect(mergeAiPlan(rule, { putts: 'holed' }, []).putts).toBe('holed');
    expect(mergeAiPlan(rule, { putts: null }, []).putts).toBeUndefined();
    expect(() => mergeAiPlan(rule, { putts: 'some' }, [])).toThrow();
  });
});

describe('the score of a hole', () => {
  it('is given when every stroke was filmed, from the tee to a holed putt', () => {
    const s = summarize(fullHole());
    expect(s.holes).toEqual([
      { hole: '7', par: 4, counted: 4, putts: 2, strokes: 4, why: [], puttsUnsure: false, edited: [], shotIds: ['drive', 'approach', 'p1', 'p2'] },
    ]);
    expect(summaryText(s)).toContain('score (hole:strokes/par putts, ?=not every stroke filmed) 7:4/4 2p total 4/4');
    expect(scoreName(3, 4, 'da')).toBe('Birdie');
    expect(scoreName(6, 3, 'en')).toBe('+3');
    expect(scoreName(5, 4, 'da')).toBe('Bogey');
  });

  it('shows it in the YouTube video: a title after the hole and a scorecard at the end', () => {
    const v = youtubeVideo(fullHole(), 'da', 'YT');
    expect(texts(v)).toContain('Hul 7 · Par 4 · Par');
    expect(texts(v)).toContain('Hul\nPar\nSlag');
    expect(texts(v)).toContain('7\n4\n4');
    expect(texts(v)).toContain('I alt\n4\n4 (±0)');
    expect(v.clips[v.clips.length - 1].kind).toBe('freeze');
    // The holed putt is held a little longer to read the score.
    expect(v.clips.filter((c) => c.kind === 'video' && c.mediaId === 'green').map((c) => c.kind === 'video' && c.out)).toEqual([24.5]);
    const en = youtubeVideo(fullHole(), 'en', 'YT');
    expect(texts(en)).toContain('Hole 7 · Par 4 · Par');
  });

  it('keeps the score title on screen for at least 2.5 s, also when the hole ends the video', () => {
    for (const v of [youtubeVideo(fullHole(), 'da', 'YT')]) {
      const title = v.layers.find((l) => l.type === 'lowerThird' && l.props.title.startsWith('Hul 7'))!;
      expect(title.end - title.start).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('is never guessed: not holed, a missing stroke or not from the tee leave it open', () => {
    const open = (doc: Project) => summarize(doc).holes[0];
    expect(open(fullHole(false))).toMatchObject({ strokes: null, why: ['not_holed'] });
    // The approach was not filmed: the putts are two flights away from the drive.
    const gap = project([media('tee', 0, 0), media('green', 9, 2 * CARRY)], [shot('drive', 'tee', 5), putt('p1', 'green', 5, 9, true)]);
    expect(open(gap)).toMatchObject({ strokes: null, counted: 2, why: ['gap'] });
    const late = project([media('fw', 5, 150), media('green', 9, 150 + CARRY)], [shot('approach', 'fw', 5), putt('p1', 'green', 5, 9, true)]);
    expect(open(late).why).toEqual(['no_tee']);
    const v = youtubeVideo(fullHole(false), 'da', 'YT');
    expect(texts(v).some((t) => t.includes('Par 4 ·'))).toBe(false);
    expect(v.clips[v.clips.length - 1].kind).toBe('video'); // no scorecard
  });

  it('shows "–" for open holes on the scorecard', () => {
    const doc = project(
      [
        media('tee', 0, 0),
        media('fw', 5, CARRY),
        media('green', 9, 2 * CARRY),
        media('t8', 20, 0, { place: { course: 'Testbane', hole: '8', par: 3, fromTee: 0, toGreen: 150, line: [] } }),
      ],
      [shot('drive', 'tee', 5), shot('approach', 'fw', 5), putt('p1', 'green', 5, 9, false), putt('p2', 'green', 20, 23, true), shot('t8s', 't8', 5)],
    );
    const t = texts(youtubeVideo(doc, 'en', 'YT'));
    expect(t).toContain('8\n3\n–');
    expect(t).toContain('Total\n4\n4 (±0)');
    expect(t).toContain('– = not every stroke filmed');
  });
});

describe('where the next stroke was filmed', () => {
  it('flags a carry the next stroke contradicts, with the distances', () => {
    // The approach was filmed 40 % of the flight's carry from the tee.
    const near = Math.round(CARRY * 0.4);
    const doc = project(
      [media('tee', 0, 0), media('fw', 5, near), media('green', 9, near + CARRY)],
      [shot('drive', 'tee', 5), shot('approach', 'fw', 5), putt('p1', 'green', 5, 9, true)],
    );
    const s = summarize(doc);
    expect(s.shots[0]).toMatchObject({ nextOff: true });
    expect(s.shots[0].nextM).toBeCloseTo(near, -1);
    expect(s.shots[1].nextOff).toBe(false);
    expect(s.holes[0].why).toEqual(['next_shot_distance']);
    const q = planFromRules(s, '', 'da').questions.find((x) => x.id === 'doubtful')!;
    const item = q.items![0];
    expect(item).toMatchObject({ shotId: 'drive', reasons: ['next_shot_distance'], carryM: CARRY });
    expect(reasonText('next_shot_distance', 'da', item)).toBe(`Næste slag blev filmet ${item.nextM} m herfra, men banen viser ${CARRY} m`);
    expect(summaryText(s)).toContain('flags=next_shot_distance');
  });

  it('suggests a carry from it when none was measured, and leaves GPS noise alone', () => {
    const doc = project(
      [media('tee', 0, 0), media('fw', 5, 140), media('green', 9, 140 + CARRY)],
      [shot('drive', 'tee', 5, { warnings: [{ code: 'default_path' }] }), shot('approach', 'fw', 5), putt('p1', 'green', 5, 9, true)],
    );
    const s = summarize(doc);
    expect(s.shots[0]).toMatchObject({ carrySuggestM: 140, nextOff: false });
    expect(summaryText(s)).toContain('carry=~140');
    // Clips a few metres apart say nothing about the flight (a retake, a partner, GPS error).
    const close = summarize(project([media('a', 0, 0), media('b', 2, 8)], [shot('s1', 'a', 5), shot('s2', 'b', 5)]));
    expect(close.shots[0]).toMatchObject({ nextOff: false, carrySuggestM: null });
  });
});

describe('asking about putts', () => {
  const unsure = () => fullHole(true, { confidence: 0.4 });

  it('asks putts:<hole> with fixed options, the found count as default and a card per putt', () => {
    const s = summarize(unsure());
    expect(s.holes[0]).toMatchObject({ puttsUnsure: true, strokes: null, why: ['putts_unsure'] });
    const plan = planFromRules(s, '', 'da');
    expect(plan.questions.some((q) => q.id === 'doubtful' && q.shotIds.some((id) => id.startsWith('p')))).toBe(false);
    const q = plan.questions.find((x) => x.id === 'putts:7')!;
    expect(q.options.map((o) => o.id)).toEqual(['1', '2', '3', '4', 'notHoled']);
    expect(q.default).toBe('2');
    expect(q.items!.map((i) => [i.shotId, i.reasons])).toEqual([
      ['p1', ['putt_count_unsure']],
      ['p2', ['putt_count_unsure']],
    ]);
    // Not known whether the last one dropped: the default does not guess.
    expect(planFromRules(summarize(fullHole(null)), '').questions.find((x) => x.id === 'putts:7')!.default).toBe('notHoled');
  });

  it('lets the answer set the count and the putts shown', () => {
    const doc = unsure();
    const plan = planFromRules(summarize(doc), '', 'en');
    const { doc: one } = prepare(doc, plan, { 'putts:7': '1' });
    expect(one.shots.filter((s) => s.kind === 'putt').map((s) => [s.id, s.visible, s.putt?.holed])).toEqual([
      ['p1', false, false],
      ['p2', true, true],
    ]);
    expect(holeScores(summarize(doc), { 'putts:7': '1' })[0]).toMatchObject({ strokes: 3, putts: 1 });
    expect(holeScores(summarize(doc), { 'putts:7': 'notHoled' })[0].strokes).toBeNull();
    const v = compose(doc, plan, { 'putts:7': '1' }, { locale: 'en' })[0].document;
    expect(texts(v)).toContain('Hole 7 · Par 4 · Birdie');
    expect(v.clips.filter((c) => c.kind === 'video' && c.mediaId === 'green')).toHaveLength(1);
    // More putts than found: the putting is kept whole.
    expect(prepare(doc, plan, { 'putts:7': '3' }).uncut).toEqual(['7']);
  });

  it('reads the analysis warning', () => {
    const p = (extra: Partial<StrokeSummary>): StrokeSummary => ({
      id: 'p',
      kind: 'putt',
      clipId: 'c',
      clip: 1,
      t: 1,
      hole: '1',
      par: 4,
      confidence: 0.9,
      flags: [],
      end: 3,
      holed: true,
      ...extra,
    });
    expect(puttsUnsure([p({})])).toBe(false);
    expect(puttsUnsure([p({ flags: ['putt_count_unsure'] })])).toBe(true);
    expect(puttsUnsure([p({ holed: null })])).toBe(true);
  });
});

describe('score corrections from the scorecard', () => {
  const edited = (doc: Project, edits: Project['scoreEdits']) => migrateProject({ ...doc, scoreEdits: edits });

  it('lets the putts settle unsure putting: a score, no question, the putts shown', () => {
    const doc = edited(fullHole(true, { confidence: 0.4 }), { '7': { putts: 1 } });
    const s = summarize(doc);
    expect(s.holes[0]).toMatchObject({ strokes: 3, putts: 1, puttsUnsure: false, why: [], edited: ['putts'] });
    const plan = planFromRules(s, '', 'en');
    expect(plan.questions.some((q) => q.id === 'putts:7')).toBe(false);
    const prepared = prepare(doc, plan, null);
    expect(prepared.settled).toEqual(['7']);
    expect(prepared.doc.shots.filter((x) => x.kind === 'putt').map((x) => [x.id, x.visible, x.putt?.holed])).toEqual([
      ['p1', false, false],
      ['p2', true, true],
    ]);
    const v = compose(doc, plan, null, { locale: 'en' })[0].document;
    expect(texts(v)).toContain('Hole 7 · Par 4 · Birdie');
    expect(texts(v)).toContain('7\n4\n3');
  });

  it('gives an open hole a score from the strokes, and tells the AI it came from the user', () => {
    const gap = project([media('tee', 0, 0), media('green', 9, 2 * CARRY)], [shot('drive', 'tee', 5), putt('p1', 'green', 5, 9, true)]);
    expect(summarize(gap).holes[0].strokes).toBeNull();
    const s = summarize(edited(gap, { '7': { strokes: 5 } }));
    expect(s.holes[0]).toMatchObject({ strokes: 5, counted: 5, why: [], edited: ['strokes'] });
    expect(summaryText(s)).toContain('7:5/4 1p (by user) total 5/4');
    expect(texts(youtubeVideo(edited(gap, { '7': { strokes: 5 } }), 'en', 'YT'))).toContain('Total\n4\n5 (+1)');
  });

  it('sets a par the map did not know, and needs one for a score', () => {
    const noPar = (doc: Project) =>
      migrateProject({ ...doc, media: Object.fromEntries(Object.entries(doc.media).map(([k, m]) => [k, { ...m, place: { ...m.place!, par: null } }])) });
    expect(summarize(noPar(fullHole())).holes[0]).toMatchObject({ par: null, strokes: null, why: ['no_par'] });
    expect(summarize(edited(noPar(fullHole()), { '7': { par: 5 } })).holes[0]).toMatchObject({ par: 5, strokes: 4, why: [] });
    expect(summarize(edited(noPar(fullHole()), { '7': { strokes: 6 } })).holes[0]).toMatchObject({ strokes: null, counted: 6, why: ['no_par'] });
  });

  it('is optional in the document and checked', () => {
    expect(fullHole().scoreEdits).toBeUndefined();
    expect(() => migrateProject({ ...fullHole(), scoreEdits: { '7': { strokes: 0 } } })).toThrow();
    expect(() => migrateProject({ ...fullHole(), scoreEdits: { '7': { par: 4.5 } } })).toThrow();
    expect(edited(fullHole(), { '7': {} }).scoreEdits).toEqual({ '7': {} });
    expect(summarize(edited(fullHole(), { '7': {} })).holes[0].edited).toEqual([]);
  });
});
