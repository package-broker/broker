/* eslint-disable no-restricted-syntax -- Isolated fixture seeding and full database snapshots require SQL; this module is rehearsal-only. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createR2ByteStore, type R2BucketLike } from '../blob/r2.js';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import { createWorker, type Env } from '../index.js';
import {
  restoreDatabase,
  exportDatabase,
  type SnapshotStatement,
} from './sql-snapshot.test.support.js';
import {
  digest,
  failedChecks,
  ORIGIN,
  seedRecords,
  verifyRoutes,
  type SeededDeployment,
} from './fixture.test.support.js';
export type { SeededDeployment } from './fixture.test.support.js';

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
interface ObjectEntry {
  orgId: string;
  sha256: string;
  size: number;
  storageKey: string;
  mediaType: string;
}
interface ListBucket extends R2BucketLike {
  list(options?: {
    cursor?: string;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}
export interface Deployment {
  mf: Miniflare;
  raw: D1DatabaseLike;
  executor: SqlExecutor;
  bucket: ListBucket;
  secrets: Map<string, string>;
  restoring: boolean;
}
export interface Backup {
  database: string;
  keys: Record<string, string>;
  objects: ObjectEntry[];
  candidate: string;
  configuration: { publicUrl: string; storage: string };
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const candidatePackages = ['core', 'db-sqlite', 'runtime-node', 'runtime-cloudflare'];
export function rehearsalBuildAvailable(repositoryRoot = repository): boolean {
  return candidatePackages.every((pkg) =>
    existsSync(join(repositoryRoot, 'packages', pkg, 'dist', 'index.js')),
  );
}
export async function candidateIdentity(): Promise<string> {
  const hash = createHash('sha256');
  for (const pkg of candidatePackages) {
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
const ports: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1048576 },
  cache: { adapter: 'cache-api', namespace: 'restore-rehearsal' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 1 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};
export async function createDeployment(): Promise<Deployment> {
  const adapter = stripTypeScriptTypes(
    await readFile(join(repository, 'packages/runtime-cloudflare/src/blob/r2.ts'), 'utf8'),
  ).replaceAll("'@package-broker/core/platform/blob'", "'./blob.mjs'");
  const core = stripTypeScriptTypes(
    await readFile(join(repository, 'packages/core/src/platform/blob.ts'), 'utf8'),
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        {
          type: 'ESModule',
          path: 'worker.mjs',
          contents: `
import { createR2ByteStore } from './r2.mjs';
export default {
  async fetch(request, env) {
    const result = await createR2ByteStore(env.STORAGE).putVerified(
      request.headers.get('x-storage-key'),
      request.body,
      {
        sha256: request.headers.get('x-sha256'),
        size: Number(request.headers.get('content-length')),
        mediaType: request.headers.get('content-type'),
      },
    );
    return Response.json(result);
  },
};
`,
        },
        { type: 'ESModule', path: 'r2.mjs', contents: adapter },
        { type: 'ESModule', path: 'blob.mjs', contents: core },
      ],
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  try {
    const raw = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
    const bucket = (await mf.getR2Bucket('STORAGE')) as unknown as ListBucket;
    return {
      mf,
      raw,
      executor: createD1Executor(raw),
      bucket,
      secrets: new Map(),
      restoring: false,
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
export async function destroyDeployment(deployment: Deployment) {
  await deployment.mf.dispose();
  deployment.secrets.clear();
}
export async function startDeployment(deployment: Deployment) {
  const logs: string[] = [];
  const worker = createWorker([], {
    platformPorts: ports,
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      }),
    },
    log: (record) => {
      logs.push(JSON.stringify(record));
    },
    console: { log: () => undefined, error: () => undefined },
  });
  const env: Env = {
    DB: deployment.raw,
    STORAGE: deployment.bucket,
    JOBS: { send: async () => undefined, sendBatch: async () => undefined },
    DEPLOYMENT_ID: 'restore-rehearsal',
    PB_PUBLIC_URL: ORIGIN,
    ...Object.fromEntries(deployment.secrets),
  };
  return {
    fetch: async (request: Request) => {
      const pending: Promise<unknown>[] = [];
      const response = await worker.fetch(request, env, {
        waitUntil: (promise) => {
          pending.push(promise);
        },
      });
      while (pending.length) await Promise.all(pending.splice(0));
      return response;
    },
    logs,
  };
}
export async function seedDeployment(deployment: Deployment, masterKey: string) {
  await assertEmptyTarget(deployment);
  await migrate(deployment.executor, await discoveredMigrations(), { holder: 'restore-rehearsal' });
  deployment.secrets.set('PB_MASTER_KEY', masterKey);
  const runtime = await startDeployment(deployment);
  const blob = createBlobStore(
    {
      ...createR2ByteStore(deployment.bucket),
      async putVerified(storageKey, body, input) {
        const response = await deployment.mf.dispatchFetch('https://restore.test/put', {
          method: 'POST',
          headers: {
            'x-storage-key': storageKey,
            'x-sha256': input.sha256,
            'content-length': String(input.size),
            'content-type': input.mediaType,
          },
          body,
          duplex: 'half',
        });
        if (!response.ok) throw new Error('fixture blob seed refused');
        return (await response.json()) as { size: number; mediaType: string };
      },
    },
    createBlobRepository(deployment.executor, { purgeLeaseSeconds: 900 }),
    { admission: createBlobUploadAdmission(), maxBytes: 1048576 },
  );
  const seeded = await seedRecords(deployment.executor, blob, runtime.fetch, masterKey);
  const response = await runtime.fetch(
    new Request(`${ORIGIN}${seeded.distPath}`, {
      headers: { authorization: `Bearer ${seeded.token}` },
    }),
  );
  if (
    response.status !== 200 ||
    digest(new Uint8Array(await response.arrayBuffer())) !== seeded.sha256
  )
    throw new Error('production dist prerequisite failed');
  return seeded;
}
export async function inventory(deployment: Deployment) {
  const organizations = await deployment.executor.all<{ orgId: string }>({
    sql: 'SELECT DISTINCT org_id AS orgId FROM blob ORDER BY org_id',
    params: [],
  });
  const objects: ObjectEntry[] = [];
  for (const { orgId } of organizations)
    objects.push(
      ...(await deployment.executor.all<ObjectEntry>({
        sql: 'SELECT org_id AS orgId, sha256, size_bytes AS size, storage_key AS storageKey, media_type AS mediaType FROM blob WHERE org_id = ? AND deleted_at IS NULL ORDER BY sha256',
        params: [orgId],
      })),
    );
  return objects;
}
export async function checkInventory(deployment: Deployment, expected?: ObjectEntry[]) {
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const entry of expected ?? (await inventory(deployment))) {
    const object = await deployment.bucket.get(entry.storageKey);
    if (object === null) {
      missing.push(entry.sha256);
      continue;
    }
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) corrupt.push(entry.sha256);
  }
  return { missing: [...new Set(missing)], corrupt: [...new Set(corrupt)] };
}
export async function backupDeployment(deployment: Deployment, directory: string): Promise<Backup> {
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'objects'), { mode: 0o700 });
  await mkdir(join(directory, 'secrets'), { mode: 0o700 });
  const exported = Buffer.from(JSON.stringify(await exportDatabase(deployment.executor)));
  await writeFile(join(directory, 'database.json'), exported, { mode: 0o600 });
  const objects = await inventory(deployment);
  const checked = await checkInventory(deployment, objects);
  if (checked.missing.length || checked.corrupt.length) throw new BackupIntegrityError();
  for (const entry of objects) {
    const object = await deployment.bucket.get(entry.storageKey);
    await writeFile(
      join(directory, 'objects', `${entry.orgId}-${entry.sha256}`),
      new Uint8Array(await new Response(object!.body).arrayBuffer()),
      { mode: 0o600 },
    );
  }
  const keys: Record<string, string> = {};
  for (const [name, value] of deployment.secrets) {
    keys[name] = digest(Buffer.from(value));
    await writeFile(join(directory, 'secrets', name), value, { mode: 0o600 });
  }
  const backup: Backup = {
    database: digest(exported),
    keys,
    objects,
    candidate: await candidateIdentity(),
    configuration: { publicUrl: ORIGIN, storage: 'r2' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(backup), { mode: 0o600 });
  return backup;
}
export async function assertEmptyTarget(target: Deployment) {
  const tables = await target.executor.all({
    sql: "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    params: [],
  });
  if (tables.length || target.secrets.size || (await target.bucket.list()).objects.length)
    throw new RestoreTargetNotEmptyError();
}
export async function restoreDeployment(
  directory: string,
  target: Deployment,
  options: { skipKeys?: boolean; skipBlobs?: boolean; masterKey?: string } = {},
) {
  const start = performance.now();
  await assertEmptyTarget(target);
  if (target.restoring) throw new RestoreTargetNotEmptyError();
  target.restoring = true;
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Backup;
    const database = await readFile(join(directory, 'database.json'));
    if (
      manifest.candidate !== (await candidateIdentity()) ||
      digest(database) !== manifest.database
    )
      throw new BackupIntegrityError();
    const secrets = new Map<string, string>();
    for (const [name, checksum] of Object.entries(manifest.keys)) {
      const value = await readFile(join(directory, 'secrets', name), 'utf8');
      if (digest(Buffer.from(value)) !== checksum) throw new BackupIntegrityError();
      secrets.set(name, value);
    }
    const objects = [];
    for (const entry of manifest.objects) {
      const bytes = await readFile(join(directory, 'objects', `${entry.orgId}-${entry.sha256}`));
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256)
        throw new BackupIntegrityError();
      objects.push({ entry, bytes });
    }
    const statements = JSON.parse(database.toString()) as SnapshotStatement[];
    await restoreDatabase(target.executor, statements);
    if (JSON.stringify(await inventory(target)) !== JSON.stringify(manifest.objects))
      throw new BackupIntegrityError();
    if (!options.skipKeys) {
      target.secrets = secrets;
      if (options.masterKey !== undefined) target.secrets.set('PB_MASTER_KEY', options.masterKey);
    }
    if (!options.skipBlobs)
      for (const { entry, bytes } of objects)
        await target.bucket.put(entry.storageKey, bytes, {
          sha256: entry.sha256,
          httpMetadata: { contentType: entry.mediaType },
        });
    return { ...(await checkInventory(target)), durationMs: performance.now() - start };
  } finally {
    target.restoring = false;
  }
}
export async function verifyDeployment(deployment: Deployment, seeded: SeededDeployment) {
  const started = performance.now();
  const runtime = await startDeployment(deployment);
  const ready = await runtime.fetch(new Request(`${ORIGIN}/_pb/auth/providers`));
  const startDurationMs = performance.now() - started;
  if (ready.status !== 200) {
    const denied = await runtime.fetch(
      new Request(`${ORIGIN}${seeded.distPath}`, {
        headers: { authorization: `Bearer ${seeded.token}` },
      }),
    );
    return {
      started: false,
      startDurationMs,
      logs: runtime.logs,
      checks: failedChecks(),
      download: { status: denied.status, completeBody: false },
      downloadSha256: '',
      blobs: await checkInventory(deployment),
      foreignStatus: 0,
      unauthenticatedStatus: 0,
    };
  }
  return {
    started: true,
    startDurationMs,
    logs: runtime.logs,
    ...(await verifyRoutes(runtime.fetch, seeded)),
    blobs: await checkInventory(deployment),
  };
}
export async function removeBackup(directory: string) {
  await rm(directory, { recursive: true, force: true });
}

// Node-hosted createWorker needs Workers stream primitives; the D1/R2 bindings remain real Miniflare bindings.
export function installWorkerStreams() {
  const previous = Object.getOwnPropertyDescriptor(crypto, 'DigestStream');
  const previousFixed = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  class DigestStream extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>;
    constructor(algorithm: string) {
      const hash = createHash(algorithm.replace('-', '').toLowerCase());
      let finish!: (value: ArrayBuffer) => void;
      const promise = new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      });
      super({
        write: (chunk) => {
          hash.update(chunk);
        },
        close: () => {
          const bytes = hash.digest();
          finish(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
        },
      });
      this.digest = promise;
    }
  }
  Object.defineProperty(crypto, 'DigestStream', { value: DigestStream, configurable: true });
  class FixedLengthStream {
    readonly readable;
    readonly writable;
    constructor() {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }
  Object.defineProperty(globalThis, 'FixedLengthStream', {
    value: FixedLengthStream,
    configurable: true,
  });
  return () => {
    if (previous) Object.defineProperty(crypto, 'DigestStream', previous);
    else Reflect.deleteProperty(crypto, 'DigestStream');
    if (previousFixed) Object.defineProperty(globalThis, 'FixedLengthStream', previousFixed);
    else Reflect.deleteProperty(globalThis, 'FixedLengthStream');
  };
}

export { exportDatabase } from './sql-snapshot.test.support.js';
