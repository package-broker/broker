import type { SourceProvider } from '@package-broker/core/sources/provider';
import { createPackageDescription } from '@package-broker/core/sources/provider';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlValue, Statement } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './db/d1-executor.js';
import type { R2BucketLike } from './blob/r2.js';
import { createWorker, type Env } from './index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function localBinding(): Promise<D1DatabaseLike> {
  const db = openNodeSqliteExecutor(undefined, { d1PatternLimit: true });
  cleanup.push(async () => db.close());
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  function prepare(statement: Statement): D1PreparedStatementLike {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await db.executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  }
  return {
    prepare: (sql) => prepare({ sql, params: [] }),
    batch: async (batch) =>
      (await db.executor.batch(batch.map((s) => statements.get(s)!))).map((r) => ({
        results: r.rows,
        meta: { changes: r.changes },
      })),
  };
}
async function miniflareBinding(): Promise<D1DatabaseLike> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
    }),
  );
  cleanup.push(() => mf.dispose());
  return (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
}

const listingCases = [
  {
    label: 'nonempty plugin listing',
    type: 'composer_repository',
    url: 'https://repo.example.test/packages.json',
    config: { selection: { packages: ['acme/one', 'acme/two'] } },
    agent: null,
    target: 'https://repo.example.test/packages.json',
    names: ['acme/one', 'acme/two'],
  },
  {
    label: 'Composer fallback',
    type: 'composer_repository',
    url: 'https://repo.example.test/packages.json',
    config: {},
    agent: null,
    target: 'https://repo.example.test/packages.json',
  },
  {
    label: 'source User-Agent override',
    type: 'composer_repository',
    url: 'https://repo.example.test/packages.json',
    config: {},
    agent: 'ListingClient/3',
    target: 'https://repo.example.test/packages.json',
  },
  {
    label: 'credentialed VCS git',
    type: 'vcs',
    url: null,
    config: { provider: 'git', repository: 'https://git.example.test/team/repo.git' },
    agent: null,
    target: 'https://git.example.test/team/repo.git',
  },
  {
    label: 'credentialed VCS github',
    type: 'vcs',
    url: null,
    config: { provider: 'github', repository: 'team/repo' },
    agent: 'VcsClient/3',
    target: 'https://api.github.com/repos/team/repo',
  },
] as const;

describe.each([
  ['node:sqlite D1 binding', localBinding],
  ['Miniflare D1', miniflareBinding],
] as const)('Worker registry jobs wiring: %s', (_name, binding) => {
  it.each(listingCases)(
    '$label: consumes source-sync with source credentials and policy',
    async (fixture) => {
      const names = 'names' in fixture ? fixture.names : [];
      const { list: listing, describe, plugin } = createListingPlugin(names);
      const sent: { url: string; headers: Headers }[] = [];
      const transport: typeof fetch = async (input, init) => {
        sent.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(null, { status: 204 });
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
      const db = await binding();
      const executor = createD1Executor(db);
      await migrate(executor, await discoveredMigrations(), { holder: 'registry-jobs' });
      const org = orgContext(ulid());
      await createOrganizationBootstrap(executor).bootstrap({
        id: org.orgId,
        slug: 'registry',
        name: 'Registry',
        now: new Date().toISOString(),
      });
      const sourceId = ulid();
      const seed = (sql: string, params: SqlValue[]) => executor.batch([{ sql, params }]);
      await seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type, url, next_poll_at) VALUES (?, ?, 'upstream', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org', '2000-01-01T00:00:00.000Z')",
        [sourceId, org.orgId],
      );
      const kernelSpy = vi.spyOn(kernelModule, 'createKernel');
      const notifications: { v: number; org: string; job: string }[] = [];
      const env: Env = {
        DB: db,
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
        } as unknown as R2BucketLike,
        JOBS: {
          send: async (body) => {
            notifications.push(body as (typeof notifications)[number]);
          },
          sendBatch: async (batch) => {
            notifications.push(...batch.map(({ body }) => body as (typeof notifications)[number]));
          },
        },
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
        DEPLOYMENT_ID: 'registry-jobs',
      };
      const worker = createWorker([plugin], {
        platformPorts: {
          blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
          cache: { adapter: 'cache-api', namespace: 'registry-jobs' },
          jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 1 },
          observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
        },
        cacheStorage: {
          open: async () => ({
            match: async () => undefined,
            put: async () => undefined,
            delete: async () => false,
          }),
        },
        console: { log: () => undefined, error: () => undefined },
      });
      expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
        200,
      );
      const kernel: import('@package-broker/core/kernel/kernel').Kernel =
        await kernelSpy.mock.results.at(-1)!.value;
      expect(
        kernel.registration.jobs.filter((job) => job.qualifiedName === 'core:source-sync:v1'),
      ).toHaveLength(1);
      expect(
        kernel.registration.jobs.find((job) => job.qualifiedName === 'core:source-poll:v1')
          ?.definition.schedule,
      ).toEqual({ everySeconds: 60 });
      await worker.scheduled({}, env);
      await seed(
        "UPDATE job_schedule SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND name = ?",
        [org.orgId, 'core:source-poll:v1'],
      );
      await worker.scheduled({}, env);
      const repository = createJobRepository(executor);
      async function deliver(body: (typeof notifications)[number], state = 'succeeded') {
        const ack = vi.fn();
        const retry = vi.fn();
        const waited: Promise<unknown>[] = [];
        await worker.queue({ messages: [{ body, ack, retry }] }, env, {
          waitUntil: (work) => {
            waited.push(work);
          },
        });
        await Promise.all(waited);
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
        expect(await repository.status(org, body.job)).toMatchObject({ state });
      }
      const poll = await executor.all<{ id: string }>({
        sql: 'SELECT id FROM job WHERE org_id = ? AND type = ?',
        params: [org.orgId, 'core:source-poll:v1'],
      });
      expect(poll).toHaveLength(1);
      await deliver(notifications.find((n) => n.job === poll[0]!.id)!);
      const sync = await executor.all<{ id: string }>({
        sql: 'SELECT id FROM job WHERE org_id = ? AND type = ?',
        params: [org.orgId, 'core:source-sync:v1'],
      });
      expect(sync).toHaveLength(1);
      await deliver(notifications.find((n) => n.job === sync[0]!.id)!);
      expect(
        await executor.all({
          sql: 'SELECT last_success_at FROM source WHERE org_id = ? AND id = ?',
          params: [org.orgId, sourceId],
        }),
      ).toEqual([{ last_success_at: expect.any(String) }]);

      const token = ulid();
      const credentialId = await credentialStore(executor).put(org, {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token })),
      });
      const listingSource = ulid();
      await executor.batch([
        {
          sql: "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, credential_id, user_agent) VALUES (?, ?, 'listing', 'composer', ?, ?, ?, ?, ?)",
          params: [
            listingSource,
            org.orgId,
            fixture.type,
            fixture.url,
            JSON.stringify(fixture.config),
            credentialId,
            fixture.agent,
          ],
        },
      ]);
      if (names.length > 0)
        await executor.batch([
          {
            sql: "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')",
            params: [ulid(), org.orgId, listingSource],
          },
        ]);
      const queued = await repository.enqueue(org, {
        id: ulid(),
        type: 'core:source-sync:v1',
        payloadJson: JSON.stringify({ sourceId: listingSource, reason: 'admin' }),
        idempotencyKey: ulid(),
        resourceKey: `source:${listingSource}`,
        maxAttempts: 2,
        projectId: null,
        initiatorTokenId: null,
        runAt: null,
      });
      const unsupportedGit = 'provider' in fixture.config && fixture.config.provider === 'git';
      await deliver(
        { v: 1, org: org.orgId, job: queued.id },
        unsupportedGit ? 'queued' : 'succeeded',
      );
      if (unsupportedGit) {
        expect(listing).not.toHaveBeenCalled();
        expect(describe).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        expect(
          await executor.all({
            sql: "SELECT id FROM ingest_session WHERE org_id = ? AND source_id = ? AND state = 'complete'",
            params: [org.orgId, listingSource],
          }),
        ).toEqual([]);
        return;
      }
      expect(listing).toHaveBeenCalledOnce();
      expect(listing.mock.calls[0]![0].org).toEqual(org);
      const credential = listing.mock.calls[0]![0].credential;
      expect(credential).not.toBeNull();
      const applied = credential!.apply(new Headers(), new URL(fixture.target));
      expect(applied.headers.get('authorization') === `Bearer ${token}`).toBe(true);
      expect(
        credential!
          .apply(new Headers(), new URL('https://unrelated.example.test'))
          .headers.has('authorization'),
      ).toBe(false);
      expect(sent.map(({ url }) => url)).toEqual([fixture.target]);
      expect(sent[0]!.headers.get('user-agent')).toBe(fixture.agent ?? 'Composer/2.8.0');
      expect(sent[0]!.headers.get('authorization') === `Bearer ${token}`).toBe(true);
      expect(listing.mock.calls[0]![1].type).toBe(fixture.type);
      if (fixture.type === 'vcs') {
        expect(listing.mock.calls[0]![1].url).toBeNull();
        expect(listing.mock.calls[0]![1].config).toMatchObject({
          refs: { tags: true, branches: [] },
        });
      }

      expect(
        await executor.all({
          sql: "SELECT state FROM ingest_session WHERE org_id = ? AND source_id = ? AND scope = 'source'",
          params: [org.orgId, listingSource],
        }),
      ).toEqual([{ state: 'complete' }]);
      if (names.length > 0) {
        const children = await executor.all<{ id: string; payload_json: string }>({
          sql: 'SELECT id, payload_json FROM job WHERE org_id = ? AND type = ? ORDER BY payload_json',
          params: [org.orgId, 'core:package-sync:v1'],
        });
        expect(children.map((child) => JSON.parse(child.payload_json))).toEqual(
          names.map((key) => ({ sourceId: listingSource, key })),
        );
        for (const child of children)
          await deliver(notifications.find((notification) => notification.job === child.id)!);
        expect(
          await executor.all({
            sql: 'SELECT p.name, v.version FROM package p JOIN version v ON v.org_id = p.org_id AND v.package_id = p.id WHERE p.org_id = ? AND p.source_id = ? ORDER BY p.name, v.version',
            params: [org.orgId, listingSource],
          }),
        ).toEqual(
          names.flatMap((name) => ['1.0.0', '2.0.0'].map((version) => ({ name, version }))),
        );
        expect(
          await executor.all({
            sql: "SELECT package_key, state FROM ingest_session WHERE org_id = ? AND source_id = ? AND scope = 'package' ORDER BY package_key",
            params: [org.orgId, listingSource],
          }),
        ).toEqual(names.map((package_key) => ({ package_key, state: 'complete' })));
        expect(describe.mock.calls.map((call) => call[2]).sort()).toEqual(names);
        for (const [context, source] of describe.mock.calls) {
          expect(context.org).toEqual(org);
          expect(source.id).toBe(listingSource);
        }
      }
      listing.mockClear();

      const definition = kernel.registration.jobs.find(
        (job) => job.qualifiedName === 'core:source-sync:v1',
      )!;
      const scope = kernel.jobScope(definition, { jobId: ulid(), attempt: 1 });
      const context: JobContext = {
        ...scope,
        org,
        jobId: ulid(),
        attempt: 1,
        fence: 1,
        idempotencyKey: ulid(),
        signal: new AbortController().signal,
      };
      await verifyIsolation(executor, org.orgId, definition.definition.handler, context, listing);
    },
  );
});

function createListingPlugin(names: readonly string[] = []) {
  const list = vi.fn<NonNullable<SourceProvider['listPackages']>>(async (context, source) => {
    expect(context.org.orgId).toBeTruthy();
    if (source.type !== 'vcs') expect(source.config).toHaveProperty('distHosts', []);
    await expect(
      context.fetch({
        url: 'http://127.0.0.1/private',
        method: 'GET',
        maxBytes: 1024,
        timeoutMs: 1000,
        purpose: 'metadata',
        signal: context.signal,
      }),
    ).rejects.toMatchObject({ code: 'refused' });
    const target =
      source.type === 'vcs'
        ? source.config.provider === 'github'
          ? `https://api.github.com/repos/${source.config.repository}`
          : source.config.repository
        : source.url!;
    const response = await context.fetch({
      url: target,
      method: 'HEAD',
      maxBytes: 1024,
      timeoutMs: 1000,
      purpose: 'metadata',
      signal: context.signal,
      ...(context.credential === null ? {} : { credential: context.credential }),
    });
    expect(response.status).toBe(204);
    return { names, last: true, next: null, snapshot: { id: '"listing"' } };
  });
  const describe = vi.fn<SourceProvider['describe']>(async (_context, _source, name) => ({
    kind: 'found',
    description: createPackageDescription({
      name,
      snapshot: { id: '"versions"' },
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        for (const [ordinal, version] of ['1.0.0', '2.0.0'].entries())
          yield {
            ordinal,
            version,
            form: 'composer-p2' as const,
            raw: JSON.stringify({
              name,
              version,
              dist: { type: 'zip', url: `https://repo.example.test/${name}/${version}.zip` },
            }),
          };
      })(),
    }),
  }));
  const plugin: PluginDefinition = {
    id: 'listing',
    package: '@test/listing',
    apiVersion: 3,
    platforms: ['node', 'cloudflare'],
    binds: ['source'],
    sourceProviders: () =>
      ['composer', 'git', 'github'].map((id) => ({
        id,
        sourceTypes: id === 'composer' ? ['composer_repository'] : ['vcs'],
        ecosystems: ['composer'],
        listPackages: list,
        describe,
        openDist: vi.fn(),
      })),
  };
  return { list, describe, plugin };
}

async function verifyIsolation(
  executor: import('@package-broker/core/db/port').SqlExecutor,
  orgId: string,
  handler: (payload: unknown, context: JobContext) => Promise<void>,
  context: JobContext,
  listing: ReturnType<typeof createListingPlugin>['list'],
) {
  const otherOrg = ulid();
  const sourceId = ulid();
  await executor.batch([
    { sql: 'DROP INDEX organization_singleton', params: [] },
    {
      sql: "INSERT INTO organization (id, slug, name) VALUES (?, 'other', 'Other')",
      params: [otherOrg],
    },
  ]);
  const store = credentialStore(executor);
  const credentialId = await store.put(orgContext(otherOrg), {
    kind: 'bearer',
    projectId: null,
    plaintext: new TextEncoder().encode(JSON.stringify({ token: ulid() })),
  });
  await executor.batch([
    {
      sql: 'INSERT INTO source (id, org_id, name, ecosystem, type, url, credential_id, config_json) VALUES (?, ?, \'foreign\', \'composer\', \'vcs\', NULL, ?, \'{"provider":"git","repository":"https://git.example.test/team/repo.git"}\')',
      params: [sourceId, otherOrg, credentialId],
    },
  ]);
  await handler({ sourceId, reason: 'admin' }, context);
  expect(listing).not.toHaveBeenCalled();
  const ownSource = ulid();
  await executor.batch([
    {
      sql: 'INSERT INTO source (id, org_id, name, ecosystem, type, url, credential_id, config_json) VALUES (?, ?, \'own\', \'composer\', \'vcs\', NULL, ?, \'{"provider":"git","repository":"https://git.example.test/team/repo.git"}\')',
      params: [ownSource, orgId, credentialId],
    },
  ]);
  await expect(handler({ sourceId: ownSource, reason: 'admin' }, context)).rejects.toMatchObject({
    code: 'handler_error',
  });
  expect(listing).not.toHaveBeenCalled();
}

function credentialStore(executor: import('@package-broker/core/db/port').SqlExecutor) {
  return createCredentialStore({
    repository: createCredentialRepository(executor),
    cipher: createSecretCipher(
      createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      'credential-encryption',
    ),
    ids: { ulid },
    clock: systemClock,
  });
}
