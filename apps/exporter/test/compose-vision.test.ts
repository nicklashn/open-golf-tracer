import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleCompose, type FrameGrabber } from '../src/compose-job';
import { grabFrames } from '../src/frames';
import { roundProject } from '../../../packages/compose/test/fixtures';

// Until the rules ask about putts themselves: a `putts:2` question about the two shots in clip b.
vi.mock('@golf/compose', async (importOriginal) => {
  const m = await importOriginal<typeof import('@golf/compose')>();
  return {
    ...m,
    planFromRules: (...args: Parameters<typeof m.planFromRules>) => {
      const plan = m.planFromRules(...args);
      const item = (shotId: string, t: number) => ({ shotId, mediaId: 'b', clip: 2, clipName: 'b.mov', t, reasons: [] });
      return {
        ...plan,
        questions: [
          ...plan.questions,
          {
            id: 'putts:2',
            text: 'Hvor mange putts på hul 2?',
            options: ['1', '2', '3', '4', 'notHoled'].map((id) => ({ id, label: id })),
            default: '2',
            shotIds: ['s2', 's3'],
            clipIds: [],
            items: [item('s2', 5), item('s3', 14)],
          },
        ],
      };
    },
  };
});

function fakeApi(ai: Record<string, unknown>) {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string, ret: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      return ret as never;
    };
  return {
    calls,
    api: {
      jobProject: rec('jobProject', { id: 'p', name: 'Runde', document: roundProject(), pending: 0 }),
      jobAi: rec('jobAi', ai),
      defer: rec('defer'),
      awaitAnswers: rec('awaitAnswers'),
      derive: async (...args: unknown[]) => {
        calls.push({ op: 'derive', args });
        return { id: 'new', name: String(args[1]) };
      },
      progress: rec('progress', { continue: true }),
      complete: rec('complete'),
    },
  };
}

/** An OpenAI-compatible provider: the plan call gets `{}`, a call with pictures gets `vision`. */
function provider(vision: unknown) {
  const bodies: { messages: { content: unknown }[] }[] = [];
  const doFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const pictures = Array.isArray(body.messages[1].content);
    const content = pictures ? JSON.stringify(vision) : '{}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: pictures ? 4000 : 1000, completion_tokens: 50 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { bodies, doFetch, pictures: () => bodies.filter((b) => Array.isArray(b.messages[1].content)).length };
}

function grabber() {
  const seen: { mediaId: string; times: number[] }[] = [];
  const crops: unknown[] = [];
  const frames: FrameGrabber = async (mediaId, times, crop) => {
    seen.push({ mediaId, times });
    crops.push(crop);
    return times.map((_, i) => `/9j/frame${i}`);
  };
  return { seen, frames, crops };
}

const AI = { provider: 'openai-compatible', model: 'm1', baseUrl: 'http://ai.test/v1', apiKey: 'sk-SECRET-123456789', maxTokens: 20000 };
type Asked = {
  plan: { questions: { id: string }[]; notes: string[] };
  vision: { answers: Record<string, string>; notes: string[] } | null;
  usage: { calls: number };
};

describe('compose job: the AI looks at the putting', () => {
  it('setting off: no frames are taken and no picture is sent', async () => {
    const p = provider({ putts: 2, holed: true, confidence: 0.9 });
    const g = grabber();
    const f = fakeApi({ ...AI, vision: false });
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'da' } }, () => {}, p.doFetch, g.frames)).toBe('asked');
    expect(g.seen).toHaveLength(0);
    expect(p.pictures()).toBe(0);
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as Asked;
    expect(asked.plan.questions.map((q) => q.id)).toContain('putts:2');
  });

  it('no AI provider: nothing is looked at, whatever the switch says', async () => {
    const g = grabber();
    const f = fakeApi({ provider: 'none', model: '', baseUrl: '', apiKey: '', maxTokens: 8000, vision: true });
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p' } }, () => {}, undefined, g.frames);
    expect(g.seen).toHaveLength(0);
  });

  it('sure: the question is answered from the frames, with a note, and the answers reach the video', async () => {
    const p = provider({ putts: 2, holed: true, confidence: 0.9 });
    const g = grabber();
    const lines: string[] = [];
    const f = fakeApi({ ...AI, vision: true });
    const log = (m: string, x: Record<string, unknown>) => lines.push(JSON.stringify({ m, ...x }));
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'da' } }, log, p.doFetch, g.frames)).toBe('asked');
    // At the putts of clip b: each strike (5, 14 s), each stop (none known: strike + 3 s) and 1 s after the last.
    expect(g.seen).toEqual([{ mediaId: 'b', times: [5, 8, 14, 17, 18] }]);
    // Cropped around where the balls were (both at 526, 1472 in the 1080×1920 frame).
    expect(g.crops[0]).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    const body = JSON.stringify(p.bodies.find((b) => Array.isArray(b.messages[1].content)));
    expect(body).toContain('putt 2 after');
    expect(p.pictures()).toBe(1);
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as Asked;
    expect(asked.plan.questions.map((q) => q.id)).toEqual(['retake:s2:s3']);
    expect(asked.plan.notes).toContain("AI'en talte 2 putts på hul 2 ud fra billeder.");
    expect(asked.vision!.answers).toEqual({ 'putts:2': '2' });
    expect(asked.usage.calls).toBe(2);
    expect(lines.some((l) => l.includes('ai vision call') && l.includes('"inputTokens":4000'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-SECRET');

    // After the user's answers: no new look, and the AI's own answers go along to the plan call.
    const p2 = provider({});
    const g2 = grabber();
    const f2 = fakeApi({ ...AI, vision: true });
    const payload = { project_id: 'p', locale: 'da', plan: asked.plan, answers: { 'retake:s2:s3': 'last' }, usage: asked.usage, vision: asked.vision };
    expect(await handleCompose(f2.api, { id: 'j', payload }, () => {}, p2.doFetch, g2.frames)).toBe('done');
    expect(g2.seen).toHaveLength(0);
    expect(JSON.stringify(p2.bodies[0].messages[1].content)).toContain('putts:2');
    const result = f2.calls.find((c) => c.op === 'complete')!.args[1] as { notes: string[]; usage: { calls: number } };
    expect(result.notes).toContain("AI'en talte 2 putts på hul 2 ud fra billeder.");
    expect(result.usage.calls).toBe(3);
  });

  it('unsure: the question stays for the user', async () => {
    const p = provider({ putts: 3, holed: null, confidence: 0.4 });
    const f = fakeApi({ ...AI, vision: true });
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p' } }, () => {}, p.doFetch, grabber().frames);
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as Asked;
    expect(asked.plan.questions.map((q) => q.id)).toContain('putts:2');
    expect(asked.vision).toBeNull();
  });

  it('a model that rejects pictures, or frames that cannot be read, never break the video', async () => {
    const doFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (Array.isArray(body.messages[1].content)) return new Response(JSON.stringify({ error: 'images not supported' }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const f = fakeApi({ ...AI, vision: true });
    expect(await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', yes: true } }, () => {}, doFetch, grabber().frames)).toBe('done');
    const broken: FrameGrabber = async () => {
      throw new Error('no such file');
    };
    const g = fakeApi({ ...AI, vision: true });
    expect(await handleCompose(g.api, { id: 'j', payload: { project_id: 'p', yes: true } }, () => {}, doFetch, broken)).toBe('done');
  });

  it('looks at the default plan ceiling: the pictures have an allowance of their own', async () => {
    const p = provider({ putts: 2, holed: true, confidence: 0.9 });
    const f = fakeApi({ ...AI, vision: true, maxTokens: 8000 });
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'en' } }, () => {}, p.doFetch, grabber().frames);
    expect(p.pictures()).toBe(1);
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as Asked & { usage: { visionTokens?: number; inputTokens: number } };
    expect(asked.plan.questions.map((q) => q.id)).not.toContain('putts:2');
    expect(asked.usage.visionTokens).toBe(4050);
  });

  it('stays within the allowance: no picture is sent when it would not fit', async () => {
    const p = provider({ putts: 2, holed: true, confidence: 0.9 });
    const g = grabber();
    const f = fakeApi({ ...AI, vision: true, maxTokens: 8000, visionMaxTokens: 2000 });
    await handleCompose(f.api, { id: 'j', payload: { project_id: 'p', locale: 'en' } }, () => {}, p.doFetch, g.frames);
    expect(p.pictures()).toBe(0);
    expect(g.seen).toHaveLength(0);
    const asked = f.calls.find((c) => c.op === 'awaitAnswers')!.args[1] as Asked;
    expect(asked.plan.questions.map((q) => q.id)).toContain('putts:2');
    expect(asked.plan.notes.some((n) => n.includes('did not look'))).toBe(true);
  });
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe.skipIf(!ffmpeg)('frames from ffmpeg', () => {
  it('gives small JPEGs in memory and skips times past the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogt-frames-'));
    try {
      const clip = join(dir, 'clip.mp4');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-pix_fmt', 'yuv420p', clip]);
      const frames = await grabFrames(clip, [0.2, 1.5, 9]);
      expect(frames).toHaveLength(2);
      const jpeg = Buffer.from(frames[0], 'base64');
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      // Width from the JPEG's SOF0 marker: at most 768 px.
      const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
      expect(jpeg.readUInt16BE(sof + 7)).toBe(768);
      expect(readdirSync(dir)).toEqual(['clip.mp4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
