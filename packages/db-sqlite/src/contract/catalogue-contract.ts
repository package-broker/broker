import { createNpmVcsEagerWriter } from '@package-broker/core/ingest/npm-vcs-enqueue';
import { applyChunk } from '@package-broker/core/ingest/apply-description';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import { npmVcsBuildJob } from '@package-broker/core/ingest/npm-vcs-build-job';
import { createDiscoveryRepositoryReader } from '../repositories/discovery.js';
import { createJobRepository } from '../repositories/job.js';
import { npmVcsBuildEnqueueInput } from '@package-broker/core/ingest/npm-vcs-build-job';
import { NPM_PACK_SKIP_CODES } from '@package-broker/core/sources/source-error-codes';
import { noopObservability } from '@package-broker/core/platform/observability';
import { createPackageSyncJob } from '@package-broker/core/ingest/package-sync-job';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createExistingVersionsReader } from '../repositories/existing-versions.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import { createUpstreamStateRepository } from '../repositories/upstream-state.js';
import { createPackageIdReads } from '../repositories/package-id.js';
import { createSourceRepository } from '../repositories/source.js';
import { createBlobReferenceReader } from '../repositories/blob-references.js';
import {
  npmVcsBuildRetryStatement,
  createNpmVcsBuildOutcomes,
  createNpmVcsBuildReader,
  createNpmVcsBuildPendingReader,
} from '../repositories/npm-vcs-build.js';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { distAttachStatements } from '../repositories/catalogue-write-dist.js';
import { versionUpdateStatements } from '../repositories/catalogue-write-version-update.js';
import { npmVersionInput } from '@package-broker/core/registry/npm/version-object';
import { npmVcsDescription } from '@package-broker/core/ingest/vcs/npm-adapter';
import { snapshotRef } from '@package-broker/core/sources/provider';
import { parseSha256 } from '@package-broker/core/platform/blob';
import { distTagStatements } from '../repositories/catalogue-write-tags.js';
import {
  admissionCondition,
  col,
  proxyEligibleCondition,
} from '../repositories/catalogue-predicates.js';
import { visibleWinner } from '../repositories/catalogue-read.js';
import { seedTwoOrganizations, type TwoOrganizations } from './two-organizations.js';
import { forgedItFor, withForeignKeysOff } from '../testing/foreign-keys-off.js';

interface Opened {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

const st = (text: string, ...params: Statement['params']): Statement => ({ sql: text, params });

export function describeCatalogueContract(
  name: string,
  open: () => Promise<Opened>,
  options: { readonly d1?: boolean } = {},
): void {
  const forgedIt = forgedItFor(options.d1 === true);
  describe(`catalogue org consistency contract: ${name}`, () => {
    let database: Opened;
    let executor: SqlExecutor;
    let orgs: TwoOrganizations;
    const batchForged = (statements: readonly Statement[]) =>
      withForeignKeysOff(executor, () => executor.batch(statements));

    beforeEach(async () => {
      database = await open();
      executor = database.executor;
      const directory = new URL('../../migrations/', import.meta.url);
      const sources = await Promise.all(
        readdirSync(directory)
          .filter((n) => n.endsWith('.sql'))
          .sort()
          .map((n) => loadMigrationSource('core', n, readFileSync(new URL(n, directory), 'utf8'))),
      );
      await migrate(executor, sources, { holder: 'catalogue-contract' });
      orgs = await seedTwoOrganizations(executor);
      await executor.batch([
        st("INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'P')", orgs.a.orgId),
        st(
          "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'npm', 'npm', 'npm_registry')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P', 'S', 100)",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K', ?, 'S', 'npm', 'widget')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, 'P', 'K', 'subscription', 'npm', 'widget')",
          orgs.a.orgId,
        ),
        st(
          `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, metadata_json)
          VALUES ('V', ?, 'K', '1.0.0', '1.0.0', 'stable', '2026-01-01T00:00:00.000Z', 'broker', '{}')`,
          orgs.a.orgId,
        ),
        st(
          `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
          VALUES ('J', ?, 'catalogue:sync:v1', 'j', 'running', 'owner', '2999-01-01T00:00:00.000Z', 1)`,
          orgs.a.orgId,
        ),
      ]);
    });

    afterEach(async () => {
      await database.close();
    });

    it.each(['npm', 'composer'] as const)(
      'scopes configured %s repository discovery by organization and source owner',
      async (ecosystem) => {
        const reader = createDiscoveryRepositoryReader(executor);
        await executor.batch([
          st(
            "INSERT INTO source (id,org_id,name,type,ecosystem,config_json) VALUES ('DS',?,'discovery','vcs',?,?)",
            orgs.a.orgId,
            ecosystem,
            JSON.stringify({ provider: 'github', repository: 'Owner/Repo' }),
          ),
        ]);
        expect(await reader.has(orgs.a, 'owner/repo', ecosystem)).toBe(true);
        expect(await reader.has(orgs.b, 'owner/repo', ecosystem)).toBe(false);
        expect(
          await reader.has(orgs.a, 'owner/repo', ecosystem === 'npm' ? 'composer' : 'npm'),
        ).toBe(false);
        expect(await reader.hasSourceName(orgs.a, 'discovery')).toBe(true);
        expect(await reader.hasSourceName(orgs.b, 'discovery')).toBe(false);
        await executor.batch([
          st("UPDATE source SET project_id='P' WHERE org_id=? AND id='DS'", orgs.a.orgId),
        ]);
        expect(await reader.has(orgs.a, 'owner/repo', ecosystem)).toBe(false);
        expect(await reader.hasSourceName(orgs.a, 'discovery')).toBe(false);
      },
    );

    it('persists terminal build outcomes by commit and policy and fences deliberate retries', async () => {
      const ctx = orgs.a;
      const commit = 'a'.repeat(40);
      await executor.batch([
        st("UPDATE source SET type='vcs' WHERE org_id=? AND id='S'", ctx.orgId),
        st(
          "UPDATE version SET source_ref=?,dist_type='tgz' WHERE org_id=? AND id='V'",
          commit,
          ctx.orgId,
        ),
      ]);
      const payload = {
        sourceId: 'S',
        packageId: 'K',
        versionId: 'V',
        version: '1.0.0',
        sourceRef: commit,
        packingPolicy: 'npm-pack-v1:1000',
        retryGeneration: 0,
      };
      const reader = createNpmVcsBuildReader(executor);
      const outcomes = createNpmVcsBuildOutcomes(executor);
      const lease = { id: 'J', owner: 'owner', fence: 1 };
      expect(await reader(ctx, payload)).not.toBeNull();
      await expect(outcomes.finish(orgs.b, lease, payload, 'too_large')).rejects.toThrow();
      await expect(
        outcomes.finish(ctx, { ...lease, fence: 2 }, payload, 'too_large'),
      ).rejects.toThrow();
      expect(await outcomes.terminal(ctx, payload)).toBe(false);
      await outcomes.start(ctx, lease, payload);
      const oldWriteGuard = outcomes.writeGuard(ctx, lease, payload);
      await outcomes.finish(ctx, lease, payload, 'too_large');
      expect(await outcomes.terminal(ctx, payload)).toBe(true);
      expect(await outcomes.terminal(orgs.b, payload)).toBe(false);
      expect(await outcomes.terminal(ctx, { ...payload, sourceId: 'other' })).toBe(false);
      expect(await outcomes.terminal(ctx, { ...payload, packageId: 'other' })).toBe(false);
      expect(await outcomes.terminal(ctx, { ...payload, packingPolicy: 'other' })).toBe(false);
      expect(await reader(ctx, payload)).toBeNull();
      expect(await reader(ctx, { ...payload, packingPolicy: 'npm-pack-v2:1000' })).not.toBeNull();
      await executor.batch([npmVcsBuildRetryStatement(orgs.b, 'S')]);
      expect(await reader(ctx, payload)).toBeNull();
      await executor.batch([npmVcsBuildRetryStatement(ctx, 'S')]);
      expect(await outcomes.terminal(ctx, payload)).toBe(false);
      await expect(executor.batch(oldWriteGuard)).rejects.toThrow();
      expect(await reader(ctx, payload)).toMatchObject({ retryGeneration: 1 });
      await expect(outcomes.finish(ctx, lease, payload, 'too_large')).rejects.toThrow();
      await executor.batch([
        st("UPDATE version SET source_ref=? WHERE org_id=? AND id='V'", 'b'.repeat(40), ctx.orgId),
      ]);
      await expect(
        outcomes.finish(ctx, lease, { ...payload, retryGeneration: 1 }, 'too_large'),
      ).rejects.toThrow();
      expect(await reader(ctx, { ...payload, sourceRef: 'b'.repeat(40) })).not.toBeNull();
    });

    it.each(['dead', 'succeeded'] as const)(
      'requeues an unattached %s build only in a later bucket',
      async (state) => {
        const ctx = orgs.a;
        const repository = createJobRepository(executor);
        const payload = { sourceId: 'S', packageId: 'K', versionId: 'V', version: '1.0.0' };
        const enqueue = (id: string, now: number) =>
          repository.enqueue(ctx, {
            id,
            type: 'core:npm-vcs-build:v1',
            payloadJson: JSON.stringify(payload),
            ...npmVcsBuildEnqueueInput(payload, now),
            runAt: null,
            maxAttempts: 3,
            projectId: null,
            initiatorTokenId: null,
          });
        const first = await enqueue('B1', 0);
        expect(first.created).toBe(true);
        await executor.batch([
          st('UPDATE job SET state=? WHERE org_id=? AND id=?', state, ctx.orgId, first.id),
        ]);
        expect(await enqueue('B2', 599999)).toEqual({ id: first.id, created: false });
        expect((await enqueue('B3', 600000)).created).toBe(true);
        const pending = createNpmVcsBuildPendingReader(executor);
        expect(await pending(ctx, 'V')).toBe(true);
        expect(await pending(orgs.b, 'V')).toBe(false);
        expect(await pending(ctx, 'other')).toBe(false);
        await executor.batch([
          st(
            "UPDATE job SET state='running',lease_owner='worker',lease_until='2999-01-01T00:00:00.000Z' WHERE org_id=? AND id='B3'",
            ctx.orgId,
          ),
        ]);
        expect(await pending(ctx, 'V')).toBe(true);
        await executor.batch([
          st("UPDATE job SET state='dead' WHERE org_id=? AND id='B3'", ctx.orgId),
        ]);
        expect(await pending(ctx, 'V')).toBe(false);
      },
    );

    it.each(NPM_PACK_SKIP_CODES)(
      'reports pack refusal %s only under the matching build lease',
      async (error) => {
        const ctx = orgs.a;
        const lease = { id: 'J', owner: 'owner', fence: 1 };
        const report = createSourceRepository(executor).reportCandidateSkipped!;
        await executor.batch([
          st(
            "UPDATE source SET type='vcs',consecutive_failures=3 WHERE org_id=? AND id='S'",
            ctx.orgId,
          ),
          st(
            "UPDATE job SET type='core:npm-vcs-build:v1',payload_json=? WHERE org_id=? AND id='J'",
            JSON.stringify({ sourceId: 'S' }),
            ctx.orgId,
          ),
        ]);
        for (const [org, guard, id] of [
          [orgs.b, lease, 'S'],
          [ctx, { ...lease, fence: 2 }, 'S'],
          [ctx, lease, 'other'],
        ] as const)
          await expect(report(org, guard, { id, error })).rejects.toThrow();
        await report(ctx, lease, { id: 'S', error });
        expect(
          await executor.all(
            st(
              "SELECT last_error,consecutive_failures FROM source WHERE org_id=? AND id='S'",
              ctx.orgId,
            ),
          ),
        ).toEqual([{ last_error: error, consecutive_failures: 3 }]);
        await executor.batch([
          st("UPDATE job SET type='core:package-sync:v1' WHERE org_id=? AND id='J'", ctx.orgId),
        ]);
        await expect(report(ctx, lease, { id: 'S', error })).rejects.toThrow();
      },
    );

    it('attaches VCS npm integrity once and accepts a subsequent dist-less sync', async () => {
      const ctx = orgs.a;
      const integrity = `sha512-${'A'.repeat(86)}==`;
      const manifest = { name: 'widget', version: '1.0.0', gitHead: 'a'.repeat(40) };
      const mapped = npmVersionInput(
        'widget',
        manifest,
        {},
        {
          kind: 'vcs',
          importedAt: '2026-01-01T00:00:00.000Z',
          probe: { secrets: [], queryParams: [] },
        },
      );
      if (!mapped.ok) throw new Error('unmapped fixture');
      await executor.batch([
        st("UPDATE source SET type='vcs' WHERE id='S' AND org_id=?", ctx.orgId),
        st(
          "UPDATE version SET metadata_json=?,source_ref=?,dist_type='tgz' WHERE id='V' AND org_id=?",
          mapped.input.metadata.json,
          manifest.gitHead,
          ctx.orgId,
        ),
        st(
          "INSERT INTO blob (id,org_id,sha256,size_bytes,storage_key) VALUES ('B',?,?,1,'npm-publish/test')",
          ctx.orgId,
          'a'.repeat(64),
        ),
      ]);
      const targetReader = createNpmVcsBuildReader(executor);
      const target = { sourceId: 'S', packageId: 'K', versionId: 'V' };
      expect(await targetReader(ctx, target)).toEqual({
        packageName: 'widget',
        version: '1.0.0',
        revision: 1,
        sourceRef: manifest.gitHead,
        retryGeneration: 0,
      });
      expect(await targetReader(orgs.b, target)).toBeNull();
      expect(await targetReader(ctx, { ...target, sourceId: 'foreign' })).toBeNull();
      const guard = createCatalogueWriteGuard(ctx, { id: 'J', owner: 'owner', fence: 1 });
      const input = {
        versionId: 'V',
        revision: 1,
        sha256: parseSha256('a'.repeat(64)),
        npmIntegrity: integrity,
        readme: { filename: 'README.md', body: '# fixture' },
        readmeTruncated: true,
      };
      const attach = distAttachStatements(ctx, guard, input);
      expect(attach.result(await executor.batch(attach.statements)).changed).toBe(true);
      expect(
        await executor.all(
          st(
            "SELECT json_extract(metadata_json, '$.readmeTruncated') AS truncated FROM version WHERE org_id=? AND id='V'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ truncated: 1 }]);
      expect(
        await executor.all(
          st("SELECT npm_integrity AS integrity FROM version WHERE org_id=? AND id='V'", ctx.orgId),
        ),
      ).toEqual([{ integrity }]);
      expect(await targetReader(ctx, target)).toBeNull();
      expect(
        await executor.all(
          st(
            "SELECT filename,body FROM version_readme WHERE org_id=? AND version_id='V'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ filename: 'README.md', body: '# fixture' }]);
      const replay = distAttachStatements(ctx, guard, {
        ...input,
        npmIntegrity: `sha512-${'B'.repeat(86)}==`,
      });
      await expect(executor.batch(replay.statements)).rejects.toThrow();
      expect(
        await executor.all(
          st("SELECT npm_integrity AS integrity FROM version WHERE org_id=? AND id='V'", ctx.orgId),
        ),
      ).toEqual([{ integrity }]);
      const update = versionUpdateStatements(ctx, guard, {
        packageId: 'K',
        ecosystem: 'npm',
        versions: [mapped.input],
      });
      expect(update.result(await executor.batch(update.statements)).refused).toEqual([]);
      await executor.batch([
        st("UPDATE source SET type='npm_registry' WHERE id='S' AND org_id=?", ctx.orgId),
      ]);
      const registry = versionUpdateStatements(ctx, guard, {
        packageId: 'K',
        ecosystem: 'npm',
        versions: [mapped.input],
      });
      expect(registry.result(await executor.batch(registry.statements)).conflicts).toEqual([
        '1.0.0',
      ]);
    });

    it.each([false, true])(
      'counts eager enqueue within the ceiling after terminal retry=%s',
      async (retry) => {
        const ctx = orgs.a;
        await executor.batch([
          st("UPDATE source SET type='vcs' WHERE org_id=? AND id='S'", ctx.orgId),
          st(
            "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('ER',?,'S','npm','widget')",
            ctx.orgId,
          ),
        ]);
        let count = 0;
        const counted: SqlExecutor = {
          driver: executor.driver,
          all(statement) {
            count++;
            return executor.all(statement);
          },
          batch(statements) {
            count += statements.length;
            return executor.batch(statements);
          },
        };
        const clock = { now: () => new Date() };
        let ids = 0;
        const jobs = createRepositoryJobs({
          store: createJobRepository(counted),
          jobs: [{ qualifiedName: 'core:npm-vcs-build:v1', definition: npmVcsBuildJob }],
          clock,
          ids: { ulid: () => `Eager${++ids}` },
        })('core', { projectId: null, tokenId: null });
        const existing = createExistingVersionsReader(counted);
        const sessions = createIngestSessions(counted);
        const writer = createNpmVcsEagerWriter(createCatalogueWriter(counted), {
          sources: createSourceRepository(counted),
          existing,
          jobs,
          target: createNpmVcsBuildReader(counted),
          packingPolicy: 'npm-pack-v1:1000',
          clock,
        });
        const scope = { scope: 'package', sourceId: 'S', packageKey: 'widget' } as const;
        const initialSession = await sessions.acquire(ctx, scope, 'eager', 300);
        if (initialSession === 'held') throw new Error('held');
        let session = initialSession;
        const tags = Array.from({ length: 50 }, (_, i) => `1.1.${i}`);
        const description = () =>
          npmVcsDescription(
            'widget',
            undefined,
            tags,
            tags.map((version) => ({
              ref: `refs/tags/${version}`,
              commit: 'a'.repeat(40),
              text: JSON.stringify({ name: 'widget', version }),
            })),
            snapshotRef('sha256:' + 'b'.repeat(64)),
          );
        const deps = { writer, existing, sessions, finalizer: createIngestFinalizer(counted) };
        const sync = async () => {
          let invocations = 0;
          for (;;) {
            count = 0;
            const result = await applyChunk(ctx, deps, {
              session,
              guard: createIngestSessionWriteGuard(ctx, session),
              source: { id: 'S', key: 'widget', type: 'vcs', ecosystem: 'npm', covered: true },
              description: await description(),
              packageDescription: null,
              validatorTtlSeconds: 0,
              toVersion(candidate) {
                const mapped = npmVersionInput(
                  'widget',
                  JSON.parse(candidate.raw),
                  {},
                  {
                    kind: 'vcs',
                    importedAt: '2026-01-01T00:00:00.000Z',
                    probe: { secrets: [], queryParams: [] },
                  },
                );
                if (!mapped.ok) throw new Error('unmapped');
                return mapped.input;
              },
            });
            invocations++;
            expect(count).toBeLessThanOrEqual(result.planned);
            expect(count).toBeLessThanOrEqual(450);
            session = result.session;
            if (result.done) {
              expect(result.status).toBe('complete');
              break;
            }
            expect(result.cursor).not.toBeNull();
            if (invocations > 10) throw new Error('unbounded continuation');
          }
          return invocations;
        };
        expect(await sync()).toBeGreaterThan(1);
        if (retry) {
          const outcomes = createNpmVcsBuildOutcomes(executor);
          const builds = await executor.all<{ payload_json: string }>(
            st(
              "SELECT payload_json FROM job WHERE org_id=? AND type='core:npm-vcs-build:v1'",
              ctx.orgId,
            ),
          );
          expect(builds).toHaveLength(50);
          for (const build of builds) {
            const payload = JSON.parse(build.payload_json);
            await outcomes.finish(ctx, { id: 'J', owner: 'owner', fence: 1 }, payload, 'too_large');
            expect(await outcomes.terminal(ctx, payload)).toBe(true);
          }
          await executor.batch([
            st(
              "UPDATE job SET state='dead' WHERE org_id=? AND type='core:npm-vcs-build:v1'",
              ctx.orgId,
            ),
            npmVcsBuildRetryStatement(ctx, 'S'),
          ]);
          for (const build of builds) {
            expect(await outcomes.terminal(ctx, JSON.parse(build.payload_json))).toBe(false);
          }
          const retrySession = await sessions.acquire(ctx, scope, 'retry', 300);
          if (retrySession === 'held') throw new Error('held');
          session = retrySession;
          const retryInvocations = await sync();
          const queued = await executor.all<{ payload_json: string }>(
            st(
              "SELECT payload_json FROM job WHERE org_id=? AND type='core:npm-vcs-build:v1' AND state='queued'",
              ctx.orgId,
            ),
          );
          expect(queued).toHaveLength(50);
          expect(retryInvocations).toBeGreaterThan(1);
          for (const build of queued) {
            expect(JSON.parse(build.payload_json)).toMatchObject({ retryGeneration: 1 });
          }
        }
        expect(
          await executor.all(
            st(
              "SELECT count(*) AS total FROM job WHERE org_id=? AND type='core:npm-vcs-build:v1'",
              ctx.orgId,
            ),
          ),
        ).toEqual([{ total: retry ? 100 : 50 }]);
      },
    );

    it('configured npm VCS name mismatch yields zero versions and one source report', async () => {
      const ctx = orgs.a;
      await executor.batch([
        st(
          "UPDATE source SET type='vcs',config_json=? WHERE org_id=? AND id='S'",
          JSON.stringify({
            provider: 'github',
            repository: 'owner/repo',
            packageName: '@scope/a',
            refs: { tags: true, branches: [] },
          }),
          ctx.orgId,
        ),
      ]);
      await executor.batch([
        st(
          "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('R',?,'S','npm','@scope/a')",
          ctx.orgId,
        ),
      ]);
      await executor.batch([
        st(
          "UPDATE job SET type='core:package-sync:v1',payload_json=? WHERE org_id=? AND id='J'",
          JSON.stringify({ sourceId: 'S', key: '@scope/a' }),
          ctx.orgId,
        ),
      ]);
      const sessions = createIngestSessions(executor);
      const lease = { id: 'J', owner: 'owner', fence: 1 };
      const job = createPackageSyncJob({
        sessions,
        apply: {
          writer: createCatalogueWriter(executor),
          sessions,
          existing: createExistingVersionsReader(executor),
          finalizer: createIngestFinalizer(executor),
        },
        jobs: {
          enqueue: async () => {
            throw new Error('unexpected continuation');
          },
        },
        executor,
        upstreamState: createUpstreamStateRepository(executor),
        sourceMetadata: async () => ({ type: 'vcs' }),
        findPackageId: (org, sourceId, key) =>
          createPackageIdReads(executor).packageId(org, sourceId, key),
        planFill: async () => ({
          source: { id: 'S', key: '@scope/a', type: 'vcs', ecosystem: 'npm', covered: true },
          describe: async () => ({
            kind: 'found',
            description: await npmVcsDescription(
              '@scope/a',
              '@scope/a',
              ['v1.0.0'],
              [
                {
                  ref: 'refs/tags/v1.0.0',
                  commit: 'a'.repeat(40),
                  text: '{"name":"@scope/b","version":"1.0.0"}',
                },
              ],
              snapshotRef('sha256:' + 'a'.repeat(64)),
            ),
          }),
          toVersion: () => {
            throw new Error('mismatched candidate reached mapper');
          },
          packageDescription: null,
          validatorTtlSeconds: 0,
          publishedValidators: {},
        }),
        writeGuard: (org, session, job) => createIngestSessionWriteGuard(org, session, job),
        clock: { now: () => new Date() },
        reportSkipped: async (context, sourceId, code) => {
          await createSourceRepository(executor).reportCandidateSkipped!(context.org, lease, {
            id: sourceId,
            error: code as 'name_mismatch',
          });
        },
      });
      await job.handler({ sourceId: 'S', key: '@scope/a' }, {
        org: ctx,
        jobId: 'J',
        observability: noopObservability,
        fences: jobFences(lease),
        signal: new AbortController().signal,
      } as JobContext);
      expect(
        await executor.all(
          st(
            "SELECT v.id FROM version v JOIN package p ON p.id=v.package_id AND p.org_id=v.org_id WHERE v.org_id=? AND p.name IN ('@scope/a','@scope/b')",
            ctx.orgId,
          ),
        ),
      ).toEqual([]);
      expect(
        await executor.all(
          st(
            "SELECT last_error,consecutive_failures FROM source WHERE org_id=? AND id='S'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ last_error: 'name_mismatch', consecutive_failures: 0 }]);
      expect(
        await executor.all(
          st("SELECT id FROM registered_name WHERE org_id=? AND pattern='@scope/b'", ctx.orgId),
        ),
      ).toEqual([]);
    });

    it.each([null, '{'])(
      'skips an invalid old manifest and applies the complete newer catalogue',
      async (text) => {
        const ctx = orgs.a;
        await executor.batch([
          st(
            "UPDATE source SET type='vcs',config_json=? WHERE org_id=? AND id='S'",
            JSON.stringify({
              provider: 'github',
              repository: 'owner/repo',
              packageName: '@scope/a',
              refs: { tags: true, branches: [] },
            }),
            ctx.orgId,
          ),
        ]);
        await executor.batch([
          st(
            "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('R',?,'S','npm','@scope/a')",
            ctx.orgId,
          ),
        ]);
        await executor.batch([
          st(
            "UPDATE job SET type='core:package-sync:v1',payload_json=? WHERE org_id=? AND id='J'",
            JSON.stringify({ sourceId: 'S', key: '@scope/a' }),
            ctx.orgId,
          ),
        ]);
        const sessions = createIngestSessions(executor);
        const lease = { id: 'J', owner: 'owner', fence: 1 };
        const job = createPackageSyncJob({
          sessions,
          apply: {
            writer: createCatalogueWriter(executor),
            sessions,
            existing: createExistingVersionsReader(executor),
            finalizer: createIngestFinalizer(executor),
          },
          jobs: {
            enqueue: async () => {
              throw new Error('unexpected continuation');
            },
          },
          executor,
          upstreamState: createUpstreamStateRepository(executor),
          sourceMetadata: async () => ({ type: 'vcs' }),
          findPackageId: (org, sourceId, key) =>
            createPackageIdReads(executor).packageId(org, sourceId, key),
          planFill: async () => ({
            source: { id: 'S', key: '@scope/a', type: 'vcs', ecosystem: 'npm', covered: true },
            describe: async () => ({
              kind: 'found',
              description: await npmVcsDescription(
                '@scope/a',
                '@scope/a',
                ['v1.0.0', 'v2.0.0', 'v3.0.0'],
                [
                  {
                    ref: 'refs/tags/v1.0.0',
                    commit: 'a'.repeat(40),
                    text,
                  },
                  ...['2.0.0', '3.0.0'].map((version) => ({
                    ref: `refs/tags/v${version}`,
                    commit: 'a'.repeat(40),
                    text: JSON.stringify({ name: '@scope/a', version }),
                  })),
                ],
                snapshotRef('sha256:' + 'a'.repeat(64)),
              ),
            }),
            toVersion: (candidate) => {
              const result = npmVersionInput(
                '@scope/a',
                JSON.parse(candidate.raw),
                {},
                {
                  kind: 'vcs',
                  importedAt: '2026-01-01T00:00:00.000Z',
                  probe: { secrets: [], queryParams: [] },
                },
              );
              return result.ok ? result.input : null;
            },
            packageDescription: null,
            validatorTtlSeconds: 0,
            publishedValidators: {},
          }),
          writeGuard: (org, session, job) => createIngestSessionWriteGuard(org, session, job),
          clock: { now: () => new Date() },
          reportSkipped: async (context, sourceId, code) => {
            await createSourceRepository(executor).reportCandidateSkipped!(context.org, lease, {
              id: sourceId,
              error: code as 'name_mismatch',
            });
          },
        });
        await job.handler({ sourceId: 'S', key: '@scope/a' }, {
          org: ctx,
          jobId: 'J',
          observability: noopObservability,
          fences: jobFences(lease),
          signal: new AbortController().signal,
        } as JobContext);
        expect(
          await executor.all(
            st(
              "SELECT v.version FROM version v JOIN package p ON p.id=v.package_id AND p.org_id=v.org_id WHERE v.org_id=? AND p.name IN ('@scope/a','@scope/b') ORDER BY v.version",
              ctx.orgId,
            ),
          ),
        ).toEqual([{ version: '2.0.0' }, { version: '3.0.0' }]);
        expect(
          await executor.all(
            st(
              "SELECT last_error,consecutive_failures FROM source WHERE org_id=? AND id='S'",
              ctx.orgId,
            ),
          ),
        ).toEqual([{ last_error: 'invalid_manifest', consecutive_failures: 0 }]);
        expect(
          await executor.all(
            st("SELECT id FROM registered_name WHERE org_id=? AND pattern='@scope/b'", ctx.orgId),
          ),
        ).toEqual([]);
      },
    );

    it('candidate reporting requires the live package-sync lease for the same organization and source', async () => {
      const ctx = orgs.a;
      await executor.batch([
        st("UPDATE source SET type='vcs' WHERE org_id=? AND id='S'", ctx.orgId),
        st(
          "UPDATE job SET type='core:package-sync:v1',payload_json=? WHERE org_id=? AND id='J'",
          JSON.stringify({ sourceId: 'S' }),
          ctx.orgId,
        ),
      ]);
      const report = createSourceRepository(executor).reportCandidateSkipped!;
      const lease = { id: 'J', owner: 'owner', fence: 1 };
      for (const [org, guard, id] of [
        [orgs.b, lease, 'S'],
        [ctx, { ...lease, fence: 2 }, 'S'],
        [ctx, lease, 'other'],
      ] as const) {
        await expect(report(org, guard, { id, error: 'name_mismatch' })).rejects.toThrow();
      }
      await executor.batch([
        st("UPDATE job SET type='other:v1' WHERE org_id=? AND id='J'", ctx.orgId),
      ]);
      await expect(report(ctx, lease, { id: 'S', error: 'name_mismatch' })).rejects.toThrow();
      await expect(
        report(ctx, lease, { id: 'S', error: 'untrusted' as 'name_mismatch' }),
      ).rejects.toThrow('invalid_candidate_report');
      expect(
        await executor.all(
          st(
            "SELECT last_error,consecutive_failures FROM source WHERE org_id=? AND id='S'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ last_error: null, consecutive_failures: 0 }]);
    });

    it('two planned builds attach once; the losing promoted blob stays orphaned until seven days', async () => {
      const ctx = orgs.a;
      await executor.batch([
        st("UPDATE source SET type='vcs' WHERE org_id=? AND id='S'", ctx.orgId),
        ...['a', 'b'].map((digit) =>
          st(
            'INSERT INTO blob (id,org_id,sha256,size_bytes,storage_key,refetchable) VALUES (?,?,?,1,?,0)',
            digit,
            ctx.orgId,
            digit.repeat(64),
            'npm-publish/' + digit,
          ),
        ),
      ]);
      const guard = createCatalogueWriteGuard(ctx, { id: 'J', owner: 'owner', fence: 1 });
      const plans = ['a', 'b'].map((digit) =>
        distAttachStatements(ctx, guard, {
          versionId: 'V',
          revision: 1,
          sha256: parseSha256(digit.repeat(64)),
          npmIntegrity: `sha512-${digit.toUpperCase().repeat(86)}==`,
          readme: { filename: 'README.md', body: digit },
        }),
      );
      const results = await Promise.allSettled(
        plans.map((plan) => executor.batch(plan.statements)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const winner = results[0]!.status === 'fulfilled' ? 'a' : 'b';
      const loser = winner === 'a' ? 'b' : 'a';
      expect(
        await executor.all(
          st(
            "SELECT blob_id,npm_integrity,revision FROM version WHERE org_id=? AND id='V'",
            ctx.orgId,
          ),
        ),
      ).toEqual([
        {
          blob_id: winner,
          npm_integrity: `sha512-${winner.toUpperCase().repeat(86)}==`,
          revision: 1,
        },
      ]);
      expect(
        await executor.all(
          st("SELECT body FROM version_readme WHERE org_id=? AND version_id='V'", ctx.orgId),
        ),
      ).toEqual([{ body: winner }]);
      expect(
        await executor.all(st("SELECT rev FROM package WHERE org_id=? AND id='K'", ctx.orgId)),
      ).toEqual([{ rev: 2 }]);
      const reader = createBlobReferenceReader(executor);
      expect(await reader.candidates(ctx, { limit: 50 })).toEqual([]);
      expect(
        await executor.all(
          st(
            'SELECT id FROM blob WHERE org_id=? AND id=? AND NOT EXISTS (SELECT 1 FROM version WHERE blob_id=blob.id) AND NOT EXISTS (SELECT 1 FROM version_revision WHERE blob_id=blob.id)',
            ctx.orgId,
            loser,
          ),
        ),
      ).toEqual([{ id: loser }]);
      await executor.batch([
        st(
          "UPDATE blob SET created_at='2020-01-01T00:00:00.000Z',published_at='2020-01-01T00:00:00.000Z' WHERE org_id=?",
          ctx.orgId,
        ),
      ]);
      expect(await reader.candidates(ctx, { limit: 50 })).toEqual([
        expect.objectContaining({ id: loser, orphan: true }),
      ]);
      expect(await reader.candidates(orgs.b, { limit: 50 })).toEqual([]);
    });

    forgedIt('a foreign tag collision produces no history, change or revision bump', async () => {
      await batchForged([
        st(
          "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, 'K', 'latest', 'V')",
          orgs.b.orgId,
        ),
      ]);
      const clock = () => executor.all(st("SELECT rev, modified_at FROM package WHERE id = 'K'"));
      const before = await clock();
      const guard = createCatalogueWriteGuard(orgs.a, { id: 'J', owner: 'owner', fence: 1 });
      const plan = distTagStatements(orgs.a, guard, {
        packageId: 'K',
        ecosystem: 'npm',
        tags: { latest: '1.0.0' },
        actorType: 'sync',
        actorId: null,
        opId: 'contract-tags',
      });
      expect(plan.result(await executor.batch(plan.statements))).toMatchObject({
        updated: 0,
        unchanged: 1,
      });
      expect(await executor.all(st('SELECT * FROM dist_tag_history'))).toEqual([]);
      expect(await clock()).toEqual(before);
      expect(await executor.all(st('SELECT org_id, version_id FROM dist_tag'))).toEqual([
        { org_id: orgs.b.orgId, version_id: 'V' },
      ]);
    });

    for (const [effect, pattern] of [
      ['exclude', 'widget'],
      ['include', 'other/*'],
      ['exclude', 'bad?'],
    ] as const) {
      forgedIt(`ignores a mismatched-org ${effect} pattern ${pattern}`, async () => {
        await batchForged([
          st(
            `INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect)
          VALUES ('PAT', ?, 'P', 'S', ?, ?)`,
            orgs.b.orgId,
            pattern,
            effect,
          ),
        ]);
        const query = db
          .selectFrom('package as pkg')
          .select('pkg.id')
          .where(
            admissionCondition(
              orgs.a,
              sql.lit('P'),
              col('pkg.source_id'),
              col('pkg.name'),
              col('pkg.visible_to_new_projects'),
            ),
          );
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    forgedIt('a foreign include cannot admit a package excluded by own includes', async () => {
      await batchForged([
        st(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('OWN', ?, 'P', 'S', 'other/*', 'include')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('FOREIGN', ?, 'P', 'S', 'widget', 'include')",
          orgs.b.orgId,
        ),
      ]);
      const query = db
        .selectFrom('package as pkg')
        .select('pkg.id')
        .where(
          admissionCondition(
            orgs.a,
            sql.lit('P'),
            col('pkg.source_id'),
            col('pkg.name'),
            col('pkg.visible_to_new_projects'),
          ),
        );
      expect(await executor.all(compile(query))).toEqual([]);
    });

    for (const effect of ['include', 'exclude'] as const) {
      forgedIt(`foreign ${effect} patterns do not count towards the limit`, async () => {
        await batchForged(
          Array.from({ length: 65 }, (_, i) =>
            st(
              "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, 'P', 'S', ?, ?)",
              `PAT${i}`,
              orgs.b.orgId,
              `other/${i}`,
              effect,
            ),
          ),
        );
        const query = db
          .selectFrom('package as pkg')
          .select('pkg.id')
          .where(
            admissionCondition(
              orgs.a,
              sql.lit('P'),
              col('pkg.source_id'),
              col('pkg.name'),
              col('pkg.visible_to_new_projects'),
            ),
          );
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    for (const mismatch of ['package', 'source', 'registered_name'] as const) {
      forgedIt(`a competing foreign ${mismatch} does not shadow a proxy`, async () => {
        await batchForged([
          st("UPDATE source SET type = 'npmjs_proxy' WHERE id = 'S'"),
          st(
            "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('OTHER', ?, 'other', 'npm', 'npm_registry')",
            mismatch === 'package' ? orgs.a.orgId : orgs.b.orgId,
          ),
          mismatch === 'registered_name'
            ? st(
                "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'OTHER', 'npm', 'widget')",
                orgs.b.orgId,
              )
            : st(
                "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('OTHER-K', ?, 'OTHER', 'npm', 'widget')",
                mismatch === 'package' ? orgs.b.orgId : orgs.a.orgId,
              ),
        ]);
        const query = db
          .selectFrom('package as pkg')
          .innerJoin('source as src', 'src.id', 'pkg.source_id')
          .select('pkg.id')
          .where('pkg.id', '=', 'K')
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }));
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    for (const table of [
      'project_package',
      'project_source',
      'source',
      'package',
      'project',
    ] as const) {
      forgedIt(`a mismatched-org ${table} row cannot supply the visible winner`, async () => {
        expect(
          await executor.all(compile(visibleWinner(orgs.a, 'P', 'npm', 'widget'))),
        ).toHaveLength(1);
        await batchForged([st(`UPDATE ${table} SET org_id = ?`, orgs.b.orgId)]);
        expect(await executor.all(compile(visibleWinner(orgs.a, 'P', 'npm', 'widget')))).toEqual(
          [],
        );
      });
    }
  });
}
