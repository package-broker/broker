import { describe, expect, it } from 'vitest';
import { delegatedMutationFence } from '@package-broker/core/authz/fence';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { VersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { runImportApply } from '@package-broker/core/import/apply';
import {
  parseManifest,
  planHash,
  type Manifest,
  type ParsedManifest,
} from '@package-broker/core/import/manifest';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { applyChunk } from '@package-broker/core/ingest/apply-description';
import { INVOCATION_BUDGET } from '@package-broker/core/ingest/plan-chunk';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createPackageDescription, snapshotRef } from '@package-broker/core/sources/provider';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createExistingVersionsReader } from '../repositories/existing-versions.js';
import { createImportJournalStore } from '../repositories/import-journal.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';

interface Fixture {
  readonly executor: SqlExecutor;
  readonly ctx: OrgContext;
  close(): Promise<void>;
}
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const job = { id: 'job', owner: 'worker', fence: 1 };
const source = {
  id: 'source',
  key: 'widget',
  type: 'npm_registry' as const,
  ecosystem: 'npm' as const,
  covered: true,
};
const version: VersionInput = {
  version: '1.0.0',
  versionNormalized: '1.0.0',
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  history: { basis: 'release_date', at: '2020-01-01T00:00:00.000Z' },
  metadata: normalizeVersionMetadata('npm', { name: 'widget', version: '1.0.0' }),
};

function counting(executor: SqlExecutor) {
  const batches: number[] = [];
  let statements = 0;
  const counted: SqlExecutor = {
    driver: executor.driver,
    all<R>(s: Statement) {
      statements++;
      return executor.all<R>(s);
    },
    batch(batch) {
      expect(batch.length).toBeLessThanOrEqual(200);
      batches.push(batch.length);
      statements += batch.length;
      return executor.batch(batch);
    },
  };
  return {
    executor: counted,
    batches,
    take() {
      const n = statements;
      statements = 0;
      return n;
    },
  };
}

async function seedCatalogue({ executor, ctx }: Fixture) {
  await executor.batch([
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
    ),
  ]);
}

type ImportItem = Manifest['items'][number];

function maximumRole(i: number): Extract<ImportItem, { type: 'role' }> {
  return {
    type: 'role',
    external_ref: `role-${i}`,
    key: `role_${i}`,
    name: 'Role',
    scope: 'organization',
    permissions: PERMISSIONS.map((p) => p.name),
  };
}

function mixedManifest(seed: number) {
  let state = seed;
  const random = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
  const items: ImportItem[] = [];
  for (let i = 0, length = 80 + random(120); i < length; i++) {
    const scoped = random(2) === 0;
    const source = {
      existing: { project: scoped ? 'existing' : null, name: scoped ? 'private' : 'main' },
    };
    switch (random(7)) {
      case 0:
        items.push({
          ...maximumRole(i),
          permissions: PERMISSIONS.slice(0, 1 + random(PERMISSIONS.length)).map((p) => p.name),
        });
        break;
      case 1:
        items.push({ type: 'project', external_ref: `p${i}`, slug: `new-${i}`, name: 'Project' });
        break;
      case 2:
        items.push({
          type: 'source',
          external_ref: `s${i}`,
          name: `new-${i}`,
          ecosystem: 'npm',
          source_type: 'npmjs_proxy',
          project: scoped ? { existing: 'existing' } : null,
          url: 'https://registry.npmjs.org',
          credential_ref: null,
          config: {},
        });
        break;
      case 3:
        items.push({
          type: 'name',
          external_ref: `n${i}`,
          source,
          ecosystem: 'npm',
          pattern: `package-${i}`,
        });
        break;
      case 4:
        items.push({
          type: 'attachment',
          external_ref: `a${i}`,
          project: { existing: `existing-${i}` },
          source: {
            existing: {
              project: scoped ? `existing-${i}` : null,
              name: scoped ? `owned-${i}` : 'main',
            },
          },
          precedence: i,
        });
        break;
      case 5:
        items.push({
          type: 'grant',
          external_ref: `g${i}`,
          scope: scoped ? 'project' : 'organization',
          project: scoped ? { existing: 'existing' } : null,
          role: { existing: scoped ? 'project_reader' : 'reader' },
          subject: { type: 'group', provider: 'oidc', value: `group-${i}` },
        });
        break;
      case 6:
        items.push({
          type: 'version_override',
          external_ref: `v${i}`,
          source,
          package: 'widget',
          version: `${i}.0.0`,
          published_at: '2026-01-01T00:00:00.000Z',
          basis: 'source_release',
        });
        break;
    }
  }
  // Shuffle input so production ordering, rather than fixture ordering, determines boundaries.
  for (let i = items.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function seedImportReferences({ executor, ctx }: Fixture, items: readonly ImportItem[]) {
  const statements = [
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('existing', ?, 'existing', 'Existing')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('main', ?, 'main', 'npm', 'npmjs_proxy')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, project_id, ecosystem, type) VALUES ('private', ?, 'private', 'existing', 'npm', 'npmjs_proxy')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('reader', ?, 'reader', 'Reader', 'organization')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('project_reader', ?, 'project_reader', 'Reader', 'project')",
      ctx.orgId,
    ),
    ...['main', 'private'].map((id) =>
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'widget')",
        id,
        ctx.orgId,
        id,
      ),
    ),
  ];
  for (const item of items) {
    if (item.type === 'attachment' && 'existing' in item.project) {
      const project = item.project.existing;
      statements.push(
        stmt(
          "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, 'Existing')",
          project,
          ctx.orgId,
          project,
        ),
      );
      if ('existing' in item.source && item.source.existing.project !== null) {
        const name = item.source.existing.name;
        statements.push(
          stmt(
            "INSERT INTO source (id, org_id, name, project_id, ecosystem, type) VALUES (?, ?, ?, ?, 'npm', 'npmjs_proxy')",
            name,
            ctx.orgId,
            name,
            project,
          ),
        );
      }
    }
    if (item.type === 'version_override' && 'existing' in item.source) {
      statements.push(
        stmt(
          "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, ?, ?, '2025-01-01T00:00:00.000Z', 'source_release', '{}')",
          item.external_ref,
          ctx.orgId,
          item.source.existing.name,
          item.version,
          item.version,
        ),
      );
    }
  }
  for (let offset = 0; offset < statements.length; offset += 200) {
    await executor.batch(statements.slice(offset, offset + 200));
  }
}

async function importFixture(fixture: Fixture, manifest: ParsedManifest, interrupted = false) {
  const { ctx } = fixture;
  const now = new Date().toISOString();
  const runId = ulid();
  const sha = 'a'.repeat(64) as Sha256;
  await fixture.executor.batch([
    stmt(
      "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'actor', 'oidc', 'subject', 'actor@example.test', 1, ?)",
      ctx.orgId,
      now,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at, plan_hash, manifest_blob_sha256) VALUES (?, ?, 'test', 'applying', 'actor', ?, ?, ?)",
      runId,
      ctx.orgId,
      now,
      await planHash(manifest),
      sha,
    ),
    stmt(
      "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, ?, ?, ?, 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
      IMPORT_RUN_JOB.apply,
      JSON.stringify(IMPORT_RUN_JOB.payload(runId)),
      IMPORT_RUN_JOB.resourceKey(runId),
    ),
  ]);
  const counter = counting(fixture.executor);
  const store = createImportJournalStore({
    executor: counter.executor,
    providerAnchors: [
      {
        provider: 'oidc',
        anchor: 'test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ],
  });
  let crash = interrupted;
  const sizes: number[] = [];
  const run = () =>
    runImportApply(
      {
        store: {
          ...store,
          async applyChunk(...args) {
            sizes.push(args[2].items.length);
            const result = await store.applyChunk(...args);
            if (crash && result.ok) {
              crash = false;
              throw new Error('interrupted after commit');
            }
            return result;
          },
        },
        blobs: {
          get: async () => ({
            info: {
              generation: '',
              sha256: sha,
              size: 1,
              mediaType: 'application/json',
              purgeAfter: null,
            },
            body: new Response(JSON.stringify(manifest)).body!,
          }),
        },
        clock: fixedClock(now),
        ids: { ulid },
      },
      ctx,
      { runId },
      (approver, run, expected) => delegatedMutationFence(approver, run, job, expected),
    );
  return { runId, counter, store, sizes, run };
}

export function describeWriterBatchContract(open: () => Promise<Fixture>): void {
  describe('writer batches stay within 200 statements', () => {
    it.each(['38 roles then attachment', ...Array.from({ length: 16 }, (_, i) => i + 1)])(
      'budgets each item in mixed import manifest %s',
      async (mix) => {
        const fixture = await open();
        try {
          const items: ImportItem[] =
            typeof mix === 'number'
              ? mixedManifest(mix)
              : [
                  ...Array.from({ length: 38 }, (_, i) => maximumRole(i)),
                  {
                    type: 'attachment',
                    external_ref: 'attachment',
                    project: { existing: 'existing-0' },
                    source: { existing: { project: null, name: 'main' } },
                    precedence: 0,
                  },
                ];
          const parsed = parseManifest({ version: 1, source_system: 'test', widening: [], items });
          if (!parsed.ok)
            throw new Error(`invalid mixed manifest: ${JSON.stringify(parsed.details)}`);
          await seedImportReferences(fixture, items);
          const { run, runId, counter, store, sizes } = await importFixture(fixture, parsed.data);
          expect(await run()).toEqual({ status: 'applied' });
          expect(counter.batches.length).toBeGreaterThan(2);
          expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
          expect(await store.appliedRefs(fixture.ctx, runId)).toHaveLength(items.length);
          expect(
            await counter.executor.all(
              stmt(
                'SELECT state, applied_count FROM import_run WHERE org_id = ? AND id = ?',
                fixture.ctx.orgId,
                runId,
              ),
            ),
          ).toEqual([{ state: 'applied', applied_count: items.length }]);
          expect(
            await counter.executor.all(
              stmt(
                "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action != 'import_run.apply'",
                fixture.ctx.orgId,
              ),
            ),
          ).toEqual([{ n: items.length }]);
          if (typeof mix !== 'number') {
            expect(sizes).toEqual([32, 7]);
            expect(counter.batches.slice(0, 2)).toEqual([197, 51]);
          }
        } finally {
          await fixture.close();
        }
      },
    );

    it('converges on the same 100-tag snapshot after a later batch fails', async () => {
      const fixture = await open();
      try {
        await seedCatalogue(fixture);
        const { ctx } = fixture;
        const counter = counting(fixture.executor);
        const guard = createCatalogueWriteGuard(ctx, job);
        const request = {
          sourceId: source.id,
          ecosystem: source.ecosystem,
          key: source.key,
          description: null,
          versions: [version],
          tags: { obsolete: '1.0.0' },
        };
        await createCatalogueWriter(counter.executor).syncPackage(ctx, guard, request);
        let batchNumber = 0;
        const interrupted = createCatalogueWriter({
          ...counter.executor,
          async batch(batch) {
            if (++batchNumber === 2) throw new Error('interrupted before commit');
            return counter.executor.batch(batch);
          },
        });
        const tags = Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`tag${i}`, '1.0.0']),
        );
        const snapshot = { ...request, versions: [], tags };
        await expect(interrupted.syncPackage(ctx, guard, snapshot)).rejects.toThrow(
          'interrupted before commit',
        );
        expect(batchNumber).toBe(2);
        const writer = createCatalogueWriter(counter.executor);
        const result = await writer.syncPackage(ctx, guard, snapshot);
        expect(result.skippedTags).toEqual([]);
        const history = () =>
          counter.executor.all(
            stmt(
              'SELECT tag, action FROM dist_tag_history WHERE org_id = ? ORDER BY tag, action',
              ctx.orgId,
            ),
          );
        expect(
          await counter.executor.all(
            stmt('SELECT tag FROM dist_tag WHERE org_id = ? ORDER BY tag', ctx.orgId),
          ),
        ).toEqual(
          Object.keys(tags)
            .sort()
            .map((tag) => ({ tag })),
        );
        const before = await history();
        expect(before).toHaveLength(102);
        await writer.syncPackage(ctx, guard, snapshot);
        expect(await history()).toEqual(before);
        expect(Math.max(...counter.batches)).toBeGreaterThan(190);
      } finally {
        await fixture.close();
      }
    });

    it.each([false, true])(
      'imports 50 maximum-permission roles (interrupted: %s)',
      async (interrupted) => {
        const fixture = await open();
        try {
          const { ctx } = fixture;
          const permissions = PERMISSIONS.map((p) => p.name);
          const parsed = parseManifest({
            version: 1,
            source_system: 'test',
            widening: [],
            items: Array.from({ length: 50 }, (_, i) => ({
              type: 'role',
              external_ref: `role-${i}`,
              key: `role_${i}`,
              name: 'Role',
              scope: 'organization',
              permissions,
            })),
          });
          if (!parsed.ok) throw new Error('invalid role manifest');
          const manifest = parsed.data;
          const { runId, counter, store, sizes, run } = await importFixture(
            fixture,
            manifest,
            interrupted,
          );
          if (interrupted) {
            await expect(run()).rejects.toThrow('interrupted after commit');
            expect(await store.appliedRefs(ctx, runId)).toHaveLength(32);
          }
          expect(await run()).toEqual({ status: 'applied' });
          expect(sizes).toEqual([32, 18]);
          expect(counter.batches).toContain(197);
          expect(counter.batches).toContain(113);
          expect(await store.appliedRefs(ctx, runId)).toHaveLength(50);
          expect(
            await counter.executor.all(
              stmt(
                'SELECT state, applied_count FROM import_run WHERE org_id = ? AND id = ?',
                ctx.orgId,
                runId,
              ),
            ),
          ).toEqual([{ state: 'applied', applied_count: 50 }]);
          expect(
            await counter.executor.all(
              stmt(
                "SELECT count(*) AS n FROM role_permission WHERE org_id = ? AND role_id != 'importer'",
                ctx.orgId,
              ),
            ),
          ).toEqual([{ n: 50 * permissions.length }]);
          expect(
            await counter.executor.all(
              stmt(
                "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action = 'role.create'",
                ctx.orgId,
              ),
            ),
          ).toEqual([{ n: 50 }]);
        } finally {
          await fixture.close();
        }
      },
    );

    it('retains all 150 ingest tag slices and removes obsolete tags', async () => {
      const fixture = await open();
      try {
        await seedCatalogue(fixture);
        const { ctx } = fixture;
        const counter = counting(fixture.executor);
        const writer = createCatalogueWriter(counter.executor);
        await writer.syncPackage(ctx, createCatalogueWriteGuard(ctx, job), {
          sourceId: source.id,
          ecosystem: source.ecosystem,
          key: source.key,
          description: null,
          versions: [version],
          tags: { obsolete: '1.0.0' },
        });
        const sessions = createIngestSessions(counter.executor);
        const acquired = await sessions.acquire(
          ctx,
          { scope: 'package', sourceId: source.id, packageKey: source.key },
          'worker',
          600,
        );
        if (acquired === 'held') throw new Error('session held');
        let session = acquired;
        const guard = createIngestSessionWriteGuard(ctx, session);
        const tags = Object.fromEntries(
          Array.from({ length: 150 }, (_, i) => [`tag${i}`, '1.0.0']),
        );
        let complete = false;
        for (let invocation = 0; invocation < 20; invocation++) {
          counter.take();
          const outcome = await applyChunk(
            ctx,
            {
              writer,
              sessions,
              existing: createExistingVersionsReader(counter.executor),
              finalizer: createIngestFinalizer(counter.executor),
            },
            {
              session,
              guard,
              source,
              packageDescription: null,
              toVersion: () => version,
              validatorTtlSeconds: 300,
              description: createPackageDescription({
                name: source.key,
                snapshot: snapshotRef('"tags"'),
                validators: {},
                documentsComplete: true,
                distTags: tags,
                members: (async function* () {
                  yield {
                    ordinal: 0,
                    version: '1.0.0',
                    form: 'npm-full',
                    raw: version.metadata.json,
                  } as const;
                })(),
              }),
            },
          );
          expect(counter.take()).toBeLessThanOrEqual(outcome.planned);
          expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
          expect(outcome.tagsSkipped).toBe(false);
          session = outcome.session;
          if (outcome.done) {
            expect(outcome.status).toBe('complete');
            complete = true;
            break;
          }
          expect(outcome.status).toBe('progress');
        }
        expect(complete).toBe(true);
        expect(
          await counter.executor.all(
            stmt('SELECT tag FROM dist_tag WHERE org_id = ? ORDER BY tag', ctx.orgId),
          ),
        ).toEqual(
          Object.keys(tags)
            .sort()
            .map((tag) => ({ tag })),
        );
      } finally {
        await fixture.close();
      }
    });
  });
}
