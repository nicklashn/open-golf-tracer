// @vitest-environment happy-dom
/** Projects page: made videos under their round, search and sort; My videos: "Export all" batches. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));

const { groupProjects } = await import('@/components/app/Projects');
const { groupExports } = await import('@/components/app/ExportsList');

const p = (id: string, name: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  updatedAt,
  posterUrl: null,
  duration: 0,
  shots: 0,
  aspect: 'original',
  processing: [],
  isDemo: false,
  failed: false,
  ...extra,
});

describe('groupProjects', () => {
  const rows = [
    p('s1', 'Short 1', '2026-10-05', { sourceId: 'r1', runId: 'j1', aspect: '9:16' }),
    p('s2', 'Short 2', '2026-10-04', { sourceId: 'r1', runId: 'j1', aspect: '9:16' }),
    p('r1', 'Furesø – 2 Oct', '2026-10-02'),
    p('r2', 'Asserbo – 1 Oct', '2026-10-03'),
    p('o1', 'Orphan', '2026-10-01', { sourceId: 'gone', runId: 'j9' }),
  ];

  it('puts made videos under their round; the newest work in a group sorts it first', () => {
    const g = groupProjects(rows, '', 'newest', 'en');
    expect(g.map((x) => x.p.id)).toEqual(['r1', 'r2', 'o1']);
    expect(g[0].made.map((m) => m.id)).toEqual(['s1', 's2']);
  });

  it('sorts by name', () => {
    expect(groupProjects(rows, '', 'name', 'en').map((x) => x.p.id)).toEqual(['r2', 'r1', 'o1']);
  });

  it('search finds a round by its own name or by one of its videos', () => {
    expect(groupProjects(rows, 'asser', 'newest', 'en').map((x) => x.p.id)).toEqual(['r2']);
    const g = groupProjects(rows, 'short 2', 'newest', 'en');
    expect(g.map((x) => [x.p.id, x.made.map((m) => m.id)])).toEqual([['r1', ['s2']]]);
    expect(groupProjects(rows, 'nothing', 'newest', 'en')).toEqual([]);
  });
});

describe('groupExports', () => {
  const e = (id: string, batch?: string) => ({ id, settings: { preset: 'shorts' as const, batch } }) as never;
  it('keeps the order and gathers the videos exported together', () => {
    const items = groupExports([e('a', 'b1'), e('x'), e('b', 'b1'), e('c', 'b2')]);
    expect(items.map((i: { kind: string }) => i.kind)).toEqual(['batch', 'row', 'batch']);
    expect((items[0] as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
