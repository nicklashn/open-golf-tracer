import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError, planFromRules, planWithAI, SYSTEM_PROMPT, summarize, testConnection, type AiConfig } from '../src';
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

  it('retries once after a network error', async () => {
    let n = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return fetch(url, init);
    };
    replies.push(chat('{"title": "Second try"}'));
    const out = await planWithAI(openai(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES, fetch: flaky });
    expect(out.plan.title).toBe('Second try');
    expect(n).toBe(2);
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
