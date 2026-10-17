#!/usr/bin/env node
/**
 * Starts everything for local development with one command:
 *   API (FastAPI :8000) · media/analysis worker · exporter · web (Next.js :3000)
 * Usage: node scripts/dev.mjs [--prod] [--open] [--no-web] [--no-worker]
 *   --prod  serves the built web app (npm run build first), --open opens the browser when ready
 *
 * There is no login, so everything listens on 127.0.0.1 only. LISTEN_HOST (environment or .env)
 * opens the web app to the network on purpose, e.g. LISTEN_HOST=0.0.0.0 – see the README.
 * The API always stays on 127.0.0.1; the web app proxies /api to it.
 * API_PORT / WEB_PORT (environment) move the API and the web app off :8000 / :3000, e.g. to run a
 * second copy beside the first; the web app, worker and exporter then talk to that API.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';
// .venv (setup.bat/setup.sh), else the Windows installer's bundled Python, else the system one.
const py =
  [resolve(root, '.venv', win ? 'Scripts/python.exe' : 'bin/python'), resolve(root, 'runtime/python/python.exe')].find(existsSync) ??
  (win ? 'python' : 'python3');
const npm = win ? 'npm.cmd' : 'npm';
const prod = args.has('--prod');

/** LISTEN_HOST from the environment, else from .env.local / .env (only this one key is read). */
function listenHost() {
  if (process.env.LISTEN_HOST) return process.env.LISTEN_HOST.trim();
  for (const f of ['.env.local', '.env']) {
    try {
      const m = /^\s*LISTEN_HOST\s*=\s*["']?([^"'#\s]*)/m.exec(readFileSync(resolve(root, f), 'utf8'));
      if (m && m[1]) return m[1];
    } catch {
      /* no such file */
    }
  }
  return '127.0.0.1';
}
const host = listenHost();
const apiPort = process.env.API_PORT || '8000';
const webPort = process.env.WEB_PORT || '3000';
const apiUrl = `http://127.0.0.1:${apiPort}`;
// The web proxy, worker and exporter find the API by API_URL (default :8000).
if (apiPort !== '8000') process.env.API_URL ??= apiUrl;

const colors = { api: 36, worker: 35, exporter: 33, web: 32 };
const procs = [];

function run(name, cmd, cmdArgs, opts = {}) {
  const p = spawn(cmd, cmdArgs, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, PYTHONUNBUFFERED: '1', NEXT_TELEMETRY_DISABLED: '1', HF_HUB_DISABLE_TELEMETRY: '1', ...opts.env },
    shell: win && cmd === npm,
  });
  const tag = `\x1b[${colors[name]}m${name.padEnd(8)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    process.stdout.write(`${tag}stoppede (${code})\n`);
    if (!stopping && opts.critical) shutdown(1);
  });
  procs.push(p);
  return p;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    try {
      if (win) spawn('taskkill', ['/pid', String(p.pid), '/f', '/t']);
      else p.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForApi(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

run('api', py, ['-m', 'uvicorn', 'golf_api.main:app', '--host', '127.0.0.1', '--port', apiPort, ...(prod ? [] : ['--reload', '--reload-dir', 'golf_api'])], {
  cwd: resolve(root, 'apps/api'),
  critical: true,
});
const ok = await waitForApi(`${apiUrl}/api/health`);
if (!ok) {
  console.error('API’et startede ikke. Se loggen ovenfor.');
  shutdown(1);
} else {
  if (!args.has('--no-worker')) {
    run('worker', py, ['-m', 'golf_worker'], { cwd: resolve(root, 'apps/worker') });
    run('exporter', npm, ['run', 'start', '-w', '@golf/exporter']);
  }
  // The web scripts bind 127.0.0.1; a later -H wins, so LISTEN_HOST can widen it on purpose.
  const extra = [...(host === '127.0.0.1' ? [] : ['-H', host]), ...(webPort === '3000' ? [] : ['-p', webPort])];
  const hostArgs = extra.length ? ['--', ...extra] : [];
  if (!args.has('--no-web')) run('web', npm, ['run', prod ? 'start' : 'dev', '-w', '@golf/web', ...hostArgs], { critical: true });
  console.log(`\n  Open Golf Tracer is running at \x1b[1mhttp://localhost:${webPort}\x1b[0m  (API: ${apiUrl}/api/docs)\n`);
  if (host !== '127.0.0.1') {
    console.log(`  \x1b[33mLISTEN_HOST=${host}: the web app is reachable from the network. There is no login –`);
    console.log('  only do this on a network you trust or behind your own auth proxy.\x1b[0m\n');
  }
  if (args.has('--open') && (await waitForApi(`http://127.0.0.1:${webPort}/`, 240))) {
    const url = `http://localhost:${webPort}`;
    if (win) spawn('cmd', ['/c', 'start', '', url], { detached: true });
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {});
  }
}
