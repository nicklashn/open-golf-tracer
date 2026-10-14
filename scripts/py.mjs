#!/usr/bin/env node
// Runs the project's Python (.venv) with the given arguments: node scripts/py.mjs -m pytest
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venv = resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const py = existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3';
process.exit(spawnSync(py, process.argv.slice(2), { stdio: 'inherit', cwd: root }).status ?? 1);
