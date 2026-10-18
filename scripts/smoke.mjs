#!/usr/bin/env node
/**
 * Smoke test of a running app (CI: the Windows job and the installed app in the release workflow).
 * Usage: node scripts/smoke.mjs --data <data folder> [--analyze] [--timeout 900]
 *   Waits for <data>/ports.json (written by scripts/dev.mjs), checks /api/health on the API and
 *   through the web app, and with --analyze runs the analysis of the bundled demo clip once.
 * Exits non-zero with the reason when something is wrong.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const dataDir = opt('--data');
const timeoutS = Number(opt('--timeout', '900'));
if (!dataDir) {
  console.error('usage: node scripts/smoke.mjs --data <data folder> [--analyze] [--timeout 900]');
  process.exit(2);
}
const deadline = Date.now() + timeoutS * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) {
  console.error(`smoke: FAILED - ${msg}`);
  process.exit(1);
}

async function json(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${r.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** Retries `fn` until it returns something truthy or the deadline passes. */
async function until(what, fn, everyMs = 1000) {
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  fail(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

const ports = await until('ports.json', () => JSON.parse(readFileSync(join(dataDir, 'ports.json'), 'utf8')));
const api = `http://127.0.0.1:${ports.api}`;
const web = `http://127.0.0.1:${ports.web}`;
console.log(`smoke: web :${ports.web}, API :${ports.api}`);

const health = await until('the API', () => json(`${api}/api/health`));
if (health.app !== 'open-golf-tracer') fail(`/api/health is not this app: ${JSON.stringify(health)}`);
if (!health.ffmpeg || !health.ffprobe) fail(`ffmpeg/ffprobe not found: ${JSON.stringify(health)}`);
console.log(`smoke: API ok, version ${health.version}`);
const viaWeb = await until('the web app', () => json(`${web}/api/health`));
if (viaWeb.app !== 'open-golf-tracer') fail('the web app does not reach the API');
console.log('smoke: web app ok');

if (argv.includes('--analyze')) {
  const project = await json(`${api}/api/projects/demo?locale=en`, { method: 'POST' });
  const media = (await json(`${api}/api/projects/${project.id}`)).media.find((m) => m.kind === 'video');
  if (!media) fail('the demo project has no video');
  const job = await json(`${api}/api/projects/${project.id}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId: media.id }),
  });
  console.log(`smoke: analysing the demo clip (job ${job.id})`);
  let lastProgress = -1;
  const done = await until(
    'the analysis',
    async () => {
      const j = (await json(`${api}/api/jobs?project_id=${project.id}`)).jobs.find((x) => x.id === job.id);
      if (j && j.progress !== lastProgress) console.log(`smoke:   ${j.status} ${Math.round(j.progress * 100)}% ${j.message ?? ''}`);
      lastProgress = j?.progress ?? lastProgress;
      return j && ['succeeded', 'failed', 'canceled'].includes(j.status) ? j : null;
    },
    3000,
  );
  if (done.status !== 'succeeded') fail(`analysis ${done.status}: ${done.error}`);
  // result.shots is what this run found (the demo project also ships a precomputed analysis).
  if (!done.result?.shots) fail(`the analysis found no shot in the demo clip: ${JSON.stringify(done.result)}`);
  console.log(`smoke: analysis ok, ${done.result.shots} shot(s) in ${done.result.seconds ?? '?'} s`);
}
console.log('smoke: all good');
