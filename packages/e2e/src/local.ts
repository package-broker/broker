import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
const masterKey = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const upstreamOrigins = [
  'https://api.github.com',
  'https://github.com',
  'https://codeload.github.com',
  'https://repo.packagist.org',
  'https://registry.npmjs.org',
  'https://git.example.test',
] as const;
export type Runtime = 'node' | 'cloudflare';

export class LocalUnavailable extends Error {
  override readonly name = 'LocalUnavailable';
}

export function fixtureDestination(url: string, fixtureOrigin: string): string {
  const target = new URL(url);
  assert(!target.username && !target.password, 'CredentialBearingUpstream');
  assert(
    upstreamOrigins.some((origin) => origin === target.origin),
    'UnexpectedUpstream',
  );
  const fixture = new URL(fixtureOrigin);
  assert(fixture.protocol === 'http:' && fixture.hostname === '127.0.0.1', 'NonLoopbackFixture');
  assert(
    !fixture.username &&
      !fixture.password &&
      fixture.pathname === '/' &&
      !fixture.search &&
      !fixture.hash,
    'InvalidFixtureOrigin',
  );
  return `${fixture.origin}/__upstream/${target.hostname}${target.pathname}${target.search}`;
}

export function assertBuiltModules(modules: readonly string[]): void {
  assert(modules.length > 0, 'EmptyModuleEvidence');
  assert(!modules.some((path) => /packages\/[^/]+\/src\//.test(path)), 'WorkspaceSourceLoaded');
}

export function assertWorkerBundle(bundle: string): void {
  assert(!/packages\/[^/]+\/src\//.test(bundle), 'WorkspaceSourceInWorkerBundle');
  assert(
    !/(?:from\s*|import\s*\()\s*["']@package-broker\//.test(bundle),
    'UnbundledWorkspaceImport',
  );
}

export function removeWebhookRegistration(bundle: string): string {
  const pattern =
    /coreRoutes: Object\.freeze\(\[createWebhookIntake\(\{ \.\.\.deps\.webhook, jobs \}\)\]\)/g;
  assert.equal([...bundle.matchAll(pattern)].length, 1, 'WebhookMutationTargetMissing');
  return bundle.replace(pattern, 'coreRoutes: Object.freeze([])');
}

export function injectSourcePollClock(bundle: string): string {
  const target =
    /(function createSourcePollJob\(deps\) \{)(\s+return defineJob\(\{\s+\.\.\.sourcePollJob,\s+validate: validatePoll,\s+async handler\(input, job\) \{\s+validatePoll\(input\);)/g;
  assert.equal([...bundle.matchAll(target)].length, 1, 'SourcePollClockTargetMissing');
  // Keep database time and every other job's clock real. Only poll-key minutes advance.
  return bundle.replace(
    target,
    `$1
  let pollTime = Date.now();$2
    pollTime = Math.max(pollTime + 60_000, Date.now());
    const now = new Date(pollTime);
    job = { ...job, ports: { ...job.ports, clock: { now: () => now } } };`,
  );
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    return address.port;
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new LocalUnavailable('Loopback listeners are unavailable.');
    throw error;
  } finally {
    if (server.listening) await new Promise<void>((accept) => server.close(() => accept()));
  }
}

const bundleEntries = ['.pb/node/server.js', '.pb/cloudflare/worker.js'];
const bundleStaleMs = 480_000;
const bundleBudgetMs = 570_000;

async function vitestRunId(): Promise<string> {
  const main = String(process.ppid);
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', main]);
    return `${main}@${stdout.trim()}`;
  } catch {
    return main;
  }
}

export async function bundleSourceFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path).catch(() => undefined);
    if (!info) return;
    if (!info.isDirectory()) {
      hash.update(`${path.slice(repository.length)}:${info.size}:${info.mtimeMs}\n`);
      return;
    }
    for (const entry of (await readdir(path)).sort())
      if (entry !== 'node_modules' && entry !== 'dist') await visit(join(path, entry));
  };
  for (const name of (await readdir(join(repository, 'packages'))).sort())
    if (name !== 'e2e') {
      await visit(join(repository, 'packages', name, 'src'));
      await visit(join(repository, 'packages', name, 'package.json'));
    }
  for (const file of ['broker.config.ts', 'pnpm-lock.yaml']) await visit(join(repository, file));
  return hash.digest('hex');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockOwner {
  pid: number;
  run: string;
  token: string;
  started: number;
}

const readOwner = (directory: string) =>
  readFile(join(directory, 'owner.json'), 'utf8')
    .then((text) => JSON.parse(text) as LockOwner)
    .catch(() => undefined);

async function acquireBundleLock(lock: string, owner: LockOwner, deadline: number): Promise<void> {
  for (;;) {
    const staging = `${lock}.new-${owner.token}`;
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'owner.json'), JSON.stringify(owner));
    try {
      // Renaming a populated directory onto an existing lock fails, so exactly one waiter wins.
      await rename(staging, lock);
      return;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
    const holder = await readOwner(lock);
    const stale =
      holder !== undefined &&
      (Date.now() - holder.started > bundleStaleMs || !processAlive(holder.pid));
    if (stale) {
      const parked = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(lock, parked);
      } catch {
        continue;
      }
      const moved = await readOwner(parked);
      if (moved?.token === holder.token) await rm(parked, { recursive: true, force: true });
      else await rename(parked, lock).catch(() => undefined);
      continue;
    }
    assert(Date.now() < deadline, 'BundleLockTimeout');
    await delay(250);
  }
}

async function releaseBundleLock(lock: string, owner: LockOwner): Promise<void> {
  if ((await readOwner(lock))?.token !== owner.token) return;
  const parked = `${lock}.released-${owner.token}`;
  await rename(lock, parked);
  await rm(parked, { recursive: true, force: true });
}

// Runs from the e2e global setup before any test file starts, so no test reads .pb while it is
// rewritten. The lock covers concurrent vitest runs sharing one checkout.
export async function buildBundles(): Promise<void> {
  const deadline = Date.now() + bundleBudgetMs;
  await mkdir(join(repository, '.pb'), { recursive: true });
  const lock = join(repository, '.pb/bundle.lock');
  const stamp = join(repository, '.pb/bundle.stamp');
  const run = await vitestRunId();
  const owner: LockOwner = {
    pid: process.pid,
    run,
    token: randomBytes(8).toString('hex'),
    started: Date.now(),
  };
  await acquireBundleLock(lock, owner, deadline);
  try {
    const fingerprint = await bundleSourceFingerprint();
    const outputs = async () =>
      Promise.all(
        bundleEntries.map(async (entry) => (await stat(join(repository, entry))).mtimeMs),
      ).catch(() => undefined);
    const recorded = await readFile(stamp, 'utf8')
      .then((text) => JSON.parse(text) as { run: string; fingerprint: string; outputs: number[] })
      .catch(() => undefined);
    const current = await outputs();
    if (
      recorded?.run === run &&
      recorded.fingerprint === fingerprint &&
      current !== undefined &&
      JSON.stringify(current) === JSON.stringify(recorded.outputs)
    )
      return;
    await rm(stamp, { force: true });
    for (const script of ['build', 'bundle']) {
      const remaining = deadline - Date.now();
      assert(remaining > 0, 'BundleBuildTimeout');
      await promisify(execFile)('pnpm', [script], {
        cwd: repository,
        maxBuffer: 64 * 1024 * 1024,
        timeout: remaining,
      }).catch((error: { killed?: boolean }) => {
        throw error.killed ? new Error('BundleBuildTimeout') : error;
      });
    }
    const built = await outputs();
    assert(built, 'BundleOutputMissing');
    await writeFile(stamp, JSON.stringify({ run, fingerprint, outputs: built }));
  } finally {
    await releaseBundleLock(lock, owner);
  }
}

export async function until(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`LocalTimeout:${label}`);
}

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [join(repository, 'packages/cli/dist/bin.js'), ...args], {
    cwd: repository,
    env,
    stdio: 'ignore',
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

export interface SqlPort {
  run(sql: string, params: (string | number | null)[]): Promise<void>;
  all<T extends Record<string, unknown>>(
    sql: string,
    params: (string | number | null)[],
  ): Promise<T[]>;
}

export type AuditRow = Record<string, string | number | null> & { seq: number; org_id: string };

const auditColumns = [
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
] as const;
const alterableAuditFields = ['action', 'payload_json', 'target_id', 'created_at'] as const;
const enqueueableJobs = ['core:audit-seal:v1', 'core:audit-verify:v1'] as const;

/* eslint-disable no-restricted-syntax -- Fixed statements; the pinned organization id is bound by the harness, never by callers. */
export function infrastructureOperations(db: SqlPort, orgId: string) {
  const seqOf = (value: number) => {
    assert(Number.isSafeInteger(value) && value > 0, 'InvalidAuditSeq');
    return value;
  };
  const snapshot = () =>
    db.all<AuditRow>(
      `SELECT ${auditColumns.join(', ')} FROM audit_event WHERE org_id = ? ORDER BY seq`,
      [orgId],
    );
  return {
    audit: {
      snapshot,
      async restore(rows: readonly AuditRow[]) {
        assert(
          rows.every((row) => row.org_id === orgId),
          'ForeignAuditSnapshot',
        );
        await db.run('DELETE FROM audit_event WHERE org_id = ?', [orgId]);
        for (const row of rows)
          await db.run(
            `INSERT INTO audit_event (${auditColumns.join(', ')}) VALUES (${auditColumns.map(() => '?').join(', ')})`,
            auditColumns.map((column) => (column === 'org_id' ? orgId : (row[column] ?? null))),
          );
      },
      async alter(seq: number, field: (typeof alterableAuditFields)[number], value: string) {
        assert(alterableAuditFields.includes(field), 'AuditFieldNotAlterable');
        await db.run(`UPDATE audit_event SET ${field} = ? WHERE org_id = ? AND seq = ?`, [
          value,
          orgId,
          seqOf(seq),
        ]);
      },
      async delete(seq: number) {
        await db.run('DELETE FROM audit_event WHERE org_id = ? AND seq = ?', [orgId, seqOf(seq)]);
      },
      async truncateFrom(seq: number) {
        await db.run('DELETE FROM audit_event WHERE org_id = ? AND seq >= ?', [orgId, seqOf(seq)]);
      },
      async reorder(first: number, second: number) {
        const [top] = await db.all<{ seq: number | null }>(
          'SELECT MAX(seq) AS seq FROM audit_event WHERE org_id = ?',
          [orgId],
        );
        const park = Number(top?.seq ?? 0) + 1_000_000;
        for (const [from, to] of [
          [seqOf(first), park],
          [seqOf(second), first],
          [park, second],
        ] as const)
          await db.run('UPDATE audit_event SET seq = ? WHERE org_id = ? AND seq = ?', [
            to,
            orgId,
            from,
          ]);
      },
    },
    jobs: {
      async enqueue(type: (typeof enqueueableJobs)[number]) {
        assert(enqueueableJobs.includes(type), 'JobTypeNotEnqueueable');
        const id = '01' + randomBytes(12).toString('hex').toUpperCase();
        await db.run('INSERT INTO job (id, org_id, type) VALUES (?, ?, ?)', [id, orgId, type]);
        return id;
      },
    },
  };
}
/* eslint-enable no-restricted-syntax */

export type InfrastructureOperations = ReturnType<typeof infrastructureOperations>;

export interface LocalBroker {
  origin: string;
  publicOrigin: string;
  setupToken: string;
  readerSetupToken?: string;
  logs: () => string;
  secrets: () => readonly string[];
  read<T extends Record<string, unknown>>(sql: string, params?: (string | number)[]): Promise<T[]>;
  audit: InfrastructureOperations['audit'];
  jobs: InfrastructureOperations['jobs'];
  loseBlob(orgId: string, sha256: string): Promise<void>;
  moduleEvidence(): Promise<void>;
  pollTick(orgId: string): Promise<void>;
  tick(): Promise<void>;
  storageKeys(): Promise<string[]>;
  filesystemEntries(): Promise<string[]>;
  close(): Promise<void>;
}

export async function startLocal(
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
  } = {},
): Promise<LocalBroker> {
  fixtureDestination(upstreamOrigins[0], fixtureOrigin);
  const fixture = new URL(fixtureOrigin);
  assert(Number(fixture.port) > 0, 'InvalidFixturePort');
  assert(!options.publicUrl || runtime === 'node', 'PublicUrlIsNodeOnly');
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const output = join(repository, '.pb', runtime);
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
  const close = async () => {
    const results = await Promise.allSettled(
      cleanups
        .slice(1)
        .reverse()
        .map((cleanup) => cleanup()),
    );
    await cleanups[0]!();
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('LocalCleanupFailed');
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
    await writeFile(script, injectSourcePollClock(await readFile(script, 'utf8')));
    if (options.patchBundle)
      await writeFile(script, options.patchBundle(await readFile(script, 'utf8')));
    if (options.removeWebhook) {
      assert.equal(runtime, 'node');
      await writeFile(script, removeWebhookRegistration(await readFile(script, 'utf8')));
    }
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
    let bootWorker: (() => typeof worker) | undefined;
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
      bootWorker = () =>
        new Miniflare(
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
          }),
        );
      worker = bootWorker();
      cleanups.push(async () => {
        await worker?.dispose();
      });
      await worker!.ready;
      // eslint-disable-next-line no-restricted-syntax -- Materialize Miniflare's empty database before applying built migrations.
      await (await worker!.getD1Database('DB')).prepare('SELECT 1').bind().all();
      await worker!.dispose();
      worker = undefined;
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
        // eslint-disable-next-line no-restricted-syntax -- Pin infrastructure writes to the single bootstrapped organization.
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
      const child = spawn(process.execPath, ['--import', preload, script], {
        cwd: copy,
        env: { ...env, PB_SQLITE_PATH: database, TMPDIR: nodeTmp, ...options.nodeEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', record);
      child.stderr?.on('data', record);
      const exited = once(child, 'exit');
      cleanups.push(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await Promise.race([
          exited,
          delay(10_000).then(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }),
        ]);
        await exited;
      });
    } else {
      worker = bootWorker!();
      await worker!.ready;
    }
    try {
      await until(async () => {
        try {
          return (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      }, 'readiness');
    } catch (error) {
      console.error(`broker output before readiness failure:\n${logs.slice(-4000)}`);
      throw error;
    }
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
          // eslint-disable-next-line no-restricted-syntax -- Read the scoped storage key for the authorized infrastructure deletion.
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
          // eslint-disable-next-line no-restricted-syntax -- Scoped test infrastructure enqueue; production handlers perform polling and sync.
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
            // eslint-disable-next-line no-restricted-syntax -- Observe the scoped infrastructure enqueue.
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
    await close();
    throw error;
  }
}
