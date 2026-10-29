import { expect } from 'vitest';
import { createAuditSealRepository } from '../../repositories/audit-seal.js';
import { createAuditVerifyReader } from '../../repositories/audit-verify.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const pageSparesForeign: ContractCase = {
  name: 'verification pages contain only sealed rows of the organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    for (const [id, org] of [
      ['FOREIGN', foreign],
      ['FOREIGN-2', foreign],
      ['OWN', own],
    ] as const) {
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
         VALUES (?, ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        id,
        org.orgId,
      );
      await createAuditSealRepository(context.executor).seal(org);
    }
    const reader = createAuditVerifyReader({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    expect(await reader.page(own, 0, 500)).toEqual([
      expect.objectContaining({ id: 'OWN', org_id: own.orgId, seq: 1 }),
    ]);
    expect(await reader.page(own, 1, 500)).toEqual([]);
    const snapshot = await reader.snapshot(own);
    expect(snapshot).toMatchObject({ head_seq: 1 });
    const plain = createAuditVerifyReader(context.executor);
    expect(snapshot.head_hash).toBe((await plain.page(own, 0, 1))[0]!.hash);
    expect(
      await reader.markVerified(
        own,
        '2026-10-22T12:00:00.000Z',
        {
          fromSeq: 1,
          throughSeq: 1,
          bodies: 0,
          withheld: 1,
        },
        await plain.snapshot(own),
      ),
    ).toBe(true);
  },
};

const checkpointSparesForeign = (checkpoint: 'head' | 'stored'): ContractCase => ({
  name: `foreign ${checkpoint} checkpoint hashes cannot satisfy completion`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    for (const org of [own, foreign]) {
      await context.executor.batch(
        [1, 2].map((seq) => ({
          sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
          VALUES (?, ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
          params: [`${org.orgId}-${seq}`, org.orgId],
        })),
      );
      await createAuditSealRepository(context.executor).seal(org);
    }
    const plain = createAuditVerifyReader(context.executor);
    const ownRows = await plain.page(own, 0, 500);
    const foreignRows = await plain.page(foreign, 0, 500);
    const snapshot = await plain.snapshot(own);
    const reader = createAuditVerifyReader({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    {
      expect(
        await reader.markVerified(
          own,
          '2026-10-22T12:00:00.000Z',
          {
            fromSeq: 1,
            throughSeq: 2,
            bodies: 0,
            withheld: 2,
          },
          {
            ...snapshot,
            stored_seq: 1,
            stored_hash: checkpoint === 'stored' ? foreignRows[0]!.hash : ownRows[0]!.hash,
            head_hash: checkpoint === 'head' ? foreignRows[1]!.hash : ownRows[1]!.hash,
          },
        ),
      ).toBe(false);
    }
  },
});

const completionSparesForeign: ContractCase = {
  name: 'verification completion updates only its organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const reader = createAuditVerifyReader({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    const completedAt = '2026-10-22T12:00:00.000Z';
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ? WHERE org_id = ?',
        params: [(await reader.snapshot(own)).chain_id, foreign.orgId],
      },
    ]);
    await reader.markVerified(
      own,
      completedAt,
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(own),
    );
    expect(
      await context.executor.all({
        sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ verified_at: null }]);
    for (const org of [own, foreign]) {
      expect(
        await context.executor.all({
          sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ audit_last_verified_at: org === own ? completedAt : null }]);
    }
  },
};

const clearSparesForeign: ContractCase = {
  name: 'clearing verification preserves foreign scope',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const plain = createAuditVerifyReader(context.executor);
    for (const org of [own, foreign])
      await plain.markVerified(
        org,
        '2026-10-22T12:00:00.000Z',
        { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
        await plain.snapshot(org),
      );
    const reader = createAuditVerifyReader({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    await reader.clearVerification(own);
    expect(
      await context.executor.all({
        sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ verified_at: '2026-10-22T12:00:00.000Z' }]);
    expect(
      await context.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: '2026-10-22T12:00:00.000Z' }]);
  },
};

const snapshotSparesForeign: ContractCase = {
  name: 'snapshot uses only its organization head and identity',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      { sql: 'UPDATE audit_chain SET head_seq = 5 WHERE org_id = ?', params: [own.orgId] },
      { sql: 'UPDATE audit_chain SET head_seq = 9 WHERE org_id = ?', params: [foreign.orgId] },
    ]);
    const reader = createAuditVerifyReader({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    // Pick the organization that an unscoped table scan would not return first.
    const [first] = await context.executor.all<{ org_id: string }>({
      sql: 'SELECT * FROM audit_chain WHERE (? is not null)',
      params: [own.orgId],
    });
    const selected = first!.org_id === own.orgId ? foreign : own;
    expect((await reader.snapshot(selected)).stored_seq).toBe(selected === own ? 5 : 9);
    const plain = createAuditVerifyReader(context.executor);
    expect((await plain.snapshot(own)).head_seq).toBe(5);
    expect((await plain.snapshot(foreign)).head_seq).toBe(9);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'clearAuditVerificationStatements',
    file: 'repositories/audit-verify.ts',
    cases: [clearSparesForeign],
    predicates: [
      {
        name: 'clear chain scope belongs to its organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: clearSparesForeign.name,
      },
      {
        name: 'clear legacy scope belongs to its organization',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: clearSparesForeign.name,
      },
    ],
  },
  {
    builder: 'createAuditVerifyReader',
    file: 'repositories/audit-verify.ts',
    cases: [
      pageSparesForeign,
      checkpointSparesForeign('head'),
      checkpointSparesForeign('stored'),
      completionSparesForeign,
      clearSparesForeign,
      snapshotSparesForeign,
    ],
    predicates: [
      {
        name: 'clear chain scope belongs to its organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: clearSparesForeign.name,
      },
      {
        name: 'clear legacy scope belongs to its organization',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: clearSparesForeign.name,
      },

      {
        name: 'snapshot and completion tails belong to the organization',
        locate: /org_id = \?(?= ORDER BY seq DESC LIMIT 1)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: pageSparesForeign.name,
      },
      ...(['head', 'stored'] as const).map((checkpoint) => ({
        name: `${checkpoint} checkpoint rows belong to the organization`,
        locate: new RegExp(`${checkpoint === 'head' ? 'h' : 's'}\\.org_id = \\?(?= AND)`),
        neutral: '(? is not null)',
        copies: 1,
        caseName: checkpointSparesForeign(checkpoint).name,
      })),
      {
        name: 'chain completion belongs to its organization',
        locate: /org_id = \?(?= AND chain_id)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: completionSparesForeign.name,
      },
      {
        name: 'snapshot identity belongs to its organization',
        locate: /(?<=FROM audit_chain WHERE )org_id = \?(?=$)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: snapshotSparesForeign.name,
      },
      {
        name: 'verification completion belongs to the organization',
        locate: /(?<=WHERE )id = \?(?=\s+AND)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: completionSparesForeign.name,
      },
      {
        name: 'sealed verification rows belong to the organization',
        locate: /org_id = \?(?= AND seq >)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: pageSparesForeign.name,
      },
    ],
  },
];
