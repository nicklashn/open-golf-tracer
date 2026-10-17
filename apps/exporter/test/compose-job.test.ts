import { describe, expect, it } from 'vitest';
import { handleAiTest, handleCompose, onlyClips } from '../src/compose-job';
import { roundProject } from '../../../packages/compose/test/fixtures';

/** The internal API as the job sees it, recording what was sent. */
function fakeApi(
  pending = 0,
  ai: Record<string, unknown> = { provider: 'none', model: '', baseUrl: '', apiKey: '', maxTokens: 8000 },
  document: unknown = roundProject(),
) {
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
      jobProject: rec('jobProject', { id: 'p', name: 'Runde', document, pending }),
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
function fakeProvider(answers: string[], usage = { prompt_tokens: 1000, completion_tokens: 100 }, status = 200) {
  const bodies: { messages: { content: string }[] }[] = [];
  const doFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const content = answers.shift() ?? '{}';
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
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

/** A full round as one is filmed: 40 clips over 18 holes, 45 shots, a few of them doubtful. */
function bigRound() {
  const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
  const media = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    kind: 'video',
    name: `IMG_${4000 + i}.MOV`,
    width: 1080,
    height: 1920,
    fps: 60,
    duration: 30,
    recordedAt: `2026-06-16T${String(8 + Math.floor((i * 6) / 60)).padStart(2, '0')}:${String((i * 6) % 60).padStart(2, '0')}:00+0200`,
    geo: { lat: 56.2 + i * 0.003, lon: 9.7 },
    place: { course: 'Testbane', hole: String(1 + Math.floor((i * 18) / 40)), par: 4, fromTee: 0, toGreen: 300, line: [] },
  }));
  const shots = Array.from({ length: 45 }, (_, i) => {
    const mediaId = `m${Math.min(39, Math.floor((i * 40) / 45))}`;
    const t = 5 + (i % 2) * 12;
    return {
      id: `shot${i}`,
      mediaId,
      impactTime: t,
      confidence: i % 7 === 3 ? 0.3 : 0.9,
      camera: { cx: 540, cy: 960 },
      anchor: { x: 300 + i * 10, y: 1472 },
      params,
      auto: { params, anchor: { x: 300 + i * 10, y: 1472 }, impactTime: t },
    };
  });
  return {
    schemaVersion: 1,
    name: 'Hele runden',
    media: Object.fromEntries(media.map((m) => [m.id, m])),
    clips: media.map((m) => ({ id: `c_${m.id}`, kind: 'video', mediaId: m.id, in: 0, out: 30 })),
    shots,
  };
}

describe('the AI never fails the video', () => {
  type Done = { notes: string[]; projects: unknown[]; title: string; usage: { calls: number } | null };
  const done = (f: ReturnType<typeof fakeApi>) => f.calls.find((c) => c.op === 'complete')!.args[1] as Done;

  it('a full round: the second call would pass the ceiling, so the first AI plan is used with the answers', async () => {
    const provider = fakeProvider([JSON.stringify({ title: 'Hele runden på Testbane' })], { prompt_tokens: 4800, completion_tokens: 400 });
    const first = fakeApi(0, AI, bigRound());
    expect(await handleCompose(first.api, { id: 'j', payload: { project_id: 'p', locale: 'en' } }, () => {}, provider.doFetch)).toBe('asked');
    const asked = first.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as {
      plan: { title: string; questions: { id: string; default: string }[] };
      usage: unknown;
    };
    expect(asked.plan.title).toBe('Hele runden på Testbane');
    const answers = Object.fromEntries(asked.plan.questions.map((q) => [q.id, q.default]));

    const second = fakeApi(0, AI, bigRound());
    const lines: string[] = [];
    const out = await handleCompose(
      second.api,
      { id: 'j', payload: { project_id: 'p', locale: 'en', plan: asked.plan, answers, usage: asked.usage } },
      (m, x) => lines.push(JSON.stringify({ m, ...x })),
      provider.doFetch,
    );
    expect(out).toBe('done');
    expect(provider.bodies).toHaveLength(1); // the second call was never sent
    const r = done(second);
    expect(r.projects).toHaveLength(1);
    expect(r.title).toBe('Hele runden på Testbane');
    expect(r.notes.some((n) => n.includes('could not adjust the plan') && n.includes('ceiling of 8000 tokens'))).toBe(true);
    expect(lines.some((l) => l.includes('"ai failed"') && l.includes('"code":"budget"'))).toBe(true);
  });

  it('a round too large for even one call: the rule plan, with a note on raising the ceiling', async () => {
    const provider = fakeProvider([]);
    const f = fakeApi(0, { ...AI, maxTokens: 2000 }, bigRound());
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'da', yes: true } }, () => {}, provider.doFetch)).toBe('done');
    expect(provider.bodies).toHaveLength(0);
    const r = done(f);
    expect(r.projects).toHaveLength(1);
    expect(r.notes[0]).toContain('for stor til loftet på 2000 tokens');
  });

  it('a rejected key: the rule plan, with the reason', async () => {
    const provider = fakeProvider([], undefined, 401);
    const f = fakeApi(0, { ...AI, provider: 'openai-compatible', apiKey: 'sk-SECRET-123456789' });
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'en', yes: true } }, () => {}, provider.doFetch)).toBe('done');
    const r = done(f);
    expect(r.notes[0]).toMatch(/^The AI could not be used \(.*rejected the API key \(401\)\), so the plan was made by fixed rules\.$/);
    expect(JSON.stringify(r)).not.toContain('sk-SECRET');
  });
});
