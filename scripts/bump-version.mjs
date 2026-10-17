#!/usr/bin/env node
/**
 * Sets the product version: the root package.json (the single source - the API's /api/health and
 * docs read it, the release workflow checks the tag against it) and, so that nothing disagrees,
 * every workspace package and the exact @golf/* versions they depend on.
 * Usage: node scripts/bump-version.mjs 0.5.0   (then: npm install --package-lock-only --ignore-scripts)
 * The "Prepare release" workflow runs both.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch>, e.g. 0.5.0');
  process.exit(2);
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, j) => writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
const rootFile = resolve(root, 'package.json');
const pkg = read(rootFile);
pkg.version = version;
write(rootFile, pkg);
for (const ws of pkg.workspaces) {
  const file = resolve(root, ws, 'package.json');
  const j = read(file);
  j.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(j[field] ?? {})) if (name.startsWith('@golf/')) j[field][name] = version;
  }
  write(file, j);
}
console.log(`version ${version}: package.json and ${pkg.workspaces.length} workspaces`);
