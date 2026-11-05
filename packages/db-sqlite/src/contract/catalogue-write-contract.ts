import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { settleIdempotent, replayResponse } from '@package-broker/core/api/idempotency';
import { createIdempotencyRepository } from '../repositories/idempotency.js';
import { visibilityAudit } from '../testing/visibility-audit.js';
import { describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type {
  CatalogueWriter,
  VisibilityStore,
  CatalogueWriteGuard,
  CatalogueReader,
  SyncPackageInput,
  SyncResult,
  VersionInput,
} from '@package-broker/core/db/catalogue';
import type {
  OrgContext,
  SqlExecutor,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import {
  MAX_METADATA_BYTES,
  MetadataError,
  MetadataTooLargeError,
  normalizeVersionMetadata,
  type NormalizedJson,
} from '@package-broker/core/catalogue/metadata';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { createCatalogueStatusRepository } from '../repositories/catalogue-status.js';
import { createCatalogueWriter, createVisibilityStore } from '../repositories/catalogue-writer.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { seedTwoOrganizations } from './two-organizations.js';
import { describeWriterBatchContract } from './writer-batch-contract.js';

export interface OpenedCatalogueWriteDatabase {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}
type Open = () => Promise<OpenedCatalogueWriteDatabase>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const HISTORY = '2020-01-01T00:00:00.000Z';
const fence = () =>
  mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {});
const version = (n = 0, extra: Partial<VersionInput> = {}): VersionInput => ({
  version: `1.0.${String(n)}`,
  versionNormalized: `1.0.${String(n)}`,
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  history: { at: HISTORY, basis: 'release_date' },
  ...extra,
});

async function withWorld(open: Open, body: (w: World) => Promise<void>, wrap?: Wrap) {
  const opened = await open();
  try {
    const { a: org, b: other } = await seedTwoOrganizations(opened.executor);
    const statements: Statement[] = [];
    const executor: SqlExecutor = {
      driver: opened.executor.driver,
      async all<R>(statement: Statement): Promise<R[]> {
        return (await executor.batch([statement]))[0]!.rows as R[];
      },
      batch(batch) {
        for (const statement of batch) expect(statement.params.length).toBeLessThanOrEqual(100);
        statements.push(...batch);
        return opened.executor.batch(batch);
      },
    };
    const now = new Date().toISOString();
    const address = ['admin', 'example.test'].join('@');
    await executor.batch([
      st(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
        org.orgId,
      ),
      st(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
        org.orgId,
      ),
      st(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
        org.orgId,
      ),
      st(
        "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
        org.orgId,
        address,
      ),
      st(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        org.orgId,
      ),
      st(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'subject', ?, 1, ?)",
        org.orgId,
        address,
        now,
      ),
      st(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
        org.orgId,
        'a'.repeat(64),
        'b'.repeat(64),
        now,
        now,
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
        org.orgId,
      ),
      ...[
        'org:sources:write',
        'org:packages:manage',
        'project:sources:write',
        'project:packages:manage',
      ].map((p) =>
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', ?)",
          org.orgId,
          p,
        ),
      ),
      st(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES ('grant', ?, 'email', ?, 'organization', 'role', ?, ?)",
        org.orgId,
        address,
        now,
        now,
      ),
    ]);
    const guarded = wrap?.(executor) ?? executor;
    const writer = createCatalogueWriter(guarded);
    const store = createVisibilityStore(guarded, {
      providerAnchors: [
        {
          provider: 'oidc',
          anchor: 'oidc:https://idp.example.test',
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ],
    });
    const guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
    const rows = async (sql: string, ...params: Statement['params']) =>
      (await executor.batch([st(sql, org.orgId, ...params)]))[0]!.rows;
    const world = {
      org,
      other,
      statements,
      executor,
      writer,
      store,
      guard,
      rows,
      reader: createCatalogueReader(executor),
      sync: (
        versions: readonly VersionInput[] = [version()],
        extra: Partial<SyncPackageInput> = {},
      ) =>
        writer.syncPackage(org, guard, {
          sourceId: 'source',
          ecosystem: 'npm',
          key: 'widget',
          description: null,
          versions,
          ...extra,
        }),
      epoch: async () =>
        (await rows('SELECT version FROM cache_epoch WHERE org_id = ?'))[0]!['version'],
      owner: () =>
        executor.batch([
          st(
            "DELETE FROM role_permission WHERE org_id = ? AND permission = 'org:sources:write'",
            org.orgId,
          ),
          st("UPDATE role SET scope = 'project' WHERE org_id = ?", org.orgId),
          st(
            "UPDATE access_grant SET scope = 'project', project_id = 'project' WHERE org_id = ?",
            org.orgId,
          ),
        ]),
    };
    await body(world);
  } finally {
    await opened.close();
  }
}
interface World {
  readonly org: OrgContext;
  readonly other: OrgContext;
  readonly executor: SqlExecutor;
  readonly writer: CatalogueWriter;
  readonly store: VisibilityStore;
  readonly guard: CatalogueWriteGuard;
  readonly reader: CatalogueReader;
  readonly statements: readonly Statement[];
  rows(sql: string, ...params: Statement['params']): Promise<StatementResult['rows']>;
  sync(versions?: readonly VersionInput[], extra?: Partial<SyncPackageInput>): Promise<SyncResult>;
  epoch(): Promise<unknown>;
  owner(): Promise<StatementResult[]>;
}
const target = {
  get audit() {
    return visibilityAudit();
  },
  projectId: 'project',
  sourceId: 'source',
};
const ref = {
  projectId: 'project',
  ecosystem: 'npm' as const,
  key: 'widget',
  versionNormalized: '1.0.0',
};
const lookup = (w: World) => w.reader.lookupVersion(w.org, ref);
async function attached(w: World) {
  const result = await w.sync();
  expect(await w.store.attachSource(w.org, fence(), target)).toMatchObject({ ok: true });
  expect(await lookup(w)).not.toBeNull();
  return result.packageId;
}

async function seedListing(w: World, count: 1 | 3): Promise<string> {
  const packageId = 'listing-widget';
  await w.executor.batch([
    ...['widget', ...(count === 3 ? ['other', 'missing'] : [])].map((key) =>
      st(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, 'source', 'npm', ?, ?)",
        `listing-${key}`,
        w.org.orgId,
        key,
        HISTORY,
      ),
    ),
    ...Array.from({ length: count }, (_, n) =>
      st(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'release_date', '{}', ?)",
        `listing-version-${String(n)}`,
        w.org.orgId,
        packageId,
        `1.0.${String(n)}`,
        `1.0.${String(n)}`,
        HISTORY,
        HISTORY,
      ),
    ),
  ]);
  return packageId;
}

async function hiddenExplicitAuthority(open: Open, wrap?: Wrap) {
  await withWorld(
    open,
    async (w) => {
      const packageId = await attached(w);
      expect(
        await w.store.setPackageFlag(w.org, fence(), { packageId, visibleToNewProjects: false }),
      ).toMatchObject({ ok: true });
      await w.owner();
      const publicPackage = await w.sync([version()], { key: 'public' });
      expect(
        await w.store.addExplicit(w.org, fence(), {
          projectId: 'project',
          packageId: publicPackage.packageId,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await w.store.addExplicit(w.org, fence(), { projectId: 'project', packageId }),
      ).toEqual({ ok: false, reason: 'authority' });
      expect(await lookup(w)).toBeNull();
      expect(
        await w.rows(
          'SELECT origin FROM project_package WHERE org_id = ? AND package_id = ?',
          packageId,
        ),
      ).toEqual([]);
    },
    wrap,
  );
}
async function publicationImmutable(open: Open, ecosystem: 'npm' | 'composer', wrap?: Wrap) {
  await withWorld(
    open,
    async (w) => {
      if (ecosystem === 'composer') {
        await w.executor.batch([
          st(
            "UPDATE source SET ecosystem = 'composer', type = 'composer_repository' WHERE org_id = ? AND id = 'source'",
            w.org.orgId,
          ),
        ]);
      }
      const input = version(0, {
        versionNormalized: ecosystem === 'composer' ? '1.0.0.0' : '1.0.0',
        metadata: normalizeVersionMetadata(ecosystem, { name: 'widget' }),
      });
      const sync = (v: VersionInput) => w.sync([v], { ecosystem });
      await sync(input);
      const before = await w.rows(
        'SELECT published_at, published_at_basis FROM version WHERE org_id = ?',
      );
      expect(
        await sync({
          ...input,
          history: { at: '2021-01-01T00:00:00.000Z', basis: 'build_date' },
          metadata: normalizeVersionMetadata(ecosystem, {
            name: 'widget',
            deprecated: 'old',
            ...(ecosystem === 'composer' ? { description: 'revised' } : {}),
          }),
        }),
      ).toMatchObject({ updated: 1 });
      if (ecosystem === 'composer') {
        expect(await w.rows('SELECT revision FROM version WHERE org_id = ?')).toEqual([
          { revision: 2 },
        ]);
        expect(await w.rows('SELECT revision FROM version_revision WHERE org_id = ?')).toEqual([
          { revision: 1 },
        ]);
      }
      expect(
        await w.rows('SELECT published_at, published_at_basis FROM version WHERE org_id = ?'),
      ).toEqual(before);
      expect(w.statements.some((statement) => /^update "version" set/i.test(statement.sql))).toBe(
        true,
      );
      for (const statement of w.statements) {
        const set = /^update\s+"?version"?\s+set\s+([\s\S]*?)\bwhere\b/i.exec(statement.sql)?.[1];
        if (set !== undefined) expect(/"?published_at(?:_basis)?"?\s*=/i.test(set)).toBe(false);
      }
    },
    wrap,
  );
}

async function publicationPhases(open: Open, wrap?: Wrap) {
  await withWorld(
    open,
    async (w) => {
      const { packageId } = await w.sync();
      const chunkHistory = { at: '2021-01-01T00:00:00.000Z', basis: 'build_date' as const };
      await w.sync([version(1, { history: chunkHistory })]);
      expect(
        await w.rows(
          'SELECT published_at, published_at_basis FROM version WHERE org_id = ? AND package_id = ? AND version_normalized = ?',
          packageId,
          '1.0.1',
        ),
      ).toEqual([{ published_at: chunkHistory.at, published_at_basis: chunkHistory.basis }]);
      const scope = { kind: 'package' as const, packageId };
      const { stamp } = await w.writer.openListing(w.org, w.guard, scope);
      await w.writer.markListing(w.org, w.guard, { scope, stamp, present: ['1.0.0', '1.0.1'] });
      await w.writer.finalizeListing(
        w.org,
        w.guard,
        completeVersionListing({ packageId, stamp, count: 2 }),
        { attemptedCandidates: 2, successfulCandidates: 2, definitiveAbsent: 0 },
      );
      const databaseNow = async () => {
        const [row] = await w.rows(
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at FROM package WHERE org_id = ?",
        );
        return Date.parse(row!['at'] as string);
      };
      const before = await databaseNow();
      await w.sync([version(2)]);
      const after = await databaseNow();
      await w.sync([version()], { key: 'other' });
      const [published] = await w.rows(
        'SELECT published_at, published_at_basis FROM version WHERE org_id = ? AND package_id = ? AND version_normalized = ?',
        packageId,
        '1.0.2',
      );
      expect(published!['published_at_basis']).toBe('broker');
      expect(published!['published_at']).not.toBe(HISTORY);
      const timestamp = Date.parse(published!['published_at'] as string);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
      expect(
        await w.rows(
          'SELECT published_at, published_at_basis FROM version WHERE org_id = ? AND package_id <> ?',
          packageId,
        ),
      ).toEqual([{ published_at: HISTORY, published_at_basis: 'release_date' }]);
    },
    wrap,
  );
}

export const catalogueWriteContractCases = {
  hiddenExplicitAuthority,
  publicationImmutable,
  publicationPhases,
};

export function describeCatalogueWriteContract(name: string, open: Open): void {
  describe(`catalogue write contract: ${name}`, () => {
    for (const action of ['releaseQuarantine', 'quarantineVersion', 'tombstoneVersion'] as const) {
      it(`${action} respects unresolved versus completed publish approvals atomically`, () =>
        withWorld(open, async (w) => {
          const { packageId } = await w.sync();
          const [row] = await w.rows('SELECT id FROM version WHERE org_id = ?');
          const versionId = String(row!.id);
          await w.rows("UPDATE version SET status = 'quarantined' WHERE org_id = ?");
          await w.rows(
            `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,expires_at)
            VALUES ('approval',?,?,?,'source',1,0,'pending','not_required','user','admin','token','2999-01-01T00:00:00.000Z')`,
            packageId,
            versionId,
          );
          if (action === 'quarantineVersion') {
            await w.rows("UPDATE version SET status='active' WHERE org_id = ?");
            await w.rows(
              "UPDATE publish_approval SET approval_state='approved',decided_by_user_id='admin',decided_at='2026-10-30T00:00:00.000Z' WHERE org_id = ?",
            );
          }
          const before = await w.rows('SELECT rev FROM package WHERE org_id = ?');
          const input = {
            packageId,
            versionId,
            expectedStatus:
              action === 'quarantineVersion' ? ('active' as const) : ('quarantined' as const),
            manage: { kind: 'organization' as const },
            audit: visibilityAudit('version.state_change'),
          };
          const result =
            action === 'tombstoneVersion'
              ? await w.store.tombstoneVersion(w.org, fence(), {
                  ...input,
                  reason: 'admin_tombstone',
                })
              : action === 'quarantineVersion'
                ? await w.store.quarantineVersion(w.org, fence(), {
                    ...input,
                    reason: 'admin_quarantine',
                  })
                : await w.store.releaseQuarantine(w.org, fence(), input);
          if (action === 'quarantineVersion') expect(result).toMatchObject({ ok: true });
          else expect(result).toEqual({ ok: false, reason: 'publish_gate' });
          if (action === 'releaseQuarantine') {
            const status = createCatalogueStatusRepository(w.executor, {
              providerAnchors: [
                {
                  provider: 'oidc',
                  anchor: 'oidc:https://idp.example.test',
                  emailAuthoritative: true,
                  emailAuthoritativeDomains: ['example.test'],
                },
              ],
            });
            expect(await status.releaseQuarantine(w.org, fence(), { versionId })).toEqual({
              ok: false,
              reason: 'publish_gate',
            });
          }

          if (action === 'quarantineVersion') {
            expect(await w.rows('SELECT rev FROM package WHERE org_id = ?')).not.toEqual(before);
            expect(await w.rows('SELECT id FROM audit_pending WHERE org_id = ?')).toHaveLength(1);
          } else {
            expect(await w.rows('SELECT rev FROM package WHERE org_id = ?')).toEqual(before);
            expect(await w.rows('SELECT id FROM audit_pending WHERE org_id = ?')).toEqual([]);
          }
        }));
    }

    describeWriterBatchContract(async () => {
      const opened = await open();
      const { a: ctx } = await seedTwoOrganizations(opened.executor);
      return { executor: opened.executor, ctx, close: () => opened.close() };
    });
    for (const ecosystem of ['npm', 'composer'] as const) {
      const denied = [
        'token',
        'access_token',
        'private_token',
        'auth',
        'key',
        'signature',
        'sig',
        'x-amz-signature',
        'x-amz-credential',
        'x-goog-signature',
        'ToKeN',
        '%74oken',
        'token[]',
      ];
      it(`${ecosystem}: refuses URL userinfo and credential parameters`, async () => {
        await withWorld(open, async (w) => {
          const base = 'https://registry.example.test/file';
          const urls = [
            base.replace('https://', 'https://user:placeholder@'),
            ...denied.map((key) => `${base}?${key}=placeholder`),
          ];
          for (const url of urls) {
            await expect(async () => {
              const dist = ecosystem === 'npm' ? { tarball: url } : { url };
              await w.sync([
                version(0, { metadata: normalizeVersionMetadata(ecosystem, { dist }) }),
              ]);
            }).rejects.toBeInstanceOf(MetadataError);
          }
          expect(await w.rows('SELECT id FROM version WHERE org_id = ?')).toEqual([]);
        });
      });
    }
    it('refuses oversized metadata at normalization and the writer boundary', async () => {
      await withWorld(open, async (w) => {
        expect(() =>
          normalizeVersionMetadata('npm', { data: 'é'.repeat(MAX_METADATA_BYTES / 2) }),
        ).toThrow(MetadataTooLargeError);
        const input = version();
        expect(
          await w.sync([
            {
              ...input,
              metadata: {
                ...input.metadata,
                json: JSON.stringify({
                  data: 'é'.repeat(MAX_METADATA_BYTES / 2),
                }) as NormalizedJson,
              },
            },
          ]),
        ).toMatchObject({ inserted: 0, refused: [{ version: '1.0.0', reason: 'too_large' }] });
        expect(await w.rows('SELECT id FROM version WHERE org_id = ?')).toEqual([]);
      });
    });
    it('rejects a future history date atomically', async () => {
      await withWorld(open, async (w) => {
        await expect(
          w.sync([
            version(0, { history: { at: '2999-01-01T00:00:00.000Z', basis: 'release_date' } }),
          ]),
        ).rejects.toThrow();
        expect(await w.rows('SELECT id FROM package WHERE org_id = ?')).toEqual([]);
      });
    });
    for (const ecosystem of ['npm', 'composer'] as const) {
      it(`${ecosystem}: never updates published_at or its basis when metadata changes`, async () => {
        await publicationImmutable(open, ecosystem);
      });
    }
    it('switches history to broker time independently for each package after finalization', async () => {
      await publicationPhases(open);
    });
    it('refuses blob replacement and preserves the first attachment', async () => {
      await withWorld(open, async (w) => {
        await w.sync();
        const versionId = (await w.rows('SELECT id FROM version WHERE org_id = ?'))[0]![
          'id'
        ] as string;
        await w.executor.batch(
          ['a', 'b'].map((letter) =>
            st(
              'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
              letter,
              w.org.orgId,
              letter.repeat(64),
              letter,
            ),
          ),
        );
        const attach = (letter: string) =>
          w.writer.attachDist(w.org, w.guard, {
            versionId,
            revision: 1,
            sha256: letter.repeat(64) as Sha256,
          });
        expect(await attach('a')).toMatchObject({ changed: true });
        expect(await attach('a')).toMatchObject({ changed: false });
        await expect(attach('b')).rejects.toThrow();
        expect(await w.rows('SELECT blob_id FROM version WHERE org_id = ?')).toEqual([
          { blob_id: 'a' },
        ]);
      });
    });
    it('refuses tombstoned slot reuse', async () => {
      await withWorld(open, async (w) => {
        await w.sync();
        const versionId = (await w.rows('SELECT id FROM version WHERE org_id = ?'))[0]![
          'id'
        ] as string;
        expect(
          await w.store.tombstoneVersion(w.org, fence(), {
            packageId: (await w.rows('SELECT package_id FROM version WHERE org_id = ?'))[0]![
              'package_id'
            ] as string,
            expectedStatus: 'active',
            manage: { kind: 'organization' },
            audit: visibilityAudit('version.state_change'),
            versionId,
            reason: 'admin_tombstone',
          }),
        ).toMatchObject({ ok: true });
        expect(await w.sync()).toMatchObject({
          inserted: 0,
          updated: 0,
          unchanged: 0,
          refused: [{ version: '1.0.0', reason: 'tombstoned' }],
        });
        expect(await w.rows('SELECT id, status FROM version WHERE org_id = ?')).toEqual([
          { id: versionId, status: 'tombstoned' },
        ]);
      });
    });
    for (const method of ['quarantineVersion', 'tombstoneVersion', 'releaseQuarantine'] as const) {
      it(`${method}: a live key reused for another version conflicts without writes`, async () => {
        await withWorld(open, async (w) => {
          const { packageId } = await w.sync([version(0), version(1)]);
          if (method === 'releaseQuarantine')
            await w.executor.batch([
              st("UPDATE version SET status = 'quarantined' WHERE org_id = ?", w.org.orgId),
            ]);
          const versions = await w.rows(
            'SELECT id FROM version WHERE org_id = ? ORDER BY version_normalized',
          );
          const record = {
            principalKey: 'user:admin',
            key: 'version-state',
            route: '/version-state',
            requestHash: 'a'.repeat(64),
            status: 204,
            responseJson: 'null',
            createdAt: '2026-10-22T00:00:00.000Z',
            expiresAt: '2999-01-01T00:00:00.000Z',
          };
          const run = (index: number) => {
            const input = {
              packageId,
              versionId: versions[index]!['id'] as string,
              expectedStatus:
                method === 'releaseQuarantine' ? ('quarantined' as const) : ('active' as const),
              manage: { kind: 'organization' as const },
              audit: visibilityAudit('version.state_change'),
              idempotency: index === 0 ? record : { ...record, requestHash: 'b'.repeat(64) },
            };
            if (method === 'quarantineVersion')
              return w.store.quarantineVersion(w.org, fence(), {
                ...input,
                reason: 'admin_quarantine',
              });
            if (method === 'tombstoneVersion')
              return w.store.tombstoneVersion(w.org, fence(), {
                ...input,
                reason: 'admin_tombstone',
              });
            return w.store.releaseQuarantine(w.org, fence(), input);
          };
          const snapshot = async () => {
            const state = [];
            for (const table of [
              'version',
              'version_revision',
              'package',
              'cache_epoch',
              'audit_pending',
              'api_idempotency',
            ])
              state.push(await w.rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1`));
            return state;
          };
          expect(await run(0)).toMatchObject({ ok: true });
          const before = await snapshot();
          expect(await run(1)).toEqual({ ok: false, reason: 'conflict' });
          expect(await snapshot()).toEqual(before);
          expect(
            await settleIdempotent({
              record,
              hash: record.requestHash,
              now: new Date(record.createdAt),
              find: () =>
                createIdempotencyRepository(w.executor).find(
                  w.org,
                  record.principalKey,
                  record.key,
                  record.createdAt,
                ),
              run: () => run(0),
              failed: (result) => !result.ok,
            }),
          ).toEqual({ kind: 'replay', record });
          expect(await snapshot()).toEqual(before);
        });
      });
    }
    for (const kind of ['source', 'package'] as const) {
      it(`${kind}: refuses incomplete and empty listing finalization`, async () => {
        await withWorld(open, async (w) => {
          const packageId = await seedListing(w, 1);
          const scope = kind === 'source' ? { kind, sourceId: 'source' } : { kind, packageId };
          const { stamp } = await w.writer.openListing(w.org, w.guard, scope);
          const input =
            kind === 'source'
              ? { sourceId: 'source', stamp, count: 1 }
              : { packageId, stamp, count: 1 };
          const complete = () =>
            kind === 'source'
              ? completeSourceListing({ sourceId: 'source', stamp, count: 1 })
              : completeVersionListing({ packageId, stamp, count: 1 });
          await expect(
            w.writer.finalizeListing(w.org, w.guard, input as never, {
              attemptedCandidates: 0,
              successfulCandidates: 0,
              definitiveAbsent: 0,
            }),
          ).rejects.toThrow();
          await expect(
            w.writer.finalizeListing(w.org, w.guard, complete(), {
              attemptedCandidates: 0,
              successfulCandidates: 0,
              definitiveAbsent: 0,
            }),
          ).rejects.toThrow();
          expect(() =>
            kind === 'source'
              ? completeSourceListing({ sourceId: 'source', stamp, count: 0 })
              : completeVersionListing({ packageId, stamp, count: 0 }),
          ).toThrow();
          expect(await w.rows('SELECT status FROM version WHERE org_id = ?')).toEqual([
            { status: 'active' },
          ]);
          expect(await w.rows('SELECT last_synced_at FROM package WHERE org_id = ?')).toEqual([
            { last_synced_at: null },
          ]);
        });
      });
      it(`${kind}: chunked listing preserves every present row and removes only the missing row`, async () => {
        await withWorld(open, async (w) => {
          const packageId = await seedListing(w, 3);
          const table = kind === 'source' ? 'package' : 'version';
          const scope = kind === 'source' ? { kind, sourceId: 'source' } : { kind, packageId };
          const { stamp } = await w.writer.openListing(w.org, w.guard, scope);
          const present = kind === 'source' ? ['widget', 'other'] : ['1.0.0', '1.0.1'];
          for (const key of present)
            await w.writer.markListing(w.org, w.guard, { scope, stamp, present: [key] });
          const finalize = (count: number) =>
            w.writer.finalizeListing(
              w.org,
              w.guard,
              kind === 'source'
                ? completeSourceListing({ sourceId: 'source', stamp, count })
                : completeVersionListing({ packageId, stamp, count }),
              { attemptedCandidates: count, successfulCandidates: count, definitiveAbsent: 0 },
            );
          await expect(finalize(2)).rejects.toBeInstanceOf(DbError);
          await expect(finalize(2)).rejects.toMatchObject({
            constraint: ACCESS_MUTATION_GUARD_CONSTRAINT,
          });
          const untouched = await w.rows(`SELECT status FROM ${table} WHERE org_id = ?`);
          expect(untouched.every((row) => row['status'] === 'active')).toBe(true);
          if (kind === 'source') return;
          await w.executor.batch([
            st(
              "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES ('listing-version-extra', ?, ?, '1.0.9', '1.0.9', ?, 'release_date', '{}', ?)",
              w.org.orgId,
              packageId,
              HISTORY,
              HISTORY,
            ),
          ]);
          present.push('1.0.9');
          await w.writer.markListing(w.org, w.guard, { scope, stamp, present: ['1.0.9'] });
          expect(await finalize(3)).toMatchObject({ removed: 1, restored: 0 });
          const key = 'version_normalized';
          const rows = await w.rows(
            `SELECT ${key} AS key, status FROM ${table} WHERE org_id = ? ORDER BY ${key}`,
          );
          expect(
            rows
              .filter((row) => row['status'] === 'active')
              .map((row) => row['key'])
              .sort(),
          ).toEqual([...present].sort());
          expect(rows.filter((row) => row['status'] === 'removed_upstream')).toHaveLength(1);
        });
      });
    }
    const visibilityCases = [
      { method: 'attachSource', action: 'source.attach' },
      { method: 'detachSource', action: 'source.detach' },
      { method: 'setPrecedence', action: 'source.reorder' },
      { method: 'addPattern', effect: 'include', action: 'source.update' },
      { method: 'addPattern', effect: 'exclude', action: 'source.update' },
      { method: 'removePattern', effect: 'include', action: 'source.update' },
      { method: 'removePattern', effect: 'exclude', action: 'source.update' },
    ] as const;
    for (const operation of visibilityCases) {
      it(`${operation.method} ${'effect' in operation ? operation.effect : ''}: audit rollback, replay and no-op are atomic`, async () => {
        await withWorld(open, async (w) => {
          if (operation.method !== 'attachSource') {
            await w.executor.batch([
              st(
                "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'project', 'source', 100)",
                w.org.orgId,
              ),
            ]);
          }
          if (operation.method === 'removePattern') {
            await w.executor.batch([
              st(
                "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('pattern', ?, 'project', 'source', 'widget*', ?)",
                w.org.orgId,
                operation.effect,
              ),
            ]);
          }
          await w.sync();
          const snapshot = async () => {
            const state = [];
            for (const table of [
              'project',
              'project_source',
              'project_package_pattern',
              'project_package',
              'cache_epoch',
              'audit_pending',
              'api_idempotency',
            ]) {
              state.push(await w.rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1`));
            }
            return state;
          };
          const audit = visibilityAudit(operation.action);
          const idempotency = {
            principalKey: 'user:admin',
            key: 'visibility',
            route: '/visibility',
            requestHash: 'a'.repeat(64),
            status: 204,
            responseJson: 'null',
            createdAt: '2026-10-19T00:00:00.000Z',
            expiresAt: '2026-10-20T00:00:00.000Z',
          };
          const run = (withIdempotency = true, event = audit, record = idempotency) => {
            const input = {
              projectId: 'project',
              sourceId: 'source',
              audit: event,
              ...(withIdempotency ? { idempotency: record } : {}),
            };
            switch (operation.method) {
              case 'attachSource':
                return w.store.attachSource(w.org, fence(), input);
              case 'detachSource':
                return w.store.detachSource(w.org, fence(), input);
              case 'setPrecedence':
                return w.store.setPrecedence(w.org, fence(), { ...input, precedence: 17 });
              case 'addPattern':
                return w.store.addPattern(w.org, fence(), {
                  ...input,
                  pattern: 'widget*',
                  effect: operation.effect,
                });
              case 'removePattern':
                return w.store.removePattern(w.org, fence(), { ...input, pattern: 'widget*' });
            }
          };
          await w.executor.batch([
            st(
              "CREATE TRIGGER reject_visibility_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit rejected'); END",
            ),
          ]);
          const before = await snapshot();
          expect(await run()).toMatchObject({ ok: false });
          expect(await snapshot()).toEqual(before);
          await w.executor.batch([st('DROP TRIGGER reject_visibility_audit')]);
          const epochBefore = await w.epoch();
          expect(await run()).toMatchObject({ ok: true });
          expect(await w.epoch()).not.toBe(epochBefore);
          expect(
            await w.rows('SELECT id, action, org_id FROM audit_pending WHERE org_id = ?'),
          ).toEqual([{ id: audit.id, action: operation.action, org_id: w.org.orgId }]);
          const stored = await snapshot();
          const replay = await settleIdempotent({
            record: idempotency,
            hash: idempotency.requestHash,
            now: new Date(idempotency.createdAt),
            find: () =>
              createIdempotencyRepository(w.executor).find(
                w.org,
                idempotency.principalKey,
                idempotency.key,
                idempotency.createdAt,
              ),
            run,
            failed: (result) => !result.ok,
          });
          expect(replay).toEqual({ kind: 'replay', record: idempotency });
          expect(replayResponse(idempotency, 'replay').status).toBe(204);
          expect(await snapshot()).toEqual(stored);
          const noop = await run(false, visibilityAudit(operation.action));
          expect(noop).toMatchObject(
            operation.method === 'detachSource' || operation.method === 'removePattern'
              ? { ok: false, reason: 'not_found' }
              : { ok: true },
          );
          expect(await snapshot()).toEqual(stored);
          if (operation.method === 'detachSource' || operation.method === 'removePattern') {
            expect(
              await run(true, visibilityAudit(operation.action), { ...idempotency, key: 'absent' }),
            ).toMatchObject({ ok: false, reason: 'not_found' });
            expect(await snapshot()).toEqual(stored);
          }
        });
      });
    }
    it('project owner cannot attach an organization source', async () => {
      await withWorld(open, async (w) => {
        await w.sync();
        await w.owner();
        expect(await w.store.attachSource(w.org, fence(), target)).toEqual({
          ok: false,
          reason: 'not_found',
        });
        expect(await w.rows('SELECT source_id FROM project_source WHERE org_id = ?')).toEqual([]);
        expect(await lookup(w)).toBeNull();
      });
    });
    it('project owner include cannot expose flag-0 packages', async () => {
      await withWorld(open, async (w) => {
        const packageId = await attached(w);
        expect(
          await w.store.setPackageFlag(w.org, fence(), { packageId, visibleToNewProjects: false }),
        ).toMatchObject({ ok: true });
        await w.owner();
        expect(
          await w.store.addPattern(w.org, fence(), { ...target, pattern: '*', effect: 'include' }),
        ).toMatchObject({ ok: true });
        expect(await lookup(w)).toBeNull();
        expect(await w.rows('SELECT package_id FROM project_package WHERE org_id = ?')).toEqual([]);
        await w.sync([version()], { key: 'public' });
        expect(await w.reader.lookupVersion(w.org, { ...ref, key: 'public' })).not.toBeNull();
      });
    });
    it('project owner explicit cannot expose flag-0 packages', () => hiddenExplicitAuthority(open));
    for (const action of ['detach', 'exclude', 'flag', 'quarantine'] as const) {
      it(`${action}: the next read is absent and the organization epoch changes`, async () => {
        await withWorld(open, async (w) => {
          const packageId = await attached(w);
          const before = await w.epoch();
          const otherBefore = (
            await w.executor.batch([
              st('SELECT version FROM cache_epoch WHERE org_id = ?', w.other.orgId),
            ])
          )[0]!.rows;
          let result;
          if (action === 'detach') result = await w.store.detachSource(w.org, fence(), target);
          else if (action === 'exclude')
            result = await w.store.addPattern(w.org, fence(), {
              ...target,
              pattern: '*',
              effect: 'exclude',
            });
          else if (action === 'flag')
            result = await w.store.setPackageFlag(w.org, fence(), {
              packageId,
              visibleToNewProjects: false,
            });
          else {
            const versionId = (await w.rows('SELECT id FROM version WHERE org_id = ?'))[0]![
              'id'
            ] as string;
            result = await w.store.quarantineVersion(w.org, fence(), {
              packageId,
              expectedStatus: 'active',
              manage: { kind: 'organization' },
              audit: visibilityAudit('version.state_change'),
              versionId,
              reason: 'admin_quarantine',
            });
          }
          expect(result).toMatchObject({ ok: true });
          expect(await lookup(w)).toBeNull();
          expect(await w.epoch()).not.toBe(before);
          expect(
            (
              await w.executor.batch([
                st('SELECT version FROM cache_epoch WHERE org_id = ?', w.other.orgId),
              ])
            )[0]!.rows,
          ).toEqual(otherBefore);
        });
      });
    }
    it('explicit rows and reads survive excludes and flag flips', async () => {
      await withWorld(open, async (w) => {
        const packageId = await attached(w);
        expect(
          await w.store.addExplicit(w.org, fence(), { projectId: 'project', packageId }),
        ).toMatchObject({ ok: true });
        expect(
          await w.store.addPattern(w.org, fence(), { ...target, pattern: '*', effect: 'exclude' }),
        ).toMatchObject({ ok: true });
        expect(await lookup(w)).not.toBeNull();
        expect(
          await w.store.setPackageFlag(w.org, fence(), { packageId, visibleToNewProjects: false }),
        ).toMatchObject({ ok: true });
        expect(await lookup(w)).not.toBeNull();
        expect(
          await w.rows(
            'SELECT origin FROM project_package WHERE org_id = ? AND package_id = ?',
            packageId,
          ),
        ).toEqual([{ origin: 'explicit' }]);
      });
    });
  });
}

export { describeNpmPublishWriterContract } from './npm-publish-writer-contract.js';

export { describeBlobSupersededContract } from './blob-superseded-contract.js';
