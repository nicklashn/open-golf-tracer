import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPuttVision,
  frameTimes,
  IMAGE_TOKENS,
  puttSegment,
  resolvePuttsWithVision,
  VISION_PROMPT,
  VideoPlan,
  type AiConfig,
  type PlanQuestion,
} from '../src';

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
const FRAMES = ['/9j/AAAA', '/9j/BBBB', '/9j/CCCC'];
const HOLE = { hole: '7', par: 4, times: [10, 12, 14] };
const openai = (extra: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'openai-compatible',
  model: 'm1',
  baseUrl: `${base}/v1`,
  apiKey: KEY,
  maxTokens: 20000,
  ...extra,
});
const anthropic = (extra: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  baseUrl: base,
  apiKey: KEY,
  maxTokens: 20000,
  ...extra,
});
const answer = { putts: 2, holed: true, confidence: 0.9 };
const chat = (content: string, usage: unknown = { prompt_tokens: 2500, completion_tokens: 30 }) => ({
  status: 200,
  json: { choices: [{ message: { content }, finish_reason: 'stop' }], usage },
});

function logger() {
  const lines: string[] = [];
  return { lines, log: (m: string, x: Record<string, unknown>) => lines.push(JSON.stringify({ m, ...x })) };
}

describe('vision: OpenAI-compatible (also Ollama /v1)', () => {
  it('sends the frames as image_url parts with base64 data URLs and logs tokens without the key', async () => {
    replies.push(chat(JSON.stringify(answer)));
    const l = logger();
    const out = await resolvePuttsWithVision(openai(), HOLE, FRAMES, { log: l.log });
    expect(out.result).toEqual(answer);
    expect(out.usage).toMatchObject({ calls: 1, inputTokens: 2500, outputTokens: 30 });
    const r = seen[0];
    expect(r.url).toBe('/v1/chat/completions');
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    const messages = r.body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: 'system', content: VISION_PROMPT });
    const parts = messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('Hole 7');
    expect(parts.slice(1)).toEqual(FRAMES.map((d) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${d}` } })));
    expect((r.body.response_format as { type: string }).type).toBe('json_schema');
    expect(l.lines.join('\n')).toContain('"inputTokens":2500');
    expect(l.lines.join('\n')).not.toContain(KEY);
  });

  it('counts the frames conservatively when the server reports no usage', async () => {
    replies.push(chat(JSON.stringify(answer), null));
    const out = await resolvePuttsWithVision(openai({ provider: 'ollama', apiKey: '' }), HOLE, FRAMES);
    expect(out.usage.inputTokens).toBeGreaterThanOrEqual(FRAMES.length * IMAGE_TOKENS);
    expect(out.usage.outputTokens).toBeGreaterThan(0);
  });

  it('a model without image support gives a clear error, never the key, and no result', async () => {
    const reject = { status: 400, json: { error: { message: `image input not supported (key ${KEY})` } } };
    replies.push(reject, reject); // structured output, then the plain-JSON retry
    const l = logger();
    const out = await resolvePuttsWithVision(openai(), HOLE, FRAMES, { log: l.log });
    expect(out.result).toBeNull();
    expect(out.skipped).toBe('error');
    expect(out.error).toMatch(/may not support images/);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(l.lines.join('\n')).not.toContain(KEY);
  });

  it('an unusable answer is no result (the user is asked)', async () => {
    replies.push(chat('{"putts": 9, "holed": "maybe"}'));
    const out = await resolvePuttsWithVision(openai(), HOLE, FRAMES);
    expect(out).toMatchObject({ result: null, skipped: 'invalid' });
    expect(out.usage.calls).toBe(1);
  });
});

describe('vision: Anthropic', () => {
  it('sends base64 image blocks before the text', async () => {
    replies.push({
      status: 200,
      json: { content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', usage: { input_tokens: 1800, output_tokens: 25 } },
    });
    const l = logger();
    const out = await resolvePuttsWithVision(anthropic(), HOLE, FRAMES, { log: l.log });
    expect(out.result).toEqual(answer);
    const r = seen[0];
    expect(r.url).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    const content = (r.body.messages as { content: { type: string; source?: unknown; text?: string }[] }[])[0].content;
    expect(content.slice(0, 3)).toEqual(FRAMES.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })));
    expect(content[3].type).toBe('text');
    expect((r.body.system as { text: string }[])[0].text).toBe(VISION_PROMPT);
    expect(l.lines.join('\n')).not.toContain(KEY);
  });
});

describe('vision: token ceiling', () => {
  it('sends nothing when the frames would pass AI_MAX_TOKENS (with the reserve kept free)', async () => {
    const used = { calls: 1, inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const out = await resolvePuttsWithVision(openai({ maxTokens: 8000 }), HOLE, [...FRAMES, ...FRAMES], { used, reserve: 2500 });
    expect(out).toMatchObject({ result: null, skipped: 'budget', usage: used });
    expect(seen).toHaveLength(0);
    // Without the reserve the same call fits.
    replies.push(chat(JSON.stringify(answer)));
    const ok = await resolvePuttsWithVision(openai({ maxTokens: 8000 }), HOLE, FRAMES, { used });
    expect(ok.result).toEqual(answer);
    expect(ok.usage.inputTokens).toBe(5500);
  });
});

const puttsQ = (hole: string): PlanQuestion => ({
  id: `putts:${hole}`,
  text: `Hvor mange putts på hul ${hole}?`,
  options: ['1', '2', '3', '4+'].map((id) => ({ id, label: id })),
  default: '2',
  shotIds: ['p1', 'p2'],
  clipIds: [],
  items: [
    { shotId: 'p1', mediaId: 'm7', clip: 3, clipName: 'g.mov', t: 20, reasons: [] },
    { shotId: 'p2', mediaId: 'm7', clip: 3, clipName: 'g.mov', t: 31, reasons: [] },
    { shotId: 'x', mediaId: 'other', clip: 4, clipName: 'h.mov', t: 2, reasons: [] },
  ],
});
const holedQ: PlanQuestion = {
  id: 'holed:7',
  text: 'I hul?',
  options: ['yes', 'no'].map((id) => ({ id, label: id })),
  default: 'yes',
  shotIds: [],
  clipIds: [],
};
const plan = VideoPlan.parse({ kind: 'youtube', includeShotIds: [], title: 'T', questions: [puttsQ('7'), holedQ, puttsQ('8')], notes: ['first'] });

describe('the putts question', () => {
  it('fills the answers and drops the questions when the model is sure', () => {
    const out = applyPuttVision(plan, '7', { putts: 2, holed: true, confidence: 0.8 }, 'da')!;
    expect(out.answers).toEqual({ 'putts:7': '2', 'holed:7': 'yes' });
    expect(out.plan.questions.map((q) => q.id)).toEqual(['putts:8']);
    expect(out.note).toBe("AI'en talte 2 putts på hul 7 ud fra billeder.");
    expect(out.plan.notes).toEqual(['first', out.note]);
    expect(applyPuttVision(plan, '7', { putts: 5, holed: null, confidence: 0.9 }, 'en')!.answers).toEqual({ 'putts:7': '4+' });
  });

  it('keeps the question when the model is unsure, and the holed question when the frames did not show it', () => {
    expect(applyPuttVision(plan, '7', { putts: 2, holed: true, confidence: 0.69 }, 'da')).toBeNull();
    const out = applyPuttVision(plan, '7', { putts: 1, holed: null, confidence: 0.95 }, 'en')!;
    expect(out.plan.questions.map((q) => q.id)).toEqual(['holed:7', 'putts:8']);
    expect(out.note).toBe('The AI counted 1 putt on hole 7 from still frames.');
  });

  it('looks from the first putt −1 s to the end of the last +1 s, in the clip with most putts', () => {
    expect(puttSegment(puttsQ('7'), (id) => (id === 'p2' ? 36 : null))).toEqual({ mediaId: 'm7', from: 19, to: 37 });
    expect(puttSegment(puttsQ('7'), () => null)).toEqual({ mediaId: 'm7', from: 19, to: 36 });
    expect(frameTimes(19, 37, 4)).toEqual([19, 25, 31, 37]);
  });
});
