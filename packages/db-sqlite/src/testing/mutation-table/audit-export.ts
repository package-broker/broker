import { expect } from 'vitest';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditExportRepository } from '../../repositories/audit-export.js';
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
  for (const ctx of [own, foreign]) {
    await seed(
      `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
      receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
      VALUES (?, 'archive', 'audit', 'webhook', 1, 'fingerprint', 1, 'build', 'active', 0, ?, 0)`,
      ctx.orgId,
      '0'.repeat(64),
    );
    for (const seq of [1, 2, 3])
      await seed(
        `INSERT INTO audit_event
      (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
      VALUES (?, ?, ?, ?, ?, '2026-10-28T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        `${ctx.orgId}-${seq}`,
        ctx.orgId,
        seq,
        String(seq - 1).repeat(64),
        String(seq).repeat(64),
      );
    await seed(
      'UPDATE audit_chain SET head_seq = ? WHERE org_id = ?',
      ctx.orgId === own.orgId ? 2 : 3,
      ctx.orgId,
    );
  }
  await seed(
    `INSERT INTO job (id, org_id, type, resource_key, state, lease_owner, fence, lease_until)
    VALUES ('export-job', ?, 'audit-export-archive', 'audit-export:archive', 'running', 'worker', 3, '2099-01-01T00:00:00.000Z')`,
    own.orgId,
  );
  const executor: SqlExecutor = {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
  return {
    own,
    foreign,
    seed,
    plain: createAuditExportRepository(context.executor),
    repository: createAuditExportRepository(executor),
    fence: systemMutationFence('audit-export', { id: 'export-job', owner: 'worker', fence: 3 }, {}),
  };
}
const read: ContractCase = {
  name: 'export snapshot and highest generation belong to the requested organization',
  async run(context) {
    const { foreign, seed, plain, repository } = await fixture(context);
    await seed('UPDATE audit_sink SET generation = 99 WHERE org_id = ?', foreign.orgId);
    const snapshot = await repository.read(foreign, 'archive');
    expect(snapshot.sink.generation).toBe(99);
    expect(snapshot).toEqual(await plain.read(foreign, 'archive'));
  },
};
const highestRead: ContractCase = {
  name: 'export highest generation excludes foreign builds',
  async run(context) {
    const { own, foreign, seed, repository } = await fixture(context);
    await seed('UPDATE audit_sink SET generation = 99 WHERE org_id = ?', foreign.orgId);
    expect((await repository.read(own, 'archive')).highestGeneration).toBe(1);
  },
};
const page: ContractCase = {
  name: 'export pages isolate both event rows and sealed head',
  async run(context) {
    const { own, foreign, repository } = await fixture(context);
    expect((await repository.page(own, 0, 100)).map((row) => row.id)).toEqual([
      `${own.orgId}-1`,
      `${own.orgId}-2`,
    ]);
    expect((await repository.page(foreign, 0, 100)).map((row) => row.id)).toEqual([
      `${foreign.orgId}-1`,
      `${foreign.orgId}-2`,
      `${foreign.orgId}-3`,
    ]);
  },
};
const head: ContractCase = {
  name: 'foreign export pages use their own sealed head',
  async run(context) {
    const { foreign, repository } = await fixture(context);
    expect((await repository.page(foreign, 0, 100)).map((row) => row.seq)).toEqual([1, 2, 3]);
  },
};
const save: ContractCase = {
  name: 'export saves isolate sink and highest generation',
  async run(context) {
    const { own, foreign, plain, repository, fence } = await fixture(context);
    const expected = await plain.read(own, 'archive');
    const other = await plain.read(foreign, 'archive');
    expect(await repository.save(own, fence, expected, { ...expected.sink, attempt: 1 }, 1)).toBe(
      true,
    );
    expect(await plain.read(foreign, 'archive')).toEqual(other);
  },
};
const highestSave: ContractCase = {
  name: 'export save generation excludes foreign builds',
  async run(context) {
    const { own, foreign, seed, plain, repository, fence } = await fixture(context);
    await seed('UPDATE audit_sink SET generation = 99 WHERE org_id = ?', foreign.orgId);
    const expected = await plain.read(own, 'archive');
    expect(await repository.save(own, fence, expected, { ...expected.sink, attempt: 1 }, 1)).toBe(
      true,
    );
  },
};
const chain: ContractCase = {
  name: 'a foreign chain snapshot cannot authorize an export save',
  async run(context) {
    const { own, foreign, plain, repository, fence } = await fixture(context);
    const expected = await plain.read(own, 'archive');
    const other = await plain.read(foreign, 'archive');
    expect(expected.chainId).not.toBe(other.chainId);
    expect(
      await repository.save(
        own,
        fence,
        { ...expected, chainId: other.chainId, incarnation: other.incarnation },
        { ...expected.sink, attempt: 1 },
        1,
      ),
    ).toBe(false);
    expect(await plain.read(own, 'archive')).toEqual(expected);
  },
};
const lease: ContractCase = {
  name: 'a foreign job lease cannot authorize an export save',
  async run(context) {
    const { own, foreign, seed, plain, repository, fence } = await fixture(context);
    await seed('UPDATE job SET org_id = ? WHERE id = ?', foreign.orgId, 'export-job');
    const expected = await plain.read(own, 'archive');
    expect(await repository.save(own, fence, expected, { ...expected.sink, attempt: 1 }, 1)).toBe(
      false,
    );
    expect(await plain.read(own, 'archive')).toEqual(expected);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditExportRepository',
    file: 'repositories/audit-export.ts',
    cases: [read, highestRead, page, head, save, highestSave, chain, lease],
    predicates: [
      {
        name: 'snapshot organization',
        locate: /c.org_id = \?(?= AND s.sink_id)/,
        neutral: '(? IS NOT NULL)',
        caseName: read.name,
        copies: 1,
      },
      {
        name: 'snapshot highest generation organization',
        locate: /(?<=MAX\(generation\), 0\) FROM audit_sink WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: highestRead.name,
        copies: 1,
      },
      {
        name: 'paged event organization',
        locate: /e.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: page.name,
        copies: 2,
      },
      {
        name: 'sealed head organization',
        locate: /(?<=head_seq FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: head.name,
        copies: 1,
      },
      {
        name: 'updated sink organization',
        locate: /org_id = \?(?= AND sink_id IS)/,
        neutral: '(? IS NOT NULL)',
        caseName: save.name,
        copies: 1,
      },
      {
        name: 'save highest generation organization',
        locate: /(?<=MAX\(generation\), 0\) FROM audit_sink WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: highestSave.name,
        copies: 1,
      },
      {
        name: 'save chain organization',
        locate: /c.org_id = \?(?=\s+AND c.chain_id)/,
        neutral: '(? IS NOT NULL)',
        caseName: chain.name,
        copies: 1,
      },
      {
        name: 'save lease organization',
        locate: /job.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: lease.name,
        copies: 1,
      },
    ],
    waivers: [
      {
        locate: /s.org_id = c.org_id/,
        reason: 'Join shape: both rows share the organization scoped by c.org_id.',
      },
    ],
  },
];
