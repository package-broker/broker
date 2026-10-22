import { describe, expect, it, vi } from 'vitest';
import { delegatedMutationFence } from '@package-broker/core/authz/fence';
import type { Statement } from '@package-broker/core/db/port';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { runImportApply } from '@package-broker/core/import/apply';
import { parseManifest, planHash, type Manifest } from '@package-broker/core/import/manifest';
import { runImportRollback } from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { parseSha256 } from '@package-broker/core/platform/blob';
import { createImportJournalStore } from '../repositories/import-journal.js';
import { createImportRollbackStore } from '../repositories/import-rollback.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';
import { seedTwoOrganizations } from './two-organizations.js';

const RUN = '01J0RN0000000000000000R001';
const NOW = '2026-10-20T12:00:00.000Z';
const BEFORE = '2026-01-01T00:00:00.000Z';
const anchors = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

export function describeFailedImportRollbackContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
): void {
  describe(`failed import rollback: ${name}`, () => {
    it.each([0, 1, 2])('rolls back after %i committed apply chunks', async (chunks) => {
      const database = await open();
      const { executor } = database;
      try {
        const { a: ctx } = await seedTwoOrganizations(executor);
        // Each override costs eight statements, plus five statements per apply chunk.
        const overridesPerChunk = Math.floor((200 - 5) / 8);
        const committed = chunks * overridesPerChunk;
        const manifest: Manifest = {
          version: 1,
          source_system: 'test',
          widening: [],
          items: Array.from({ length: committed + 2 }, (_, index) => ({
            type: 'version_override',
            external_ref: `v${index}`,
            source: { existing: { project: null, name: 'source' } },
            package: 'pkg',
            version: `1.0.${index}`,
            published_at: NOW,
            basis: 'import_time',
          })),
        };
        const parsed = parseManifest(manifest);
        if (!parsed.ok) throw new Error('invalid manifest fixture');
        const manifestHash = parseSha256(await planHash(parsed.data));
        await executor.batch([
          stmt(
            "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
            ctx.orgId,
          ),
          stmt(
            "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
            ctx.orgId,
          ),
          stmt(
            "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
            ctx.orgId,
          ),
          ...['actor', 'requester'].flatMap((user) => [
            stmt(
              'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
              user,
              ctx.orgId,
              `${user}@example.test`,
            ),
            stmt(
              "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', ?, ?, 1, ?)",
              `identity-${user}`,
              ctx.orgId,
              user,
              user,
              `${user}@example.test`,
              NOW,
            ),
            stmt(
              "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', 'importer')",
              `grant-${user}`,
              ctx.orgId,
              `${user}@example.test`,
            ),
          ]),
          stmt(
            "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at, manifest_blob_sha256, plan_hash) VALUES (?, ?, 'test', 'applying', 'actor', ?, ?, ?)",
            RUN,
            ctx.orgId,
            NOW,
            manifestHash,
            manifestHash,
          ),
          stmt(
            "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('import-job', ?, ?, ?, ?, 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
            ctx.orgId,
            IMPORT_RUN_JOB.apply,
            JSON.stringify({ runId: RUN }),
            IMPORT_RUN_JOB.resourceKey(RUN),
          ),
          stmt(
            "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
            ctx.orgId,
          ),
          stmt(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('package', ?, 'source', 'npm', 'pkg')",
            ctx.orgId,
          ),
          ...Array.from({ length: committed + 1 }, (_, index) =>
            stmt(
              "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES (?, ?, 'package', ?, ?, ?, 'source_release', '{}')",
              `v${index}`,
              ctx.orgId,
              `1.0.${index}`,
              `1.0.${index}`,
              BEFORE,
            ),
          ),
        ]);
        const fences = (user: string, runId: string, expected: Readonly<Record<string, number>>) =>
          delegatedMutationFence(
            user,
            runId,
            { id: 'import-job', owner: 'worker', fence: 1 },
            expected,
          );
        const journal = createImportJournalStore({ executor, providerAnchors: anchors });
        const applyChunk = vi.spyOn(journal, 'applyChunk');
        expect(
          await runImportApply(
            {
              store: journal,
              clock: fixedClock(NOW),
              ids: { ulid },
              blobs: {
                get: async () => ({
                  info: {
                    generation: '',
                    sha256: manifestHash,
                    size: JSON.stringify(manifest).length,
                    mediaType: 'application/json',
                    purgeAfter: null,
                  },
                  body: new Response(JSON.stringify(manifest)).body!,
                }),
              },
            },
            ctx,
            { runId: RUN },
            fences,
          ),
        ).toEqual({ status: 'failed', reason: 'conflict' });
        expect(applyChunk).toHaveBeenCalledTimes(chunks + 1);
        expect(await journal.appliedRefs(ctx, RUN)).toHaveLength(committed);
        expect(
          await executor.all(
            stmt('SELECT state FROM import_run WHERE org_id = ? AND id = ?', ctx.orgId, RUN),
          ),
        ).toEqual([{ state: 'failed' }]);
        await executor.batch([
          stmt(
            "UPDATE version SET metadata_json = '{\"edited\":true}', revision = revision + 1 WHERE org_id = ? AND id = 'v0' AND revision = 2",
            ctx.orgId,
          ),
          stmt(
            "UPDATE import_ref SET content_hash = NULL WHERE org_id = ? AND import_run_id = ? AND entity_id = 'v1'",
            ctx.orgId,
            RUN,
          ),
          stmt(
            'UPDATE job SET type = ?, payload_json = ? WHERE org_id = ? AND id = ?',
            IMPORT_RUN_JOB.rollback,
            JSON.stringify({ runId: RUN, requestedBy: 'requester' }),
            ctx.orgId,
            'import-job',
          ),
        ]);
        const counts = {
          restored: Math.max(0, committed - 2),
          conflict: chunks === 0 ? 0 : 2,
          expired: 0,
        };
        expect(
          await runImportRollback(
            {
              store: createImportRollbackStore({ executor, providerAnchors: anchors }),
              clock: fixedClock(NOW),
              ids: { ulid },
            },
            ctx,
            { runId: RUN, requestedBy: 'requester' },
            fences,
          ),
        ).toEqual({ status: 'rolled_back', counts });
        expect(
          await executor.all(
            stmt(
              'SELECT state, last_error, rollback_restored_count, rollback_conflict_count, rollback_expired_count FROM import_run WHERE org_id = ? AND id = ?',
              ctx.orgId,
              RUN,
            ),
          ),
        ).toEqual([
          {
            state: 'rolled_back',
            last_error: null,
            rollback_restored_count: counts.restored,
            rollback_conflict_count: counts.conflict,
            rollback_expired_count: 0,
          },
        ]);
        const versions = await executor.all<{
          id: string;
          published_at: string;
          published_at_basis: string;
          metadata_json: string;
          revision: number;
        }>(
          stmt(
            'SELECT id, published_at, published_at_basis, metadata_json, revision FROM version WHERE org_id = ? ORDER BY id',
            ctx.orgId,
          ),
        );
        expect(versions).toHaveLength(committed + 1);
        for (const version of versions) {
          const conflict = chunks > 0 && ['v0', 'v1'].includes(version.id);
          const pending = version.id === `v${committed}`;
          expect(version).toEqual({
            id: version.id,
            published_at: conflict ? NOW : BEFORE,
            published_at_basis: conflict ? 'import_time' : 'source_release',
            metadata_json: chunks > 0 && version.id === 'v0' ? '{"edited":true}' : '{}',
            revision: pending ? 1 : conflict && version.id === 'v1' ? 2 : 3,
          });
        }
        const refs = await journal.rollbackRefs(ctx, RUN);
        expect(refs.filter((ref) => ref.rolledBackAt === NOW)).toHaveLength(counts.restored);
        expect(
          refs.filter(
            (ref) => ref.conflictState === 'changed_after_import' && ref.rolledBackAt === null,
          ),
        ).toHaveLength(counts.conflict);
        expect(
          await executor.all(
            stmt(
              "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'import_run.rollback'",
              ctx.orgId,
            ),
          ),
        ).toHaveLength(counts.restored + 1);
      } finally {
        await database.close();
      }
    });
  });
}
