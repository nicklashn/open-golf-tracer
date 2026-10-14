import { Project, SCHEMA_VERSION } from './project';

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** migrations[n] upgrades a version-n document to n+1. */
const migrations: Record<number, Migration> = {};

/** Upgrades any stored document to the current schema and fills defaults. */
export function migrateProject(raw: unknown): Project {
  let doc = (raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}) as Record<string, unknown>;
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : SCHEMA_VERSION;
  if (v > SCHEMA_VERSION) throw new Error(`Projektet er fra en nyere version (${v}).`);
  while (v < SCHEMA_VERSION) {
    const m = migrations[v];
    if (!m) throw new Error(`Mangler migrering fra version ${v}`);
    doc = m(doc);
    v += 1;
  }
  doc.schemaVersion = SCHEMA_VERSION;
  return Project.parse(doc);
}
