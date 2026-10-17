// @vitest-environment happy-dom
/**
 * "Make a video for me": a video waiting for answers comes back after a reload (and after the
 * live connection was lost), answers wait for the save of a shot just fixed, the format goes as
 * its own field, and AI errors read in the user's language.
 */
import { act } from 'react';
import { aiErrorJson, AiError } from '@golf/compose';
import { migrateProject } from '@golf/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; body?: unknown }[] = [];
let jobs: Record<string, unknown>[] = [];
let saveOk = true;
let reconnect: (() => void) | undefined;

const question = {
  id: 'retake:s2:s3',
  text: 'Hole 2: two shots from the same spot. Which should be in the video?',
  options: [
    { id: 'both', label: 'Both' },
    { id: 'last', label: 'Only the last' },
  ],
  default: 'last',
  shotIds: [],
  clipIds: [],
};
const waiting = {
  id: 'job_c',
  kind: 'compose',
  status: 'awaiting_answers',
  progress: 0.2,
  message: '',
  projectId: 'p1',
  mediaId: null,
  error: '',
  result: { questions: [question] },
};

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('@/lib/events', () => ({
  useJobEvents: (_cb: unknown, _project: unknown, onReconnect?: () => void) => {
    reconnect = onReconnect;
  },
}));
vi.mock('@/editor/autosave', () => ({ saveNow: async () => saveOk }));
vi.mock('@/lib/api', () => ({
  api: async (path: string, opts?: { body?: unknown; method?: string }) => {
    calls.push({ path, body: opts?.body });
    if (path === '/ai/settings') return { effective: { provider: 'none', vision: false, maxTokens: 20000 } };
    if (path.startsWith('/jobs?project_id=')) return { jobs };
    if (path === '/autovideo') return { ...waiting, id: 'job_new', status: 'queued', result: {} };
    if (path.endsWith('/answers')) return { ...waiting, status: 'queued', result: {} };
    throw new Error(path);
  },
  errorMessage: (e: unknown) => String(e),
}));

const { useEditor } = await import('@/editor/store');
const { AutoVideoDialog } = await import('@/editor/AutoVideo');
const { mount } = await import('./helpers/render');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
const button = (text: string | RegExp) =>
  [...document.body.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));

const PARAMS = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const doc = migrateProject({
  schemaVersion: 1,
  name: 'Round',
  media: { a: { id: 'a', kind: 'video', name: 'a.mov', width: 1920, height: 1080, fps: 30, duration: 20 } },
  clips: [{ id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 20 }],
  shots: [
    {
      id: 's1',
      mediaId: 'a',
      impactTime: 5,
      camera: { cx: 960, cy: 540 },
      anchor: { x: 900, y: 900 },
      params: PARAMS,
      auto: { params: PARAMS, anchor: { x: 900, y: 900 }, impactTime: 5 },
    },
  ],
});

describe('AutoVideoDialog', () => {
  beforeEach(() => {
    calls.length = 0;
    saveOk = true;
    jobs = [];
    useEditor.setState({ projectId: 'p1', doc });
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('after a reload, opening the dialog shows the questions the video is waiting for', async () => {
    jobs = [waiting];
    const view = mount(<AutoVideoDialog open onOpenChange={() => {}} />);
    await flush();
    expect(calls.map((c) => c.path)).toContain('/jobs?project_id=p1');
    expect(document.body.querySelector('[data-testid="auto-questions"]')?.textContent).toContain('two shots from the same spot');
    view.unmount();
  });

  it('after the live connection was lost, fetches the job again (it may have finished meanwhile)', async () => {
    jobs = [waiting];
    const view = mount(<AutoVideoDialog open onOpenChange={() => {}} />);
    await flush();
    jobs = [
      {
        ...waiting,
        status: 'failed',
        error: aiErrorJson(
          new AiError('Cannot reach Ollama at http://localhost:11434.', 'network', { reason: 'unreachable', what: 'Ollama', origin: 'http://localhost:11434' }),
        ),
      },
    ];
    await act(async () => reconnect?.());
    await flush();
    // The provider's English is not shown: the error code is put in the user's language.
    expect(document.body.querySelector('[data-testid="auto-failed"]')?.textContent).toContain('Cannot reach Ollama at http://localhost:11434. Is it running?');
    view.unmount();
  });

  it('answers wait for the save of a shot fixed in the editor, and stop when it fails', async () => {
    jobs = [waiting];
    const view = mount(<AutoVideoDialog open onOpenChange={() => {}} />);
    await flush();
    saveOk = false;
    await act(async () => button('Continue')!.click());
    await flush();
    expect(calls.some((c) => c.path.endsWith('/answers'))).toBe(false);
    expect(document.body.textContent).toContain('could not be saved');
    saveOk = true;
    await act(async () => button('Continue')!.click());
    await flush();
    expect(calls.find((c) => c.path === '/jobs/job_c/answers')?.body).toEqual({ answers: { 'retake:s2:s3': 'last' } });
    view.unmount();
  });

  it('sends the format card as its own field, not as words in the wish', async () => {
    const view = mount(<AutoVideoDialog open onOpenChange={() => {}} />);
    await flush();
    const highlight = [...document.body.querySelectorAll('input[type="radio"]')].find((r) => (r as HTMLInputElement).value === 'highlight') as HTMLInputElement;
    await act(async () => highlight.click());
    await act(async () => button(/Make the video/)!.click());
    await flush();
    const body = calls.find((c) => c.path === '/autovideo')?.body as { kind: string; preference: string };
    expect(body.kind).toBe('highlight');
    expect(body.preference).toBe('');
    view.unmount();
  });

  it('does not start when the project could not be saved', async () => {
    saveOk = false;
    const view = mount(<AutoVideoDialog open onOpenChange={() => {}} />);
    await flush();
    await act(async () => button(/Make the video/)!.click());
    await flush();
    expect(calls.some((c) => c.path === '/autovideo')).toBe(false);
    expect(document.body.textContent).toContain('could not be saved');
    view.unmount();
  });
});
