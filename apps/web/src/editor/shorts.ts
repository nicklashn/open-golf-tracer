'use client';

/**
 * "Make a short of every shot": one new vertical project per shot (built by @golf/compose's
 * `shortFor`), each saved as its own copy of the project.
 */
import { shortFor } from '@golf/compose';
import { migrateProject } from '@golf/schema';
import { api } from '@/lib/api';
import { saveNow } from './autosave';
import { useEditor } from './store';

export { shortFor } from '@golf/compose';

export async function makeShorts(namePattern: (n: number) => string, locale: 'da' | 'en' = 'en'): Promise<number> {
  await saveNow(true);
  const s = useEditor.getState();
  const shots = s.doc.shots.filter((x) => x.visible && x.kind === 'full');
  let made = 0;
  for (const [i, shot] of shots.entries()) {
    const copy = await api<{ id: string }>(`/projects/${s.projectId}/duplicate`, { method: 'POST' });
    const loaded = await api<{ document: unknown; docVersion: number }>(`/projects/${copy.id}`);
    const doc = migrateProject(loaded.document);
    // The copy has its own media ids; find the shot by its position.
    const twin = doc.shots.find((x) => x.id === shot.id) ?? doc.shots[s.doc.shots.indexOf(shot)];
    if (!twin) continue;
    const short = shortFor(doc, twin, namePattern(i + 1), locale);
    const total = short.clips.reduce((a, c) => a + (c.kind === 'video' ? (c.out - c.in) / c.speed : c.duration), 0);
    short.layers = short.layers.map((l) => ({ ...l, end: Math.min(l.end, total) }));
    await api(`/projects/${copy.id}/document`, { method: 'PUT', body: { document: short, baseVersion: loaded.docVersion } });
    made++;
  }
  return made;
}
