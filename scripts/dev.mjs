#!/usr/bin/env node
/**
 * Starts everything for local development with one command:
 *   API (FastAPI :8000) · media/analysis worker · exporter · web (Next.js :3000)
 * Usage: node scripts/dev.mjs [--prod] [--open] [--single] [--no-web] [--no-worker]
 *   --prod  serves the built web app (npm run build first), --open opens the browser when ready
 *   --single  (start.bat, the installed app) when this copy is already running, only open the
 *           browser; when another program holds :3000 or :8000, use free ports instead
 *   OGT_NO_BROWSER=1 leaves the browser closed even with --open (CI smoke tests)
 *
 * There is no login, so everything listens on 127.0.0.1 only. LISTEN_HOST (environment or .env)
 * opens the web app to the network on purpose, e.g. LISTEN_HOST=0.0.0.0 – see the README.
 * The API always stays on 127.0.0.1; the web app proxies /api to it.
 * API_PORT / WEB_PORT (environment) move the API and the web app off :8000 / :3000, e.g. to run a
 * second copy beside the first; the web app, worker and exporter then talk to that API.
 * The ports in use are written to <data>/ports.json, see scripts/launcher.mjs.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answers, choosePorts, clearState, findRunning, upToDate, writeState } from './launcher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';
// .venv (setup.bat/setup.sh), else the Windows installer's bundled Python, else the system one.
const py =
  [resolve(root, '.venv', win ? 'Scripts/python.exe' : 'bin/python'), resolve(root, 'runtime/python/python.exe')].find(existsSync) ??
  (win ? 'python' : 'python3');
const npm = win ? 'npm.cmd' : 'npm';
const prod = args.has('--prod');

/** A key from the environment, else from .env.local / .env (only the keys asked for are read). */
function setting(key) {
  if (process.env[key]) return process.env[key].trim();
  for (const f of ['.env.local', '.env']) {
    try {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'#\\r\\n]*?)["']?\\s*(#.*)?$`, 'm').exec(readFileSync(resolve(root, f), 'utf8'));
      if (m && m[1]) return m[1];
    } catch {
      /* no such file */
    }
  }
  return '';
}
const host = setting('LISTEN_HOST') || '127.0.0.1';
// The API's data folder (DATA_DIR is relative to apps/api, where the API runs), for ports.json.
const dataDir = resolve(root, 'apps/api', setting('DATA_DIR') || '../../data');
const single = args.has('--single');
const openBrowser = args.has('--open') && !process.env.OGT_NO_BROWSER;
let apiPort = Number(process.env.API_PORT || 8000);
let webPort = Number(process.env.WEB_PORT || 3000);

function openUrl(url) {
  if (!openBrowser) return;
  if (win) spawn('cmd', ['/c', 'start', '', url], { detached: true });
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {});
}

if (single) {
  const running = await findRunning(dataDir, { api: apiPort, web: webPort });
  if (running) {
    console.log(`\n  Open Golf Tracer is already running at http://localhost:${running.web} - opening it in the browser.`);
    console.log(`  Open Golf Tracer kører allerede på http://localhost:${running.web} - den åbnes i browseren.\n`);
    openUrl(`http://localhost:${running.web}`);
    process.exit(0);
  }
  const ports = await choosePorts({ api: apiPort, web: webPort, apiFixed: !!process.env.API_PORT, webFixed: !!process.env.WEB_PORT, host });
  for (const m of ports.moved) {
    console.log(`  Port ${m.from} is used by another program, so Open Golf Tracer uses port ${m.to} instead.`);
    console.log(`  Port ${m.from} bruges af et andet program, så Open Golf Tracer bruger port ${m.to} i stedet.`);
  }
  ({ api: apiPort, web: webPort } = ports);
}
for (const [port, name, skip] of [
  [apiPort, 'API_PORT', false],
  [webPort, 'WEB_PORT', args.has('--no-web')],
]) {
  if (skip || !(await answers(port))) continue;
  console.error(`\n  Port ${port} is already in use - is Open Golf Tracer already running? Close it, or start with ${name}=<another port>.`);
  console.error(`  Port ${port} er allerede i brug - kører Open Golf Tracer allerede? Luk den, eller start med ${name}=<en anden port>.\n`);
  process.exit(1);
}
const apiUrl = `http://127.0.0.1:${apiPort}`;
// The web proxy, worker and exporter find the API by API_URL (default :8000).
if (apiPort !== 8000) process.env.API_URL ??= apiUrl;

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
process.on('SIGHUP', () => shutdown(0)); // Windows: the console window is being closed
process.on('exit', () => clearState(dataDir, process.pid));

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

const reload = prod ? [] : ['--reload', '--reload-dir', 'golf_api'];
run('api', py, ['-m', 'uvicorn', 'golf_api.main:app', '--host', '127.0.0.1', '--port', String(apiPort), ...reload], {
  cwd: resolve(root, 'apps/api'),
  critical: true,
});
const ok = await waitForApi(`${apiUrl}/api/health`);
if (!ok) {
  console.error('API’et startede ikke. Se loggen ovenfor.');
  shutdown(1);
} else {
  writeState(dataDir, { web: webPort, api: apiPort, pid: process.pid });
  // --prod runs what the builds made (npm run build; the installer also bundles the exporter):
  // plain node, without tsx or Next's compilers, which the installed app does not ship.
  const exporterDist = resolve(root, 'apps/exporter/dist/main.mjs');
  // Only a bundle newer than its sources: a stale one would export with old code.
  const exporterBuilt = prod && upToDate(exporterDist, [resolve(root, 'apps/exporter/src'), resolve(root, 'packages')]);
  const standalone = resolve(root, 'apps/web/.next/standalone/apps/web');
  if (!args.has('--no-worker')) {
    run('worker', py, ['-m', 'golf_worker'], { cwd: resolve(root, 'apps/worker') });
    if (exporterBuilt) run('exporter', process.execPath, [exporterDist], { cwd: resolve(root, 'apps/exporter') });
    else run('exporter', npm, ['run', 'start', '-w', '@golf/exporter']);
  }
  // The web scripts bind 127.0.0.1; a later -H wins, so LISTEN_HOST can widen it on purpose.
  const extra = [...(host === '127.0.0.1' ? [] : ['-H', host]), ...(webPort === 3000 ? [] : ['-p', String(webPort)])];
  const hostArgs = extra.length ? ['--', ...extra] : [];
  if (args.has('--no-web')) {
    /* API (and worker) only */
  } else if (prod && existsSync(resolve(standalone, 'server.js'))) {
    run('web', process.execPath, ['server.js'], { cwd: standalone, critical: true, env: { PORT: String(webPort), HOSTNAME: host } });
  } else {
    run('web', npm, ['run', prod ? 'start' : 'dev', '-w', '@golf/web', ...hostArgs], { critical: true });
  }
  console.log(`\n  Open Golf Tracer is running at \x1b[1mhttp://localhost:${webPort}\x1b[0m  (API: ${apiUrl}/api/docs)\n`);
  if (host !== '127.0.0.1') {
    console.log(`  \x1b[33mLISTEN_HOST=${host}: the web app is reachable from the network. There is no login –`);
    console.log('  only do this on a network you trust or behind your own auth proxy.\x1b[0m\n');
  }
  if (openBrowser && (await waitForApi(`http://127.0.0.1:${webPort}/`, 240))) openUrl(`http://localhost:${webPort}`);
}
