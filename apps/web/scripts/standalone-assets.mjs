// After next build: the standalone server (.next/standalone, see next.config.ts) serves
// .next/static and public/ only from its own folder, so they are copied there.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(web, '.next/standalone/apps/web');
if (!existsSync(resolve(out, 'server.js'))) throw new Error(`next build made no standalone server in ${out}`);
for (const [from, to] of [
  ['.next/static', '.next/static'],
  ['public', 'public'],
]) {
  rmSync(resolve(out, to), { recursive: true, force: true });
  cpSync(resolve(web, from), resolve(out, to), { recursive: true });
}
