import { expect } from 'vitest';
import { AUDIT_GENESIS_HASH, verifyChain, type AuditRow } from '@package-broker/core/audit/chain';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditSealRepository } from '../../repositories/audit-seal.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const sealSparesForeign: ContractCase = {
  name: 'sealing uses only the organization pending rows and head and preserves foreign audit data',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const { executor } = context;
    const seed = seeder(executor);
    for (const [id, orgId] of [
      ['10-OWN', own.orgId],
      ['20-SHARED', own.orgId],
      ['00-FOREIGN', foreign.orgId],
      ['01-FOREIGN', foreign.orgId],
    ] as const) {
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
         VALUES (?, ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
        id,
        orgId,
      );
    }
    // The foreign event shares an ID with an unsealed own row, so a widened DELETE subquery
    // would consume that row even though it was excluded by the seal limit.
    await seed(
      `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
       VALUES ('20-SHARED', ?, 1, ?, ?, '2026-10-17T09:00:00.000Z', 'system', 'org.update', 'organization')`,
      foreign.orgId,
      AUDIT_GENESIS_HASH,
      'f'.repeat(64),
    );

    const pending = (orgId: string) =>
      executor.all({
        sql: 'SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id',
        params: [orgId],
      });
    const events = (orgId: string) =>
      executor.all<AuditRow>({
        sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
        params: [orgId],
      });
    const foreignPendingBefore = await pending(foreign.orgId);
    const foreignEventsBefore = await events(foreign.orgId);
    const mutating: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(context.mutate(statement)),
      batch: (statements) => executor.batch(context.mutateBatch(statements)),
    };

    const outcome = await createAuditSealRepository(mutating).seal(own, 1);

    expect(outcome).toMatchObject({ outcome: 'sealed', sealed: 1, headSeq: 1 });
    const ownEvents = await events(own.orgId);
    expect(ownEvents).toEqual([
      expect.objectContaining({
        id: '10-OWN',
        org_id: own.orgId,
        seq: 1,
        prev_hash: AUDIT_GENESIS_HASH,
      }),
    ]);
    expect(await verifyChain(ownEvents)).toBeNull();
    expect(outcome).toMatchObject({ headHash: ownEvents[0]?.hash });
    expect((await pending(own.orgId)).map((row) => row.id)).toEqual(['20-SHARED']);
    expect(await pending(foreign.orgId)).toEqual(foreignPendingBefore);
    expect(await events(foreign.orgId)).toEqual(foreignEventsBefore);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditSealRepository',
    file: 'repositories/audit-seal.ts',
    cases: [sealSparesForeign],
    predicates: [
      {
        name: 'the chain head belongs to the organization',
        locate: /org_id = \?(?= ORDER BY seq DESC)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
      {
        name: 'pending rows belong to the organization',
        locate: /org_id = \?(?= ORDER BY id LIMIT)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
      {
        name: 'deletion selects sealed event ids only from the organization',
        locate: /org_id = \?(?= AND seq BETWEEN)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
    ],
    waivers: [
      {
        locate: /org_id = \?(?= AND id IN)/,
        reason:
          'The scoped audit_event subquery selects only IDs just inserted from the own pending rows; audit_pending.id is globally unique, so the outer organization predicate is redundant for those IDs.',
      },
    ],
  },
];
