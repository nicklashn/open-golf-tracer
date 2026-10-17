// @vitest-environment happy-dom
/**
 * Settings → Performance: an Optimise started before the page opened is followed again (with
 * a Stop button), and "Details" shows each step with the error of a failed one.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let jobStatus = 'running';
/** NVIDIA cards are named by nvidia-smi; AMD/Intel run DirectML without a name. */
let nvidia = true;

const trials = [
  { kind: 'detector', sessions: 1, batch: 1, callers: 1, fps: 24.3, vram_mb: 1766, error: null, provider: 'DmlExecutionProvider' },
  {
    kind: 'detector',
    sessions: 1,
    batch: 1,
    callers: 2,
    fps: null,
    vram_mb: null,
    error: 'RuntimeException: DmlFusedNode_7_11 failed',
    provider: 'DmlExecutionProvider',
  },
  { kind: 'decode', sessions: 0, batch: 0, callers: 2, fps: 410, vram_mb: null, error: null },
];
const perf = (profile: string) => ({
  profile,
  effective: { analyses: 2, ingests: 4, sessions: 1, batch: 1, threads: 0, gpu: true },
  profiles: { balanced: { analyses: 1, ingests: 2, sessions: 1, batch: 1, threads: 0, gpu: true } },
  tuned: { summary: { speedup: 1.6, inference: 'DirectML', gpu: 'RTX 5070', vramMb: 12227, stop: 'error', trials }, at: '2026-10-17T08:00:00Z' },
  fallback: null,
  cpuOnly: false,
  ingestFromEnv: false,
  hardware: {
    cpuCores: 28,
    ram: { totalMb: 16000, availableMb: 9000 },
    gpus: nvidia ? [{ name: 'RTX 5070', vramMb: 12227, usedMb: 900 }] : [],
    inference: 'DirectML',
  },
});
const job = () => ({ id: 'job_t', kind: 'tune', status: jobStatus, progress: 0.3, message: 'Testing', error: '', result: {} });

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('@/lib/api', () => ({
  api: async (path: string, opts?: { method?: string }) => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (path.startsWith('/performance')) return perf('tuned');
    if (path.startsWith('/jobs?active=true')) return { jobs: [job()] };
    if (path === '/jobs') return { jobs: [job()] };
    if (path === '/jobs/job_t/cancel') return job();
    throw new Error(path);
  },
  errorMessage: (e: unknown) => String(e),
}));

const { PerformanceSettings } = await import('@/components/app/PerformanceSettings');
const { mount } = await import('./helpers/render');

describe('PerformanceSettings', () => {
  afterEach(() => vi.useRealTimers());

  it('follows a running Optimise and shows the steps it tried', async () => {
    vi.useFakeTimers();
    const view = mount(<PerformanceSettings />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const stop = [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Stop');
    expect(stop).toBeTruthy();
    await act(async () => {
      stop!.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toContain('POST /jobs/job_t/cancel');

    jobStatus = 'succeeded';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(calls).toContain('GET /performance?refresh=true');
    expect([...view.el.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(false);
    const details = view.el.querySelector('[data-testid="perf-details"]');
    expect(details?.textContent).toContain('24.3 frames/s');
    expect(details?.textContent).toContain('DmlFusedNode_7_11');
    expect(details?.textContent).toContain('2 video(s) decoded at once');
    view.unmount();
  });

  it('names the graphics card the ball search uses, also without NVIDIA (DirectML)', async () => {
    nvidia = false;
    jobStatus = 'succeeded';
    const view = mount(<PerformanceSettings />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(view.el.querySelector('[data-testid="perf-gpu"]')?.textContent).toBe('Graphics card: RTX 5070 (DirectML)');
    view.unmount();
    nvidia = true;
  });
});
