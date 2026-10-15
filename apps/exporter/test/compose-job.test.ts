import { describe, expect, it } from 'vitest';
import { handleAiTest, handleCompose, onlyClips } from '../src/compose-job';
import { roundProject } from '../../../packages/compose/test/fixtures';

/** The internal API as the job sees it, recording what was sent. */
function fakeApi(pending = 0, ai: Record<string, unknown> = { provider: 'none', model: '', baseUrl: '', apiKey: '', maxTokens: 8000 }) {
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
      jobAi: rec('jobAi', ai),
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
const ops = (calls: { op: string }[]) => calls.map((c) => c.op).filter((o) => o !== 'progress' && o !== 'jobAi');

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

/** An OpenAI-compatible provider answering from a list; counts the calls it gets. */
function fakeProvider(answers: string[]) {
  const bodies: { messages: { content: string }[] }[] = [];
  const doFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const content = answers.shift() ?? '{}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, doFetch };
}
const AI = { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', apiKey: '', maxTokens: 8000 };

describe('compose job with an AI model', () => {
  it('makes at most two calls: the plan, then once more after the answers', async () => {
    const provider = fakeProvider([
      JSON.stringify({ title: 'Søndagsrunden', questions: [{ id: 'retake:s2:s3', text: 'Var hul 2 et omslag?' }] }),
      JSON.stringify({ title: 'Søndagsrunden', shotTexts: [{ shotId: 's3', text: 'Andet forsøg sad!' }], description: 'To huller i Testbane.' }),
    ]);
    const first = fakeApi(0, AI);
    expect(await handleCompose(first.api, { id: 'j', payload: { project_id: 'p', locale: 'da' } }, () => {}, provider.doFetch)).toBe('asked');
    const asked = first.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as {
      plan: { title: string; questions: { text: string }[] };
      usage: { calls: number };
    };
    expect(asked.plan.questions[0].text).toBe('Var hul 2 et omslag?');
    expect(asked.usage.calls).toBe(1);

    const second = fakeApi(0, AI);
    await handleCompose(
      second.api,
      { id: 'j', payload: { project_id: 'p', locale: 'da', plan: asked.plan, answers: { 'retake:s2:s3': 'last' }, usage: asked.usage } },
      () => {},
      provider.doFetch,
    );
    expect(provider.bodies).toHaveLength(2);
    expect(provider.bodies[1].messages[1].content).toContain('ANSWERS');
    const result = second.calls.find((c) => c.op === 'complete')!.args[1] as {
      usage: { calls: number; inputTokens: number };
      description: string;
      notes: string[];
    };
    expect(result.usage).toMatchObject({ calls: 2, inputTokens: 2000 });
    expect(result.description).toBe('To huller i Testbane.');
    expect(result.notes[0]).toContain('llama3.1');
    const doc = second.calls.find((c) => c.op === 'derive')!.args[2] as { layers: { type: string; props: { text?: string } }[] };
    expect(doc.layers.some((l) => l.type === 'text' && l.props.text === 'Andet forsøg sad!')).toBe(true);
  });

  it('with --yes (no questions asked) there is only one call', async () => {
    const provider = fakeProvider(['{"title": "Kort"}']);
    const f = fakeApi(0, AI);
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', yes: true } }, () => {}, provider.doFetch)).toBe('done');
    expect(provider.bodies).toHaveLength(1);
  });

  it('uses the rule plan with a note when the model twice answers nonsense', async () => {
    const provider = fakeProvider(['nonsense', 'still nonsense']);
    const f = fakeApi(0, AI);
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', yes: true, locale: 'en' } }, () => {}, provider.doFetch);
    const result = f.calls.find((c) => c.op === 'complete')!.args[1] as { notes: string[]; projects: unknown[] };
    expect(result.notes[0]).toContain('fixed rules');
    expect(result.projects).toHaveLength(1);
  });

  it('logs tokens per job but never the key', async () => {
    const lines: string[] = [];
    const provider = fakeProvider(['{"title": "T"}']);
    const f = fakeApi(0, { ...AI, provider: 'openai-compatible', apiKey: 'sk-SECRET-123456789' });
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', yes: true } }, (m, x) => lines.push(JSON.stringify({ m, ...x })), provider.doFetch);
    expect(lines.some((l) => l.includes('"inputTokens":1000'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-SECRET');
  });

  it('"Test connection" reports model and tokens', async () => {
    const provider = fakeProvider(['{"ok": true}']);
    const f = fakeApi(0, AI);
    await handleAiTest(f.api, { id: 't' }, provider.doFetch);
    expect(f.calls.find((c) => c.op === 'complete')!.args[1]).toMatchObject({ provider: 'ollama', model: 'llama3.1', usage: { calls: 1 } });
  });
});
