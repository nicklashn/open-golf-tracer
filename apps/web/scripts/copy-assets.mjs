// Copies shared assets (fonts for the renderer) into public/ before dev/build.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
mkdirSync(resolve(here, '../public/fonts'), { recursive: true });
cpSync(resolve(root, 'assets/fonts/static'), resolve(here, '../public/fonts'), { recursive: true });
