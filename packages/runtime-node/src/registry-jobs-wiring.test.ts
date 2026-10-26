import { generateKeyPairSync } from 'node:crypto';
import * as sshProvider from './sources/ssh-provider.js';
import * as guardedFetch from './sources/guarded-fetch.js';
import type { SourceProvider } from '@package-broker/core/sources/provider';
import { createPackageDescription } from '@package-broker/core/sources/provider';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { startNode } from './startup.js';

afterEach(() => vi.restoreAllMocks());

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
  {
    label: 'credentialed VCS ssh',
    type: 'vcs',
    url: null,
    config: { provider: 'ssh', repository: 'git@git.example.test:team/repo.git' },
    agent: null,
    target: 'https://git.example.test/team/repo.git',
  },
] as const;

describe('Node registry jobs wiring', () => {
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
      vi.spyOn(guardedFetch, 'createGuardedFetch').mockReturnValue(transport);
      const isSsh =
        fixture.config && 'provider' in fixture.config && fixture.config.provider === 'ssh';
      const privateKeyPem = generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const createSshProvider = sshProvider.createSshGitProvider;
      if (isSsh)
        vi.spyOn(sshProvider, 'createSshGitProvider').mockImplementation((options) => ({
          ...createSshProvider(options),
          listPackages: async (context, source, cursor) => {
            const key = await options.sshKey(source);
            expect(key.kind).toBe('ssh_key');
            expect(key.privateKeyPem === privateKeyPem).toBe(true);
            return listing(context, source, cursor);
          },
        }));
      await mkdir(join(process.cwd(), '.pb'), { recursive: true });
      const directory = await realpath(await mkdtemp(join(process.cwd(), '.pb', 'registry-jobs-')));
      let broker: Awaited<ReturnType<typeof startNode>> | undefined;
      let database: ReturnType<typeof openBetterSqliteExecutor> | undefined;
      try {
        const path = join(directory, 'broker.sqlite');
        broker = await startNode({
          plugins: [plugin],
          migrations: await discoveredMigrations(),
          env: {
            PB_SQLITE_PATH: path,
            PB_BLOB_ROOT: join(directory, 'blobs'),
            PB_ORG_SLUG: 'registry',
            PB_ORG_NAME: 'Registry',
            PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            PB_PUBLIC_URL: 'http://127.0.0.1',
            DEPLOYMENT_ID: 'registry-test',
          },
          platformPorts: {
            blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
            cache: { adapter: 'lru', maxBytes: 1024 },
            jobs: { adapter: 'database', maxRunning: 1 },
            observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
          },
          stdout: { write: () => true, on: () => undefined },
          stderr: { write: () => true, on: () => undefined },
        });
        database = openBetterSqliteExecutor(path);
        const { executor } = database;
        const identity = await createOrganizationBootstrap(executor).findSingleton();
        const org = orgContext(identity!.id);
        const kernel = await broker.ready();
        expect(
          kernel.registration.jobs.filter((job) => job.qualifiedName === 'core:source-sync:v1'),
        ).toHaveLength(1);
        expect(
          kernel.registration.jobs.find((job) => job.qualifiedName === 'core:source-poll:v1')
            ?.definition.schedule,
        ).toEqual({ everySeconds: 60 });
        const sourceId = ulid();
        await executor.batch([
          {
            sql: "INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES (?, ?, 'upstream', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org')",
            params: [sourceId, org.orgId],
          },
        ]);
        const repository = createJobRepository(executor);
        const { id } = await repository.enqueue(org, {
          id: ulid(),
          type: 'core:source-sync:v1',
          payloadJson: JSON.stringify({ sourceId, reason: 'admin' }),
          idempotencyKey: ulid(),
          maxAttempts: 2,
          resourceKey: `source:${sourceId}`,
          projectId: null,
          initiatorTokenId: null,
          runAt: null,
        });
        await vi.waitFor(
          async () => {
            expect(await repository.status(org, id)).toMatchObject({ state: 'succeeded' });
          },
          { timeout: 10_000, interval: 25 },
        );
        expect(
          await executor.all({
            sql: 'SELECT last_success_at, consecutive_failures FROM source WHERE org_id = ? AND id = ?',
            params: [org.orgId, sourceId],
          }),
        ).toEqual([{ last_success_at: expect.any(String), consecutive_failures: 0 }]);

        const token = ulid();
        const credentialId = await credentialStore(executor).put(org, {
          kind: isSsh ? 'ssh_key' : 'bearer',
          projectId: null,
          plaintext: new TextEncoder().encode(
            JSON.stringify(
              isSsh
                ? { privateKeyPem, knownHosts: 'git.example.test ssh-ed25519 AAAA' }
                : { token },
            ),
          ),
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
        await vi.waitFor(
          async () => {
            expect(await repository.status(org, queued.id)).toMatchObject({ state: 'succeeded' });
          },
          { timeout: 10_000, interval: 25 },
        );
        expect(listing).toHaveBeenCalledOnce();
        expect(listing.mock.calls[0]![0].org).toEqual(org);
        const credential = listing.mock.calls[0]![0].credential;
        expect(credential).not.toBeNull();
        const applied = credential!.apply(new Headers(), new URL(fixture.target));
        expect(applied.headers.get('authorization') === (isSsh ? null : `Bearer ${token}`)).toBe(
          true,
        );
        expect(
          credential!
            .apply(new Headers(), new URL('https://unrelated.example.test'))
            .headers.has('authorization'),
        ).toBe(false);
        expect(sent.map(({ url }) => url)).toEqual([fixture.target]);
        expect(sent[0]!.headers.get('user-agent')).toBe(fixture.agent ?? 'Composer/2.8.0');
        expect(sent[0]!.headers.get('authorization') === (isSsh ? null : `Bearer ${token}`)).toBe(
          true,
        );
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
          await vi.waitFor(
            async () => {
              const children = await executor.all<{ id: string; payload_json: string }>({
                sql: 'SELECT id, payload_json FROM job WHERE org_id = ? AND type = ? ORDER BY payload_json',
                params: [org.orgId, 'core:package-sync:v1'],
              });
              expect(children.map((child) => JSON.parse(child.payload_json))).toEqual(
                names.map((key) => ({
                  sourceId: listingSource,
                  key,
                  syncGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
                })),
              );
              for (const child of children)
                expect(await repository.status(org, child.id)).toMatchObject({
                  state: 'succeeded',
                });
            },
            { timeout: 10_000, interval: 25 },
          );
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

        const sync = kernel.registration.jobs.find(
          (job) => job.qualifiedName === 'core:source-sync:v1',
        )!;
        const scope = kernel.jobScope(sync, { jobId: ulid(), attempt: 1 });
        const context: JobContext = {
          ...scope,
          org,
          jobId: ulid(),
          attempt: 1,
          fence: 1,
          idempotencyKey: ulid(),
          signal: new AbortController().signal,
        };
        await verifyIsolation(executor, org.orgId, sync.definition.handler, context, listing);
      } finally {
        await broker?.close();
        await database?.close();
        await rm(directory, { recursive: true, force: true });
      }
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
          : source.config.provider === 'ssh'
            ? 'https://git.example.test/team/repo.git'
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
