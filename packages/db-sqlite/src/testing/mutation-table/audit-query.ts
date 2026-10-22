import { expect } from 'vitest';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { createAuditQueryRepository } from '../../repositories/audit-query.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';

async function fixture(context: CaseContext) {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  for (const [id, orgId, seq] of [
    ['OWN-1', own.orgId, 1],
    ['OWN-2', own.orgId, 2],
    ['FOREIGN-1', foreign.orgId, 1],
    ['FOREIGN-4', foreign.orgId, 4],
  ] as const) {
    await seed(
      `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, action, target_type, project_id)
       VALUES (?, ?, ?, ?, ?, '2026-10-17T10:00:00.000Z', 'system', 'actor', 'org.update', 'organization', 'project')`,
      id,
      orgId,
      seq,
      seq === 1 ? AUDIT_GENESIS_HASH : String(seq - 1).repeat(64),
      String(seq).repeat(64),
    );
  }
  for (const [id, orgId] of [
    ['PENDING-OWN', own.orgId],
    ['PENDING-FOREIGN-1', foreign.orgId],
    ['PENDING-FOREIGN-2', foreign.orgId],
  ] as const) {
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
       VALUES (?, ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      id,
      orgId,
    );
  }
  for (const [orgId, timestamp] of [
    [own.orgId, '2026-10-22T11:00:00.000Z'],
    [foreign.orgId, '2026-10-22T12:00:00.000Z'],
  ] as const) {
    await seed('UPDATE organization SET audit_last_verified_at = ? WHERE id = ?', timestamp, orgId);
  }
  const foreignRows = async () => ({
    events: await context.executor.all({
      sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
      params: [foreign.orgId],
    }),
    pending: await context.executor.all({
      sql: 'SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id',
      params: [foreign.orgId],
    }),
  });
  const before = await foreignRows();
  const executor: ScalarSqlExecutor = {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
  return {
    own,
    foreign,
    repository: createAuditQueryRepository(executor),
    async assertForeignUnchanged() {
      expect(await foreignRows()).toEqual(before);
    },
  };
}

const listSparesForeign: ContractCase = {
  name: 'audit lists and filters return only organization rows',
  async run(context) {
    const { own, repository, assertForeignUnchanged } = await fixture(context);
    for (const filter of [
      {},
      { projectId: 'project' },
      { actor: 'actor' },
      { action: 'org.update' },
      { projectId: 'project', actor: 'actor', action: 'org.update' },
      { afterId: 'OWN-1' },
    ]) {
      const page = await repository.list(own, { ...filter, limit: 200 });
      expect(page.items.map((row) => row.id)).toEqual(
        filter.afterId === undefined ? ['OWN-1', 'OWN-2'] : ['OWN-2'],
      );
      expect(page.items.every((row) => row.org_id === own.orgId)).toBe(true);
      expect(page.next).toBeNull();
    }
    await assertForeignUnchanged();
  },
};

const cursorSparesForeign: ContractCase = {
  name: 'an audit cursor from another organization cannot select a page',
  async run(context) {
    const { own, repository, assertForeignUnchanged } = await fixture(context);
    expect(await repository.list(own, { afterId: 'FOREIGN-1', limit: 200 })).toEqual({
      items: [],
      next: null,
    });
    await assertForeignUnchanged();
  },
};

const headSparesForeign: ContractCase = {
  name: 'the audit head and pending count use only organization rows',
  async run(context) {
    const { own, repository, assertForeignUnchanged } = await fixture(context);
    expect(await repository.head(own)).toEqual({
      seq: 2,
      hash: '2'.repeat(64),
      pending: 1,
      lastVerifiedAt: '2026-10-22T11:00:00.000Z',
    });
    await assertForeignUnchanged();
  },
};

const verificationSparesForeign: ContractCase = {
  name: 'audit head reads the requested organization verification time',
  async run(context) {
    const { foreign, repository } = await fixture(context);
    expect((await repository.head(foreign))?.lastVerifiedAt).toBe('2026-10-22T12:00:00.000Z');
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditQueryRepository',
    file: 'repositories/audit-query.ts',
    cases: [listSparesForeign, cursorSparesForeign, headSparesForeign, verificationSparesForeign],
    predicates: [
      {
        name: 'listed audit events belong to the organization',
        locate: /(?<=FROM audit_event WHERE )org_id = \?(?! AND id =| ORDER BY seq DESC)/,
        neutral: '(? is not null)',
        copies: 6,
        caseName: listSparesForeign.name,
      },
      {
        name: 'the cursor event belongs to the organization',
        locate: /org_id = \?(?= AND id =)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: cursorSparesForeign.name,
      },
      {
        name: 'the sealed audit head belongs to the organization',
        locate: /org_id = \?(?= ORDER BY seq DESC)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: headSparesForeign.name,
      },
      {
        name: 'the last verification time belongs to the organization',
        locate: /(?<=FROM organization WHERE )id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: verificationSparesForeign.name,
      },
      {
        name: 'the pending audit count belongs to the organization',
        locate: /org_id = \?(?=\) AS pending)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: headSparesForeign.name,
      },
    ],
  },
];
