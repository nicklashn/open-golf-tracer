/**
 * Export worker: claims "export" jobs from the API's queue and renders them, and "compose"
 * jobs ("Make a video for me", see compose-job.ts).
 * npm run start -w @golf/exporter   (API_URL, INTERNAL_TOKEN or DATA_DIR/.internal-token)
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { InternalApi } from './api';
import { AiError, handleAiTest, handleCompose } from './compose-job';
import { Canceled, runExport } from './run';
import type { MediaFile } from './plan';

const api = new InternalApi();
const worker = `${hostname()}-exporter-${process.pid}`;
let stopping = false;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', logger: 'golf.exporter', msg, ...extra }));
}

async function handle(job: { id: string; payload: Record<string, unknown> }): Promise<void> {
  const p = job.payload as {
    export_id: string;
    document: { media?: Record<string, unknown>; layers?: { type: string; props: { mediaId?: string } }[]; audioTracks?: { mediaId: string }[] };
    settings: unknown;
  };
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
  const t0 = performance.now();
  const res = await runExport({
    document: p.document,
    settings: p.settings,
    media,
    output: path,
    onProgress: async (f, message) => (await api.progress(job.id, f, message)).continue,
  });
  await api.exportDone(p.export_id, { width: res.width, height: res.height, duration: res.duration });
  await api.complete(job.id, { width: res.width, height: res.height, duration: res.duration, seconds: res.seconds });
  log('export done', { job: job.id, seconds: +((performance.now() - t0) / 1000).toFixed(1), frames: res.frames, overlay: res.overlay });
}

/** One lane claims one kind of job at a time. Exports and video plans run in separate lanes,
 *  so a long 4K export never holds up "Make a video for me". */
async function lane(kinds: string[], run: (job: { id: string; kind: string; payload: Record<string, unknown> }) => Promise<void>): Promise<void> {
  let idle = 500;
  while (!stopping) {
    let job: Awaited<ReturnType<InternalApi['claim']>>['job'] = null;
    try {
      job = (await api.claim(kinds, worker)).job;
    } catch (e) {
      log('cannot reach the API – retrying', { error: String(e) });
      await sleep(3000);
      continue;
    }
    if (!job) {
      await sleep(idle);
      idle = Math.min(2000, idle * 1.5);
      continue;
    }
    idle = 500;
    try {
      await run(job);
    } catch (e) {
      const canceled = e instanceof Canceled;
      log(canceled ? `${job.kind} canceled` : `${job.kind} failed`, { job: job.id, error: String(e) });
      try {
        await api.fail(job.id, canceled ? 'Annulleret af brugeren' : String(e instanceof Error ? e.message : e), !canceled);
      } catch (e2) {
        log('kunne ikke melde fejl', { error: String(e2) });
      }
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

log('exporter starter', { worker, api: api.base, lanes: ['export', 'compose'] });
void lane(['export'], handle);
void lane(['compose', 'ai_test'], async (job) => {
  try {
    if (job.kind === 'ai_test') return await handleAiTest(api, job);
    const outcome = await handleCompose(api, job, log);
    if (outcome !== 'waiting') log(`video ${outcome}`, { job: job.id });
  } catch (e) {
    // The AI said no, or cannot be reached: the user has to change something, so no retry.
    if (e instanceof AiError) {
      log('ai failed', { job: job.id, code: e.code, error: e.message });
      await api.fail(job.id, e.message, false);
      return;
    }
    throw e;
  }
});
