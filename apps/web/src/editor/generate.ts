'use client';

/**
 * "Make a video" in the editor: the edits are built by @golf/compose; this saves the current
 * project, copies it and stores the generated edit in the copy.
 */
import { highlightShort, youtubeVideo, type LayerNames, type VideoKind } from '@golf/compose';
import { migrateProject } from '@golf/schema';
import { api } from '@/lib/api';
import { saveNow } from './autosave';
import { useEditor } from './store';

export { highlightShort, playedShots, youtubeVideo, type LayerNames, type VideoKind } from '@golf/compose';

type Locale = 'da' | 'en';

/**
 * Builds the video as a new project next to the current one and returns its id. The copy
 * gets its own media ids, so shots are matched by position.
 */
export async function makeVideo(kind: VideoKind, name: string, locale: Locale, layerNames: LayerNames = {}): Promise<string> {
  await saveNow(true);
  const s = useEditor.getState();
  const copy = await api<{ id: string }>(`/projects/${s.projectId}/duplicate`, { method: 'POST' });
  const loaded = await api<{ document: unknown; docVersion: number }>(`/projects/${copy.id}`);
  const doc = migrateProject(loaded.document);
  const out = kind === 'youtube' ? youtubeVideo(doc, locale, name, layerNames) : highlightShort(doc, locale, name, layerNames);
  await api(`/projects/${copy.id}/document`, { method: 'PUT', body: { document: out, baseVersion: loaded.docVersion } });
  return copy.id;
}
