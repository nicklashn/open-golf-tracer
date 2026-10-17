import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiErrorJson,
  AiError,
  DEFAULT_AI_MAX_TOKENS,
  estimateTokens,
  largeRound,
  ollamaContext,
  parseAiError,
  planFromRules,
  planWithAI,
  summarize,
  summaryText,
  SYSTEM_PROMPT,
  testConnection,
  userMessage,
  videoTokenEstimate,
  type AiConfig,
} from '../src';
import { roundProject } from './fixtures';

/** A fake provider: records requests, answers from a queue. */
interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
let server: Server;
let base = '';
let seen: Seen[] = [];
let replies: { status: number; json: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : {} });
      const r = replies.shift() ?? { status: 500, json: { error: 'no reply queued' } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
beforeEach(() => {
  seen = [];
  replies = [];
});

const KEY = 'sk-test-SECRET-1234567890';
const openai = (extra: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'openai-compatible',
  model: 'm1',
  baseUrl: `${base}/v1`,
  apiKey: KEY,
  maxTokens: 8000,
  ...extra,
});
const anthropic = (extra: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  baseUrl: base,
  apiKey: KEY,
  maxTokens: 8000,
  ...extra,
});
const chat = (content: string, usage = { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 700 } }) => ({
  status: 200,
  json: { choices: [{ message: { content }, finish_reason: 'stop' }], usage },
});
const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 300, output_tokens: 150, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
    ...extra,
  },
});

const summary = summarize(roundProject());
const rulePlan = planFromRules(summary, 'youtube', 'en'); // one retake question (s2/s3)
const TEMPLATES = ['range', 'minimal'];

describe('OpenAI-compatible adapter (Ollama, LM Studio, OpenAI, OpenRouter)', () => {
  it('sends the fixed system prompt first, the summary – never video – and asks for structured JSON', async () => {
    replies.push(chat(JSON.stringify({ kind: 'highlight', title: 'Runden', questions: [{ id: 'retake:s2:s3', text: 'Omslag på hul 2?', default: 'last' }] })));
    const out = await planWithAI(openai(), summary, 'en highlight, kun de bedste', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(seen).toHaveLength(1);
    const r = seen[0];
    expect(r.url).toBe('/v1/chat/completions');
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    const messages = r.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(messages[1].content).toContain('SUMMARY');
    expect(messages[1].content).not.toMatch(/"params"|"track"|data:video/);
    expect((r.body.response_format as { type: string }).type).toBe('json_schema');
    expect(out.plan.kind).toBe('highlight');
    expect(out.plan.title).toBe('Runden');
    expect(out.plan.questions[0].text).toBe('Omslag på hul 2?');
    expect(out.plan.questions[0].default).toBe('last');
    expect(out.usage).toEqual({ calls: 1, inputTokens: 900, outputTokens: 120, cacheReadTokens: 700, cacheWriteTokens: 0 });
  });

  it('cannot add shots or questions – only the rule plan is adjusted', async () => {
    replies.push(
      chat(
        JSON.stringify({
          includeShotIds: ['s1', 'nope'],
          questions: [
            { id: 'retake:s2:s3', default: 'invented' },
            { id: 'extra', text: 'New?', default: 'a', options: [{ id: 'a', label: 'A' }] },
          ],
          shotTexts: [{ shotId: 'nope', text: 'x' }],
          template: 'neon',
        }),
      ),
    );
    const { plan } = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(plan.includeShotIds).toEqual(['s1']);
    expect(plan.questions.map((q) => q.id)).toEqual(['retake:s2:s3']);
    expect(plan.questions[0].default).toBe(rulePlan.questions[0].default);
    expect(plan.shotTexts).toBeUndefined();
    expect(plan.template).toBe(rulePlan.template); // neon not allowed for this user
  });

  it('falls back to plain JSON mode when the server does not know json_schema', async () => {
    replies.push({ status: 400, json: { error: { message: 'response_format json_schema not supported' } } }, chat('{"title":"T"}'));
    const { plan } = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(seen.map((s) => (s.body.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
    expect(plan.title).toBe('T');
  });

  it('retries once with the validation error, then uses the rule plan', async () => {
    replies.push(chat('not json at all'), chat('```json\n{"title": "Fixed"}\n```'));
    const ok = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(ok.plan.title).toBe('Fixed');
    expect(seen[1].body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('INVALID') })]));
    expect(ok.usage.calls).toBe(2);

    seen = [];
    replies.push(chat('{"kind": "cinema"}'), chat('still nothing'));
    const bad = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(bad.fellBack).toBe(true);
    expect(bad.plan).toEqual(rulePlan);
    expect(seen).toHaveLength(2);
  });

  it('sends the answers on the second call and keeps the token count across calls', async () => {
    replies.push(chat('{"title": "Efter svar"}'));
    const used = { calls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const out = await planWithAI(openai(), summary, '', rulePlan, { 'retake:s2:s3': 'last' }, { allowedTemplates: TEMPLATES, used });
    expect((seen[0].body.messages as { content: string }[])[1].content).toContain('"retake:s2:s3":"last"');
    expect(out.usage.calls).toBe(2);
    expect(out.usage.inputTokens).toBe(1900);
  });

  it('stops with a clear error before passing AI_MAX_TOKENS', async () => {
    await expect(planWithAI(openai({ maxTokens: 500 }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES })).rejects.toMatchObject({
      code: 'budget',
    });
    expect(seen).toHaveLength(0);
  });

  it('says what is wrong: rejected key, missing model, Ollama not running – without the key', async () => {
    replies.push({ status: 401, json: { error: { message: `bad key ${KEY}` } } });
    const e1 = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((e) => e);
    expect(e1).toBeInstanceOf(AiError);
    expect(e1.code).toBe('auth');
    expect(String(e1.message)).not.toContain(KEY);

    replies.push({ status: 404, json: { error: 'model "llama9" not found' } });
    const e2 = await planWithAI(openai({ provider: 'ollama', model: 'llama9' }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((e) => e);
    expect(e2.message).toContain('ollama pull llama9');

    const e3 = await planWithAI(openai({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1' }), summary, '', rulePlan, null, {
      allowedTemplates: TEMPLATES,
    }).catch((e) => e);
    expect(e3.code).toBe('network');
    expect(e3.message).toContain('Cannot reach Ollama');
  });

  it('sends once more only when the request never reached the server', async () => {
    let n = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (n++ === 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return fetch(url, init);
    };
    replies.push(chat('{"title": "Second try"}'));
    const out = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES, fetch: flaky });
    expect(out.plan.title).toBe('Second try');
    expect(n).toBe(2);
  });

  it('never resends a request that timed out or broke off (it may be billed), and counts its tokens', async () => {
    for (const thrown of [
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    ]) {
      let n = 0;
      const slow: typeof fetch = async () => {
        n++;
        throw thrown;
      };
      const e = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES, fetch: slow }).catch((x) => x);
      expect(n).toBe(1);
      expect(e).toBeInstanceOf(AiError);
      expect(e.code).toBe('network');
      expect(e.info.reason).toBe(thrown.name === 'TimeoutError' ? 'timeout' : 'broken');
      // Counted as if the provider did the work: the prompt and a full answer.
      expect(e.usage.calls).toBe(1);
      expect(e.usage.inputTokens).toBeGreaterThan(estimateTokens(SYSTEM_PROMPT));
    }
  });

  it('OpenAI reasoning models (gpt-5, o-series) get max_completion_tokens and no temperature', async () => {
    replies.push(chat('{"title": "T"}'));
    await planWithAI(openai({ model: 'gpt-5-mini' }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    const b = seen[0].body;
    expect(b.max_completion_tokens).toBeGreaterThan(0);
    expect(b).not.toHaveProperty('max_tokens');
    expect(b).not.toHaveProperty('temperature');
    expect(b.reasoning_effort).toBe('low');
    expect((b.response_format as { type: string }).type).toBe('json_schema');
  });

  it('a model that rejects max_tokens, then temperature, is asked again the way it wants (400s are not billed)', async () => {
    replies.push(
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            param: 'max_tokens',
            code: 'unsupported_parameter',
          },
        },
      },
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
            param: 'temperature',
            code: 'unsupported_value',
          },
        },
      },
      chat('{"title": "Reasoned"}'),
    );
    const out = await planWithAI(openai({ model: 'my-reasoner' }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(out.plan.title).toBe('Reasoned');
    expect(seen.map((x) => [x.body.max_tokens ?? null, x.body.max_completion_tokens ?? null, x.body.temperature ?? null])).toEqual([
      [2000, null, 0.2],
      [null, 2000, 0.2],
      [null, 2000, null],
    ]);
    // Structured output stays on: the 400s were about other parameters.
    expect(seen.every((x) => (x.body.response_format as { type: string }).type === 'json_schema')).toBe(true);
    expect(out.usage.calls).toBe(1);
  });
});

describe('Ollama (its own /api/chat)', () => {
  const ollama = (extra: Partial<AiConfig> = {}) => openai({ provider: 'ollama', model: 'llama3.1', apiKey: '', ...extra });
  const reply = (content: string) => ({ status: 200, json: { message: { role: 'assistant', content }, done: true, prompt_eval_count: 5100, eval_count: 120 } });

  it('sizes the context window to the prompt, so a whole round is not cut off at 2–4k tokens', async () => {
    const big = largeRound();
    replies.push(reply('{"title": "Hele runden"}'));
    const out = await planWithAI(ollama(), big.summary, '', big.plan, null, { allowedTemplates: TEMPLATES, kind: 'youtube' });
    const r = seen[0];
    expect(r.url).toBe('/api/chat'); // the old /v1 base URL still works
    expect(r.body.stream).toBe(false);
    expect(r.body.format).toMatchObject({ type: 'object' }); // the JSON schema
    const prompt = estimateTokens(SYSTEM_PROMPT, userMessage(big.summary, '', big.plan, null, 'youtube'));
    const ctx = (r.body.options as { num_ctx: number }).num_ctx;
    expect(prompt).toBeGreaterThan(4096);
    expect(ctx).toBeGreaterThanOrEqual(prompt * 1.3 + 2000);
    expect(ctx % 2048).toBe(0);
    expect(out.plan.title).toBe('Hele runden');
    expect(out.usage).toMatchObject({ calls: 1, inputTokens: 5100, outputTokens: 120 });
  });

  it('the window stays small for small prompts and within what Ollama can hold', () => {
    expect(ollamaContext(300, 0, 256)).toBe(4096);
    expect(ollamaContext(10_000, 0, 2000)).toBe(16_384);
    expect(ollamaContext(1e6, 0, 2000)).toBe(131_072);
  });

  it('falls back to "json" on Ollama before 0.5, and says how to get a missing model', async () => {
    replies.push({ status: 400, json: { error: 'invalid format' } }, reply('{"title": "Old"}'));
    const out = await planWithAI(ollama(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(seen.map((x) => (typeof x.body.format === 'string' ? x.body.format : 'schema'))).toEqual(['schema', 'json']);
    expect(out.plan.title).toBe('Old');

    replies.push({ status: 404, json: { error: "model 'llama9' not found" } });
    const e = await planWithAI(ollama({ model: 'llama9' }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((x) => x);
    expect(e.message).toContain('ollama pull llama9');
    expect(e.info).toMatchObject({ reason: 'ollamaPull', model: 'llama9' });
  });
});

describe('what the model sees and may change', () => {
  it('names shots by number, and their numbers come back as ids', async () => {
    const msg = userMessage(summary, '', rulePlan, { 'retake:s2:s3': 'last', 'shot:s2': 'keep' });
    expect(summaryText(summary)).toMatch(/^shot 1 clip=1 t=\S+ hole=1 /m);
    expect(summaryText(summary)).not.toContain('id=');
    expect(msg).toContain('"includeShots":[1,2,3]');
    expect(msg).toContain('"shot:2":"keep"');
    replies.push(chat(JSON.stringify({ includeShots: [1, 3], order: [3, 1], shotTexts: [{ shot: 3, text: 'Andet forsøg' }] })));
    const { plan } = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(plan.includeShotIds).toEqual(['s1', 's3']);
    expect(plan.order).toEqual(['s3', 's1']);
    expect(plan.shotTexts?.s3).toBe('Andet forsøg');
  });

  it('the format the user picked is its own line, and neither the wish nor the model can change it', async () => {
    const rules = planFromRules(summary, 'en short af hvert slag', 'en', { kind: 'youtube' });
    expect(rules.kind).toBe('youtube');
    replies.push(chat(JSON.stringify({ kind: 'shorts', title: 'T' })));
    const { plan } = await planWithAI(openai(), summary, 'en short af hvert slag', rules, null, { allowedTemplates: TEMPLATES, kind: 'youtube' });
    expect((seen[0].body.messages as { content: string }[])[1].content).toContain('FORMAT\nyoutube\n');
    expect(plan.kind).toBe('youtube');
  });

  it('a large round (100 shots) fits the default ceiling with both calls', () => {
    const big = largeRound();
    expect(estimateTokens(summaryText(big.summary))).toBeLessThan(3500);
    const e = videoTokenEstimate(big.summary, '', big.plan);
    expect(big.plan.questions.length).toBeGreaterThan(0);
    expect(e.needed).toBeLessThanOrEqual(DEFAULT_AI_MAX_TOKENS);
  });
});

describe('AI errors for the apps', () => {
  it('travel as a code with the facts, short enough for the job error and without the key', async () => {
    replies.push({ status: 401, json: { error: { message: `bad key ${KEY}` } } });
    const e = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((x) => x);
    const text = aiErrorJson(e);
    expect(text.length).toBeLessThan(500);
    expect(text).not.toContain(KEY);
    expect(parseAiError(text)).toMatchObject({ code: 'auth', reason: 'key', status: 401 });
    expect(parseAiError('Workeren stoppede uventet.')).toBeNull();
    const long = aiErrorJson(new AiError('x'.repeat(2000), 'http', { what: 'w', detail: 'd'.repeat(2000) }));
    expect(long.length).toBeLessThan(500);
    expect(parseAiError(long)?.code).toBe('http');
  });
});

describe('Anthropic adapter', () => {
  it('uses the Messages API with a cached system prompt and structured output', async () => {
    replies.push(msg('{"title": "Fra Claude", "description": "To drives på rangen."}'));
    const out = await planWithAI(anthropic(), summary, 'rolig video', rulePlan, null, { allowedTemplates: TEMPLATES });
    const r = seen[0];
    expect(r.url).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.body.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(r.body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(out.plan.title).toBe('Fra Claude');
    expect(out.plan.description).toBe('To drives på rangen.');
    expect(out.usage).toEqual({ calls: 1, inputTokens: 900, outputTokens: 150, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it('reports a refusal and counts its tokens', async () => {
    replies.push(msg('', { stop_reason: 'refusal' }));
    const e = await planWithAI(anthropic(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((x) => x);
    expect(e.code).toBe('refused');
  });

  it('needs a key', async () => {
    const e = await testConnection(anthropic({ apiKey: '' })).catch((x) => x);
    expect(e.code).toBe('config');
    expect(seen).toHaveLength(0);
  });

  it('"Test connection" makes one tiny call and returns model and tokens', async () => {
    replies.push(msg('{"ok": true}'));
    const t = await testConnection(anthropic());
    expect(t.model).toBe('claude-opus-5-5');
    expect(t.usage.calls).toBe(1);
    expect(seen[0].body.max_tokens).toBe(256);
  });
});
