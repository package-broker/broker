import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  delegatedMutationFence,
  systemMutationFence,
  mutationFence,
  type AuthenticatedActor,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { ImportApplyItem } from '@package-broker/core/import/apply';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { ulid } from '@package-broker/core/ids';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { blobEligibleCondition } from './blob-references.js';
import { createImportJournalStore, IMPORT_VERIFICATION_JOB } from './import-journal.js';
import { createImportRunStore } from './import-run.js';
import { createDistResolver } from './catalogue-dist.js';
import { visibleWinner } from './catalogue-read.js';
import { compile } from '../kysely.js';

const V = '2026-10-19T00:00:00.000Z';
const EXPIRY = '2027-01-17T00:00:00.000Z';
const anchors = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

describe('import journal', () => {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let store: ReturnType<typeof createImportJournalStore>;
  let clock: string;
  let reads: Statement[];
  let batches: (readonly Statement[])[];
  let beforeBatch: (() => Promise<void>) | undefined;
  const job = { id: 'apply-job', owner: 'worker', fence: 1 };
  const fence = () => delegatedMutationFence('actor', 'run', job, {});
  const verifier = () => systemMutationFence('verifier', { ...job, id: 'verify-job' }, {});

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    if (database.orgs === null) throw new Error('missing fixture');
    ({ a: ctx, b: foreign } = database.orgs);
    clock = V;
    reads = [];
    batches = [];
    beforeBatch = undefined;
    const fixed = (s: Statement): Statement => ({
      ...s,
      sql: s.sql.replaceAll("'now'", `'${clock}'`),
    });
    executor = {
      driver: database.executor.driver,
      all: <R>(s: Statement) => {
        reads.push(s);
        return database.executor.all<R>(fixed(s));
      },
      async batch(statements) {
        batches.push(statements);
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        return database.executor.batch(statements.map(fixed));
      },
    };
    await executor.batch([
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
        V,
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
        "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at) VALUES ('run', ?, 'test', 'applying', 'actor', ?)",
        ctx.orgId,
        V,
      ),
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('other-run', ?, 'test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
        foreign.orgId,
      ),
      stmt(
        "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('apply-job', ?, ?, ?, ?, 'running', 'worker', '2030-01-01T00:00:00.000Z', 1)",
        ctx.orgId,
        IMPORT_RUN_JOB.apply,
        JSON.stringify(IMPORT_RUN_JOB.payload('run')),
        IMPORT_RUN_JOB.resourceKey('run'),
      ),
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('package', ?, 'source', 'npm', 'pkg')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('blob', ?, ?, 1, 'blob')",
        ctx.orgId,
        'a'.repeat(64),
      ),
      stmt(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at, last_op_id) VALUES ('version', ?, 'package', '1.0.0', '1.0.0', '2026-01-01T00:00:00.000Z', 'source_release', '{}', 'blob', 'tombstoned', ?, 'old-op')",
        ctx.orgId,
        V,
      ),
    ]);
    await executor.batch([
      stmt(
        "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('verify-job', ?, ?, ?, ?, 'running', 'worker', '2030-01-01T00:00:00.000Z', 1)",
        ctx.orgId,
        IMPORT_VERIFICATION_JOB.type,
        JSON.stringify(IMPORT_RUN_JOB.payload('run')),
        IMPORT_VERIFICATION_JOB.resourceKey('run'),
      ),
    ]);
    batches = [];
    store = createImportJournalStore({ executor, providerAnchors: anchors });
  });
  afterEach(async () => {
    await database.close();
  });

  async function apply(items: readonly ImportApplyItem[]) {
    const audits = items.map((item) => {
      const result = auditEvent({
        id: ulid(),
        now: V,
        action: item.type === 'attachment' ? 'source.attach' : 'project.create',
        actor: { type: 'user', id: 'actor' },
        target: { type: item.type === 'attachment' ? 'source' : 'project', id: null },
        projectId: null,
        changes:
          item.type === 'attachment'
            ? { position: { new: item.precedence } }
            : { name: { new: 'Imported' } },
        context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      });
      if (!result.ok) throw new Error('invalid audit fixture');
      return result.event;
    });
    return store.applyChunk(ctx, fence(), {
      runId: 'run',
      items,
      audits,
      auditProjects: items.map((item) => (item.type === 'attachment' ? item.project : null)),
      widening: [],
      now: V,
    });
  }
  const override: ImportApplyItem = {
    type: 'version_override',
    external_ref: 'override',
    source: { existing: { project: null, name: 'source' } },
    package: 'pkg',
    version: '1.0.0',
    published_at: V,
    basis: 'import_time',
  };
  const project: ImportApplyItem = {
    type: 'project',
    external_ref: 'project',
    slug: 'imported',
    name: 'Imported',
  };
  it.each([
    {
      provider: 'git',
      repository: 'https://git.example.test/acme/widget.git',
      installationId: null,
      packageName: null,
    },
    {
      provider: 'ssh',
      repository: 'ssh://git@git.example.test/acme/widget.git',
      installationId: null,
      packageName: null,
    },
    {
      provider: 'github',
      repository: 'acme/widget',
      installationId: 7,
      packageName: 'acme/widget',
    },
  ] as const)(
    'stores runtime config for an imported $provider source without mutating the wire config',
    async (vcs) => {
      const config = { ...vcs, refs: { tags: true, branches: ['main'] } };
      const original = structuredClone(config);
      const item: ImportApplyItem = {
        type: 'source',
        external_ref: 'vcs-source',
        name: 'imported-vcs',
        ecosystem: 'composer',
        source_type: 'vcs',
        project: null,
        url: null,
        config,
        status: 'paused',
      };
      expect(await apply([item])).toEqual({ ok: true });
      const rows = () =>
        executor.all<{ config_json: string; status: string }>(
          stmt(
            'SELECT config_json, status FROM source WHERE org_id = ? AND name = ?',
            ctx.orgId,
            item.name,
          ),
        );
      const stored = await rows();
      expect(stored).toEqual([{ status: 'paused', config_json: expect.any(String) }]);
      expect(JSON.parse(stored[0]!.config_json)).toEqual({
        provider: vcs.provider,
        repository: vcs.repository,
        refs: config.refs,
        ...(vcs.installationId === null ? {} : { installationId: vcs.installationId }),
        ...(vcs.packageName === null ? {} : { packageName: vcs.packageName }),
      });
      expect(config).toEqual(original);
      const refs = await store.rollbackRefs(ctx, 'run');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
        entityType: 'source',
        action: 'create',
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(await apply([item])).toEqual({ ok: true });
      expect(await rows()).toEqual(stored);
      expect(await store.rollbackRefs(ctx, 'run')).toEqual(refs);
      expect(
        await executor.all(
          stmt('SELECT id FROM source WHERE org_id = ? AND name = ?', foreign.orgId, item.name),
        ),
      ).toEqual([]);
    },
  );
  it.each(['before planning', 'before the batch'])(
    'refuses an override when a purge claims its rollback blob %s',
    async (timing) => {
      const [pkg] = await executor.all(
        stmt("SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'", ctx.orgId),
      );
      const claim = async () => {
        await database.executor.batch([
          stmt(
            "UPDATE blob SET purge_lease_until = '2030-01-01T00:00:00.000Z' WHERE org_id = ? AND id = 'blob'",
            ctx.orgId,
          ),
        ]);
      };
      if (timing === 'before planning') await claim();
      else beforeBatch = claim;
      expect(await apply([project, override])).toEqual({ ok: false, reason: 'conflict' });
      expect(await store.rollbackRefs(ctx, 'run')).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM version_revision WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM project WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(
          stmt(
            "SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'",
            ctx.orgId,
          ),
        ),
      ).toEqual([pkg]);
      expect(
        await executor.all(
          stmt(
            "SELECT revision, published_at FROM version WHERE org_id = ? AND id = 'version'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ revision: 1, published_at: '2026-01-01T00:00:00.000Z' }]);
    },
  );
  it.each([null, '2026-10-18T23:59:59.999Z', V])(
    'allows an override when the rollback blob purge lease is %s',
    async (lease) => {
      await executor.batch([
        stmt(
          'UPDATE blob SET purge_lease_until = ? WHERE org_id = ? AND id = ?',
          lease,
          ctx.orgId,
          'blob',
        ),
      ]);
      expect(await apply([override])).toEqual({ ok: true });
      const [ref] = await store.rollbackRefs(ctx, 'run');
      expect(JSON.parse(ref!.beforeImageJson!).blob_id).toBe('blob');
      expect(ref!.beforeImageExpiresAt).toBeNull();
    },
  );
  it('allows an override without a rollback blob', async () => {
    await executor.batch([
      stmt("UPDATE version SET blob_id = NULL WHERE org_id = ? AND id = 'version'", ctx.orgId),
    ]);
    expect(await apply([override])).toEqual({ ok: true });
    const [ref] = await store.rollbackRefs(ctx, 'run');
    expect(JSON.parse(ref!.beforeImageJson!).blob_id).toBeNull();
  });

  const attachment: ImportApplyItem = {
    type: 'attachment',
    external_ref: 'attachment',
    project: { existing: 'reader' },
    source: { existing: { project: null, name: 'source' } },
    precedence: 10,
  };
  async function seedAttachmentProject() {
    await executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('reader', ?, 'reader', 'Reader')",
        ctx.orgId,
      ),
    ]);
  }
  it('makes packages in an existing source visible after importing its attachment', async () => {
    await seedAttachmentProject();
    expect(await executor.all(compile(visibleWinner(ctx, 'reader', 'npm', 'pkg')))).toEqual([]);
    expect(await apply([attachment])).toEqual({ ok: true });
    expect(await executor.all(compile(visibleWinner(ctx, 'reader', 'npm', 'pkg')))).toEqual([
      expect.objectContaining({ package_id: 'package', source_id: 'source' }),
    ]);
    expect(
      await executor.all(
        stmt(
          'SELECT project_id, package_id, origin FROM project_package WHERE org_id = ?',
          ctx.orgId,
        ),
      ),
    ).toEqual([{ project_id: 'reader', package_id: 'package', origin: 'subscription' }]);
    expect(await executor.all(compile(visibleWinner(foreign, 'reader', 'npm', 'pkg')))).toEqual([]);
  });
  it('rolls attachment visibility back when a later item fails', async () => {
    await seedAttachmentProject();
    await executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('collision', ?, 'imported', 'Existing')",
        ctx.orgId,
      ),
    ]);
    expect(await apply([attachment, project])).toEqual({ ok: false, reason: 'conflict' });
    expect(await store.rollbackRefs(ctx, 'run')).toEqual([]);
    expect(
      await executor.all(stmt('SELECT source_id FROM project_source WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
    expect(
      await executor.all(
        stmt('SELECT package_id FROM project_package WHERE org_id = ?', ctx.orgId),
      ),
    ).toEqual([]);
    expect(
      await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
  });
  it('audits the resolved source while retaining the composite attachment journal identity', async () => {
    await seedAttachmentProject();
    expect(await apply([attachment])).toEqual({ ok: true });
    expect(
      await executor.all(
        stmt(
          'SELECT action, target_type, target_id, project_id FROM audit_pending WHERE org_id = ?',
          ctx.orgId,
        ),
      ),
    ).toEqual([
      { action: 'source.attach', target_type: 'source', target_id: 'source', project_id: 'reader' },
    ]);
    expect(await store.rollbackRefs(ctx, 'run')).toEqual([
      expect.objectContaining({
        entityType: 'project_source',
        entityId: 'reader:source',
        action: 'create',
      }),
    ]);
  });
  it('keeps a pre-import revision-qualified dist URL resolvable', async () => {
    const metadata = JSON.stringify({ dist: { tarball: 'https://registry.example.test/pkg.tgz' } });
    await executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('reader', ?, 'reader', 'Reader')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'reader', 'source')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'reader' AS project_id, 'package' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
        ctx.orgId,
      ),
      stmt(
        "UPDATE version SET status = 'active', tombstoned_at = NULL, metadata_json = ?, source_ref = 'old-ref' WHERE org_id = ? AND id = 'version'",
        metadata,
        ctx.orgId,
      ),
    ]);
    const resolver = createDistResolver(database.executor);
    const query = {
      by: 'id',
      projectId: 'reader',
      ecosystem: 'npm',
      key: 'pkg',
      versionId: 'version',
      revision: 1,
    } as const;
    const old = await resolver.resolveDist(ctx, query);
    expect(old).toMatchObject({
      current: true,
      blob: { id: 'blob' },
      fetch: { sourceRef: 'old-ref' },
    });
    expect(await apply([override])).toEqual({ ok: true });
    expect(await resolver.resolveDist(ctx, query)).toEqual({ ...old, current: false });
    expect(
      await executor.all(
        stmt(
          'SELECT revision, blob_id, source_ref, metadata_json, reason, op_id FROM version_revision WHERE org_id = ?',
          ctx.orgId,
        ),
      ),
    ).toEqual([
      {
        revision: 1,
        blob_id: 'blob',
        source_ref: 'old-ref',
        metadata_json: metadata,
        reason: 'import_published_at_override',
        op_id: 'run',
      },
    ]);
  });
  it.each([V, '2030-01-01T00:00:00.000Z'])(
    'advances package revision and modified time monotonically from %s',
    async (modifiedAt) => {
      await executor.batch([
        stmt(
          "UPDATE package SET rev = 7, modified_at = ? WHERE org_id = ? AND id = 'package'",
          modifiedAt,
          ctx.orgId,
        ),
      ]);
      expect(await apply([override])).toEqual({ ok: true });
      const [row] = await executor.all<{ rev: number; modified_at: string }>(
        stmt("SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'", ctx.orgId),
      );
      expect(row!.rev).toBe(8);
      expect(Date.parse(row!.modified_at)).toBeGreaterThan(Date.parse(modifiedAt));
      expect(await apply([override])).toEqual({ ok: true });
      expect(
        await executor.all(
          stmt(
            "SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'",
            ctx.orgId,
          ),
        ),
      ).toEqual([row]);
    },
  );
  it.each([
    ['blob_id', null, 'blob'],
    ['published_at', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
    ['status', 'tombstoned', 'yanked'],
    ['metadata_json', '{}', '{"description":"Changed"}'],
  ] as const)(
    'refuses a stale before-image when %s changes without a revision bump',
    async (column, initial, changed) => {
      await executor.batch([
        stmt(
          `UPDATE version SET ${column} = ? WHERE org_id = ? AND id = 'version'`,
          initial,
          ctx.orgId,
        ),
      ]);
      const [pkg] = await executor.all(
        stmt("SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'", ctx.orgId),
      );
      beforeBatch = async () => {
        await database.executor.batch([
          stmt(
            `UPDATE version SET ${column} = ? WHERE org_id = ? AND id = 'version'`,
            changed,
            ctx.orgId,
          ),
        ]);
      };
      expect(await apply([override])).toEqual({ ok: false, reason: 'conflict' });
      expect(await store.rollbackRefs(ctx, 'run')).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM version_revision WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(
          stmt(
            "SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'",
            ctx.orgId,
          ),
        ),
      ).toEqual([pkg]);
      expect(
        await executor.all(
          stmt(
            `SELECT ${column}, revision FROM version WHERE org_id = ? AND id = 'version'`,
            ctx.orgId,
          ),
        ),
      ).toEqual([{ [column]: changed, revision: 1 }]);
      expect(await apply([override])).toEqual({ ok: true });
      const [ref] = await store.rollbackRefs(ctx, 'run');
      expect(JSON.parse(ref!.beforeImageJson!)[column]).toBe(changed);
    },
  );
  it('rolls dist history and the package revision back if a later item fails', async () => {
    const [pkg] = await executor.all(
      stmt("SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'", ctx.orgId),
    );
    await executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('collision', ?, 'imported', 'Existing')",
        ctx.orgId,
      ),
    ]);
    expect(await apply([override, project])).toEqual({ ok: false, reason: 'conflict' });
    expect(await store.rollbackRefs(ctx, 'run')).toEqual([]);
    expect(
      await executor.all(stmt('SELECT id FROM version_revision WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
    expect(
      await executor.all(
        stmt(
          "SELECT revision, published_at FROM version WHERE org_id = ? AND id = 'version'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ revision: 1, published_at: '2026-01-01T00:00:00.000Z' }]);
    expect(
      await executor.all(
        stmt("SELECT rev, modified_at FROM package WHERE org_id = ? AND id = 'package'", ctx.orgId),
      ),
    ).toEqual([pkg]);
  });
  it.each([
    ['project', 'status', 'archived'],
    ['role', 'protects_last_holder', 1],
    ['source', 'removal_policy', 'exclude'],
    ['registered_name', 'pattern', 'changed/*'],
    ['project_source', 'precedence', 42],
    ['access_grant', 'created_by', 'actor'],
  ] as const)(
    'hashes the complete created %s domain and detects a later %s edit',
    async (table, column, changed) => {
      expect(
        await apply([
          project,
          {
            type: 'role',
            external_ref: 'reader',
            key: 'reader',
            name: 'Reader',
            scope: 'project',
            permissions: ['project:read'],
          },
          {
            type: 'source',
            external_ref: 'new-source',
            name: 'registry',
            ecosystem: 'npm',
            source_type: 'npm_registry',
            project: null,
            url: 'https://registry.example.test/',
            config: {
              selection: { packages: [], patterns: [], expandPatterns: false },
              distHosts: [],
              mirrorsFallback: false,
            },
            status: 'paused',
          },
          {
            type: 'name',
            external_ref: 'name',
            source: { ref: 'new-source' },
            ecosystem: 'npm',
            pattern: 'acme/*',
          },
          {
            type: 'attachment',
            external_ref: 'attachment',
            project: { ref: 'project' },
            source: { ref: 'new-source' },
            precedence: 10,
          },
          {
            type: 'grant',
            external_ref: 'reader-grant',
            scope: 'project',
            project: { ref: 'project' },
            role: { ref: 'reader' },
            subject: { type: 'group', provider: 'oidc', value: 'readers' },
          },
        ]),
      ).toEqual({ ok: true });
      const ref = (await store.rollbackRefs(ctx, 'run')).find((r) => r.entityType === table)!;
      const predicate = table === 'project_source' ? 'project_id = ? AND source_id = ?' : 'id = ?';
      const identity = table === 'project_source' ? ref.entityId.split(':') : [ref.entityId];
      const liveHash = async () => {
        const [row] = await executor.all<Record<string, SqlValue>>(
          stmt(`SELECT * FROM ${table} WHERE org_id = ? AND ${predicate}`, ctx.orgId, ...identity),
        );
        const excluded = new Set([
          'id',
          'org_id',
          'created_at',
          'updated_at',
          'revision',
          'last_op_id',
          'last_synced_at',
          'last_accessed_at',
        ]);
        const domain: Record<string, SqlValue | readonly string[]> = Object.fromEntries(
          Object.entries(row!).filter(([key]) => !excluded.has(key)),
        );
        if (table === 'role') domain.permissions = ['project:read'];
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify(
              Object.fromEntries(
                Object.keys(domain)
                  .sort()
                  .map((key) => [key, domain[key]]),
              ),
            ),
          ),
        );
        return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
      };
      expect(ref.contentHash).toBe(await liveHash());
      await executor.batch([
        stmt(
          `UPDATE ${table} SET ${column} = ? WHERE org_id = ? AND ${predicate}`,
          changed,
          ctx.orgId,
          ...identity,
        ),
      ]);
      expect(ref.contentHash).not.toBe(await liveHash());
    },
  );
  async function protect() {
    expect(await apply([override])).toEqual({ ok: true });
    await executor.batch([
      stmt('UPDATE version SET blob_id = NULL WHERE org_id = ? AND id = ?', ctx.orgId, 'version'),
    ]);
    await executor.batch([
      stmt("UPDATE blob SET created_at = '2020-01-01T00:00:00.000Z' WHERE org_id = ?", ctx.orgId),
    ]);
  }
  async function eligible() {
    const condition = blobEligibleCondition(ctx, 'b');
    return executor.all(
      stmt(`SELECT b.id FROM blob b WHERE ${condition.sql}`, ...condition.params),
    );
  }
  async function expectedEpoch(context: OrgContext) {
    const [row] = await executor.all<{ version: string }>(
      stmt('SELECT version FROM cache_epoch WHERE org_id = ?', context.orgId),
    );
    if (row === undefined) throw new Error('missing organization epoch');
    return row.version;
  }
  async function verify() {
    await executor.batch([
      stmt("UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = 'run'", ctx.orgId),
    ]);
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: true });
  }
  it.each([
    ['type', 'unrelated-job'],
    ['resource_key', IMPORT_RUN_JOB.resourceKey('other-run')],
    ['payload_json', JSON.stringify(IMPORT_RUN_JOB.payload('other-run'))],
  ])('does not verify with a leased job whose %s is unrelated', async (column, value) => {
    await executor.batch([
      stmt("UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = 'run'", ctx.orgId),
      stmt(
        `UPDATE job SET ${column} = ? WHERE org_id = ? AND id = 'verify-job'`,
        value!,
        ctx.orgId,
      ),
    ]);
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.all(
        stmt(
          "SELECT state, before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ state: 'verifying', before_image_expires_at: null }]);
  });
  it('rechecks the verification job association inside the batch', async () => {
    await executor.batch([
      stmt("UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = 'run'", ctx.orgId),
    ]);
    beforeBatch = async () => {
      await database.executor.batch([
        stmt(
          "UPDATE job SET payload_json = ? WHERE org_id = ? AND id = 'verify-job'",
          JSON.stringify(IMPORT_RUN_JOB.payload('other-run')),
          ctx.orgId,
        ),
      ]);
    };
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.all(
        stmt(
          "SELECT before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ before_image_expires_at: null }]);
  });
  it('fits a maximum role chunk within statement and parameter budgets', async () => {
    const permissions = PERMISSIONS.map((p) => p.name);
    expect(permissions.length).toBeGreaterThanOrEqual(33);
    const roles = Array.from({ length: 50 }, (_, i) => ({
      type: 'role' as const,
      external_ref: `role-${String(i)}`,
      key: `role-${String(i)}`,
      name: 'Role',
      scope: 'organization' as const,
      permissions,
    }));
    const rolesPerChunk = 32;
    for (let offset = 0; offset < roles.length; offset += rolesPerChunk) {
      expect(await apply(roles.slice(offset, offset + rolesPerChunk))).toEqual({ ok: true });
    }
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.length <= 200)).toBe(true);
    expect(batches.every((batch) => batch.every((s) => s.params.length <= 100))).toBe(true);
    expect(
      await executor.all(
        stmt(
          "SELECT count(*) AS n FROM role_permission WHERE org_id = ? AND role_id != 'importer'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ n: 50 * permissions.length }]);
    expect(await store.appliedRefs(ctx, 'run')).toHaveLength(50);
  });
  it('refuses an expanded batch exceeding its UTF-8 byte budget before writing', async () => {
    expect(
      await apply(
        Array.from({ length: 50 }, (_, i) => ({
          ...project,
          external_ref: `project-${String(i)}`,
          slug: `project-${String(i)}`,
          name: '😀'.repeat(22_000),
        })),
      ),
    ).toEqual({ ok: false, reason: 'conflict' });
    expect(batches).toEqual([]);
    expect(await store.appliedRefs(ctx, 'run')).toEqual([]);
  });
  it('hashes role permissions in canonical order and detects a permission-only edit', async () => {
    const permissions = ['project:packages:write', 'project:read'];
    expect(
      await apply([
        {
          type: 'role',
          external_ref: 'reader',
          key: 'reader',
          name: 'Reader',
          scope: 'project',
          permissions,
        },
      ]),
    ).toEqual({ ok: true });
    const digest = async (permissions: readonly string[]) => {
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            is_system: 0,
            key: 'reader',
            name: 'Reader',
            permissions: [...permissions].sort(),
            protects_last_holder: 0,
            scope: 'project',
          }),
        ),
      );
      return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
    };
    const [row] = await executor.all<{ content_hash: string }>(
      stmt(
        "SELECT content_hash FROM import_ref WHERE org_id = ? AND import_run_id = 'run'",
        ctx.orgId,
      ),
    );
    expect(row!.content_hash).toBe(await digest([...permissions].reverse()));
    await executor.batch([
      stmt(
        "DELETE FROM role_permission WHERE org_id = ? AND role_id = (SELECT entity_id FROM import_ref WHERE org_id = ? AND external_ref = 'reader') AND permission = ?",
        ctx.orgId,
        ctx.orgId,
        permissions[0]!,
      ),
    ]);
    expect(row!.content_hash).not.toBe(await digest((await store.rolePermissions(ctx, 'reader'))!));
  });
  it('returns persisted images, hashes and expiry only through the rollback read', async () => {
    expect(await apply([project, override])).toEqual({ ok: true });
    const rows = await store.rollbackRefs(ctx, 'run');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entityType === 'project')).toMatchObject({
      runId: 'run',
      entityType: 'project',
      externalRef: 'project',
      action: 'create',
      beforeImageJson: null,
      beforeImageExpiresAt: null,
      conflictState: 'none',
      rolledBackAt: null,
    });
    const version = rows.find((r) => r.entityType === 'version')!;
    expect(version).toMatchObject({
      entityId: 'version',
      action: 'update',
      publishedAtBasis: 'import_time',
    });
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(version.beforeImageJson!)).toEqual({
      blob_id: 'blob',
      published_at: '2026-01-01T00:00:00.000Z',
      status: 'tombstoned',
      metadata_json: '{}',
      published_at_basis: 'source_release',
    });
    await verify();
    expect(
      (await store.rollbackRefs(ctx, 'run')).every((r) => r.beforeImageExpiresAt === EXPIRY),
    ).toBe(true);
  });
  it('does not return rollback images from another run', async () => {
    expect(await apply([override])).toEqual({ ok: true });
    expect(await store.rollbackRefs(ctx, 'other-run')).toEqual([]);
  });
  it('does not return rollback images from another organization', async () => {
    expect(await apply([override])).toEqual({ ok: true });
    expect(await store.rollbackRefs(foreign, 'run')).toEqual([]);
  });
  it('does not return rollback images with mismatched ref and run ownership', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json) VALUES ('mismatched', ?, 'foreign-run', 'version', 'version', 'mismatched', 'update', '{}')",
        ctx.orgId,
      ),
    ]);
    expect(await store.rollbackRefs(ctx, 'foreign-run')).toEqual([]);
  });
  it('protects an open run image from T410', async () => {
    await protect();
    expect(await eligible()).toEqual([]);
  });
  it('protects an image one second before the 90-day boundary', async () => {
    await protect();
    await verify();
    clock = '2027-01-16T23:59:59.000Z';
    expect(await eligible()).toEqual([]);
  });
  it('releases an image exactly at the 90-day boundary', async () => {
    await protect();
    await verify();
    clock = EXPIRY;
    expect(await eligible()).toEqual([{ id: 'blob' }]);
  });
  it('stores NULL for a create', async () => {
    expect(await apply([project])).toEqual({ ok: true });
    expect(
      await executor.all(
        stmt(
          "SELECT action, before_image_json FROM import_ref WHERE org_id = ? AND import_run_id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ action: 'create', before_image_json: null }]);
  });
  it('stores the four version domain keys, the prior basis and the override basis', async () => {
    expect(await apply([override])).toEqual({ ok: true });
    const [row] = await executor.all<{ before_image_json: string; published_at_basis: string }>(
      stmt(
        "SELECT before_image_json, published_at_basis FROM import_ref WHERE org_id = ? AND import_run_id = 'run'",
        ctx.orgId,
      ),
    );
    expect(JSON.parse(row!.before_image_json)).toEqual({
      blob_id: 'blob',
      published_at: '2026-01-01T00:00:00.000Z',
      status: 'tombstoned',
      metadata_json: '{}',
      published_at_basis: 'source_release',
    });
    expect(row!.published_at_basis).toBe('import_time');
  });
  it('does not leave a ref when the lease guard fails', async () => {
    beforeBatch = async () => {
      await database.executor.batch([stmt('UPDATE job SET fence = 2 WHERE org_id = ?', ctx.orgId)]);
    };
    expect(await apply([project])).toEqual({ ok: false, reason: 'guard' });
    expect(
      await executor.all(stmt('SELECT id FROM import_ref WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
    expect(
      await executor.all(
        stmt("SELECT id FROM project WHERE org_id = ? AND slug = 'imported'", ctx.orgId),
      ),
    ).toEqual([]);
  });
  it('does not return refs from another run', async () => {
    expect(await apply([project])).toEqual({ ok: true });
    expect(await store.appliedRefs(ctx, 'other-run')).toEqual([]);
  });
  it('does not return refs from another organization', async () => {
    expect(await apply([project])).toEqual({ ok: true });
    expect(await store.appliedRefs(foreign, 'run')).toEqual([]);
    expect(await store.loadRun(foreign, 'run')).toBeNull();
  });
  it('does not select before-images through ordinary reads', async () => {
    await store.loadRun(ctx, 'run');
    await store.appliedRefs(ctx, 'run');
    await store.rolePermissions(ctx, 'importer');
    expect(reads.every((s) => !/before_image_json|select\s+\*/i.test(s.sql))).toBe(true);
  });
  it('does not repeat a mutation or audit for a duplicate journal key', async () => {
    expect(await apply([override])).toEqual({ ok: true });
    expect(await apply([override])).toEqual({ ok: true });
    expect(
      await executor.all(stmt('SELECT revision FROM version WHERE org_id = ?', ctx.orgId)),
    ).toEqual([{ revision: 2 }]);
    expect(
      await executor.all(
        stmt('SELECT count(*) AS n FROM audit_pending WHERE org_id = ?', ctx.orgId),
      ),
    ).toEqual([{ n: 1 }]);
  });
  it('accepting a verified run leaves its expiry unchanged', async () => {
    await protect();
    await verify();
    await executor.batch([
      stmt(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES ('session', ?, 'actor', ?, ?, '2030-01-01T00:00:00.000Z', ?)",
        ctx.orgId,
        'a'.repeat(64),
        'b'.repeat(64),
        V,
      ),
    ]);
    const runs = createImportRunStore({
      executor,
      providerAnchors: anchors,
      blobs: {
        async stage() {
          throw new Error('not_implemented');
        },
        async openStaged() {
          throw new Error('not_implemented');
        },
        async promote() {
          throw new Error('not_implemented');
        },
        async discard() {
          throw new Error('not_implemented');
        },
        async put() {
          throw new Error('unexpected upload');
        },
        async get() {
          return null;
        },
        async head() {
          return null;
        },
      },
    });
    const session = mutationFence(
      { userId: 'actor', sessionId: 'session' } as AuthenticatedActor,
      {},
    );
    const { run } = await runs.inspect(ctx, session, 'acceptRun', 'run', V);
    if (run === null) throw new Error('missing run');
    expect(
      await runs.acceptRun(ctx, session, {
        runId: 'run',
        expected: run,
        now: V,
        audit: stmt('SELECT 1'),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await executor.all(
        stmt(
          "SELECT before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ before_image_expires_at: EXPIRY }]);
  });
  it('rolls the journal back when a domain change fails after its insert', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('collision', ?, 'imported', 'Existing')",
        ctx.orgId,
      ),
    ]);
    expect(await apply([project])).toEqual({ ok: false, reason: 'conflict' });
    expect(
      await executor.all(stmt('SELECT id FROM import_ref WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
    expect(
      await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
  });
  async function seedLocalApprover() {
    await executor.batch([
      stmt("DELETE FROM identity WHERE org_id = ? AND user_id = 'actor'", ctx.orgId),
      stmt(
        "UPDATE role SET protects_last_holder = 1 WHERE org_id = ? AND id = 'importer'",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('local-totp', ?, 'totp', x'00', zeroblob(12), 1, 'test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES ('actor', ?, 'pbkdf2-sha256$test', 'local-totp', ?)",
        ctx.orgId,
        V,
      ),
    ]);
  }
  it.each([{ providerAnchors: anchors }, { providerAnchors: [] }])(
    'applies for a local-only protected admin with $providerAnchors',
    async ({ providerAnchors }) => {
      await seedLocalApprover();
      store = createImportJournalStore({ executor, providerAnchors });
      expect(await apply([project])).toEqual({ ok: true });
      expect(await store.appliedRefs(ctx, 'run')).toEqual(['project:project']);
      expect(
        await executor.all(stmt('SELECT slug FROM project WHERE org_id = ?', ctx.orgId)),
      ).toEqual([{ slug: 'imported' }]);
      expect(
        await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
      ).toHaveLength(1);
    },
  );
  it.each([
    ['password removal', 'UPDATE local_login SET password_hash = NULL WHERE org_id = ?'],
    ['TOTP disablement', 'UPDATE local_login SET totp_enabled_at = NULL WHERE org_id = ?'],
    ['TOTP unlinking', 'UPDATE local_login SET totp_credential_id = NULL WHERE org_id = ?'],
    ['login removal', 'DELETE FROM local_login WHERE org_id = ?'],
    ['protected role removal', 'UPDATE role SET protects_last_holder = 0 WHERE org_id = ?'],
    ['permission removal', 'DELETE FROM role_permission WHERE org_id = ?'],
    ['grant removal', 'DELETE FROM access_grant WHERE org_id = ?'],
    ['account suspension', "UPDATE user_account SET status = 'suspended' WHERE org_id = ?"],
  ])('refuses a local approver after %s immediately before the batch', async (_, change) => {
    await seedLocalApprover();
    expect(await apply([])).toEqual({ ok: true });
    beforeBatch = async () => {
      await database.executor.batch([stmt(change, ctx.orgId)]);
    };
    expect(await apply([project])).toEqual({ ok: false, reason: 'guard' });
    expect(await store.appliedRefs(ctx, 'run')).toEqual([]);
    expect(await executor.all(stmt('SELECT id FROM project WHERE org_id = ?', ctx.orgId))).toEqual(
      [],
    );
    expect(
      await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
  });
  it.each(['local_login', 'credential'])(
    'refuses a local approver whose %s belongs to another organization',
    async (table) => {
      await seedLocalApprover();
      expect(await apply([])).toEqual({ ok: true });
      beforeBatch = async () => {
        await database.executor.batch([
          stmt(`UPDATE ${table} SET org_id = ? WHERE org_id = ?`, foreign.orgId, ctx.orgId),
        ]);
      };
      expect(await apply([project])).toEqual({ ok: false, reason: 'guard' });
      expect(await store.appliedRefs(ctx, 'run')).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM project WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
    },
  );
  it('refuses an approver suspended immediately before the batch', async () => {
    beforeBatch = async () => {
      await database.executor.batch([
        stmt("UPDATE user_account SET status = 'suspended' WHERE org_id = ?", ctx.orgId),
      ]);
    };
    expect(await apply([project])).toEqual({ ok: false, reason: 'guard' });
    expect(
      await executor.all(stmt('SELECT id FROM import_ref WHERE org_id = ?', ctx.orgId)),
    ).toEqual([]);
  });
  it('can fail a run after its approver was suspended', async () => {
    await executor.batch([
      stmt("UPDATE user_account SET status = 'suspended' WHERE org_id = ?", ctx.orgId),
    ]);
    await store.finish(ctx, fence(), { runId: 'run', outcome: { failed: 'guard_failed' }, now: V });
    expect((await store.loadRun(ctx, 'run'))?.state).toBe('failed');
    expect(await terminalAudits()).toMatchObject([
      { action: 'import_run.fail', actor_type: 'user', actor_id: 'actor', target_id: 'run' },
    ]);
  });
  async function terminalAudits() {
    return executor.all<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      target_type: string;
      target_id: string;
      project_id: string | null;
      created_at: string;
      payload_json: string;
    }>(
      stmt(
        "SELECT action, actor_type, actor_id, target_type, target_id, project_id, created_at, payload_json FROM audit_pending WHERE org_id = ? AND action LIKE 'import_run.%'",
        ctx.orgId,
      ),
    );
  }
  it.each([
    ['applied', 'import_run.apply', 'applied'],
    [{ failed: 'conflict' }, 'import_run.fail', 'failed'],
  ] as const)(
    'audits finish outcome %j in the state-change batch',
    async (outcome, action, state) => {
      await store.finish(ctx, fence(), { runId: 'run', outcome, now: V });
      expect((await store.loadRun(ctx, 'run'))?.state).toBe(state);
      const audits = await terminalAudits();
      expect(audits).toEqual([
        {
          action,
          actor_type: 'user',
          actor_id: 'actor',
          target_type: 'import_run',
          target_id: 'run',
          project_id: null,
          created_at: V,
          payload_json: expect.any(String),
        },
      ]);
      expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({
        changes: { state: { old: 'applying', new: state } },
      });
      expect(batches).toHaveLength(1);
      expect(batches[0]!.some((s) => s.sql.includes('INSERT INTO audit_pending'))).toBe(true);
      await expect(store.finish(ctx, fence(), { runId: 'run', outcome, now: V })).rejects.toThrow(
        'import finish refused',
      );
      expect(await terminalAudits()).toEqual(audits);
    },
  );
  it.each(['lease', 'state', 'organization'] as const)(
    'does not audit finish refused by its %s guard',
    async (reason) => {
      if (reason !== 'organization') {
        await executor.batch([
          reason === 'lease'
            ? stmt("UPDATE job SET lease_owner = 'new-worker' WHERE org_id = ?", ctx.orgId)
            : stmt("UPDATE import_run SET state = 'planned' WHERE org_id = ?", ctx.orgId),
        ]);
      }
      const before = await store.loadRun(ctx, 'run');
      await expect(
        store.finish(reason === 'organization' ? foreign : ctx, fence(), {
          runId: 'run',
          outcome: { failed: 'conflict' },
          now: V,
        }),
      ).rejects.toThrow('import finish refused');
      expect(await store.loadRun(ctx, 'run')).toEqual(before);
      expect(await terminalAudits()).toEqual([]);
      expect(
        await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', foreign.orgId)),
      ).toEqual([]);
    },
  );
  it.each(['applied', { failed: 'conflict' }] as const)(
    'rolls finish outcome %j back if its audit cannot be staged',
    async (outcome) => {
      await executor.batch([
        stmt(
          "CREATE TRIGGER refuse_terminal_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
        ),
      ]);
      await expect(store.finish(ctx, fence(), { runId: 'run', outcome, now: V })).rejects.toThrow();
      expect(
        await executor.all(
          stmt(
            "SELECT state, last_error FROM import_run WHERE org_id = ? AND id = 'run'",
            ctx.orgId,
          ),
        ),
      ).toEqual([{ state: 'applying', last_error: null }]);
      expect(await terminalAudits()).toEqual([]);
    },
  );
  it('audits verification in the state-change batch', async () => {
    await verify();
    const audits = await terminalAudits();
    expect(audits).toEqual([
      {
        action: 'import_run.verify',
        actor_type: 'system',
        actor_id: null,
        target_type: 'import_run',
        target_id: 'run',
        project_id: null,
        created_at: V,
        payload_json: expect.any(String),
      },
    ]);
    expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({
      changes: { state: { old: 'verifying', new: 'verified' } },
    });
    const batch = batches.at(-1)!;
    expect(batch.some((s) => s.sql.includes('UPDATE import_run'))).toBe(true);
    expect(batch.some((s) => s.sql.includes('INSERT INTO audit_pending'))).toBe(true);
  });
  it('does not audit verification after losing its job lease', async () => {
    await executor.batch([
      stmt("UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = 'run'", ctx.orgId),
    ]);
    beforeBatch = async () => {
      await database.executor.batch([
        stmt(
          "UPDATE job SET lease_owner = 'new-worker' WHERE org_id = ? AND id = 'verify-job'",
          ctx.orgId,
        ),
      ]);
    };
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.all(
        stmt(
          "SELECT state, before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ state: 'verifying', before_image_expires_at: null }]);
    expect(await terminalAudits()).toEqual([]);
  });
  it('rolls verification and expiry back if its audit cannot be staged', async () => {
    await executor.batch([
      stmt("UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = 'run'", ctx.orgId),
      stmt(
        "CREATE TRIGGER refuse_terminal_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      ),
    ]);
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.all(
        stmt(
          "SELECT state, before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ state: 'verifying', before_image_expires_at: null }]);
    expect(await terminalAudits()).toEqual([]);
  });
  it('does not verify a foreign run', async () => {
    expect(
      await store.markVerified(foreign, verifier(), {
        runId: 'run',
        verifiedAt: V,
        expectedEpoch: await expectedEpoch(foreign),
      }),
    ).toMatchObject({ ok: false });
    expect(await terminalAudits()).toEqual([]);
    expect(
      await executor.all(stmt('SELECT id FROM audit_pending WHERE org_id = ?', foreign.orgId)),
    ).toEqual([]);
  });
  it('does not extend expiry on repeated verification', async () => {
    await verify();
    const audits = await terminalAudits();
    expect(
      await store.markVerified(ctx, verifier(), {
        runId: 'run',
        verifiedAt: '2026-10-20T00:00:00.000Z',
        expectedEpoch: await expectedEpoch(ctx),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.all(
        stmt(
          "SELECT before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'run'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ before_image_expires_at: EXPIRY }]);
    expect(audits).toHaveLength(1);
    expect(await terminalAudits()).toEqual(audits);
  });
  it.each(['source_release', 'packagist_added', 'import_time'] as const)(
    'records override basis %s',
    async (basis) => {
      expect(await apply([{ ...override, basis }])).toEqual({ ok: true });
      expect(
        await executor.all(
          stmt('SELECT published_at_basis FROM import_ref WHERE org_id = ?', ctx.orgId),
        ),
      ).toEqual([{ published_at_basis: basis }]);
    },
  );
  it('creates linked items in one chunk and resumes references from a prior chunk', async () => {
    const role: ImportApplyItem = {
      type: 'role',
      external_ref: 'reader',
      key: 'reader',
      name: 'Reader',
      scope: 'project',
      permissions: ['project:read'],
    };
    const source: ImportApplyItem = {
      type: 'source',
      external_ref: 'new-source',
      name: 'registry',
      ecosystem: 'composer',
      source_type: 'composer_repository',
      project: { ref: 'project' },
      url: 'https://packages.example.test/',
      config: {
        selection: { packages: [], patterns: [], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
      status: 'paused',
    };
    expect(await apply([role, project, source])).toEqual({ ok: true });
    expect(
      await apply([
        {
          type: 'name',
          external_ref: 'name',
          source: { ref: 'new-source' },
          ecosystem: 'composer',
          pattern: 'acme/*',
        },
        {
          type: 'attachment',
          external_ref: 'attachment',
          project: { ref: 'project' },
          source: { ref: 'new-source' },
          precedence: 10,
        },
        {
          type: 'grant',
          external_ref: 'reader-grant',
          scope: 'project',
          project: { ref: 'project' },
          role: { ref: 'reader' },
          subject: { type: 'email', value: 'reader@example.test' },
        },
      ]),
    ).toEqual({ ok: true });
    expect(
      await executor.all(
        stmt(
          "SELECT status, credential_id FROM source WHERE org_id = ? AND name = 'registry'",
          ctx.orgId,
        ),
      ),
    ).toEqual([{ status: 'paused', credential_id: null }]);
    expect(await store.appliedRefs(ctx, 'run')).toHaveLength(6);
  });
});
