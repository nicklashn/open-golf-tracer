// @vitest-environment happy-dom
/** Restoring a version asks in the app (not the browser's confirm), saves without forcing and
 *  clears in/out points of the replaced timeline. */
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from './helpers/render';

const calls: { path: string; body?: Record<string, unknown> }[] = [];
let server: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    api: async (path: string, opts?: { body?: Record<string, unknown> }) => {
      calls.push({ path, body: opts?.body });
      if (path.endsWith('/versions'))
        return { versions: [{ id: 'v1', docVersion: 1, label: 'Before colours', auto: false, createdAt: new Date().toISOString(), shots: 1, layers: 0 }] };
      if (path.endsWith('/restore')) return { docVersion: 7, document: server };
      if (path.endsWith('/duplicate')) return { id: 'copy1' };
      return { docVersion: 3 };
    },
  };
});
const pushed: string[] = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push: (u: string) => pushed.push(u) }) }));

const { VersionsDialog } = await import('../src/editor/Dialogs');
const { useEditor } = await import('../src/editor/store');
const ops = await import('../src/editor/ops');
const { bigRound } = await import('./helpers/bigRound');
const E = () => useEditor.getState();

const flushAll = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

describe('version restore', () => {
  it('asks in an app dialog, saves first without forcing, resets in/out', async () => {
    const { doc, media } = bigRound({ videos: 1, clipsPerVideo: 2, shotsPerClip: 1, layers: 0 });
    E().init({ projectId: 'p', doc, docVersion: 1, media });
    server = { ...doc, name: 'Restored' };
    ops.rename('Unsaved');
    useEditor.setState({ inPoint: 2, outPoint: 5 });
    const confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy;
    const m = mount(<VersionsDialog open onOpenChange={() => undefined} />);
    await flushAll();
    act(() => button('Restore').click());
    await flushAll();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="restore-confirm"]')).not.toBeNull();
    act(() => (document.querySelector('[data-testid="restore-confirm"]') as HTMLButtonElement).click());
    await flushAll();
    const save = calls.find((c) => c.path === '/projects/p/document')!;
    expect(save.body).toMatchObject({ force: false });
    expect(calls.some((c) => c.path.endsWith('/restore'))).toBe(true);
    expect(E().doc.name).toBe('Restored');
    expect(E().docVersion).toBe(7);
    expect(E().inPoint).toBeNull();
    expect(E().outPoint).toBeNull();
    m.unmount();
  });
});

describe('conflict dialog', () => {
  it('"Save mine as a copy" keeps this window\'s document as a new project and opens it', async () => {
    const { ConflictDialog } = await import('../src/editor/Editor');
    const { doc, media } = bigRound({ videos: 1, clipsPerVideo: 1, shotsPerClip: 1, layers: 0 });
    E().init({ projectId: 'p', doc, docVersion: 1, media });
    ops.rename('Mine');
    useEditor.setState({ saveState: 'conflict' });
    calls.length = 0;
    const m = mount(<ConflictDialog />);
    await flushAll();
    expect(button('Keep mine')).toBeTruthy();
    expect(button('Load latest')).toBeTruthy();
    act(() => (document.querySelector('[data-testid="conflict-copy"]') as HTMLButtonElement).click());
    await flushAll();
    const dup = calls.find((c) => c.path === '/projects/p/duplicate')!;
    expect((dup.body!.document as { name: string }).name).toBe('Mine');
    expect(dup.body!.name).toBe('Mine (my copy)');
    expect(pushed).toEqual(['/app/projects/copy1']);
    expect(calls.some((c) => c.path === '/projects/p/document')).toBe(false); // theirs is not overwritten
    m.unmount();
  });
});
