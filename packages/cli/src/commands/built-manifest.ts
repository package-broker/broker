import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { diagnoseRoutes } from '../manifest.js';
import type { DiagnosticRoute } from '@package-broker/core/authz/catalogue-diagnostics';
import type { PackageRouteBinding, RouteBoundary } from '@package-broker/core/plugin';
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

export class LegacyRouteTableError extends BuiltManifestError {
  constructor() {
    super('manifest route table predates route boundaries; run pb build again');
    this.name = 'LegacyRouteTableError';
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

const PACKAGE_PLACEHOLDER: PackageRouteBinding = { ecosystem: 'composer', name: () => null };

function parseRoute(raw: unknown, index: number): DiagnosticRoute {
  const label = `route ${index}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BuiltManifestError(`${label}: must be an object`);
  }
  const { method, path, plugin, permission, boundary, needsOrg } = raw as Record<string, unknown>;
  const flag = (raw as Record<string, unknown>).package;
  if (typeof method !== 'string') throw new BuiltManifestError(`${label}: method must be a string`);
  if (typeof path !== 'string') throw new BuiltManifestError(`${label}: path must be a string`);
  if (typeof plugin !== 'string') throw new BuiltManifestError(`${label}: plugin must be a string`);
  if (permission !== null && typeof permission !== 'string') {
    throw new BuiltManifestError(`${label}: permission must be a string or null`);
  }
  if (boundary !== undefined && typeof boundary !== 'string') {
    throw new BuiltManifestError(`${label}: boundary must be a string`);
  }
  if (needsOrg !== undefined && typeof needsOrg !== 'boolean') {
    throw new BuiltManifestError(`${label}: needsOrg must be a boolean`);
  }
  if (flag !== undefined && flag !== true) {
    throw new BuiltManifestError(`${label}: package must be true when present`);
  }
  return {
    method: method as DiagnosticRoute['method'],
    path,
    plugin,
    permission,
    handler: () => new Response(null),
    ...(boundary === undefined ? {} : { boundary: boundary as RouteBoundary }),
    ...(needsOrg === undefined ? {} : { needsOrg }),
    ...(flag === true ? { package: PACKAGE_PLACEHOLDER } : {}),
  };
}

export async function loadBuiltRoutes(outDir: string): Promise<DiagnosticRoute[] | null> {
  const path = resolve(outDir, 'generated', 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new BuiltManifestError(
      `cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const routes = (parsed as { routes?: unknown } | null)?.routes;
  if (routes === undefined) return null;
  if (!Array.isArray(routes)) throw new BuiltManifestError('manifest routes must be an array');
  const entries = routes.map((raw, index) => parseRoute(raw, index));
  if (entries.some((route) => route.permission !== null && route.boundary === undefined)) {
    throw new LegacyRouteTableError();
  }
  return entries;
}

export async function builtRouteProblems(outDir: string): Promise<string[] | null> {
  const routes = await loadBuiltRoutes(outDir);
  return routes === null ? null : diagnoseRoutes(routes);
}

export async function routesAreValid(outDir: string): Promise<boolean> {
  let problems: string[] | null;
  try {
    problems = await builtRouteProblems(outDir);
  } catch (error) {
    if (!(error instanceof LegacyRouteTableError)) throw error;
    console.error(`error: ${error.message}`);
    return false;
  }
  if (problems === null) {
    console.error('warning: manifest has no route table; route permissions were not checked');
    return true;
  }
  for (const problem of problems) console.error(`error: ${problem}`.replace(/[\r\n]+/g, ' '));
  return problems.length === 0;
}
