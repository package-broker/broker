/* eslint-disable no-restricted-syntax -- Test infrastructure uses fixed SQL scoped to the pinned organization; no production SQL is added. */
// Retention restarts one compiled fixture across build and environment transitions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertBuiltModules,
  assertWorkerBundle,
  fixtureDestination,
  infrastructureOperations,
  injectSourcePollClock,
  LocalUnavailable,
  removeWebhookRegistration,
  repository,
  reserveLoopbackPort,
  until,
  upstreamOrigins,
} from './local.js';
import { retentionBundle, type StaleSealOutcome } from './audit-retention-fixture.js';
import { auditHash, type AuditRecord } from './audit.spec.js';
import type { LocalBroker, Runtime, SqlPort } from './local.js';
const masterKey = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export interface RetentionBroker extends Omit<
  LocalBroker,
  'databaseSnapshot' | 'confirmAuditRestore'
> {
  staleSeal(): Promise<{ release(): void; settled: Promise<StaleSealOutcome> }>;
  fillCapacity(bytes: number): Promise<void>;
  configure(values: Record<string, string>): Promise<void>;
  fixture(sql: string, params: (string | number | null)[]): Promise<void>;
  enqueue(kind: 'seal' | 'verify' | 'maintain' | 'export-webhook'): Promise<string>;
}
async function command(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [join(repository, 'packages/cli/dist/bin.js'), ...args], {
    cwd: repository,
    env,
    stdio: 'ignore',
    timeout: 30_000,
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `LocalCommandFailed:${args.slice(0, 2).join(':')}`);
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

export async function startRetentionLocal(
  runtime: Runtime,
  fixtureOrigin: string,
  options: {
    removeWebhook?: boolean;
    reader?: boolean;
    nodeTransport?: string;
    outboundDestination?: (url: string, brokerOrigin: string) => string;
    patchBundle?: (bundle: string) => string;
    publicUrl?: string;
    nodeEnv?: Record<string, string>;
    output: string;
    runtimeEnv: Record<string, string>;
  },
): Promise<RetentionBroker> {
  fixtureDestination(upstreamOrigins[0], fixtureOrigin);
  const fixture = new URL(fixtureOrigin);
  assert(Number(fixture.port) > 0, 'InvalidFixturePort');
  assert(!options.publicUrl || runtime === 'node', 'PublicUrlIsNodeOnly');
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const output = options.output;
  const entry = runtime === 'node' ? 'server.js' : 'worker.js';
  try {
    await readFile(join(output, entry));
    await readFile(join(repository, 'packages/cli/dist/bin.js'));
  } catch {
    throw new LocalUnavailable('Build output is missing; run pnpm typecheck && pnpm bundle.');
  }
  await mkdir(join(repository, '.pb'), { recursive: true });
  const directory = await mkdtemp(join(repository, '.pb/e2e-'));
  const cleanups: (() => Promise<unknown>)[] = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= cleanup());
  const cleanup = async () => {
    const results = await Promise.allSettled(
      cleanups
        .slice(1)
        .reverse()
        .map((cleanup) => cleanup()),
    );
    try {
      await cleanups[0]!();
    } catch (error) {
      results.push({ status: 'rejected', reason: error });
    }
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length)
      throw new Error('LocalCleanupFailed', {
        cause: new AggregateError(failures, 'LocalResourceCleanupFailed'),
      });
  };
  let logs = '';
  let logOverflow = false;
  const record = (chunk: unknown) => {
    const next = logs + String(chunk);
    logOverflow ||= next.length > 2_000_000;
    logs = next.slice(-2_000_000);
  };
  try {
    const copy = join(directory, 'bundle');
    await cp(output, copy, { recursive: true });
    const script = join(copy, entry);
    await writeFile(
      script,
      retentionBundle(injectSourcePollClock(await readFile(script, 'utf8')), runtime),
    );
    if (options.patchBundle)
      await writeFile(script, options.patchBundle(await readFile(script, 'utf8')));
    if (options.removeWebhook) {
      assert.equal(runtime, 'node');
      await writeFile(script, removeWebhookRegistration(await readFile(script, 'utf8')));
    }
    const runtimeEnv = { ...options.runtimeEnv };
    let restart: () => Promise<void> = async () => {};
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      PB_MASTER_KEY: masterKey,
      PB_PUBLIC_URL: options.publicUrl ?? origin,
      PB_BLOB_ROOT: join(directory, 'blobs'),
      PORT: String(port),
      DEPLOYMENT_ID: 'local-release',
    };
    let database = join(directory, 'db.sqlite');
    let worker:
      | {
          ready: Promise<URL>;
          setOptions(options: unknown): Promise<void>;
          getWorker(): Promise<{
            scheduled(options: { scheduledTime: number; cron: string }): Promise<unknown>;
          }>;
          getD1Database(name: string): Promise<{
            prepare(sql: string): {
              bind(...params: unknown[]): {
                all(): Promise<{ results: Record<string, unknown>[] }>;
              };
            };
          }>;
          getR2Bucket(name: string): Promise<{
            delete(key: string): Promise<void>;
            list(options: { cursor?: string }): Promise<{
              objects: { key: string }[];
              truncated: boolean;
              cursor?: string;
            }>;
          }>;
          dispose(): Promise<void>;
        }
      | undefined;
    if (runtime === 'cloudflare') {
      const require = createRequire(join(repository, 'packages/runtime-cloudflare/package.json'));
      const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
      const persist = join(directory, 'state');
      const { descriptor: assets } = JSON.parse(
        await readFile(join(copy, 'assets.json'), 'utf8'),
      ) as {
        descriptor: {
          directory: string;
          binding: string;
          run_worker_first: boolean;
          html_handling: string;
          not_found_handling: string;
        };
      };
      const workerOptions = () =>
        convertV4MiniflareOptions({
          host: '127.0.0.1',
          port,
          rootPath: copy,
          modules: true,
          scriptPath: entry,
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          resourcePersistencePath: persist,
          isolatedResourcePersistencePath: join(directory, 'isolated'),
          resourceTmpPath: join(directory, 'tmp'),
          logRequests: false,
          assets: {
            directory: resolve(copy, assets.directory),
            binding: assets.binding,
            run_worker_first: assets.run_worker_first,
            routerConfig: { has_user_worker: true },
            assetConfig: {
              html_handling: assets.html_handling,
              not_found_handling: assets.not_found_handling,
            },
          },
          r2Buckets: ['STORAGE'],
          queueProducers: { JOBS: 'local-jobs' },
          queueConsumers: ['local-jobs'],
          analyticsEngineDatasets: { ANALYTICS: { dataset: 'local-release' } },
          bindings: {
            PB_MASTER_KEY: masterKey,
            PB_PUBLIC_URL: origin,
            DEPLOYMENT_ID: 'local-release',
            ...runtimeEnv,
          },
          handleStructuredLogs: (entry: { message: string }) => record(entry.message),
          outboundService: async (request: Request) => {
            const destination = options.outboundDestination
              ? options.outboundDestination(request.url, origin)
              : fixtureDestination(request.url, fixtureOrigin);
            return fetch(destination, {
              method: request.method,
              headers: request.headers,
              redirect: 'manual',
              ...(['GET', 'HEAD'].includes(request.method)
                ? {}
                : {
                    body: new Uint8Array(await request.arrayBuffer()),
                  }),
            });
          },
        });
      worker = new Miniflare(workerOptions());
      restart = async () => {
        await worker!.setOptions(workerOptions());
        await worker!.ready;
      };
      let readyFailure: { error: unknown } | undefined;
      cleanups.push(async () => {
        try {
          await worker?.dispose();
        } catch (error) {
          // Miniflare disposal rethrows a failed initialization after cleaning up.
          if (!readyFailure || error !== readyFailure.error) throw error;
        }
      });
      try {
        await worker!.ready;
      } catch (error) {
        readyFailure = { error };
        throw error;
      }
      await (await worker!.getD1Database('DB')).prepare('SELECT 1').bind().all();
      // The completed read holds no transaction across the external CLI migration.
      const sqliteFiles = (await files(join(persist, 'd1'))).filter(
        (path) => path.endsWith('.sqlite') && !path.endsWith('/metadata.sqlite'),
      );
      assert.equal(sqliteFiles.length, 1, 'D1DatabaseFileMissing');
      database = sqliteFiles[0]!;
    }
    await command(['migrate', '--sqlite', database, '--out', copy], env);
    await command(['bootstrap', '--sqlite', database, '--slug', 'acme', '--name', 'Acme'], env);
    const tokenFile = join(directory, 'setup-token');
    await command(
      [
        'admin',
        'bootstrap',
        '--email',
        'admin@example.test',
        '--sqlite',
        database,
        '--token-file',
        tokenFile,
      ],
      env,
    );
    const organizations = (() => {
      const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
      try {
        return db.prepare('SELECT id FROM organization').all() as { id: string }[];
      } finally {
        db.close();
      }
    })();
    assert.equal(organizations.length, 1, 'SingleOrganizationExpected');
    const pinnedOrgId = organizations[0]!.id;
    const readerTokenFile = join(directory, 'reader-setup-token');
    if (options.reader)
      await command(
        [
          'admin',
          'bootstrap',
          '--email',
          'reader@example.test',
          '--sqlite',
          database,
          '--token-file',
          readerTokenFile,
        ],
        env,
      );
    const moduleFile = join(directory, 'modules.json');
    if (runtime === 'node') {
      const require = createRequire(join(repository, 'packages/runtime-node/package.json'));
      await mkdir(join(copy, 'node_modules'), { recursive: true });
      await rm(join(copy, 'node_modules/better-sqlite3'), { recursive: true, force: true });
      await symlink(
        dirname(require.resolve('better-sqlite3/package.json')),
        join(copy, 'node_modules/better-sqlite3'),
        'dir',
      );
      const nodeTmp = join(directory, 'node-tmp');
      await mkdir(nodeTmp);
      const preload = join(directory, 'transport.mjs');
      await writeFile(
        preload,
        `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const origins = ${JSON.stringify(upstreamOrigins)};
const loaded = [];
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number')
    return listen.apply(this, [{ port: args[0], host: '127.0.0.1' }, ...args.slice(1)]);
  return listen.apply(this, args);
};
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  loaded.push(result.url);
  writeFileSync(${JSON.stringify(moduleFile)}, JSON.stringify(loaded));
  return result;
} });
${
  options.nodeTransport ??
  `https.request = (options) => {
  const url = new URL('https://' + options.host + options.path);
  if (!origins.includes(url.origin)) throw new Error('UnexpectedUpstream');
  return http.request({ hostname: '127.0.0.1', port: ${JSON.stringify(fixture.port)},
    path: '/__upstream/' + url.hostname + url.pathname + url.search,
    method: options.method, headers: options.headers, agent: false });
};`
}
syncBuiltinESMExports();
`,
      );
      const launch = () => {
        const child = spawn(process.execPath, ['--import', preload, script], {
          cwd: copy,
          env: {
            ...env,
            ...options.nodeEnv,
            ...runtimeEnv,
            PB_SQLITE_PATH: database,
            TMPDIR: nodeTmp,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', record);
        child.stderr?.on('data', record);
        const exited = once(child, 'exit');
        return async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGTERM');
          await Promise.race([
            exited,
            delay(10_000).then(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }),
          ]);
          await exited;
        };
      };
      let stop = launch();
      cleanups.push(() => stop());
      restart = async () => {
        await stop();
        stop = launch();
      };
    }
    await until(async () => {
      try {
        return (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, 'readiness');
    const read = async <T extends Record<string, unknown>>(
      sql: string,
      params: (string | number)[] = [],
    ): Promise<T[]> => {
      assert(
        /^SELECT\b/i.test(sql) && /\borg_id\s*=\s*\?/i.test(sql),
        'UnscopedInfrastructureRead',
      );
      if (worker)
        return (
          await (
            await worker.getD1Database('DB')
          )
            .prepare(sql)
            .bind(...params)
            .all()
        ).results as T[];
      const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
      try {
        return db.prepare(sql).all(...params) as T[];
      } finally {
        db.close();
      }
    };
    const sqlPort: SqlPort = {
      async run(sql, params) {
        if (worker) {
          await (
            await worker.getD1Database('DB')
          )
            .prepare(sql)
            .bind(...params)
            .all();
          return;
        }
        const db = new DatabaseSync(database, { timeout: 5000 });
        try {
          db.prepare(sql).run(...params);
        } finally {
          db.close();
        }
      },
      async all<T extends Record<string, unknown>>(
        sql: string,
        params: (string | number | null)[],
      ) {
        if (worker)
          return (
            await (
              await worker.getD1Database('DB')
            )
              .prepare(sql)
              .bind(...params)
              .all()
          ).results as T[];
        const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
        try {
          return db.prepare(sql).all(...params) as T[];
        } finally {
          db.close();
        }
      },
    };
    return {
      origin,
      publicOrigin: new URL(options.publicUrl ?? origin).origin,
      setupToken: (await readFile(tokenFile, 'utf8')).trim(),
      ...(options.reader
        ? { readerSetupToken: (await readFile(readerTokenFile, 'utf8')).trim() }
        : {}),
      logs: () => logs,
      secrets: () => [masterKey, 'admin@example.test'],
      read,
      async staleSeal() {
        const control = (operation: 'capture' | 'release') =>
          fetch(origin + '/__fixture/stale-seal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ orgId: pinnedOrgId, operation }),
            signal: AbortSignal.timeout(30_000),
          });
        let captured = false;
        for (let attempt = 0; attempt < 3 && !captured; attempt++) {
          const db = new DatabaseSync(database, { timeout: 5000 });
          try {
            const result = db
              .prepare(
                `INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json)
              SELECT ?, org_id, created_at, 'system', NULL, NULL, NULL, action, target_type, target_id, project_id, payload_json
              FROM audit_event WHERE org_id = ? AND action = 'project.create' LIMIT 1`,
              )
              .run('01' + randomBytes(12).toString('hex').toUpperCase(), pinnedOrgId);
            assert(Number(result.changes) === 1, 'StaleSealTemplateMissing');
          } finally {
            db.close();
          }
          const response = await control('capture');
          assert(response.status === 200 || response.status === 409, 'StaleSealCaptureFailed');
          captured = response.ok;
        }
        assert(captured, 'StaleSealDidNotPause');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const settled = gate.then(async () => {
          const response = await control('release');
          assert(response.ok, 'StaleSealReleaseFailed');
          return (await response.json()) as StaleSealOutcome;
        });
        return { release, settled };
      },
      async fillCapacity(bytes) {
        const db = new DatabaseSync(database, { timeout: 5000 });
        try {
          db.exec('BEGIN IMMEDIATE');
          const template = db
            .prepare(
              "SELECT * FROM audit_event WHERE org_id = ? AND action = 'project.create' LIMIT 1",
            )
            .get(pinnedOrgId) as AuditRecord | undefined;
          assert(template, 'CapacityTemplateMissing');
          const chain = db
            .prepare(
              'SELECT head_seq, head_hash, journal_rows, journal_bytes FROM audit_chain WHERE org_id = ?',
            )
            .get(pinnedOrgId)!;
          let seq = Number(chain['head_seq']);
          let hash = String(chain['head_hash']);
          let total = Number(chain['journal_bytes']);
          let count = 0;
          const columns = [
            'id',
            'org_id',
            'seq',
            'prev_hash',
            'hash',
            'created_at',
            'actor_type',
            'actor_id',
            'token_selector',
            'source_ip',
            'action',
            'target_type',
            'target_id',
            'project_id',
            'payload_json',
          ];
          const insert = db.prepare(
            `INSERT INTO audit_event (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          );
          while (total < bytes) {
            const row: AuditRecord = {
              ...template,
              id: '01' + randomBytes(12).toString('hex').toUpperCase(),
              org_id: pinnedOrgId,
              seq: ++seq,
              prev_hash: hash,
              hash: '',
              actor_type: 'system',
              actor_id: null,
              source_ip: null,
              token_selector: null,
            };
            row.hash = auditHash(row);
            const values = columns.map((key) => row[key] as string | number | null);
            insert.run(...values);
            total += Buffer.byteLength(
              JSON.stringify(Object.fromEntries(columns.map((key) => [key, row[key]]))),
            );
            hash = row.hash;
            count++;
          }
          db.prepare(
            'UPDATE audit_chain SET head_seq = ?, head_hash = ?, journal_rows = journal_rows + ?, journal_bytes = ? WHERE org_id = ?',
          ).run(seq, hash, count, total, pinnedOrgId);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        } finally {
          db.close();
        }
      },
      async configure(values: Record<string, string>) {
        Object.assign(runtimeEnv, values);
        await restart();
        await until(async () => {
          try {
            return (await fetch(origin + '/health/ready', { signal: AbortSignal.timeout(1000) }))
              .ok;
          } catch {
            return false;
          }
        }, 'retention-restart');
      },
      async fixture(sql: string, params: (string | number | null)[]) {
        assert(
          /\borg_id\s*=\s*\?/i.test(sql) && params.includes(pinnedOrgId),
          'UnscopedRetentionFixture',
        );
        await sqlPort.run(sql, params);
      },
      async enqueue(kind: 'seal' | 'verify' | 'maintain' | 'export-webhook') {
        return infrastructureOperations(sqlPort, pinnedOrgId).jobs.enqueue(`core:audit-${kind}:v1`);
      },
      ...infrastructureOperations(sqlPort, pinnedOrgId),
      async storageKeys() {
        if (!worker) {
          return (
            await files(env['PB_BLOB_ROOT']!).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return [];
              throw error;
            })
          )
            .map((path) => path.slice(env['PB_BLOB_ROOT']!.length + 1))
            .sort();
        }
        const bucket = await worker.getR2Bucket('STORAGE');
        const keys: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await bucket.list(cursor ? { cursor } : {});
          keys.push(...page.objects.map((object) => object.key));
          if (!page.truncated) return keys.sort();
          assert(page.cursor && page.cursor !== cursor, 'StorageEnumerationIncomplete');
          cursor = page.cursor;
        }
      },
      async filesystemEntries() {
        // Runtime-managed stores that the oracles read through their own ports instead.
        const managed = [
          // Node SQLite database and its journal: read().
          /^db\.sqlite(?:-wal|-shm)?$/,
          // Node blob store: storageKeys() and blob rows.
          /^blobs\//,
          // Module loader recorder written by the harness preload.
          /^modules\.json$/,
          // D1 database file and journal: read().
          /^state\/d1\/miniflare-D1DatabaseObject\/[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/,
          // R2 objects and the bucket index: storageKeys().
          /^state\/r2\/STORAGE\/blobs\/[a-f0-9]+$/,
          /^state\/r2\/miniflare-R2BucketObject\/[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/,
          // Cache API entries (metadata responses) and their index, written through the cache port.
          /^state\/cache\/named_pb-metadata-v1\/blobs\/[a-f0-9]+$/,
          /^state\/cache\/miniflare-CacheObject\/[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/,
        ];
        const paths = (await files(directory))
          .map((path) => path.slice(directory.length + 1))
          .filter((path) => !managed.some((pattern) => pattern.test(path)));
        const entries = await Promise.all(
          paths.map(async (path) => {
            const absolute = join(directory, path);
            const info = await lstat(absolute);
            const bytes = info.isSymbolicLink()
              ? await readlink(absolute)
              : await readFile(absolute);
            return `${path}:${createHash('sha256').update(bytes).digest('hex')}`;
          }),
        );
        return entries.sort();
      },
      async loseBlob(orgId, sha256) {
        assert(/^[a-f0-9]{64}$/.test(sha256), 'InvalidBlobDigest');
        const rows = await read<{ storage_key: string }>(
          'SELECT storage_key FROM blob WHERE org_id = ? AND sha256 = ?',
          [orgId, sha256],
        );
        assert.equal(rows.length, 1, 'BlobNotFound');
        const key = String(rows[0]!['storage_key']);
        if (worker) await (await worker.getR2Bucket('STORAGE')).delete(key);
        else {
          const path = resolve(env['PB_BLOB_ROOT']!, key);
          assert(path.startsWith(env['PB_BLOB_ROOT']! + '/'), 'InvalidBlobKey');
          await rm(path);
          await rm(`${path}.media`, { force: true });
        }
      },
      async pollTick(orgId) {
        // A unique ULID-shaped test ID also passes the Worker's queue notification validation.
        const id = '01' + randomBytes(12).toString('hex').toUpperCase();
        // Enqueue a due tick, then let the production runners claim and settle it.
        const sql =
          "INSERT INTO job (id, org_id, type) SELECT ?, id, 'core:source-poll:v1' FROM organization WHERE id = ?";
        if (worker) {
          await (await worker.getD1Database('DB')).prepare(sql).bind(id, orgId).all();
        } else {
          const db = new DatabaseSync(database, { timeout: 5000 });
          try {
            db.prepare(sql).run(id, orgId);
          } finally {
            db.close();
          }
        }
        await until(async () => {
          if (worker)
            await (
              await worker.getWorker()
            ).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' });
          const [job] = await read<{ state: string }>(
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          assert(job, 'SourcePollJobMissing');
          assert.notEqual(job.state, 'dead', 'SourcePollJobFailed');
          return job.state === 'succeeded';
        }, 'source-poll');
      },
      async tick() {
        if (worker)
          await (
            await worker.getWorker()
          ).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' });
      },
      async moduleEvidence() {
        assert(!logOverflow, 'IncompleteLogEvidence');
        if (runtime === 'node') {
          const modules = JSON.parse(await readFile(moduleFile, 'utf8')) as string[];
          assert(modules.includes(new URL(`file://${script}`).href), 'EntryModuleNotLoaded');
          assertBuiltModules(modules);
        } else {
          const bundle = await readFile(script, 'utf8');
          assertWorkerBundle(bundle);
        }
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (!(error instanceof Error))
        throw new AggregateError([error, cleanupError], 'LocalStartupFailed', {
          cause: cleanupError,
        });
      Object.defineProperty(error, 'cause', {
        configurable: true,
        writable: true,
        value:
          error.cause === undefined
            ? cleanupError
            : new AggregateError([error.cause, cleanupError], 'LocalStartupCauses'),
      });
    }
    throw error;
  }
}
