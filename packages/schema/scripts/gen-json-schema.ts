/** Writes JSON Schema files the Python API validates against: npm run gen:schema */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ExportSettings, Project } from '../src/project';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../json');
for (const [name, schema] of [
  ['project', Project],
  ['export-settings', ExportSettings],
] as const) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  writeFileSync(resolve(out, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote ${name}.schema.json`);
}
