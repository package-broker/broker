import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
const masterKey = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const upstreamOrigins = [
  'https://api.github.com',
  'https://github.com',
  'https://codeload.github.com',
  'https://repo.packagist.org',
  'https://registry.npmjs.org',
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

export async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
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

export interface LocalBroker {
  origin: string;
  setupToken: string;
  logs: () => string;
  read<T extends Record<string, unknown>>(sql: string, params?: (string | number)[]): Promise<T[]>;
  loseBlob(orgId: string, sha256: string): Promise<void>;
  moduleEvidence(): Promise<void>;
  pollTick(orgId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startLocal(
  runtime: Runtime,
  fixtureOrigin: string,
  options: { removeWebhook?: boolean } = {},
): Promise<LocalBroker> {
  fixtureDestination(upstreamOrigins[0], fixtureOrigin);
  const fixture = new URL(fixtureOrigin);
  assert(Number(fixture.port) > 0, 'InvalidFixturePort');
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
    if (options.removeWebhook) {
      assert.equal(runtime, 'node');
      await writeFile(script, removeWebhookRegistration(await readFile(script, 'utf8')));
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      PB_MASTER_KEY: masterKey,
      PB_PUBLIC_URL: origin,
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
          getR2Bucket(name: string): Promise<{ delete(key: string): Promise<void> }>;
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
              const destination = fixtureDestination(request.url, fixtureOrigin);
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
https.request = (options) => {
  const url = new URL('https://' + options.host + options.path);
  if (!origins.includes(url.origin)) throw new Error('UnexpectedUpstream');
  return http.request({ hostname: '127.0.0.1', port: ${JSON.stringify(fixture.port)},
    path: '/__upstream/' + url.hostname + url.pathname + url.search,
    method: options.method, headers: options.headers, agent: false });
};
syncBuiltinESMExports();
`,
      );
      const child = spawn(process.execPath, ['--import', preload, script], {
        cwd: copy,
        env: { ...env, PB_SQLITE_PATH: database },
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
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db.prepare(sql).all(...params) as T[];
      } finally {
        db.close();
      }
    };
    return {
      origin,
      setupToken: (await readFile(tokenFile, 'utf8')).trim(),
      logs: () => logs,
      read,
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
          const db = new DatabaseSync(database);
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
