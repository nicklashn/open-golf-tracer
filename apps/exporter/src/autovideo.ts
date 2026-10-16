/**
 * "Make a video for me" from the command line:
 *
 *   npm run autovideo -- <folder|files…> [--preference "…"] [--kind youtube|highlight|shorts]
 *        [--answers answers.json] [--yes] [--export shorts|youtube1080|youtube4k|original]
 *        [--out folder] [--locale da|en] [--name "…"] [--api http://127.0.0.1:8000]
 *
 * Talks to the running app (there is no login), creates a project, uploads the
 * clips with the resumable upload API (they join the project in the order they were filmed),
 * waits for ingest and analysis, runs the compose job – asking its questions here, or answering
 * them with the defaults (--yes) or from a file – and optionally exports and downloads the result.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { itemPlace, reasonText, type PlanQuestion } from '@golf/compose';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm']);

interface Job {
  id: string;
  kind: string;
  status: string;
  progress: number;
  message: string;
  error: string;
  result: Record<string, unknown>;
}

/** The public API, as the browser uses it. The app has a single local user, so no session is needed. */
export class Client {
  constructor(readonly base: string) {}

  async raw(method: string, path: string, body?: BodyInit, type = 'application/json'): Promise<Response> {
    return fetch(`${this.base}${path}`, { method, body, headers: body !== undefined ? { 'content-type': type } : {} });
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, `/api${path}`, body === undefined ? undefined : JSON.stringify(body));
    if (!r.ok) {
      let msg = `${r.status}`;
      try {
        const j = (await r.json()) as { error?: { message?: string } };
        msg = j.error?.message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new Error(`${method} ${path}: ${msg}`);
    }
    return (await r.json()) as T;
  }
}

/** Video files of the arguments (folders are read one level deep), in file-name order. */
export function videoFiles(inputs: string[]): string[] {
  const out: string[] = [];
  for (const p of inputs.map((x) => resolve(x))) {
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
        if (VIDEO_EXT.has(extname(f).toLowerCase()) && !f.includes('_traced')) out.push(join(p, f));
    } else out.push(p);
  }
  return out;
}

interface UploadStatus {
  id: string;
  chunkSize: number;
  chunks: number;
  received: number[];
  status: string;
  mediaId: string | null;
}

/** Uploads one file in chunks; an interrupted run resumes from the chunks the server has. */
async function upload(c: Client, file: string, projectId: string, state: Record<string, string>, saveState: () => void): Promise<string> {
  const size = statSync(file).size;
  const key = `${projectId}:${file}:${size}:${statSync(file).mtimeMs}`;
  let up: UploadStatus | null = null;
  if (state[key]) up = await c.call<UploadStatus>('GET', `/uploads/${state[key]}`).catch(() => null);
  if (!up || up.status === 'failed') {
    up = await c.call<UploadStatus>('POST', '/uploads', { filename: basename(file), size, kind: 'video', projectId });
    state[key] = up.id;
    saveState();
  }
  if (up.status !== 'complete') {
    const have = new Set(up.received);
    const fh = await open(file, 'r');
    try {
      for (let i = 0; i < up.chunks; i++) {
        if (have.has(i)) continue;
        const len = Math.min(up.chunkSize, size - i * up.chunkSize);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, i * up.chunkSize);
        for (let attempt = 0; ; attempt++) {
          const r = await c.raw('PUT', `/api/uploads/${up.id}/chunks/${i}`, buf, 'application/octet-stream');
          if (r.ok) break;
          if (attempt >= 3) throw new Error(`Upload of ${basename(file)} failed (${r.status})`);
          await sleep(1000 * 2 ** attempt);
        }
        process.stderr.write(`\r  ${basename(file)} ${Math.round(((i + 1) / up.chunks) * 100)}%   `);
      }
    } finally {
      await fh.close();
    }
    process.stderr.write('\n');
  }
  const done = await c.call<{ media: { id: string } }>('POST', `/uploads/${up.id}/complete`);
  delete state[key];
  saveState();
  return done.media.id;
}

async function waitFor(c: Client, projectId: string, label: string, done: (jobs: Job[]) => boolean): Promise<Job[]> {
  for (;;) {
    const { jobs } = await c.call<{ jobs: Job[] }>('GET', `/jobs?project_id=${projectId}`);
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    process.stderr.write(`\r  ${label}: ${active.length ? active.map((j) => `${j.kind} ${Math.round(j.progress * 100)}%`).join(', ') : 'ready'}        `);
    if (done(jobs)) {
      process.stderr.write('\n');
      return jobs;
    }
    await sleep(1500);
  }
}

/** Shows the questions together; Enter keeps the default. When input ends (piped, no terminal)
 *  the remaining questions keep their defaults. */
async function ask(questions: PlanQuestion[], locale: 'da' | 'en'): Promise<Record<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let closed = false;
  const ended = new Promise<string>((done) =>
    rl.once('close', () => {
      closed = true;
      done('');
    }),
  );
  const answers: Record<string, string> = {};
  try {
    for (const [n, q] of questions.entries()) {
      process.stderr.write(`\n${n + 1}. ${q.text}\n`);
      for (const item of q.items ?? [])
        process.stderr.write(
          `   - ${itemPlace(item, locale)} (${item.clipName})${item.reasons.length ? `: ${item.reasons.map((r) => reasonText(r, locale, item)).join('; ')}` : ''}\n`,
        );
      q.options.forEach((o, i) => process.stderr.write(`   ${i + 1}) ${o.label}${o.id === q.default ? '  (default)' : ''}\n`));
      const a = closed ? '' : (await Promise.race([rl.question('   > '), ended])).trim();
      const pick = q.options[Number(a) - 1];
      answers[q.id] = pick ? pick.id : q.default;
    }
  } finally {
    rl.close();
  }
  return answers;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      preference: { type: 'string', default: '' },
      kind: { type: 'string' },
      answers: { type: 'string' },
      yes: { type: 'boolean', default: false },
      export: { type: 'string' },
      out: { type: 'string', default: '.' },
      locale: { type: 'string', default: 'en' },
      name: { type: 'string' },
      api: { type: 'string', default: process.env.API_URL ?? 'http://127.0.0.1:8000' },
    },
  });
  const files = videoFiles(positionals);
  if (!files.length) throw new Error('No videos given. Usage: npm run autovideo -- <folder|files…> [--yes]');
  const locale = values.locale === 'da' ? 'da' : 'en';
  const preference = [values.preference, values.kind ? `${values.kind === 'shorts' ? 'one short per shot' : values.kind}` : ''].filter(Boolean).join(', ');

  const c = new Client(values.api!.replace(/\/$/, ''));
  const stateFile = resolve(values.out!, '.autovideo-uploads.json');
  const state: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  mkdirSync(values.out!, { recursive: true });
  const saveState = () => writeFileSync(stateFile, JSON.stringify(state, null, 1));

  const name = values.name ?? `${basename(resolve(positionals[0]))} – auto`;
  const project = await c.call<{ id: string }>('POST', '/projects', { name });
  console.error(`Project ${project.id}: uploading ${files.length} clip(s)`);
  for (const f of files) await upload(c, f, project.id, state, saveState);
  const media = await waitFor(
    c,
    project.id,
    'Analysing',
    (jobs) => !jobs.some((j) => j.kind !== 'compose' && (j.status === 'queued' || j.status === 'running')),
  );
  for (const j of media.filter((x) => x.status === 'failed'))
    console.error(`  ! ${j.kind === 'analyze' ? 'Analysis' : 'Processing'} of a clip failed: ${j.error || 'unknown error'} – the video is made from the rest.`);

  const fileAnswers = values.answers ? (JSON.parse(readFileSync(values.answers, 'utf8')) as Record<string, string>) : null;
  let job = await c.call<Job>('POST', '/autovideo', { projectId: project.id, preference, locale, yes: values.yes, answers: fileAnswers });
  for (;;) {
    await sleep(1000);
    const { jobs } = await c.call<{ jobs: Job[] }>('GET', `/jobs?project_id=${project.id}`);
    job = jobs.find((j) => j.id === job.id) ?? job;
    process.stderr.write(`\r  Video: ${job.message} ${Math.round(job.progress * 100)}%      `);
    if (job.status === 'awaiting_answers') {
      const questions = (job.result.questions ?? []) as PlanQuestion[];
      const answers = await ask(questions, locale);
      job = await c.call<Job>('POST', `/jobs/${job.id}/answers`, { answers });
    } else if (job.status === 'failed' || job.status === 'canceled') throw new Error(`The video failed: ${job.error || job.status}`);
    else if (job.status === 'succeeded') break;
  }
  process.stderr.write('\n');
  const result = job.result as { projects: { id: string; name: string }[]; notes?: string[]; description?: string };
  for (const n of result.notes ?? []) console.error(`  · ${n}`);
  for (const p of result.projects) console.log(`${p.name}: ${values.api!.replace(':8000', ':3000')}/app/projects/${p.id}`);

  if (values.export) {
    for (const p of result.projects) {
      let e = await c.call<{ id: string; status: string; progress: number; url: string | null; error: string }>('POST', `/projects/${p.id}/exports`, {
        settings: { preset: values.export },
      });
      while (e.status !== 'succeeded') {
        if (e.status === 'failed' || e.status === 'canceled') throw new Error(`Export of ${p.name} failed: ${e.error || e.status}`);
        await sleep(1500);
        e = await c.call<typeof e>('GET', `/exports/${e.id}`);
        process.stderr.write(`\r  Export ${p.name}: ${Math.round(e.progress * 100)}%   `);
      }
      process.stderr.write('\n');
      const r = await c.raw('GET', e.url!.startsWith('http') ? new URL(e.url!).pathname + new URL(e.url!).search : e.url!);
      const file = join(values.out!, `${p.name.replace(/[\\/:*?"<>|]+/g, '-')}.mp4`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      console.log(`Saved ${file}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
