/**
 * Export worker: claims "export" jobs from the API's queue and renders them, and "compose"
 * jobs ("Make a video for me", see compose-job.ts).
 * npm run start -w @golf/exporter   (API_URL, INTERNAL_TOKEN or DATA_DIR/.internal-token)
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { InternalApi } from './api';
import { aiErrorJson } from '@golf/compose';
import { AiError, handleAiTest, handleCompose } from './compose-job';
import { handleExport } from './export-job';
import { Canceled } from './run';

const api = new InternalApi();
const worker = `${hostname()}-exporter-${process.pid}`;
let stopping = false;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', logger: 'golf.exporter', msg, ...extra }));
}

async function handle(job: { id: string; payload: Record<string, unknown> }): Promise<void> {
  const t0 = performance.now();
  const res = await handleExport(api, job);
  log('export done', {
    job: job.id,
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    frames: res.frames,
    overlay: res.overlay,
    overlayFrames: res.overlayFrames,
  });
}

/** One lane claims one kind of job at a time. Exports, video plans and "Test connection" run in
 *  separate lanes, so a long 4K export never holds up "Make a video for me", nor a video the test. */
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
        await api.fail(job.id, canceled ? 'Canceled by the user' : String(e instanceof Error ? e.message : e), !canceled);
      } catch (e2) {
        log('could not report the failure', { error: String(e2) });
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

/** The AI said no, or cannot be reached: the user has to change something, so no retry. The
 *  error is a code the apps put in the user's language (see `aiErrorJson`). */
async function aiFailed(job: { id: string }, e: unknown): Promise<boolean> {
  if (!(e instanceof AiError)) return false;
  log('ai failed', { job: job.id, code: e.code, error: e.message });
  await api.fail(job.id, aiErrorJson(e), false);
  return true;
}

log('exporter starter', { worker, api: api.base, lanes: ['export', 'compose', 'ai_test'] });
void lane(['export'], handle);
void lane(['compose'], async (job) => {
  try {
    const outcome = await handleCompose(api, job, log);
    if (outcome !== 'waiting') log(`video ${outcome}`, { job: job.id });
  } catch (e) {
    if (!(await aiFailed(job, e))) throw e;
  }
});
// "Test connection" has a lane of its own: it answers in seconds even while a video is planned.
void lane(['ai_test'], async (job) => {
  try {
    await handleAiTest(api, job);
  } catch (e) {
    if (!(await aiFailed(job, e))) throw e;
  }
});
