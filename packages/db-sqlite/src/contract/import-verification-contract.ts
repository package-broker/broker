import { describe, expect, it } from 'vitest';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { IMPORT_RUN_JOB, IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
import {
  createImportJournalStore,
  hash as importContentHash,
} from '../repositories/import-journal.js';
import { createImportVerificationStore } from '../repositories/import-verification.js';

export function describeImportVerificationContract(
  make: () => Promise<{
    executor: SqlExecutor;
    ctx: OrgContext;
    close(): Promise<void>;
  }>,
): void {
  describe('import verification lease contract', () => {
    async function fixture() {
      const f = await make();
      const { executor, ctx } = f;
      const now = new Date().toISOString();
      const runId = '01J00000000000000000000RUN';
      const job = { id: 'verify-job', owner: 'worker', fence: 1 };
      const s = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
      const manifest = { version: 1, source_system: 'test', items: [], widening: [] } as const;
      await executor.batch([
        s(
          "INSERT INTO import_run (id, org_id, source_system, state) VALUES (?, ?, 'test', 'verifying')",
          runId,
          ctx.orgId,
        ),
        s(
          "INSERT INTO job (id, org_id, type, resource_key, payload_json, state, lease_owner, lease_until, fence) VALUES (?, ?, ?, ?, ?, 'running', ?, '2099-01-01T00:00:00.000Z', 1)",
          job.id,
          ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
          IMPORT_VERIFICATION_JOB.resourceKey(runId),
          JSON.stringify({ runId }),
          job.owner,
        ),
      ]);
      let beforeBatch: (() => Promise<void>) | undefined;
      const queries: Statement[] = [];
      const recording: SqlExecutor = {
        driver: executor.driver,
        all: (s) => {
          queries.push(s);
          return executor.all(s);
        },
        async batch(statements) {
          const hook = beforeBatch;
          beforeBatch = undefined;
          await hook?.();
          return executor.batch(statements);
        },
      };
      const store = createImportVerificationStore({ executor: recording, providerAnchors: [] });
      return {
        ...f,
        store,
        queries,
        now,
        runId,
        job,
        s,
        manifest,
        fence: () => systemMutationFence('verifier', job, {}),
        input: { runId, now, manifest },
        beforeBatch: (hook: () => Promise<void>) => {
          beforeBatch = hook;
        },
        row: () =>
          executor.all(
            s(
              'SELECT state, last_error, before_image_expires_at FROM import_run WHERE org_id = ? AND id = ?',
              ctx.orgId,
              runId,
            ),
          ),
        audits: () =>
          executor.all(
            s('SELECT action, payload_json FROM audit_pending WHERE org_id = ?', ctx.orgId),
          ),
      };
    }
    for (const loss of ['owner', 'fence', 'expiry'] as const) {
      it(`keeps verifying without audit or expiry after mid-verification lease ${loss} loss`, async () => {
        const f = await fixture();
        try {
          f.beforeBatch(async () => {
            const change =
              loss === 'owner'
                ? "lease_owner = 'other'"
                : loss === 'fence'
                  ? 'fence = 2'
                  : "lease_until = '2000-01-01T00:00:00.000Z'";
            await f.executor.batch([
              f.s(`UPDATE job SET ${change} WHERE org_id = ? AND id = ?`, f.ctx.orgId, f.job.id),
            ]);
          });
          expect(await f.store.verify(f.ctx, f.fence(), f.input)).toMatchObject({ ok: false });
          expect(await f.row()).toEqual([
            { state: 'verifying', last_error: null, before_image_expires_at: null },
          ]);
          expect(await f.audits()).toEqual([]);
        } finally {
          await f.close();
        }
      });
    }

    it.each([
      ['missing row', 'DELETE FROM project WHERE org_id = ?', 'item_missing'],
      ['digest change', "UPDATE project SET name = 'Changed' WHERE org_id = ?", 'digest_mismatch'],
      [
        'archived visibility',
        "UPDATE project SET status = 'archived' WHERE org_id = ?",
        'visibility_mismatch',
      ],
      [
        'rolled-back ref',
        "UPDATE import_ref SET rolled_back_at = '2026-01-01T00:00:00.000Z' WHERE org_id = ?",
        'item_missing',
      ],
      [
        'missing digest',
        'UPDATE import_ref SET content_hash = NULL WHERE org_id = ?',
        'digest_mismatch',
      ],
    ])('rejects an item with %s', async (_name, mutation, reason) => {
      const f = await fixture();
      try {
        const domain = {
          slug: 'imported',
          name: 'Imported',
          status: 'active',
          token_max_scope: 'full',
          require_publish_approval: 0,
        };
        await f.executor.batch([
          f.s(
            "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'imported', 'Imported')",
            f.ctx.orgId,
          ),
          f.s(
            "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, content_hash) VALUES ('ref', ?, ?, 'project', 'project', 'project', 'create', ?)",
            f.ctx.orgId,
            f.runId,
            await importContentHash(domain),
          ),
          f.s(mutation, f.ctx.orgId),
        ]);
        expect(
          await f.store.verify(f.ctx, f.fence(), {
            ...f.input,
            manifest: {
              ...f.manifest,
              items: [
                { type: 'project', external_ref: 'project', slug: 'imported', name: 'Imported' },
              ],
            },
          }),
        ).toMatchObject({ ok: true });
        expect(await f.row()).toEqual([
          { state: 'applied', last_error: reason, before_image_expires_at: null },
        ]);
        expect(await f.audits()).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it('verifies large manifests in bounded read pages within the D1 parameter limit', async () => {
      const f = await fixture();
      try {
        const items = Array.from({ length: 85 }, (_, i) => ({
          type: 'project' as const,
          external_ref: `project-${i}`,
          slug: `project-${i}`,
          name: `Project ${i}`,
        }));
        const statements: Statement[] = [];
        for (const item of items) {
          const digest = await importContentHash({
            slug: item.slug,
            name: item.name,
            status: 'active',
            token_max_scope: 'full',
            require_publish_approval: 0,
          });
          statements.push(
            f.s(
              'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
              item.external_ref,
              f.ctx.orgId,
              item.slug,
              item.name,
            ),
            f.s(
              "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, content_hash) VALUES (?, ?, ?, 'project', ?, ?, 'create', ?)",
              item.external_ref,
              f.ctx.orgId,
              f.runId,
              item.external_ref,
              item.external_ref,
              digest,
            ),
          );
        }
        await f.executor.batch(statements);
        expect(
          await f.store.verify(f.ctx, f.fence(), {
            ...f.input,
            manifest: { ...f.manifest, items },
          }),
        ).toMatchObject({ ok: true });
        expect(f.queries.length).toBeLessThanOrEqual(5);
        expect(f.queries.every((query) => query.params.length <= 100)).toBe(true);
        expect(await f.row()).toMatchObject([{ state: 'verified' }]);
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'checks version override digest and basis (changed=%s)',
      async (changed) => {
        const f = await fixture();
        try {
          const digest = await importContentHash({
            blob_id: null,
            published_at: f.now,
            status: 'active',
            metadata_json: '{}',
          });
          await f.executor.batch([
            f.s(
              "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
              f.ctx.orgId,
            ),
            f.s(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('package', ?, 'source', 'npm', 'pkg')",
              f.ctx.orgId,
            ),
            f.s(
              "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('version', ?, 'package', '1.0.0', '1.0.0', ?, ?, '{}')",
              f.ctx.orgId,
              f.now,
              changed ? 'import_time' : 'source_release',
            ),
            f.s(
              "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, content_hash, published_at_basis) VALUES ('version-ref', ?, ?, 'version', 'version', 'override', 'update', ?, 'source_release')",
              f.ctx.orgId,
              f.runId,
              digest,
            ),
          ]);
          const item = {
            type: 'version_override' as const,
            external_ref: 'override',
            source: { existing: { project: null, name: 'source' } },
            package: 'pkg',
            version: '1.0.0',
            published_at: f.now,
            basis: 'source_release' as const,
          };
          expect(
            await f.store.verify(f.ctx, f.fence(), {
              ...f.input,
              manifest: { ...f.manifest, items: [item] },
            }),
          ).toMatchObject({ ok: true });
          expect(await f.row()).toMatchObject([
            {
              state: changed ? 'applied' : 'verified',
              last_error: changed ? 'digest_mismatch' : null,
            },
          ]);
        } finally {
          await f.close();
        }
      },
    );

    it('refuses a stale fence on success and failure and permits the new owner to resume', async () => {
      const f = await fixture();
      try {
        await f.executor.batch([
          f.s('UPDATE job SET fence = 2 WHERE org_id = ? AND id = ?', f.ctx.orgId, f.job.id),
        ]);
        expect(await f.store.verify(f.ctx, f.fence(), f.input)).toMatchObject({ ok: false });
        expect(
          await f.store.fail(f.ctx, f.fence(), { ...f.input, reason: 'item_missing' }),
        ).toMatchObject({ ok: false });
        expect(await f.audits()).toEqual([]);
        const fresh = systemMutationFence('verifier', { ...f.job, fence: 2 }, {});
        expect(await f.store.verify(f.ctx, fresh, f.input)).toMatchObject({ ok: true });
        expect(await f.row()).toEqual([
          {
            state: 'verified',
            last_error: null,
            before_image_expires_at: new Date(Date.parse(f.now) + 90 * 86400000).toISOString(),
          },
        ]);
        const audits = await f.audits();
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ action: 'import_run.verify' });
        expect(
          await f.store.verify(f.ctx, fresh, {
            ...f.input,
            now: new Date(Date.parse(f.now) + 1000).toISOString(),
          }),
        ).toMatchObject({ ok: false });
        expect(await f.audits()).toEqual(audits);
      } finally {
        await f.close();
      }
    });
    it('refuses completion when a domain write replaces the snapshot epoch', async () => {
      const f = await fixture();
      try {
        f.beforeBatch(async () => {
          await f.executor.batch([
            f.s(
              'UPDATE cache_epoch SET version = hex(randomblob(16)) WHERE org_id = ?',
              f.ctx.orgId,
            ),
          ]);
        });
        expect(await f.store.verify(f.ctx, f.fence(), f.input)).toMatchObject({ ok: false });
        expect(await f.row()).toEqual([
          { state: 'verifying', last_error: null, before_image_expires_at: null },
        ]);
        expect(await f.audits()).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it.each(['success', 'failure'] as const)(
      'refuses %s while an own rollback is queued',
      async (outcome) => {
        const f = await fixture();
        try {
          await f.executor.batch([
            f.s(
              "INSERT INTO job (id, org_id, type, resource_key, payload_json, state) VALUES ('rollback', ?, ?, ?, '{}', 'queued')",
              f.ctx.orgId,
              IMPORT_RUN_JOB.rollback,
              IMPORT_RUN_JOB.resourceKey(f.runId),
            ),
          ]);
          const result =
            outcome === 'success'
              ? await f.store.verify(f.ctx, f.fence(), f.input)
              : await f.store.fail(f.ctx, f.fence(), { ...f.input, reason: 'item_missing' });
          expect(result).toMatchObject({ ok: false });
          expect(await f.row()).toEqual([
            { state: 'verifying', last_error: null, before_image_expires_at: null },
          ]);
          expect(await f.audits()).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([-120000, 120000])(
      'refuses a worker clock skew of %s ms against database time',
      async (skew) => {
        const f = await fixture();
        try {
          expect(
            await f.store.verify(f.ctx, f.fence(), {
              ...f.input,
              now: new Date(Date.parse(f.now) + skew).toISOString(),
            }),
          ).toMatchObject({ ok: false });
          expect(await f.row()).toEqual([
            { state: 'verifying', last_error: null, before_image_expires_at: null },
          ]);
          expect(await f.audits()).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it('refuses verification without an expected snapshot epoch', async () => {
      const f = await fixture();
      try {
        const journal = createImportJournalStore({ executor: f.executor, providerAnchors: [] });
        // Exercise an untyped caller as well as the required TypeScript input.
        const result = await journal.markVerified(f.ctx, f.fence(), {
          runId: f.runId,
          verifiedAt: f.now,
          // @ts-expect-error expectedEpoch must be a string
          expectedEpoch: null,
        });
        expect(result).toMatchObject({ ok: false });
        expect(await f.row()).toEqual([
          { state: 'verifying', last_error: null, before_image_expires_at: null },
        ]);
        expect(await f.audits()).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('returns a failed verification to applied with its audited reason and no expiry', async () => {
      const f = await fixture();
      try {
        expect(
          await f.store.verify(f.ctx, f.fence(), {
            ...f.input,
            manifest: {
              ...f.manifest,
              items: [
                { type: 'project', external_ref: 'missing', slug: 'missing', name: 'Missing' },
              ],
            },
          }),
        ).toMatchObject({ ok: true });
        expect(await f.row()).toEqual([
          { state: 'applied', last_error: 'item_missing', before_image_expires_at: null },
        ]);
        const audits = await f.audits();
        expect(audits).toHaveLength(1);
        expect(JSON.parse(String(audits[0]!.payload_json))).toMatchObject({
          changes: {
            state: { old: 'verifying', new: 'applied' },
            reason: { new: 'item_missing' },
          },
        });
      } finally {
        await f.close();
      }
    });
    it.each(['success', 'failure'] as const)(
      'rolls %s back when its audit insert fails',
      async (outcome) => {
        const f = await fixture();
        try {
          await f.executor.batch([
            f.s(
              "CREATE TRIGGER refuse_verification_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
            ),
          ]);
          const result =
            outcome === 'success'
              ? await f.store.verify(f.ctx, f.fence(), f.input)
              : await f.store.fail(f.ctx, f.fence(), { ...f.input, reason: 'digest_mismatch' });
          expect(result).toMatchObject({ ok: false });
          expect(await f.row()).toEqual([
            { state: 'verifying', last_error: null, before_image_expires_at: null },
          ]);
          expect(await f.audits()).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
  });
}
