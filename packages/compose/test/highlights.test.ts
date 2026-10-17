import { migrateProject, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import {
  bestShots,
  explainPreference,
  factNumbers,
  guardFacts,
  highlightScore,
  planFromRules,
  readPreference,
  shotScore,
  summarize,
  summaryText,
  typicalTokenEstimate,
  userMessage,
  VideoPlan,
  videoTokenEstimate,
  type RoundSummary,
} from '../src';

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
const putt = (id: string, mediaId: string, impactTime: number, end: number, holed: boolean | null) =>
  shot(id, mediaId, impactTime, { kind: 'putt', putt: { end, holed } });

const LAT = 56.2;
const M_PER_DEG = 111195;
const media = (id: string, minute: number, north: number, hole = '7', extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'video',
  name: `IMG_${id}_Familie_Hansen.MOV`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt: `2026-06-16T10:${String(minute).padStart(2, '0')}:00+0200`,
  geo: { lat: LAT + north / M_PER_DEG, lon: 9.7, acc: 5 },
  place: { course: 'Testbane', hole, par: 4, fromTee: north, toGreen: Math.max(0, 380 - north), line: [] },
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
const CARRY = summarize(project([media('x', 0, 0)], [shot('x1', 'x', 5)])).shots[0].carryM!;

/** Hole 7, par 4: drive, approach and one long holed putt – a birdie. The green clip is 3 m from the green. */
const birdieHole = () =>
  project(
    [
      media('tee', 0, 0),
      media('fw', 5, CARRY),
      media('green', 9, 2 * CARRY, '7', { place: { course: 'Testbane', hole: '7', par: 4, fromTee: 2 * CARRY, toGreen: 3, line: [] } }),
    ],
    [shot('drive', 'tee', 5), shot('approach', 'fw', 5), putt('p1', 'green', 5, 10, true)],
  );

describe('golf highlights in the summary', () => {
  it('tags a birdie hole, the close approach and the long holed putt – from facts only', () => {
    const s = summarize(birdieHole());
    expect(s.holes[0]).toMatchObject({ hole: '7', strokes: 3, par: 4 });
    const tags = Object.fromEntries([...s.shots, ...s.putts].map((x) => [x.id, x.tags ?? []]));
    expect(tags.drive).toContain('birdie');
    expect(tags.approach).toEqual(expect.arrayContaining(['birdie', 'close']));
    expect(tags.p1).toEqual(expect.arrayContaining(['birdie', 'long_putt']));
    // Fewer than three measured flights: none is "the longest of the round".
    expect([...s.shots].some((x) => x.tags?.includes('longest'))).toBe(false);
  });

  it('a hole not filmed to the end has no birdie, and an estimated carry is never the longest', () => {
    const doc = project(
      [media('a', 0, 0, '1'), media('b', 20, 0, '2'), media('c', 40, 0, '3'), media('d', 50, 0, '4')],
      [
        shot('s1', 'a', 5),
        shot('s2', 'b', 5),
        shot('s3', 'c', 5),
        shot('s4', 'd', 5, { track: { t: [], u: [], v: [] }, warnings: [{ code: 'no_track', message: '' }] }),
      ],
    );
    const s = summarize(doc);
    expect(s.shots.flatMap((x) => x.tags ?? []).filter((t) => t === 'birdie')).toEqual([]);
    const longest = s.shots.filter((x) => x.tags?.includes('longest'));
    expect(longest).toHaveLength(1);
    expect(longest[0].id).not.toBe('s4');
  });

  it('ranks the best shots by golf quality, not only by confidence', () => {
    const s = summarize(birdieHole());
    const drive = s.shots.find((x) => x.id === 'drive')!;
    const plain = { ...drive, id: 'plain', tags: [], confidence: 1 };
    expect(shotScore(plain)).toBeGreaterThan(shotScore({ ...drive, confidence: 0.8 }));
    expect(highlightScore({ ...drive, confidence: 0.8 })).toBeGreaterThan(highlightScore(plain));
  });

  it('"the best shots" without AI keeps the tagged ones and says so', () => {
    const s = summarize(birdieHole());
    // A round of nine more plain shots on other holes.
    const extra = Array.from({ length: 9 }, (_, i) => ({ ...s.shots[0], id: `x${i}`, n: 10 + i, hole: String(10 + i), tags: [], confidence: 0.7 }));
    const big: RoundSummary = { ...s, shots: [...s.shots, ...extra] };
    const plan = planFromRules(big, 'the best shots', 'en');
    expect(plan.includeShotIds).toEqual(expect.arrayContaining(['drive', 'approach']));
    expect(plan.includeShotIds.length).toBeLessThan(big.shots.length);
    expect(plan.notes.some((n) => n.startsWith('Only the best shots'))).toBe(true);
    expect(bestShots(big.shots).map((x) => x.id)).toEqual(plan.includeShotIds);
    // The close approach gets a line in the video.
    expect(plan.shotTexts?.approach).toBe('Close approach');
  });

  it('the summary text lists tags and never the file names', () => {
    const s = summarize(birdieHole());
    const text = summaryText(s);
    expect(text).toContain('tags=birdie,close');
    expect(text).toMatch(/putt clip=3 t=5 hole=7 holed=y tags=.*long_putt/);
    expect(text).not.toContain('Hansen');
    expect(text).not.toContain('.MOV');
  });

  it('the rule plan sent to the model has no file names either', () => {
    const doc = project([media('a', 0, 0, '1'), media('b', 20, 0, '2')], [shot('s1', 'a', 5, { confidence: 0.2 })]);
    const s = summarize(doc);
    const rules = planFromRules(s, '', 'en');
    expect(JSON.stringify(rules)).toContain('Hansen'); // the user sees the names
    const msg = userMessage(s, '', rules);
    expect(msg).not.toContain('Hansen');
    expect(msg).toContain('clip 2');
  });
});

describe('what the rules understood of the wish', () => {
  it('lists what it understood and the words it did not', () => {
    const e = explainPreference('YouTube-video af runden, kun gode slag, rolig stil og masser af drama');
    expect(e.understood).toEqual([{ key: 'kind', value: 'youtube' }, { key: 'goodOnly' }, { key: 'template', value: 'minimal' }]);
    expect(e.unknown).toEqual(['masser', 'drama']);
    expect(e.preference).toEqual(readPreference('YouTube-video af runden, kun gode slag, rolig stil og masser af drama'));
  });

  it('in English, with the best shots, putts and a title', () => {
    const e = explainPreference('A vertical highlight of the best shots without putts, titled "Sunday Club"');
    expect(e.understood).toEqual([
      { key: 'kind', value: 'highlight' },
      { key: 'best' },
      { key: 'putts', value: 'none' },
      { key: 'title', value: 'Sunday Club' },
    ]);
    expect(e.unknown).toEqual(['titled']);
    expect(e.preference).toMatchObject({ best: true, goodOnly: true });
    expect(explainPreference('')).toEqual({ preference: readPreference(''), understood: [], unknown: [] });
  });
});

describe('the fact guard', () => {
  const s = summarize(birdieHole());
  const base = VideoPlan.parse({ kind: 'youtube', includeShotIds: ['drive', 'approach'], title: 'Testbane', questions: [] });

  it('keeps texts whose numbers are facts of the round', () => {
    const facts = factNumbers(s);
    expect(facts.has(CARRY)).toBe(true);
    expect(facts.has(7)).toBe(true);
    const plan = {
      ...base,
      title: 'Birdie på hul 7',
      shotTexts: { drive: `${CARRY} m carry` },
      description: `Hul 7 på 3 slag, par 4. Et drive på ${CARRY} m.`,
    };
    expect(guardFacts(plan, s, { fallbackTitle: 'Testbane' })).toEqual({ plan, dropped: [] });
  });

  it('drops made-up numbers and guesses, and falls back to the rule title', () => {
    const plan = {
      ...base,
      title: '18 huller på Testbane',
      shotTexts: { drive: '300 m drive', approach: 'Flot indspil' },
      description: 'En birdie på hul 7. Et drive på 275 m!',
    };
    const out = guardFacts(plan, s, { fallbackTitle: 'Testbane · 16. juni 2026' });
    expect(out.plan.title).toBe('Testbane · 16. juni 2026');
    expect(out.plan.shotTexts).toEqual({ approach: 'Flot indspil' });
    expect(out.plan.description).toBe('En birdie på hul 7.');
    expect(out.dropped).toHaveLength(3);
  });

  it('a "~" carry from the next stroke is not a fact', () => {
    const guess: RoundSummary = { ...s, shots: s.shots.map((x) => ({ ...x, carryM: null, carrySuggestM: 151 })) };
    expect(guardFacts({ ...base, shotTexts: { drive: '151 m' } }, guess, { fallbackTitle: 'T' }).plan.shotTexts).toBeUndefined();
  });

  it("allows the user's own numbers", () => {
    const plan = { ...base, title: 'Runde 3 med klubben' };
    expect(guardFacts(plan, s, { fallbackTitle: 'T', preference: 'kald den "Runde 3"' }).plan.title).toBe('Runde 3 med klubben');
  });
});

describe('token estimates', () => {
  it('a full round needs more than one call fits in the old 8 000 ceiling when it asks', () => {
    const e = typicalTokenEstimate();
    expect(e.plan).toBeGreaterThan(4000);
    expect(e.needed).toBeGreaterThan(8000);
    expect(e.vision).toBe(0);
    const v = typicalTokenEstimate({ vision: true });
    expect(v.vision).toBeGreaterThan(0);
    expect(v.total).toBe(v.plan + v.vision);
    expect(typicalTokenEstimate({ vision: true, visionMaxTokens: 1000 }).vision).toBe(1000);
  });

  it('a small round with no questions makes one call', () => {
    const s = summarize(project([media('a', 0, 0, '1')], [shot('s1', 'a', 5)]));
    const plan = planFromRules(s, '', 'en');
    expect(plan.questions).toEqual([]);
    const e = videoTokenEstimate(s, '', plan);
    expect(e.needed).toBeLessThan(8000);
    expect(e.plan).toBeLessThan(e.needed);
  });
});
