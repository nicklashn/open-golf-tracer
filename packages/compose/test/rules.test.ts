import { migrateProject, type Project } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { compose, itemPlace, planFromRules, prepare, readPreference, reasonText, resolveAnswers, shotChoices, summarize, summaryText, VideoPlan } from '../src';
import { demoProject, roundProject, sound } from './fixtures';

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
    expect(readPreference('')).toEqual({ kind: null, goodOnly: false, template: null, title: null, putts: null });
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
    // No float noise (it only costs tokens): the demo's impact at 2.3985 s reads t=2.4.
    const demo = summaryText(summarize(demoProject()));
    expect(demo).toContain('t=2.4 ');
    expect(demo).not.toMatch(/\d\.\d{4,}/);
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

  it('asks whether file-name order is right when clips have neither a recording time nor a hole', () => {
    const doc = project([media('b2', null, null), media('a1', null, null)], [shot('s2', 'b2', 5), shot('s1', 'a1', 5)]);
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(ids(plan)).toEqual(['order']);
    expect(plan.questions[0].options.map((o) => o.id)).toEqual(['filename', 'added']);
    const order = (answers: Record<string, string>) => [...new Set(prepare(doc, plan, answers).doc.clips.map((c) => c.mediaId))];
    expect(order({})).toEqual(['a1', 'b2']); // file names
    expect(order({ order: 'added' })).toEqual(['b2', 'a1']); // as added
  });

  it('orders clips without a recording time by hole, wrapping 18 → 1, without asking', () => {
    const doc = project(
      [media('x1', null, '2'), media('x2', null, '17'), media('x3', null, '10'), media('x4', null, '1'), media('x5', null, '12')],
      [shot('s1', 'x1', 5), shot('s2', 'x2', 5), shot('s3', 'x3', 5), shot('s4', 'x4', 5), shot('s5', 'x5', 5)],
    );
    const s = summarize(doc);
    expect(s.clips.map((c) => c.hole)).toEqual(['10', '12', '17', '1', '2']);
    expect(s.order.by).toBe('hole');
    expect(planFromRules(s, '', 'en').questions).toEqual([]);
  });

  it('does not trust file dates over holes, and asks about a clip with neither', () => {
    const file = { recordedAtSource: 'file' };
    const doc = project(
      [media('a', '2026-10-16T09:00:01Z', '3', file), media('b', '2026-10-16T09:00:02Z', '1', file), media('c', '2026-10-16T09:00:03Z', null, file)],
      [shot('s1', 'a', 5), shot('s2', 'b', 5), shot('s3', 'c', 5)],
    );
    const s = summarize(doc);
    expect(s.clips.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    // File dates are no strike times: copied files land seconds apart and are no "same shot".
    expect(s.shots.every((x) => x.at === null)).toBe(true);
    const plan = planFromRules(s, '', 'en');
    expect(ids(plan)).toEqual(['order']);
    expect(plan.questions[0].clipIds).toEqual(['c']);
  });

  it('keeps the filmed order but asks when sure times contradict the holes', () => {
    const doc = project(
      [
        media('a', '2026-06-16T10:00:00+0200', '1'),
        media('b', '2026-06-16T10:20:00+0200', '7'),
        media('c', '2026-06-16T10:40:00+0200', '3'),
        media('d', '2026-06-16T11:00:00+0200', '4'),
      ],
      [shot('s1', 'a', 5), shot('s2', 'b', 5), shot('s3', 'c', 5), shot('s4', 'd', 5)],
    );
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(ids(plan)).toEqual(['order']);
    const q = plan.questions[0];
    expect(q.text).toBe('The recording times say hole 7 in clip 2 (b.mov) was filmed before hole 3 in clip 3 (c.mov). Is that right?');
    expect(q.options.map((o) => o.id)).toEqual(['filmed', 'holes']);
    expect(q.default).toBe('filmed');
    const order = (answers: Record<string, string>) => [...new Set(prepare(doc, plan, answers).doc.clips.map((c) => c.mediaId))];
    expect(order({})).toEqual(['a', 'b', 'c', 'd']);
    expect(order({ order: 'holes' })).toEqual(['a', 'c', 'd', 'b']);
  });

  it('a round started on hole 10, filmed by name-timed clips, needs no question', () => {
    const name = { recordedAtSource: 'filename' };
    const holes = ['10', '11', '13', '18', '1', '2', '9'];
    const doc = project(
      holes.map((h, i) => media(`h${h}`, `2026-06-16T${String(10 + i).padStart(2, '0')}:00:00+0200`, h, name)),
      holes.map((h) => shot(`s${h}`, `h${h}`, 5)),
    );
    const s = summarize(doc);
    expect(s.order).toEqual({ by: 'time', unsure: [], conflict: null });
    expect(planFromRules(s, '', 'en').questions).toEqual([]);
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

  it('keeps the better angle of a shot two phones heard alike, without asking', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:01+0200', '1', { width: 1920, height: 1080 })],
      [shot('sa', 'a', 7, { sound: sound(1) }), shot('sb', 'b', 6.02, { sound: sound(1, 0.3, 1) })],
    );
    const yt = planFromRules(summarize(doc), 'youtube', 'en');
    expect(ids(yt)).toEqual([]);
    expect(yt.includeShotIds).toEqual(['sb']); // landscape for YouTube
    expect(yt.notes.join(' ')).toContain('Shot 2 (hole 1) was filmed from more than one angle: clip 1 (a.mov), clip 2 (b.mov). Using clip 2 (b.mov).');
    expect(shown(prepare(doc, yt, {}).doc)).toEqual(['sb']);
    expect(planFromRules(summarize(doc), 'tiktok', 'da').includeShotIds).toEqual(['sa']); // portrait for a short
  });

  it('does not merge a partner teeing off right after from the same spot', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:45+0200', '1')],
      [shot('me', 'a', 7, { sound: sound(1) }), shot('partner', 'b', 7, { sound: sound(2), anchor: { x: 700, y: 1500 } })],
    );
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(ids(plan)).toEqual([]);
    expect(plan.includeShotIds).toEqual(['me', 'partner']);
  });

  it('asks when two clips sound alike but their clocks disagree', () => {
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:40+0200', '1')],
      [shot('sa', 'a', 7, { sound: sound(1) }), shot('sb', 'b', 7, { sound: sound(1, 0.3) })],
    );
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(ids(plan)).toEqual(['same:sa:sb']);
    expect(plan.includeShotIds).toEqual(['sa', 'sb']);
  });

  it('asks about a retake filmed by two phones once, between the angles kept', () => {
    const doc = project(
      [
        media('a1', '2026-06-16T10:00:00+0200', '1'),
        media('b1', '2026-06-16T10:00:01+0200', '1', { width: 1920, height: 1080 }),
        media('a2', '2026-06-16T10:01:00+0200', '1'),
        media('b2', '2026-06-16T10:01:01+0200', '1', { width: 1920, height: 1080 }),
      ],
      [
        shot('x1', 'a1', 7, { sound: sound(1) }),
        shot('y1', 'b1', 6, { sound: sound(1, 0.3) }),
        shot('x2', 'a2', 7, { sound: sound(3) }),
        shot('y2', 'b2', 6, { sound: sound(3, 0.3) }),
      ],
    );
    const plan = planFromRules(summarize(doc), 'youtube', 'en');
    expect(ids(plan)).toEqual(['retake:y1:y2']);
    expect(plan.includeShotIds).toEqual(['y1', 'y2']);
    expect(shown(prepare(doc, plan, { 'retake:y1:y2': 'last' }).doc)).toEqual(['y2']);
  });

  it('picks the template the preference asks for', () => {
    const s = summarize(plainRound());
    expect(planFromRules(s, 'tv style', 'en').template).toBe('tv');
    expect(planFromRules(s, 'calm', 'en').template).toBe('minimal');
  });
});

describe('the shots a question is about (cards)', () => {
  it('doubtful shots carry clip, time in the clip and reasons', () => {
    const doc = plainRound();
    doc.shots[1] = { ...doc.shots[1], impactTime: 27.24, warnings: [{ code: 'implausible' }, { code: 'few_points' }] };
    doc.shots[2] = { ...doc.shots[2], confidence: 0.3, warnings: [{ code: 'no_track' }, { code: 'low_confidence' }] };
    const q = planFromRules(summarize(doc), '', 'en').questions.find((x) => x.id === 'doubtful')!;
    expect(q.items).toEqual([
      { shotId: 's2', mediaId: 'b', clip: 2, clipName: 'b.mov', t: 27.2, reasons: ['implausible', 'few_points'] },
      { shotId: 's3', mediaId: 'c', clip: 3, clipName: 'c.mov', t: 5, reasons: ['practice_swing'] },
    ]);
    expect(itemPlace(q.items![0], 'da')).toBe('Klip 2 · 0:27');
    expect(reasonText('practice_swing', 'en')).toContain('practice swing');
    expect(reasonText('no_track', 'da')).toContain('ikke fundet i luften');
  });

  it('retakes and the same shot from two angles list both shots', () => {
    const plan = planFromRules(summarize(roundProject()), '', 'en');
    expect(plan.questions[0].items?.map((i) => [i.shotId, i.reasons.includes('retake')])).toEqual([
      ['s2', true],
      ['s3', true],
    ]);
    const doc = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:02+0200', '1')],
      [shot('sa', 'a', 7, { confidence: 0.7 }), shot('sb', 'b', 5.5, { confidence: 0.9 })],
    );
    const same = planFromRules(summarize(doc), '', 'en').questions.find((x) => x.id.startsWith('same:'))!;
    expect(same.items?.map((i) => [i.mediaId, i.clip, i.t, i.reasons])).toEqual([
      ['a', 1, 7, ['same_shot']],
      ['b', 2, 5.5, ['same_shot']],
    ]);
  });

  it('a stored plan without items still parses', () => {
    const plan = planFromRules(summarize(roundProject()), '', 'en');
    const old = { ...plan, questions: plan.questions.map(({ items: _, ...q }) => q) };
    expect(VideoPlan.parse(old).questions[0].items).toBeUndefined();
    expect(shotChoices(VideoPlan.parse(old), { 'shot:s2': 'drop' }).size).toBe(0);
  });

  it("a choice for one shot wins over the question's answer", () => {
    const doc = plainRound();
    doc.shots[1] = { ...doc.shots[1], warnings: [{ code: 'no_track' }] };
    doc.shots[2] = { ...doc.shots[2], confidence: 0.3 };
    const plan = planFromRules(summarize(doc), '', 'en');
    expect(shown(prepare(doc, plan, { doubtful: 'keep', 'shot:s3': 'drop' }).doc)).toEqual(['s1', 's2']);
    expect(shown(prepare(doc, plan, { doubtful: 'drop', 'shot:s2': 'keep' }).doc)).toEqual(['s1', 's2']);
    // Only 'keep' / 'drop' for shots the questions show; anything else is ignored.
    expect(shown(prepare(doc, plan, { 'shot:s3': 'maybe', 'shot:s1': 'drop' }).doc)).toEqual(['s1', 's2', 's3']);
    // Same shot from two angles: keep the other angle too.
    const two = project(
      [media('a', '2026-06-16T10:00:00+0200', '1'), media('b', '2026-06-16T10:00:02+0200', '1')],
      [shot('sa', 'a', 7, { confidence: 0.7 }), shot('sb', 'b', 5.5, { confidence: 0.9 })],
    );
    const p2 = planFromRules(summarize(two), '', 'en');
    expect(shown(prepare(two, p2, { 'shot:sa': 'keep' }).doc).sort()).toEqual(['sa', 'sb']);
    const [v] = compose(doc, plan, { 'shot:s2': 'drop', 'shot:s3': 'drop' }, { locale: 'en' });
    expect(v.document.layers.filter((l) => l.type === 'statCard')).toHaveLength(1);
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
