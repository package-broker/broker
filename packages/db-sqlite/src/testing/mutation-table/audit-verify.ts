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
  },
};

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
    await reader.markVerified(own, completedAt);
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

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditVerifyReader',
    file: 'repositories/audit-verify.ts',
    cases: [pageSparesForeign, completionSparesForeign],
    predicates: [
      {
        name: 'verification completion belongs to the organization',
        locate: /(?<=WHERE )id = \?(?= AND)/,
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
