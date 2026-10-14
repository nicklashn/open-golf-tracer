/**
 * Exit code 1 when the web app must be (re)built: no build yet, or any web/package source is
 * newer than it (e.g. after `git pull`). start.bat uses this so it never serves a stale build.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildId = join(root, 'apps/web/.next/BUILD_ID');
if (!existsSync(buildId)) process.exit(1);
const built = statSync(buildId).mtimeMs;

const SOURCES = ['apps/web/src', 'apps/web/public', 'apps/web/next.config.ts', 'apps/web/package.json', 'packages', 'package-lock.json'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'test']);

function newer(path) {
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (st.isFile()) return st.mtimeMs > built;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    if (newer(join(path, e.name))) return true;
  }
  return false;
}

process.exit(SOURCES.some((s) => newer(join(root, s))) ? 1 : 0);
