// @vitest-environment happy-dom
/**
 * Settings → About shows the version, PC and data folder, links the notices and the diagnostics
 * zip, and turns the update check off; the banner shows a newer release until it is dismissed.
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let update = { enabled: true, current: '0.5.4', latest: '0.6.0', url: 'https://github.com/nicklashn/open-golf-tracer/releases/tag/v0.6.0', newer: true };

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('@/lib/api', () => ({
  api: async (path: string, opts?: { method?: string; body?: { enabled: boolean } }) => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (path === '/about')
      return {
        version: '0.5.4',
        os: 'Windows 11 (10.0.26100, AMD64)',
        python: '3.12.10',
        inference: 'DirectML',
        providers: ['DmlExecutionProvider', 'CPUExecutionProvider'],
        gpus: ['NVIDIA GeForce RTX 5070'],
        ffmpeg: 'ffmpeg version 7.1.1-essentials_build-www.gyan.dev',
        dataDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Open Golf Tracer\\data',
        notices: true,
        canOpenFolder: true,
      };
    if (path === '/about/update' && opts?.method === 'PUT') {
      update = { ...update, enabled: opts.body!.enabled, newer: false };
      return update;
    }
    if (path === '/about/update') return update;
    if (path === '/about/open-data-folder') return { ok: true };
    throw new Error(path);
  },
  errorMessage: (e: unknown) => String(e),
}));

const { AboutSettings, UpdateBanner } = await import('@/components/app/AboutSettings');
const { mount } = await import('./helpers/render');

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('About', () => {
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    update = { enabled: true, current: '0.5.4', latest: '0.6.0', url: 'https://github.com/nicklashn/open-golf-tracer/releases/tag/v0.6.0', newer: true };
  });

  it('shows the version, PC, links and the update opt-out', async () => {
    const view = mount(<AboutSettings />);
    await flush();
    const text = view.el.textContent!;
    for (const s of ['0.5.4', 'Windows 11', 'DirectML (DmlExecutionProvider, CPUExecutionProvider)', 'RTX 5070', '7.1.1-essentials', 'Open Golf Tracer\\data'])
      expect(text).toContain(s);
    const links = [...view.el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/api/about/notices');
    expect(links).toContain('/api/about/diagnostics');
    expect(text).toContain('Version 0.6.0 is out.');

    const open = [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Open folder')!;
    await act(async () => open.click());
    expect(calls).toContain('POST /about/open-data-folder');

    await act(async () => (view.el.querySelector('[role="switch"]') as HTMLElement).click());
    await flush();
    expect(calls).toContain('PUT /about/update');
    expect(view.el.textContent).not.toContain('Version 0.6.0 is out.');
    view.unmount();
  });

  it('banner shows a newer version until it is dismissed', async () => {
    let view = mount(<UpdateBanner />);
    await flush();
    expect(view.el.textContent).toContain('Version 0.6.0 is out.');
    expect(view.el.querySelector('a')!.getAttribute('href')).toBe(update.url);
    await act(async () => (view.el.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click());
    expect(view.el.textContent).toBe('');
    view.unmount();

    view = mount(<UpdateBanner />);
    await flush();
    expect(view.el.textContent).toBe(''); // the same version stays dismissed
    view.unmount();

    update = { ...update, latest: '0.7.0' };
    view = mount(<UpdateBanner />);
    await flush();
    expect(view.el.textContent).toContain('Version 0.7.0 is out.');
    view.unmount();
  });

  it('banner stays away when there is nothing newer', async () => {
    update = { ...update, newer: false };
    const view = mount(<UpdateBanner />);
    await flush();
    expect(view.el.textContent).toBe('');
    view.unmount();
  });
});
