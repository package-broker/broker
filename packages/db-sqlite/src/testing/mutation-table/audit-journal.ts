import { expect } from 'vitest';
import { createAuditJournalReader } from '../../repositories/audit-query.js';
import { seedAuditJournal } from '../audit-journal-fixture.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const isolation: ContractCase = {
  name: 'bound journal scopes events, chain identity, and pending count',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditJournal(context.executor, own, 2);
    await seedAuditJournal(context.executor, foreign, 4);
    await context.executor.batch([
      {
        sql: "INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type) VALUES ('foreign', ?, '2026-10-28T00:00:00.000Z', 'system', 'org.update', 'organization')",
        params: [foreign.orgId],
      },
    ]);
    await context.executor.batch([
      {
        sql: "INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type) VALUES ('own', ?, '2026-10-28T00:00:00.000Z', 'system', 'org.update', 'organization')",
        params: [own.orgId],
      },
    ]);
    const reader = createAuditJournalReader(
      {
        ...context.executor,
        all: (statement) => context.executor.all(context.mutate(statement)),
      },
      foreign,
    );
    const result = await reader.list({ projectId: null, limit: 200 }).catch(() => null);
    expect(result).not.toBeNull();
    expect(result!.items.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(result!.items.every((row) => row.orgId === foreign.orgId)).toBe(true);
    const [chain] = await context.executor.all<{ chain_id: string }>({
      sql: 'SELECT chain_id FROM audit_chain WHERE org_id = ?',
      params: [foreign.orgId],
    });
    expect(result!.items.every((row) => row.chainId === chain!.chain_id)).toBe(true);
    expect(await reader.head()).toMatchObject({
      chainId: chain!.chain_id,
      headSeq: 4,
      pendingCount: 1,
    });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditJournalReader',
    file: 'repositories/audit-query.ts',
    cases: [isolation],
    predicates: [
      {
        name: 'journal chain identity belongs to the event organization',
        locate: /chain\.org_id = event\.org_id/,
        neutral: '1 = 1',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'journal events belong to the bound organization',
        locate: /event\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'persistent journal head belongs to the bound organization',
        locate: /(?<=FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'journal pending count belongs to the bound organization',
        locate: /(?<=FROM audit_pending WHERE )org_id = \?(?=\) AS pending_count)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolation.name,
      },
    ],
  },
];
