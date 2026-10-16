import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError, planFromRules, planWithAI, resolvePuttsWithVision, summarize, SYSTEM_PROMPT, testConnection, VISION_PROMPT, type AiConfig } from '../src';
import { roundProject } from './fixtures';

/** A fake Responses API: records requests, answers with JSON errors or a server-sent event stream. */
interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
type Reply = { status: number; json: unknown } | { sse: unknown[]; raw?: string };
let server: Server;
let base = '';
let seen: Seen[] = [];
let replies: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : {} });
      const r = replies.shift() ?? { status: 500, json: { error: { message: 'no reply queued' } } };
      if ('sse' in r) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Written in small pieces so events are split across chunks.
        const text = r.sse.map((e) => `event: ${(e as { type: string }).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('') + (r.raw ?? '');
        for (let i = 0; i < text.length; i += 37) res.write(text.slice(i, i + 37));
        res.end();
        return;
      }
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

const TOKEN = 'at-SECRET-ACCESS-TOKEN-0123456789';
const chatgpt = (extra: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'chatgpt',
  model: 'picked-model',
  baseUrl: `${base}/v1`,
  apiKey: TOKEN,
  maxTokens: 20000,
  ...extra,
});
const USAGE = { input_tokens: 1200, output_tokens: 90, input_tokens_details: { cached_tokens: 800 } };
/** A successful stream: the text in two deltas, then response.completed with the usage. */
const stream = (text: string, usage = USAGE) => ({
  sse: [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: text.slice(0, 7) },
    { type: 'response.output_text.delta', delta: text.slice(7) },
    { type: 'response.output_text.done', text },
    { type: 'response.completed', response: { status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } },
  ],
});

const summary = summarize(roundProject());
const rulePlan = planFromRules(summary, 'youtube', 'en');
const TEMPLATES = ['range', 'minimal'];

describe('ChatGPT adapter (Responses API on the ChatGPT plan)', () => {
  it('streams a plan: store false, stream true, instructions instead of a system message, no unsupported fields', async () => {
    replies.push(stream(JSON.stringify({ kind: 'highlight', title: 'From ChatGPT' })));
    const logs: string[] = [];
    const out = await planWithAI(chatgpt(), summary, 'a highlight', rulePlan, null, {
      allowedTemplates: TEMPLATES,
      log: (m, x) => logs.push(`${m} ${JSON.stringify(x)}`),
    });
    expect(seen).toHaveLength(1);
    const r = seen[0];
    expect(r.url).toBe('/v1/responses');
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.headers.accept).toBe('text/event-stream');
    expect(r.body).toMatchObject({ model: 'picked-model', instructions: SYSTEM_PROMPT, store: false, stream: true });
    for (const k of ['max_output_tokens', 'temperature', 'top_p', 'metadata', 'user', 'truncation', 'background', 'previous_response_id', 'messages'])
      expect(r.body).not.toHaveProperty(k);
    const input = r.body.input as { role: string; content: { type: string; text?: string }[] }[];
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
    expect(input[0].content[0].type).toBe('input_text');
    expect(input[0].content[0].text).toContain('SUMMARY');
    expect(r.body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });

    expect(out.fellBack).toBe(false);
    expect(out.plan.kind).toBe('highlight');
    expect(out.plan.title).toBe('From ChatGPT');
    expect(out.usage).toEqual({ calls: 1, inputTokens: 1200, outputTokens: 90, cacheReadTokens: 800, cacheWriteTokens: 0 });
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('falls back to plain instructions when structured output is not accepted', async () => {
    replies.push({ status: 400, json: { error: { code: 'subscription_sharing_unsupported_capability', param: 'text.format', message: 'nope' } } });
    replies.push(stream('Here you go: {"title": "Plain JSON"}'));
    const out = await planWithAI(chatgpt(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(seen).toHaveLength(2);
    expect(seen[0].body.text).toBeDefined();
    expect(seen[1].body).not.toHaveProperty('text');
    expect(out.plan.title).toBe('Plain JSON');
  });

  it('retries an invalid answer once with the validation error, then uses the rule plan', async () => {
    replies.push(stream('{"kind": "cinema"}'), stream('{"kind": "cinema"}'));
    const out = await planWithAI(chatgpt(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES });
    expect(seen).toHaveLength(2);
    expect(out.fellBack).toBe(true);
    expect(out.usage.calls).toBe(2);
  });

  it('sends still frames as input_image parts', async () => {
    replies.push(stream('{"putts": 2, "holed": true, "confidence": 0.9}'));
    const out = await resolvePuttsWithVision(chatgpt(), { hole: '7', par: 4, times: [10, 12] }, ['/9j/AAAA', '/9j/BBBB']);
    expect(out.result).toEqual({ putts: 2, holed: true, confidence: 0.9 });
    const r = seen[0];
    expect(r.body.instructions).toBe(VISION_PROMPT);
    const content = (r.body.input as { content: { type: string; image_url?: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(['input_text', 'input_image', 'input_image']);
    expect(content[1].image_url).toBe('data:image/jpeg;base64,/9j/AAAA');
  });

  it('a model without image support keeps the question', async () => {
    const reject = { status: 400, json: { error: { message: 'image input not supported' } } };
    replies.push(reject, reject);
    const out = await resolvePuttsWithVision(chatgpt(), { hole: '7', par: 4, times: [10] }, ['/9j/AAAA']);
    expect(out.result).toBeNull();
    expect(out.error).toMatch(/may not support images/);
  });

  it('401 asks to sign in again; 429 and a usage-limit event point to ChatGPT usage settings – never the token', async () => {
    replies.push({ status: 401, json: { error: { message: `bad token ${TOKEN}` } } });
    const e1 = await planWithAI(chatgpt(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((e) => e);
    expect(e1).toBeInstanceOf(AiError);
    expect(e1.code).toBe('auth');
    expect(e1.message).toContain('Sign in with ChatGPT again');
    expect(e1.message).not.toContain(TOKEN);

    replies.push({ status: 429, json: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } });
    const e2 = await planWithAI(chatgpt(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((e) => e);
    expect(e2.code).toBe('limit');
    expect(e2.message).toContain('https://chatgpt.com/settings/usage');

    replies.push({
      sse: [
        { type: 'response.created', response: {} },
        { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' }, usage: { input_tokens: 10 } } },
      ],
    });
    const e3 = await planWithAI(chatgpt(), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((e) => e);
    expect(e3.code).toBe('limit');

    replies.push({ status: 503, json: { detail: 'Direct routing is not enabled' } });
    const e4 = await testConnection(chatgpt()).catch((e) => e);
    expect(e4.code).toBe('http');
    expect(e4.message).toContain('503');
    for (const e of [e1, e2, e3, e4]) expect(String(e.message)).not.toContain(TOKEN);
  });

  it('a stream that ends without response.completed, or is incomplete, is not a success', async () => {
    replies.push({ sse: [{ type: 'response.output_text.delta', delta: '{"title": "half' }] });
    const e1 = await testConnection(chatgpt()).catch((e) => e);
    expect(e1.code).toBe('network');
    replies.push({ sse: [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }] });
    const e2 = await testConnection(chatgpt()).catch((e) => e);
    expect(e2.message).toContain('max_output_tokens');
  });

  it('without a token it says why and sends nothing; "Test connection" works with one', async () => {
    const e = await testConnection(chatgpt({ apiKey: '', error: 'The ChatGPT sign-in has expired. Sign in again.' })).catch((x) => x);
    expect(e.code).toBe('auth');
    expect(e.message).toContain('expired');
    const e2 = await testConnection(chatgpt({ model: '' })).catch((x) => x);
    expect(e2.code).toBe('config');
    expect(seen).toHaveLength(0);

    replies.push(stream('{"ok": true}', { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }));
    const t = await testConnection(chatgpt());
    expect(t.model).toBe('picked-model');
    expect(t.usage).toMatchObject({ calls: 1, inputTokens: 30, outputTokens: 5 });
  });

  it('stays within AI_MAX_TOKENS', async () => {
    const e = await planWithAI(chatgpt({ maxTokens: 500 }), summary, '', rulePlan, null, { allowedTemplates: TEMPLATES }).catch((x) => x);
    expect(e.code).toBe('budget');
    expect(seen).toHaveLength(0);
  });
});
