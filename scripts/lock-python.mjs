#!/usr/bin/env node
/**
 * Regenerates the Python lock files from the requirements*.txt files, with hashes, for every
 * platform at once (onnxruntime-directml on Windows, onnxruntime elsewhere):
 *   requirements-lock.txt      what the Windows installer ships (build.ps1 installs it with --require-hashes)
 *   requirements-dev-lock.txt  the same pins plus the test tools, for CI and contributors
 * Needs uv (https://docs.astral.sh/uv/). Usage: npm run lock:py [-- --upgrade | --upgrade-package numpy]
 * Without --upgrade the pins already in the lock files are kept where they still fit.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);
const common = ['pip', 'compile', '--universal', '--python-version', '3.12', '--generate-hashes', '--custom-compile-command', 'npm run lock:py', '--quiet'];

function uv(args) {
  const r = spawnSync('uv', [...common, ...args, ...extra], { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error('uv was not found: https://docs.astral.sh/uv/getting-started/installation/');
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

uv(['apps/worker/requirements.txt', '-o', 'requirements-lock.txt']);
// The dev lock is held to the runtime pins, so CI tests exactly the versions that ship.
uv(['apps/worker/requirements.txt', 'requirements-dev.txt', '-c', 'requirements-lock.txt', '-o', 'requirements-dev-lock.txt']);
