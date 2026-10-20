/* eslint-disable no-restricted-syntax -- Isolated fixture seeding and full database snapshots require SQL; this module is rehearsal-only. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { existsSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { orgContext } from '@package-broker/core/db/port';
import {
  blobStorageKey,
  createBlobStore,
  createBlobUploadAdmission,
  type Sha256,
} from '@package-broker/core/platform/blob';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from '../blob/filesystem.js';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';
import type { NodeBroker } from '../index.js';
import { startNode } from '../startup.js';
import {
  digest,
  failedChecks,
  ORIGIN,
  seedRecords,
  verifyRoutes,
  type SeededDeployment,
} from './fixture.test.support.js';
export type { SeededDeployment } from './fixture.test.support.js';

export interface DeploymentPaths {
  root: string;
  database: string;
  secrets: string;
  blobRoot: string;
  blobObject(orgId: string, sha256: string): string;
}
function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), basename(path));
}
export function deploymentPaths(root: string): DeploymentPaths {
  root = canonical(resolve(root));
  return {
    root,
    database: join(root, 'broker.sqlite'),
    secrets: join(root, 'secrets'),
    blobRoot: join(root, 'blobs'),
    blobObject: (org, sha) =>
      join(root, 'blobs', blobStorageKey(orgContext(org).orgId, sha as Sha256)),
  };
}
export class RestoreTargetNotEmptyError extends Error {
  override name = 'RestoreTargetNotEmptyError';
  constructor() {
    super('restore target is not empty');
  }
}
export class BackupIntegrityError extends Error {
  override name = 'BackupIntegrityError';
  constructor() {
    super('backup checksum or inventory mismatch');
  }
}
export interface BlobEntry {
  orgId: string;
  sha256: string;
  size: number;
  storageKey: string;
  mediaType: string;
}
export interface BackupManifest {
  database: string;
  keys: string[];
  keyChecksums: Record<string, string>;
  blobs: { sha256: string; size: number }[];
  objects: BlobEntry[];
  candidate: string;
  configuration: { publicUrl: string; storage: string };
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function candidateIdentity(): Promise<string> {
  const hash = createHash('sha256');
  for (const pkg of ['core', 'db-sqlite', 'runtime-node', 'runtime-cloudflare']) {
    const root = join(repository, 'packages', pkg, 'dist');
    const files = (await readdir(root, { recursive: true }))
      .filter(
        (path) =>
          path.endsWith('.js') &&
          !path.includes('.test.') &&
          !path.includes('testing/') &&
          !path.includes('restore-rehearsal/'),
      )
      .sort();
    if (!files.includes('index.js')) throw new Error('build candidate before rehearsal');
    for (const file of files) {
      hash.update(`${pkg}/${file}\0`);
      hash.update(await readFile(join(root, file)));
    }
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const candidate = `${revision}:sha256:${hash.digest('hex')}`;
  const pinned = process.env['PB_REHEARSAL_CANDIDATE'];
  if (pinned !== undefined && candidate !== pinned)
    throw new Error('candidate identity differs from pinned rehearsal candidate');
  return candidate;
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function nonempty(path: string) {
  return (await exists(path)) && (await readdir(path)).length > 0;
}
export async function assertEmptyTarget(paths: DeploymentPaths) {
  if (
    (await exists(paths.database)) ||
    (await exists(paths.database + '-wal')) ||
    (await exists(paths.database + '-shm')) ||
    (await exists(paths.database + '-journal')) ||
    (await nonempty(paths.secrets)) ||
    (await nonempty(paths.blobRoot))
  )
    throw new RestoreTargetNotEmptyError();
}
export async function inventory(paths: DeploymentPaths): Promise<BlobEntry[]> {
  const db = new Database(paths.database, { readonly: true, fileMustExist: true });
  try {
    const organizations = db
      .prepare('SELECT DISTINCT org_id AS orgId FROM blob ORDER BY org_id')
      .all() as { orgId: string }[];
    const query = db.prepare(
      'SELECT org_id AS orgId, sha256, size_bytes AS size, storage_key AS storageKey, media_type AS mediaType FROM blob WHERE org_id = ? AND deleted_at IS NULL ORDER BY sha256',
    );
    return organizations.flatMap(({ orgId }) => query.all(orgId) as BlobEntry[]);
  } finally {
    db.close();
  }
}
export async function checkInventory(paths: DeploymentPaths, objects?: BlobEntry[]) {
  const expected = objects ?? (await inventory(paths));
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const entry of expected) {
    const path = paths.blobObject(entry.orgId, entry.sha256);
    if (!(await exists(path))) {
      missing.push(entry.sha256);
      continue;
    }
    const bytes = await readFile(path);
    if (
      bytes.length !== entry.size ||
      digest(bytes) !== entry.sha256 ||
      !(await exists(path + '.media')) ||
      (await readFile(path + '.media', 'utf8')) !== entry.mediaType
    )
      corrupt.push(entry.sha256);
  }
  return { missing: [...new Set(missing)], corrupt: [...new Set(corrupt)] };
}
export async function seedDeployment(
  paths: DeploymentPaths,
  masterKey: string,
): Promise<SeededDeployment> {
  await assertEmptyTarget(paths);
  await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.secrets, 'master-key'), masterKey, { mode: 0o600, flag: 'wx' });
  const broker = await startDeployment(paths);
  const opened = openBetterSqliteExecutor(paths.database);
  try {
    const blob = createBlobStore(
      await openFilesystemByteStore({ root: paths.blobRoot }),
      createBlobRepository(opened.executor, { purgeLeaseSeconds: 900 }),
      { admission: createBlobUploadAdmission(), maxBytes: 1048576 },
    );
    const kernel = await broker.ready();
    const seeded = await seedRecords(
      opened.executor,
      blob,
      (request) => kernel.fetch(request),
      masterKey,
    );
    const response = await kernel.fetch(
      new Request(`${ORIGIN}${seeded.distPath}`, {
        headers: { authorization: `Bearer ${seeded.token}` },
      }),
    );
    if (
      response.status !== 200 ||
      digest(new Uint8Array(await response.arrayBuffer())) !== seeded.sha256
    )
      throw new Error(`production dist prerequisite failed (${String(response.status)})`);
    return seeded;
  } finally {
    await opened.close();
    await broker.close();
  }
}
export async function backupDeployment(
  paths: DeploymentPaths,
  directory: string,
): Promise<BackupManifest> {
  await mkdir(directory, { mode: 0o700 });
  const target = deploymentPaths(directory);
  const db = new Database(paths.database, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target.database);
  } finally {
    db.close();
  }
  const objects = await inventory(target);
  const checked = await checkInventory(paths, objects);
  if (checked.missing.length || checked.corrupt.length) throw new BackupIntegrityError();
  await cp(paths.secrets, target.secrets, { recursive: true });
  await mkdir(target.blobRoot, { recursive: true });
  for (const object of objects) {
    const destination = target.blobObject(object.orgId, object.sha256);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(paths.blobObject(object.orgId, object.sha256), destination);
    await copyFile(
      paths.blobObject(object.orgId, object.sha256) + '.media',
      destination + '.media',
    );
  }
  const keys = (await readdir(target.secrets)).sort();
  const keyChecksums: Record<string, string> = {};
  for (const key of keys) keyChecksums[key] = digest(await readFile(join(target.secrets, key)));
  const unique = [
    ...new Map(objects.map(({ sha256, size }) => [sha256, { sha256, size }])).values(),
  ];
  const manifest: BackupManifest = {
    database: digest(await readFile(target.database)),
    keys,
    keyChecksums,
    blobs: unique,
    objects,
    candidate: await candidateIdentity(),
    configuration: { publicUrl: ORIGIN, storage: 'filesystem' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}
export async function destroyDeployment(paths: DeploymentPaths) {
  await rm(paths.root, { recursive: true, force: true });
}
export async function restoreDeployment(
  directory: string,
  target: DeploymentPaths,
  options: { masterKey?: string; skipKeys?: boolean; skipBlobs?: boolean } = {},
) {
  const started = performance.now();
  const source = deploymentPaths(directory);
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  await assertEmptyTarget(target);
  if (
    manifest.candidate !== (await candidateIdentity()) ||
    digest(await readFile(source.database)) !== manifest.database ||
    JSON.stringify(await inventory(source)) !== JSON.stringify(manifest.objects)
  )
    throw new BackupIntegrityError();
  for (const key of manifest.keys)
    if (digest(await readFile(join(source.secrets, key))) !== manifest.keyChecksums[key])
      throw new BackupIntegrityError();
  const checked = await checkInventory(source, manifest.objects);
  if (checked.missing.length || checked.corrupt.length) throw new BackupIntegrityError();
  await mkdir(target.root, { recursive: true, mode: 0o700 });
  const reservation = join(target.root, '.restore-reservation');
  await mkdir(reservation);
  try {
    await assertEmptyTarget(target);
    await copyFile(source.database, target.database);
    if (!options.skipKeys) {
      await cp(source.secrets, target.secrets, { recursive: true });
      if (options.masterKey !== undefined)
        await writeFile(join(target.secrets, 'master-key'), options.masterKey, { mode: 0o600 });
    }
    if (!options.skipBlobs) await cp(source.blobRoot, target.blobRoot, { recursive: true });
    const result = await checkInventory(target, manifest.objects);
    return {
      missingBlobs: result.missing,
      corruptBlobs: result.corrupt,
      durationMs: performance.now() - started,
    };
  } finally {
    await rm(reservation, { recursive: true });
  }
}
const ports: PlatformPortConfig = {
  blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1048576 },
  cache: { adapter: 'lru' },
  jobs: { adapter: 'database', maxRunning: 1 },
  observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
};
export async function startDeployment(
  paths: DeploymentPaths,
  ..._context: [SeededDeployment?]
): Promise<NodeBroker> {
  const keyPath = join(paths.secrets, 'master-key');
  void _context;
  return startNode({
    plugins: [],
    migrations: await discoveredMigrations(),
    env: {
      PB_SQLITE_PATH: paths.database,
      PB_PUBLIC_URL: ORIGIN,
      PB_BLOB_ROOT: paths.blobRoot,
      DEPLOYMENT_ID: 'restore-rehearsal',
      PB_MASTER_KEY_FILE: keyPath,
    },
    platformPorts: ports,
    stdout: { write: () => true, on: () => undefined },
    stderr: { write: () => true, on: () => undefined },
  });
}
export async function verifyDeployment(paths: DeploymentPaths, seeded: SeededDeployment) {
  const start = performance.now();
  let broker: NodeBroker;
  try {
    broker = await startDeployment(paths, seeded);
  } catch (error) {
    return {
      started: false,
      startFailure: (error as Error).name,
      startDurationMs: performance.now() - start,
      checks: failedChecks(),
      downloadSha256: '',
      download: { status: 0, completeBody: false },
      blobs: await checkInventory(paths),
      foreignStatus: 0,
      unauthenticatedStatus: 0,
    };
  }
  const startDurationMs = performance.now() - start;
  try {
    const kernel = await broker.ready();
    const result = await verifyRoutes((request) => kernel.fetch(request), seeded);
    return {
      started: true,
      startFailure: '',
      startDurationMs,
      ...result,
      blobs: await checkInventory(paths),
    };
  } finally {
    await broker.close();
  }
}
