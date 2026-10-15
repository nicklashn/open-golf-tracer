import { describe, expect, it } from 'vitest';
import { handleCompose, onlyClips } from '../src/compose-job';
import { roundProject } from '../../../packages/compose/test/fixtures';

/** The internal API as the job sees it, recording what was sent. */
function fakeApi(pending = 0) {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string, ret: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      return ret as never;
    };
  let n = 0;
  return {
    calls,
    api: {
      jobProject: rec('jobProject', { id: 'p', name: 'Runde', document: roundProject(), pending }),
      defer: rec('defer', { status: 'queued' }),
      awaitAnswers: rec('awaitAnswers', { status: 'awaiting_answers' }),
      derive: async (...args: unknown[]) => {
        calls.push({ op: 'derive', args });
        return { id: `new${++n}`, name: String(args[1]) };
      },
      progress: rec('progress', { continue: true }),
      complete: rec('complete', { ok: true }),
    },
  };
}
const ops = (calls: { op: string }[]) => calls.map((c) => c.op).filter((o) => o !== 'progress');

describe('compose job', () => {
  it('waits while the analysis runs', async () => {
    const f = fakeApi(2);
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p' } })).toBe('waiting');
    expect(ops(f.calls)).toEqual(['jobProject', 'defer']);
  });

  it('asks once, then builds the video with the answers and the same plan', async () => {
    const f = fakeApi();
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', preference: 'youtube', locale: 'da' } })).toBe('asked');
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as { plan: { questions: { id: string }[] } };
    expect(asked.plan.questions.map((q) => q.id)).toEqual(['retake:s2:s3']);

    const g = fakeApi();
    const out = await handleCompose(g.api, {
      id: 'j',
      payload: { project_id: 'p', locale: 'da', plan: asked.plan, answers: { 'retake:s2:s3': 'last' }, names: { statCard: 'Tal' } },
    });
    expect(out).toBe('done');
    expect(ops(g.calls)).toEqual(['jobProject', 'derive', 'complete']);
    const doc = g.calls.find((c) => c.op === 'derive')!.args[2] as { layers: { type: string; name: string; props: { shotId?: string } }[] };
    const cards = doc.layers.filter((l) => l.type === 'statCard');
    // Filmed order (clip a first), and the retake answered with "only the last".
    expect(cards.map((l) => l.props.shotId)).toEqual(['s1', 's3']);
    expect(cards[0].name).toBe('Tal');
    const result = g.calls.find((c) => c.op === 'complete')!.args[1] as { projects: { id: string }[]; kind: string };
    expect(result.projects).toEqual([{ id: 'new1', name: expect.any(String) }]);
    expect(result.kind).toBe('youtube');
  });

  it('with --yes it uses the defaults and does not stop', async () => {
    const f = fakeApi();
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', preference: 'en short af hvert slag', yes: true } })).toBe('done');
    expect(f.calls.filter((c) => c.op === 'derive')).toHaveLength(3);
  });

  it('keeps only the chosen clips', () => {
    const doc = onlyClips(roundProject(), ['a']);
    expect(Object.keys(doc.media)).toEqual(['a']);
    expect(doc.shots.map((s) => s.id)).toEqual(['s1']);
    expect(doc.layers).toEqual([]); // the course map belonged to a shot in clip b
  });
});
