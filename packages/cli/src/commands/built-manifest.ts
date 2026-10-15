import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';

export class BuiltManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltManifestError';
  }
}

interface ManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly phase: 'expand' | 'contract';
  readonly owner: string;
}

const ID = /^([a-z0-9-]+):(\d{4}_[a-z0-9_]+)$/;
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

function describeEntry(raw: unknown, index: number): string {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? `entry ${index} (${JSON.stringify(id)})` : `entry ${index}`;
}

function parseEntry(raw: unknown, index: number): ManifestEntry {
  const label = describeEntry(raw, index);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BuiltManifestError(`${label}: must be an object`);
  }
  const { id, name, checksum, phase } = raw as Record<string, unknown>;
  if (typeof id !== 'string') throw new BuiltManifestError(`${label}: id must be a string`);
  if (typeof name !== 'string') throw new BuiltManifestError(`${label}: name must be a string`);
  if (typeof checksum !== 'string') {
    throw new BuiltManifestError(`${label}: checksum must be a string`);
  }
  if (phase !== 'expand' && phase !== 'contract') {
    throw new BuiltManifestError(`${label}: phase must be "expand" or "contract"`);
  }
  const idMatch = ID.exec(id);
  if (idMatch === null) throw new BuiltManifestError(`${label}: invalid id`);
  if (!NAME.test(name)) throw new BuiltManifestError(`${label}: invalid name`);
  if (!CHECKSUM.test(checksum)) {
    throw new BuiltManifestError(`${label}: checksum must be 64 lowercase hex characters`);
  }
  const owner = idMatch[1] as string;
  if (id !== `${owner}:${name.slice(0, -'.sql'.length)}`) {
    throw new BuiltManifestError(`${label}: id does not match name`);
  }
  return { id, name, checksum, phase, owner };
}

async function readManifest(outDir: string): Promise<unknown[]> {
  const path = resolve(outDir, 'generated', 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new BuiltManifestError(
      `cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BuiltManifestError('manifest must be an object');
  }
  const { schemaVersion, migrations } = parsed as Record<string, unknown>;
  if (schemaVersion !== 1) throw new BuiltManifestError('manifest schemaVersion must be 1');
  if (!Array.isArray(migrations))
    throw new BuiltManifestError('manifest migrations must be an array');
  return migrations;
}

async function loadEntry(
  root: string,
  entry: ManifestEntry,
  label: string,
): Promise<MigrationSource> {
  const path = resolve(root, entry.owner, entry.name);
  if (!path.startsWith(root + sep)) {
    throw new BuiltManifestError(`${label}: path escapes the migrations directory`);
  }
  let source: MigrationSource;
  try {
    source = await loadMigrationSource(entry.owner, entry.name, await readFile(path, 'utf8'));
  } catch (error) {
    throw new BuiltManifestError(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (source.checksum !== entry.checksum) {
    throw new BuiltManifestError(`${label}: checksum does not match the file`);
  }
  if (source.phase !== entry.phase) {
    throw new BuiltManifestError(`${label}: phase does not match the file`);
  }
  return source;
}

export async function loadBuiltMigrations(outDir: string): Promise<MigrationSource[]> {
  const rawEntries = await readManifest(outDir);
  const root = resolve(outDir, 'migrations');
  const seen = new Set<string>();
  const owners: string[] = [];
  const sources: MigrationSource[] = [];

  for (const [index, raw] of rawEntries.entries()) {
    const entry = parseEntry(raw, index);
    const label = describeEntry(raw, index);
    if (seen.has(entry.id)) throw new BuiltManifestError(`${label}: duplicate id`);
    seen.add(entry.id);
    if (!owners.includes(entry.owner)) owners.push(entry.owner);
    sources.push(await loadEntry(root, entry, label));
  }

  try {
    return await planMigrations(sources, owners);
  } catch (error) {
    throw new BuiltManifestError(error instanceof Error ? error.message : String(error));
  }
}
