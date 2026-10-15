import { migrateProject, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { compose, planFromRules, prepare, readPreference, resolveAnswers, summarize, summaryText, VideoPlan } from '../src';
import { roundProject } from './fixtures';

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
const media = (id: string, recordedAt: string | null, hole: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt,
  geo: hole ? { lat: 56.2, lon: 9.7 } : null,
  place: hole ? { course: 'Testbane', hole, par: 4, fromTee: 0, toGreen: 300, line: [] } : null,
  ...extra,
});
const clip = (mediaId: string) => ({ id: `c_${mediaId}`, kind: 'video', mediaId, in: 0, out: 30 });

function project(medias: ReturnType<typeof media>[], shots: ReturnType<typeof shot>[]): Project {
  return migrateProject({
    schemaVersion: 1,
    name: 'Runde',
    media: Object.fromEntries(medias.map((m) => [m.id, m])),
    clips: medias.map((m) => clip(m.id)),
    shots,
  });
}

/** Three holes, one shot each, filmed 20 minutes apart. */
const plainRound = () =>
  project(
    [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:20:00+0200', '2'), media('c', '2026-06-16T10:40:00+0200', '3')],
    [shot('s1', 'a', 5), shot('s2', 'b', 5), shot('s3', 'c', 5)],
  );

const ids = (p: VideoPlan) => p.questions.map((q) => q.id);
const shown = (doc: Project) => doc.shots.filter((s) => s.visible).map((s) => s.id);

describe('reading the preference without AI', () => {
  it('finds format, "only good shots", a calm look and a quoted title', () => {
    expect(readPreference('YouTube-video af runden, kun gode slag, rolig stil')).toMatchObject({ kind: 'youtube', goodOnly: true, template: 'minimal' });
    expect(readPreference('a TikTok of the best shots')).toMatchObject({ kind: 'highlight', goodOnly: true });
    expect(readPreference('en short af hvert slag')).toMatchObject({ kind: 'shorts' });
    expect(readPreference('Title "Sommer på Royal"').title).toBe('Sommer på Royal');
    expect(readPreference('')).toEqual({ kind: null, goodOnly: false, template: null, title: null });
  });
});

describe('the round summary (all an AI sees)', () => {
  it('has a line per clip and per shot, in the order filmed', () => {
    const s = summarize(plainRound());
    expect(s.clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(s.shots.map((x) => [x.id, x.clip, x.hole])).toEqual([
      ['s1', 1, '1'],
      ['s2', 2, '2'],
      ['s3', 3, '3'],
    ]);
    const text = summaryText(s);
    expect(text.split('\n')).toHaveLength(1 + 3 + 3);
    expect(text).not.toContain('params');
  });
});

describe('planFromRules', () => {
  it('a clean round needs no questions and keeps every shot', () => {
    const plan = planFromRules(summarize(plainRound()), 'youtube', 'en');
    expect(plan.questions).toEqual([]);
    expect(plan.kind).toBe('youtube');
    expect(plan.includeShotIds).toEqual(['s1', 's2', 's3']);
    expect(plan.title).toContain('Testbane');
    expect(() => VideoPlan.parse(plan)).not.toThrow();
  });

  it('asks about doubtful shots (warnings or low confidence); "only good" leaves them out by default', () => {
    const doc = plainRound();
    doc.shots[1] = { ...doc.shots[1], warnings: [{ code: 'no_track' }] };
    doc.shots[2] = { ...doc.shots[2], confidence: 0.3 };
    const plan = planFromRules(summarize(doc), '', 'da');
    const q = plan.questions.find((x) => x.id === 'doubtful')!;
    expect(q.shotIds).toEqual(['s2', 's3']);
    expect(q.default).toBe('keep');
    expect(planFromRules(summarize(doc), 'kun gode slag', 'da').questions[0].default).toBe('drop');
    expect(shown(prepare(doc, plan, { doubtful: 'drop' }).doc)).toEqual(['s1']);
    expect(shown(prepare(doc, plan, {}).doc)).toEqual(['s1', 's2', 's3']);
  });

  it('asks about clips without shots and can use them as mood shots', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('x', '2026-06-16T10:10:00+0200', '1'), media('b', '2026-06-16T10:20:00+0200', '2')],
      [shot('s1', 'a', 5), shot('s2', 'b', 5)],
    );
    const plan = planFromRules(summarize(doc), 'youtube', 'en');
    expect(ids(plan)).toEqual(['noShots']);
    const plain = compose(doc, plan, {}, { locale: 'en' })[0].document;
    const withMood = compose(doc, plan, { noShots: 'broll' }, { locale: 'en' })[0].document;
    expect(plain.clips.some((c) => c.mediaId === 'x')).toBe(false);
    const order = withMood.clips.filter((c) => c.kind === 'video').map((c) => c.mediaId);
    expect(order.indexOf('x')).toBeGreaterThan(order.indexOf('a'));
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('b'));
    // Graphics after the mood shot move with it.
    const cards = (d: Project) => d.layers.filter((l) => l.type === 'statCard').map((l) => l.start);
    expect(cards(withMood)[1] - cards(plain)[1]).toBeCloseTo(6, 3);
    // Shorts cannot use them: a note instead of a question.
    const shorts = planFromRules(summarize(doc), 'short af hvert slag', 'da');
    expect(ids(shorts)).toEqual([]);
    expect(shorts.notes.join(' ')).toContain('x.mov');
  });

  it('asks whether file-name order is right when clips have no recording time', () => {
    const doc = project([media('b2', null, '2'), media('a1', null, '1')], [shot('s2', 'b2', 5), shot('s1', 'a1', 5)]);
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(ids(plan)).toEqual(['order']);
    const order = (answers: Record<string, string>) => [...new Set(prepare(doc, plan, answers).doc.clips.map((c) => c.mediaId))];
    expect(order({})).toEqual(['a1', 'b2']); // file names
    expect(order({ order: 'added' })).toEqual(['b2', 'a1']); // as added
  });

  it('asks which hole a clip without GPS in the middle of a round is', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('x', '2026-06-16T10:10:00+0200', null), media('b', '2026-06-16T10:20:00+0200', '2')],
      [shot('s1', 'a', 5), shot('sx', 'x', 5), shot('s2', 'b', 5)],
    );
    const plan = planFromRules(summarize(doc), '', 'en');
    const q = plan.questions.find((x) => x.id === 'gps:x')!;
    expect(q.options.map((o) => o.id)).toEqual(['previous', 'next', 'unknown']);
    expect(prepare(doc, plan, {}).doc.media.x.place?.hole).toBe('1');
    expect(prepare(doc, plan, { 'gps:x': 'next' }).doc.media.x.place?.hole).toBe('2');
    expect(prepare(doc, plan, { 'gps:x': 'unknown' }).doc.media.x.place).toBeNull();
  });

  it('asks about a possible retake: both, only the last or only the best', () => {
    // roundProject: s2 and s3 on hole 2, 9 s apart from the same tee spot.
    const doc = roundProject();
    doc.shots = doc.shots.map((s) => (s.id === 's3' ? { ...s, confidence: 0.95 } : s.id === 's2' ? { ...s, confidence: 0.8 } : s));
    const plan = planFromRules(summarize(doc), '', 'da');
    expect(ids(plan)).toEqual(['retake:s2:s3']);
    expect(plan.questions[0].default).toBe('both');
    expect(shown(prepare(doc, plan, {}).doc).sort()).toEqual(['s1', 's2', 's3']);
    expect(shown(prepare(doc, plan, { 'retake:s2:s3': 'last' }).doc).sort()).toEqual(['s1', 's3']);
    expect(shown(prepare(doc, plan, { 'retake:s2:s3': 'best' }).doc).sort()).toEqual(['s1', 's3']);
    expect(planFromRules(summarize(doc), 'only good shots', 'en').questions[0].default).toBe('best');
  });

  it('asks which angle to use when one shot was filmed in two clips', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:02+0200', '1')],
      [shot('sa', 'a', 7, { confidence: 0.7 }), shot('sb', 'b', 5.5, { confidence: 0.9 })],
    );
    const plan = planFromRules(summarize(doc), '', 'en');
    const q = plan.questions.find((x) => x.id.startsWith('same:'))!;
    expect(q.default).toBe('keep:sb');
    expect(shown(prepare(doc, plan, {}).doc)).toEqual(['sb']);
    expect(shown(prepare(doc, plan, { [q.id]: 'both' }).doc).sort()).toEqual(['sa', 'sb']);
  });

  it('picks the template the preference asks for', () => {
    const s = summarize(plainRound());
    expect(planFromRules(s, 'tv style', 'en').template).toBe('tv');
    expect(planFromRules(s, 'calm', 'en').template).toBe('minimal');
  });
});

describe('compose', () => {
  it('builds the kind the plan asks for and leaves the source alone', () => {
    const doc = plainRound();
    const before = JSON.stringify(doc);
    const plan = planFromRules(summarize(doc), 'youtube', 'en');
    const [yt] = compose(doc, plan, {}, { locale: 'en' });
    expect(yt.document.format.aspect).toBe('16:9');
    expect(yt.name).toBe(plan.title);
    expect(compose(doc, { ...plan, kind: 'highlight' }, {}, { locale: 'en' })[0].document.format.aspect).toBe('9:16');
    const shorts = compose(doc, { ...plan, kind: 'shorts' }, {}, { locale: 'en' });
    expect(shorts).toHaveLength(3);
    expect(shorts[0].name).toBe(`${plan.title} – 1`);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('leaves out shots not in the plan, follows its order, adds its texts and look', () => {
    const doc = plainRound();
    const plan = VideoPlan.parse({
      kind: 'youtube',
      template: 'minimal',
      includeShotIds: ['s3', 's1'],
      order: ['s3', 's1'],
      title: 'Bedste slag',
      shotTexts: { s3: 'Lige ud!' },
    });
    const [v] = compose(doc, plan, {}, { locale: 'da' });
    const cards = v.document.layers.filter((l) => l.type === 'statCard');
    expect(cards.map((l) => (l.type === 'statCard' ? l.props.shotId : ''))).toEqual(['s3', 's1']);
    expect(v.document.clips.filter((c) => c.kind === 'video').map((c) => c.mediaId)).toEqual(['c', 'a']);
    const text = v.document.layers.find((l) => l.type === 'text');
    expect(text?.type === 'text' && text.props.text).toBe('Lige ud!');
    expect(v.document.shots.find((s) => s.id === 's3')?.style.width).not.toBe(doc.shots[2].style.width);
  });

  it('gives nothing when every shot is left out', () => {
    const doc = plainRound();
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(compose(doc, { ...plan, includeShotIds: [] }, {}, { locale: 'en' })).toEqual([]);
  });

  it('uses the default for answers that are missing or not an option', () => {
    const doc = roundProject();
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(resolveAnswers(plan, { 'retake:s2:s3': 'nonsense' })).toEqual({ 'retake:s2:s3': 'both' });
  });
});
