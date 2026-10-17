/**
 * Helpers for scripts/dev.mjs: is a copy of the app already running, and which ports are free.
 *
 * While it runs, dev.mjs keeps two files in the data folder:
 *   ports.json  {"web":3000,"api":8000,"pid":1234} - a second start (the shortcut
 *               clicked twice) finds the running copy here, also on ports other than 3000/8000
 *   app.pid     the launcher's process id, for the Windows installer and uninstaller to close it
 * Both can be left behind when the window is closed; they only count while /api/health answers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

/** What /api/health calls itself, so another program on the port is not mistaken for this app. */
export const APP = 'open-golf-tracer';

/** True when something accepts connections on host:port. */
export function answers(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((done) => {
    const s = net.connect({ port, host });
    const end = (v) => {
      s.destroy();
      done(v);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

/** True when this process could listen on host:port. */
function canListen(port, host) {
  return new Promise((done) => {
    const srv = net.createServer();
    srv.once('error', () => done(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => done(true)));
  });
}

/** Free = nothing answers there (Windows lets a program bind 127.0.0.1 next to one on 0.0.0.0) and we may listen. */
export async function isFree(port, host = '127.0.0.1') {
  return !(await answers(port)) && (await canListen(port, host));
}

/** The first free port after `from` (a short search keeps the address easy to read), else any free one. */
export async function freePort(from, host = '127.0.0.1', avoid = []) {
  for (let p = from + 1; p <= Math.min(from + 20, 65535); p++) if (!avoid.includes(p) && (await isFree(p, host))) return p;
  return new Promise((done, fail) => {
    const srv = net.createServer();
    srv.once('error', fail);
    srv.listen({ port: 0, host }, () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

/** This app's /api/health on the port, or null (nothing there, or another program). */
export async function ourApi(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = r.ok ? await r.json() : null;
    return j && j.app === APP ? j : null;
  } catch {
    return null;
  }
}

export function readState(dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'ports.json'), 'utf8'));
    return Number.isInteger(s.api) && Number.isInteger(s.web) ? s : null;
  } catch {
    return null;
  }
}

export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ports.json'), JSON.stringify(state) + '\n');
  writeFileSync(join(dataDir, 'app.pid'), String(state.pid));
}

/** Removes the files, unless another launcher has written its own since. */
export function clearState(dataDir, pid) {
  if (readState(dataDir)?.pid !== pid) return;
  for (const f of ['ports.json', 'app.pid']) rmSync(join(dataDir, f), { force: true });
}

/** The running copy - the one in ports.json, or one on the usual ports - as {web, api, version}. */
export async function findRunning(dataDir, usual) {
  const saved = readState(dataDir);
  for (const c of [saved, usual]) {
    if (!c) continue;
    const health = await ourApi(c.api);
    if (health) return { web: c.web, api: c.api, version: health.version };
  }
  return null;
}

/**
 * The ports to start on. A port that was asked for (API_PORT / WEB_PORT) is kept as it is; a default
 * one that another program holds is swapped for a free one, reported in `moved`.
 */
export async function choosePorts({ api, web, apiFixed = false, webFixed = false, host = '127.0.0.1' }) {
  const moved = [];
  if (!apiFixed && !(await isFree(api))) {
    const to = await freePort(api, '127.0.0.1', [web]);
    moved.push({ what: 'api', from: api, to });
    api = to;
  }
  if (!webFixed && !(await isFree(web, host))) {
    const to = await freePort(web, host, [api]);
    moved.push({ what: 'web', from: web, to });
    web = to;
  }
  return { api, web, moved };
}

/** True when `file` exists and is newer than every file under `sources` (a bundle that is not stale). */
export function upToDate(file, sources) {
  if (!existsSync(file)) return false;
  const built = statSync(file).mtimeMs;
  const newer = (path) => {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    if (st.isFile()) return st.mtimeMs > built;
    return readdirSync(path, { withFileTypes: true }).some((e) => !['node_modules', 'dist', 'test'].includes(e.name) && newer(join(path, e.name)));
  };
  return !sources.some(newer);
}
