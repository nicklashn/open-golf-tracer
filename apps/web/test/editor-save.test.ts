// @vitest-environment happy-dom
/**
 * Saving: a flush never overwrites another window's save, a rejected save says why and is not
 * retried forever, other tabs hear about a save, project caps block an edit with a reason, and
 * analysis shots beyond the cap are reported instead of vanishing.
 */
import { LIMITS } from '@golf/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';

const calls: { path: string; body?: Record<string, unknown> }[] = [];
let respond: (path: string, body?: Record<string, unknown>) => unknown = () => ({ docVersion: 2 });

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    api: async (path: string, opts?: { body?: Record<string, unknown> }) => {
      calls.push({ path, body: opts?.body });
      const r = respond(path, opts?.body);
      if (r instanceof Error) throw r;
      return r;
    },
  };
});

const { flush, onSavedElsewhere, saveNow, saveErrorOf, startAutosave } = await import('../src/editor/autosave');
const ops = await import('../src/editor/ops');
const { onLimitHit, useEditor } = await import('../src/editor/store');
const { bigRound } = await import('./helpers/bigRound');

const E = () => useEditor.getState();

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ docVersion: 2 });
  const { doc, media } = bigRound({ videos: 2, clipsPerVideo: 1, shotsPerClip: 2, layers: 1 });
  E().init({ projectId: 'p', doc, docVersion: 1, media });
});
afterEach(() => vi.useRealTimers());

describe('flush', () => {
  it('saves against the loaded version and never forces', async () => {
    ops.rename('Mine');
    expect(await flush()).toEqual({ ok: true });
    expect(calls[0].body).toMatchObject({ baseVersion: 1, force: false });
    expect(E().saveState).toBe('saved');
    expect(E().docVersion).toBe(2);
  });

  it('stops at a conflict and opens the dialog instead of overwriting', async () => {
    respond = () => new ApiError(409, 'version_conflict', 'changed');
    ops.rename('Mine');
    const r = await flush();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('conflict');
    expect(E().saveState).toBe('conflict');
    // While the conflict is open, a flush (export, "make a video") does not save at all.
    calls.length = 0;
    expect((await flush()).ok).toBe(false);
    expect(calls).toHaveLength(0);
    // "Keep mine" is the only overwrite.
    respond = () => ({ docVersion: 5 });
    expect((await saveNow(true)).ok).toBe(true);
    expect(calls[0].body).toMatchObject({ force: true });
  });

  it('says why a save was rejected and does not retry it until the next edit', async () => {
    vi.useFakeTimers();
    const stop = startAutosave();
    respond = () => new ApiError(422, 'invalid_document', 'invalid field', { path: 'shots', error: 'too long' });
    ops.rename('Mine');
    await flush();
    expect(E().saveState).toBe('error');
    expect(E().saveError).toMatchObject({ reason: 'invalid', path: 'shots' });
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(0);
    // The next edit tries again.
    respond = () => ({ docVersion: 3 });
    ops.rename('Mine 2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    expect(E().saveState).toBe('saved');
    expect(E().saveError).toBeNull();
    stop();
  });

  it('retries a passing failure with growing waits', async () => {
    vi.useFakeTimers();
    const stop = startAutosave();
    respond = () => new ApiError(0, 'network', 'offline');
    ops.rename('Mine');
    await flush();
    expect(E().saveError?.reason).toBe('network');
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1); // the next wait is 10 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    stop();
  });

  it('maps server errors to reasons', () => {
    expect(saveErrorOf(new ApiError(413, 'document_too_large', 'big'))).toMatchObject({ reason: 'too_large' });
    expect(saveErrorOf(new ApiError(422, 'unknown_media', 'x'))).toMatchObject({ reason: 'unknown_media' });
    expect(saveErrorOf(new ApiError(503, 'server_error', 'x'))).toMatchObject({ reason: 'server' });
    expect(saveErrorOf(new ApiError(409, 'version_conflict', 'x'))).toBe('conflict');
  });
});

describe('other tabs', () => {
  it('a tab without changes loads the newer save; one with changes gets the conflict dialog', async () => {
    const theirs = { ...E().doc, name: 'Theirs' };
    respond = () => ({ document: theirs, docVersion: 4, media: [] });
    E().select({ kind: 'shot', id: E().doc.shots[1].id });
    expect(await onSavedElsewhere({ type: 'saved', projectId: 'p', docVersion: 4, tab: 'other' })).toBe('reloaded');
    expect(E().doc.name).toBe('Theirs');
    expect(E().docVersion).toBe(4);
    expect(E().selection).not.toBeNull(); // the shot still exists
    ops.rename('Mine');
    expect(await onSavedElsewhere({ type: 'saved', projectId: 'p', docVersion: 5, tab: 'other' })).toBe('conflict');
    expect(E().saveState).toBe('conflict');
    expect(E().doc.name).toBe('Mine');
    // Another project's save is not ours.
    expect(await onSavedElsewhere({ type: 'saved', projectId: 'q', docVersion: 9, tab: 'other' })).toBeNull();
  });

  it('a save is announced on the BroadcastChannel', async () => {
    const heard: unknown[] = [];
    const other = new BroadcastChannel('ogt-documents');
    other.onmessage = (e) => heard.push(e.data);
    const stop = startAutosave();
    ops.rename('Mine');
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([expect.objectContaining({ type: 'saved', projectId: 'p', docVersion: 2 })]);
    stop();
    other.close();
  });
});

describe('project caps', () => {
  it('an edit past a cap is not made and the user is told', () => {
    const hits: unknown[] = [];
    onLimitHit((h) => hits.push(h));
    const base = E().doc.shots[0];
    E().silently((d) => {
      d.shots = Array.from({ length: LIMITS.shots }, (_, i) => ({ ...base, id: `s${i}` })) as typeof d.shots;
    });
    const before = E().doc;
    ops.insertShot({ ...base, id: 'one-too-many' });
    expect(E().doc).toBe(before);
    expect(hits).toEqual([{ what: 'shots', max: LIMITS.shots }]);
    // Edits that do not grow past the cap still work.
    ops.setShotVisible('s1', false);
    expect(E().doc.shots[1].visible).toBe(false);
    onLimitHit(null);
  });

  it('analysis shots beyond the cap are counted, not lost silently', () => {
    const base = E().doc.shots[0];
    const room = LIMITS.shots - E().doc.shots.length;
    const incoming = Array.from({ length: room + 3 }, (_, i) => ({ ...base, id: `n${i}` }));
    const r = ops.mergeServerShots(incoming);
    expect(r.added).toHaveLength(room);
    expect(r.dropped).toBe(3);
    expect(E().doc.shots).toHaveLength(LIMITS.shots);
    expect(E().past).toHaveLength(0); // a merge, not an undo step
  });

  it('a full round of 400 shots fits', () => {
    expect(LIMITS.shots).toBeGreaterThanOrEqual(400);
  });
});
