// @vitest-environment happy-dom
/**
 * Settings → AI: the token limit can be typed (clearing the field does not snap back to the
 * default), and "Test connection" says so when the exporter never picks the test up, and shows
 * an AI error in the user's language.
 */
import { act } from 'react';
import { aiErrorJson, AiError } from '@golf/compose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let testJob: Record<string, unknown> = {};

const settings = {
  provider: 'ollama',
  model: 'llama3.1',
  baseUrl: '',
  keyMasked: '',
  maxTokens: 20000,
  vision: false,
  effective: {
    provider: 'ollama',
    model: 'llama3.1',
    baseUrl: 'http://localhost:11434/v1',
    source: 'user',
    keyMasked: '',
    maxTokens: 20000,
    cloud: false,
    vision: false,
  },
  server: { provider: 'none', model: '', keyMasked: '' },
  defaults: { ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
  chatgpt: { signedIn: false, registered: false, email: '', expiresAt: null, problem: '' },
};

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('@/lib/api', () => ({
  api: async (path: string, opts?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: opts?.method, body: opts?.body });
    if (path === '/ai/settings') return opts?.method === 'PUT' ? { ...settings, ...(opts.body as object) } : settings;
    if (path === '/ai/test') return { id: 'job_t', kind: 'ai_test', status: 'queued' };
    if (path === '/jobs') return { jobs: [{ id: 'job_t', kind: 'ai_test', ...testJob }] };
    if (path === '/jobs/job_t/cancel') return {};
    throw new Error(path);
  },
  errorMessage: (e: unknown) => String(e),
}));

const { AiSettingsForm } = await import('@/components/app/AiSettings');
const { mount } = await import('./helpers/render');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
const type = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('AiSettingsForm', () => {
  afterEach(() => {
    vi.useRealTimers();
    calls.length = 0;
  });

  it('the token limit keeps what is typed, and is brought into range on leaving the field', async () => {
    const view = mount(<AiSettingsForm />);
    await flush();
    const input = view.el.querySelector('[data-testid="ai-max-tokens"]') as HTMLInputElement;
    expect(input.value).toBe('20000');
    await act(async () => type(input, ''));
    expect(input.value).toBe('');
    await act(async () => type(input, '3'));
    expect(input.value).toBe('3');
    await act(async () => type(input, '30000'));
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.value).toBe('30000');
    await act(async () => type(input, '3'));
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.value).toBe('500');
    view.unmount();
  });

  it('"Test connection" says when the exporter never takes the test, and gives up', async () => {
    vi.useFakeTimers();
    testJob = { status: 'queued', error: '' };
    const view = mount(<AiSettingsForm />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const test = [...view.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Test connection'))!;
    await act(async () => {
      test.click();
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(view.el.textContent).toContain('waiting for the export worker');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.el.textContent).toContain('The test did not start');
    expect(calls.some((c) => c.path === '/jobs/job_t/cancel')).toBe(true);
    view.unmount();
  });

  it('a failed test reads in the user’s language, not the provider’s English', async () => {
    vi.useFakeTimers();
    testJob = {
      status: 'failed',
      error: aiErrorJson(new AiError('Ollama does not have the model "x". Run: ollama pull x', 'model', { reason: 'ollamaPull', what: 'Ollama', model: 'x' })),
    };
    const view = mount(<AiSettingsForm />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const test = [...view.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Test connection'))!;
    await act(async () => {
      test.click();
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(view.el.textContent).toContain('The connection does not work: Ollama does not have the model "x". Run: ollama pull x');
    expect(view.el.textContent).not.toContain('ai:{');
    view.unmount();
  });
});
