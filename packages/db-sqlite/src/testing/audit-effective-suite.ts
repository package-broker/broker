import { describe, it, expect } from 'vitest';
import type { EffectiveAuditConfig } from '@package-broker/core/audit/effective';
import type { MigratedDatabase } from './migrated-database.js';
import { createAuditEffectiveRepository } from '../repositories/audit-effective.js';
import { createAuditNoneRepository } from '../repositories/audit-none.js';

export function auditEffectiveRepositorySuite(open: () => Promise<MigratedDatabase>) {
  describe('effective audit persistence', () => {
    const initial: EffectiveAuditConfig = {
      policy: 'availability',
      policySource: 'build',
      persistRaise: false,
      mode: 'none',
      trailActive: false,
      activeSinkIds: [],
      blockedSinkIds: [],
      durableSinkIds: [],
      durablePath: false,
      maxJournalBytes: 67108864,
      warnings: [],
    };
    it('initializes exactly once without events and cannot borrow a foreign snapshot', async () => {
      const database = await open();
      try {
        const org = database.orgs!.a;
        const foreign = database.orgs!.b;
        const repository = createAuditEffectiveRepository(database.executor);
        const reader = createAuditNoneRepository(database.executor);
        const snapshot = await reader.snapshot(org);
        const before = await reader.snapshot(foreign);
        expect(await repository.initialize(org, before, initial, 0)).toBe(false);
        expect(await repository.initialize(org, snapshot, initial, 0)).toBe(true);
        expect(await repository.initialize(org, snapshot, initial, 0)).toBe(false);
        expect(await reader.snapshot(org)).toEqual({
          ...snapshot,
          mode: 'none',
          modeGeneration: 1,
        });
        expect(await reader.snapshot(foreign)).toEqual(before);
        for (const table of ['audit_pending', 'audit_ledger'])
          expect(
            await database.executor.all({
              sql: `SELECT id FROM ${table} WHERE org_id = ?`,
              params: [org.orgId],
            }),
          ).toEqual([]);
      } finally {
        await database.close();
      }
    });
    it.each(['pending', 'ledger', 'head', 'generation', 'restore', 'required'] as const)(
      'does not initialize over %s state even with an earlier fresh snapshot',
      async (state) => {
        const database = await open();
        try {
          const org = database.orgs!.a;
          const reader = createAuditNoneRepository(database.executor);
          const snapshot = await reader.snapshot(org);
          if (state === 'pending')
            await database.executor.batch([
              {
                sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
                  VALUES (?, 'setup', '2026-10-31T12:00:00.000Z', 'system', 'setup.complete', 'user')`,
                params: [org.orgId],
              },
            ]);
          else if (state === 'ledger')
            await createAuditEffectiveRepository(database.executor).save(
              org,
              snapshot,
              { ...initial, policy: 'required', mode: 'trail' },
              0,
              '2026-10-31T12:00:00.000Z',
            );
          else
            await database.executor.batch([
              {
                sql: `UPDATE audit_chain SET ${
                  state === 'head'
                    ? 'head_seq = 1'
                    : state === 'generation'
                      ? 'mode_generation = 1'
                      : state === 'restore'
                        ? 'restore_pending = 1'
                        : "policy = 'required'"
                } WHERE org_id = ?`,
                params: [org.orgId],
              },
            ]);
          const before = await reader.snapshot(org);
          expect(
            await createAuditEffectiveRepository(database.executor).initialize(
              org,
              snapshot,
              initial,
              0,
            ),
          ).toBe(false);
          expect(await reader.snapshot(org)).toEqual(before);
        } finally {
          await database.close();
        }
      },
    );

    it('raises policy atomically, records the transition once and isolates organizations', async () => {
      const database = await open();
      try {
        const org = database.orgs!.a;
        const foreign = database.orgs!.b;
        const repository = createAuditEffectiveRepository(database.executor);
        const snapshot = await createAuditNoneRepository(database.executor).snapshot(org);
        const effective: EffectiveAuditConfig = {
          policy: 'required',
          policySource: 'env',
          persistRaise: true,
          mode: 'trail',
          trailActive: true,
          activeSinkIds: [],
          blockedSinkIds: [],
          durableSinkIds: [],
          durablePath: true,
          maxJournalBytes: 67108864,
          warnings: [],
        };
        expect(await repository.save(org, snapshot, effective, 1, '2026-10-31T12:00:00.000Z')).toBe(
          true,
        );
        expect(await repository.save(org, snapshot, effective, 1, '2026-10-31T12:00:00.000Z')).toBe(
          false,
        );
        const current = await createAuditNoneRepository(database.executor).snapshot(org);
        expect(current).toMatchObject({
          policy: 'required',
          mode: 'trail',
          modeGeneration: snapshot.modeGeneration + 1,
        });
        expect(await repository.save(org, current, effective, 1, '2026-10-31T12:00:00.000Z')).toBe(
          true,
        );
        expect(
          await database.executor.all({
            sql: 'SELECT kind FROM audit_ledger WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ kind: 'policy_change' }]);
        expect(
          await database.executor.all({
            sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ action: 'audit.mode_change' }]);
        expect(await createAuditNoneRepository(database.executor).snapshot(foreign)).toMatchObject({
          policy: 'availability',
          modeGeneration: 0,
        });
        await expect(
          repository.save(
            org,
            current,
            { ...effective, policy: 'availability' },
            1,
            '2026-10-31T12:00:00.000Z',
          ),
        ).rejects.toThrow('Invalid audit effective transition');
      } finally {
        await database.close();
      }
    });
    it('keeps a fenced cutover during a policy raise', async () => {
      const database = await open();
      try {
        const org = database.orgs!.a;
        await database.executor.batch([
          {
            sql: "UPDATE audit_chain SET pending_mode = 'export', cutover_seq = 7, head_seq = 9 WHERE org_id = ?",
            params: [org.orgId],
          },
        ]);
        const snapshot = await createAuditNoneRepository(database.executor).snapshot(org);
        const effective: EffectiveAuditConfig = {
          policy: 'required',
          policySource: 'env',
          persistRaise: true,
          mode: 'export',
          trailActive: false,
          activeSinkIds: [],
          blockedSinkIds: [],
          durableSinkIds: [],
          durablePath: true,
          maxJournalBytes: 67108864,
          warnings: [],
        };
        const repository = createAuditEffectiveRepository(database.executor);
        expect(await repository.save(org, snapshot, effective, 0, '2026-10-31T12:00:00.000Z')).toBe(
          true,
        );
        const raised = {
          ...snapshot,
          policy: 'required' as const,
          modeGeneration: snapshot.modeGeneration + 1,
        };
        expect(await createAuditNoneRepository(database.executor).snapshot(org)).toEqual(raised);
        expect(
          await repository.save(
            org,
            raised,
            { ...effective, mode: 'trail' },
            0,
            '2026-10-31T12:00:00.000Z',
          ),
        ).toBe(false);
        expect(await createAuditNoneRepository(database.executor).snapshot(org)).toEqual(raised);
      } finally {
        await database.close();
      }
    });
    it('uses cli as the source of a stored required ratchet and null system correlation ids', async () => {
      const database = await open();
      try {
        const org = database.orgs!.a;
        await database.executor.batch([
          {
            sql: "UPDATE audit_chain SET policy = 'required', mode = 'none' WHERE org_id = ?",
            params: [org.orgId],
          },
        ]);
        const snapshot = await createAuditNoneRepository(database.executor).snapshot(org);
        const effective: EffectiveAuditConfig = {
          policy: 'required',
          policySource: 'stored',
          persistRaise: false,
          mode: 'trail',
          trailActive: true,
          activeSinkIds: [],
          blockedSinkIds: [],
          durableSinkIds: [],
          durablePath: true,
          maxJournalBytes: 67108864,
          warnings: [],
        };
        expect(
          await createAuditEffectiveRepository(database.executor).save(
            org,
            snapshot,
            effective,
            0,
            '2026-10-31T12:00:00.000Z',
          ),
        ).toBe(true);
        const [event] = await database.executor.all<{ payload_json: string }>({
          sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ?',
          params: [org.orgId],
        });
        expect(JSON.parse(event!.payload_json)).toMatchObject({
          op_id: null,
          request_id: null,
          changes: { source: { new: 'cli' } },
        });
      } finally {
        await database.close();
      }
    });
    it.each(['restore', 'generation'] as const)(
      'refuses %s contention without partial ledger or events',
      async (cause) => {
        const database = await open();
        try {
          const org = database.orgs!.a;
          const snapshot = await createAuditNoneRepository(database.executor).snapshot(org);
          await database.executor.batch([
            {
              sql:
                cause === 'restore'
                  ? 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?'
                  : `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq) VALUES (?, 'archive', 'sink', 'webhook', 2, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, '${'0'.repeat(64)}', 0)`,
              params: [org.orgId],
            },
          ]);
          const effective: EffectiveAuditConfig = {
            policy: 'availability',
            policySource: 'build',
            persistRaise: false,
            mode: 'export',
            trailActive: false,
            activeSinkIds: [],
            blockedSinkIds: [],
            durableSinkIds: [],
            durablePath: false,
            maxJournalBytes: 67108864,
            warnings: [],
          };
          expect(
            await createAuditEffectiveRepository(database.executor).save(
              org,
              snapshot,
              effective,
              0,
              '2026-10-31T12:00:00.000Z',
            ),
          ).toBe(false);
          expect(
            await database.executor.all({
              sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
              params: [org.orgId],
            }),
          ).toEqual([]);
          expect(
            await database.executor.all({
              sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
              params: [org.orgId],
            }),
          ).toEqual([]);
        } finally {
          await database.close();
        }
      },
    );
    it('rolls the policy, ledger and verification back when event staging fails', async () => {
      const database = await open();
      try {
        const org = database.orgs!.a;
        const snapshot = await createAuditNoneRepository(database.executor).snapshot(org);
        await database.executor.batch([
          {
            sql: `CREATE TRIGGER refuse_effective_event BEFORE INSERT ON audit_pending
          WHEN NEW.action = 'audit.mode_change' BEGIN SELECT RAISE(ABORT, 'fixture_refusal'); END`,
            params: [],
          },
        ]);
        const effective: EffectiveAuditConfig = {
          policy: 'required',
          policySource: 'env',
          persistRaise: true,
          mode: 'trail',
          trailActive: true,
          activeSinkIds: [],
          blockedSinkIds: [],
          durableSinkIds: [],
          durablePath: true,
          maxJournalBytes: 67108864,
          warnings: [],
        };
        await expect(
          createAuditEffectiveRepository(database.executor).save(
            org,
            snapshot,
            effective,
            0,
            '2026-10-31T12:00:00.000Z',
          ),
        ).rejects.toBeDefined();
        expect(await createAuditNoneRepository(database.executor).snapshot(org)).toEqual(snapshot);
        expect(
          await database.executor.all({
            sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([]);
        expect(
          await database.executor.all({
            sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([]);
      } finally {
        await database.close();
      }
    });
  });
}
