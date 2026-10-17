/**
 * The "export" job: fetches the project's media from the API, renders the export in the
 * user's language and reports back. Kept apart from main.ts (the worker loop) so it can be
 * tested with a fake API.
 */
import type { InternalApi } from './api';
import type { MediaFile } from './plan';
import { runExport, type ExportJob, type ExportResult } from './run';

export type ExportApi = Pick<InternalApi, 'media' | 'exportStart' | 'exportDone' | 'complete' | 'progress'>;

export interface ExportPayload {
  export_id: string;
  document: { media?: Record<string, unknown>; layers?: { type: string; props: { mediaId?: string } }[]; audioTracks?: { mediaId: string }[] };
  settings: unknown;
  /** The user's UI language when the export was asked for (older jobs have none). */
  locale?: string;
}

export async function handleExport(
  api: ExportApi,
  job: { id: string; payload: Record<string, unknown> },
  run: (job: ExportJob) => Promise<ExportResult> = runExport,
): Promise<ExportResult> {
  const p = job.payload as unknown as ExportPayload;
  const ids = new Set<string>([...Object.keys(p.document.media ?? {}), ...(p.document.audioTracks ?? []).map((a) => a.mediaId)]);
  for (const l of p.document.layers ?? []) if (l.type === 'image' && l.props.mediaId) ids.add(l.props.mediaId);
  const media: Record<string, MediaFile> = {};
  for (const id of ids) {
    const m = await api.media(id);
    const pr = m.probe as Record<string, unknown>;
    media[id] = {
      id,
      path: m.path,
      width: Number(pr.width ?? 0),
      height: Number(pr.height ?? 0),
      fps: Number(pr.fps ?? 30),
      duration: Number(pr.duration ?? 0),
      hdr: Boolean(pr.hdr),
      hasAudio: Boolean(pr.hasAudio),
      color: (pr.color as Record<string, string>) ?? undefined,
    };
  }
  const { path } = await api.exportStart(p.export_id);
  const res = await run({
    document: p.document,
    settings: p.settings,
    media,
    output: path,
    locale: p.locale === 'da' ? 'da' : 'en',
    onProgress: async (f, message) => (await api.progress(job.id, f, message)).continue,
  });
  await api.exportDone(p.export_id, { width: res.width, height: res.height, duration: res.duration });
  await api.complete(job.id, { width: res.width, height: res.height, duration: res.duration, seconds: res.seconds, mixedHdr: res.mixedHdr });
  return res;
}
