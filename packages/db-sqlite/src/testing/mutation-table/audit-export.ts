import { auditDurableCoverage, type AuditExportState } from '@package-broker/core/audit/export';
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
const replay: ContractCase = {
  name: 'durable ACK resolution reads only the requested organization incidents and resolutions',
  async run(context) {
    const { own, foreign, seed, plain, repository, fence } = await fixture(context);
    for (const ctx of [own, foreign]) {
      const snapshot = await plain.read(ctx, 'archive');
      await seed(
        `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
        count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        VALUES (?, '01J00000000000000000000007', 'uncertain', ?, 0, ?, ?, 1, 'archive',
        'partial_rejected', 'availability', 0, 'system', '2026-10-30T00:00:00.000Z')`,
        ctx.orgId,
        snapshot.chainId,
        ctx === own ? 2 : 1,
        ctx === own ? 2 : 1,
      );
      if (ctx === foreign)
        await seed(
          `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch,
        from_seq, to_seq, count, sink_id, resolves_id, reason_code, policy, mode_generation, actor_type, created_at)
        VALUES (?, '01J00000000000000000000008', 'replay', ?, 0, 1, 1, 1, 'archive',
        '01J00000000000000000000007', 'durable_ack', 'availability', 0, 'system', '2026-10-30T00:00:00.000Z')`,
          ctx.orgId,
          snapshot.chainId,
        );
    }
    // Identical chain identity makes organization isolation independently observable.
    const ownSnapshot = await plain.read(own, 'archive');
    await seed(
      'UPDATE audit_chain SET chain_id = ? WHERE org_id = ?',
      ownSnapshot.chainId,
      foreign.orgId,
    );
    // Ledger rows are immutable, so seed a matching foreign chain incident separately.
    await seed(
      `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
      count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
      VALUES (?, '01J00000000000000000000009', 'uncertain', ?, 0, 2, 2, 1, 'archive',
      'partial_rejected', 'availability', 0, 'system', '2026-10-30T00:00:00.000Z')`,
      foreign.orgId,
      ownSnapshot.chainId,
    );
    await seed(
      `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
      receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
      VALUES (?, 'other', 'audit', 'webhook', 1, 'fingerprint', 1, 'build', 'active', 0, ?, 0)`,
      own.orgId,
      '0'.repeat(64),
    );
    for (const [id, chainId, epoch, sinkId] of [
      ['10', 'f'.repeat(32), 0, 'archive'],
      ['11', ownSnapshot.chainId, 1, 'archive'],
      ['12', ownSnapshot.chainId, 0, 'other'],
    ] as const) {
      await seed(
        `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
        count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        VALUES (?, ?, 'uncertain', ?, ?, 2, 2, 1, ?, 'partial_rejected', 'availability', 0, 'system', '2026-10-30T00:00:00.000Z')`,
        own.orgId,
        id.padStart(26, '0'),
        chainId,
        epoch,
        sinkId,
      );
    }
    for (const [id, kind, from, to] of [
      ['13', 'skipped', 2, 2],
      ['14', 'uncertain', 2, 3],
      ['15', 'uncertain', 1, 2],
    ] as const) {
      await seed(
        `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
        count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'archive', 'partial_rejected', 'availability', 0, 'system', '2026-10-30T00:00:00.000Z')`,
        own.orgId,
        id.padStart(26, '0'),
        kind,
        ownSnapshot.chainId,
        from,
        to,
        to - from + 1,
      );
    }
    await seed(
      'UPDATE audit_sink SET inflight_repr = ? WHERE org_id = ? AND sink_id = ?',
      JSON.stringify({ custodyFromSeq: 2 }),
      own.orgId,
      'archive',
    );
    const base = await plain.read(own, 'archive');
    const expected = {
      ...base.sink,
      inflightFrom: 2,
      inflightTo: 2,
      inflightRepr: JSON.stringify({ custodyFromSeq: 2 }),
    };
    expect(await plain.save(own, fence, base, expected, 1)).toBe(true);
    const snapshot = await plain.read(own, 'archive');
    await expect(
      repository.save(
        own,
        fence,
        snapshot,
        {
          ...snapshot.sink,
          progressSeq: 2,
          custodySeq: 2,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 2,
            ...auditDurableCoverage(snapshot.sink, { from: 2, to: 2 }),
          }),
        },
        1,
        { replayCreatedAt: '2026-10-30T00:00:00.000Z', durableAck: { from: 2, to: 2 } },
      ),
    ).resolves.toBe(true);
    const rows = await context.executor.all<{
      resolves_id: string;
      from_seq: number;
      to_seq: number;
    }>({
      sql: "SELECT resolves_id, from_seq, to_seq FROM audit_ledger WHERE org_id = ? AND kind = 'replay'",
      params: [own.orgId],
    });
    expect(rows).toEqual([{ resolves_id: '01J00000000000000000000007', from_seq: 2, to_seq: 2 }]);
  },
};
async function holdFixture(context: CaseContext) {
  const fixed = await fixture(context);
  for (const ctx of [fixed.own, fixed.foreign])
    await fixed.seed(
      `UPDATE audit_sink SET inflight_from = 1, inflight_to = 2, inflight_body = '{}',
      inflight_repr = '{"custodyFromSeq":1,"purpose":"events"}' WHERE org_id = ?`,
      ctx.orgId,
    );
  const held = (sink: AuditExportState): AuditExportState => ({
    ...sink,
    inflightRepr: JSON.stringify({
      custodyFromSeq: 1,
      purpose: 'events',
      uncertainOutcome: { rejectedCount: 1 },
    }),
  });
  return { ...fixed, held };
}
const holdSink: ContractCase = {
  name: 'export holds update only the requested organization sink',
  async run(context) {
    const { own, foreign, plain, repository, fence, held } = await holdFixture(context);
    const expected = await plain.read(own, 'archive');
    const other = await plain.read(foreign, 'archive');
    expect(await repository.hold(own, fence, expected, held(expected.sink), 1)).toBe(true);
    expect(await plain.read(foreign, 'archive')).toEqual(other);
  },
};
const holdHighest: ContractCase = {
  name: 'export hold generation excludes foreign builds',
  async run(context) {
    const { own, foreign, seed, plain, repository, fence, held } = await holdFixture(context);
    await seed('UPDATE audit_sink SET generation = 99 WHERE org_id = ?', foreign.orgId);
    const expected = await plain.read(own, 'archive');
    expect(await repository.hold(own, fence, expected, held(expected.sink), 1)).toBe(true);
  },
};
const holdChain: ContractCase = {
  name: 'a foreign chain snapshot cannot authorize an export hold',
  async run(context) {
    const { own, foreign, plain, repository, fence, held } = await holdFixture(context);
    const expected = await plain.read(own, 'archive');
    const other = await plain.read(foreign, 'archive');
    expect(
      await repository.hold(
        own,
        fence,
        { ...expected, chainId: other.chainId, incarnation: other.incarnation },
        held(expected.sink),
        1,
      ),
    ).toBe(false);
    expect(await plain.read(own, 'archive')).toEqual(expected);
  },
};
const holdLease: ContractCase = {
  name: 'a foreign job lease cannot authorize an export hold',
  async run(context) {
    const { own, foreign, seed, plain, repository, fence, held } = await holdFixture(context);
    await seed('UPDATE job SET org_id = ? WHERE id = ?', foreign.orgId, 'export-job');
    const expected = await plain.read(own, 'archive');
    expect(await repository.hold(own, fence, expected, held(expected.sink), 1)).toBe(false);
    expect(await plain.read(own, 'archive')).toEqual(expected);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditExportRepository',
    file: 'repositories/audit-export.ts',
    cases: [
      read,
      highestRead,
      page,
      head,
      save,
      highestSave,
      chain,
      lease,
      replay,
      holdSink,
      holdHighest,
      holdChain,
      holdLease,
    ],
    predicates: [
      {
        name: 'replay incident kind',
        locate: /u.kind = 'uncertain'/,
        neutral: '1 = 1',
        caseName: replay.name,
        copies: 1,
      },
      {
        name: 'replay incident lower bound',
        locate: /u.from_seq >= json_extract\(coverage.value, '\$\.from'\)/,
        neutral: '1 = 1',
        caseName: replay.name,
        copies: 1,
      },
      {
        name: 'replay incident upper bound',
        locate: /u.to_seq <= json_extract\(coverage.value, '\$\.to'\)/,
        neutral: '1 = 1',
        caseName: replay.name,
        copies: 1,
      },
      {
        name: 'replay incident organization',
        locate: /u.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: replay.name,
        copies: 1,
      },
      {
        name: 'replay resolution organization',
        locate: /r.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: replay.name,
        copies: 1,
      },
      ...(['chain_id', 'epoch', 'sink_id'] as const).map((column) => ({
        name: `replay incident ${column}`,
        locate: new RegExp(`u\\.${column} = \\?`),
        neutral: '(? IS NOT NULL)',
        caseName: replay.name,
        copies: 1,
      })),
      {
        name: 'replay insert organization',
        locate: /duplicate.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: replay.name,
        copies: 1,
      },
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
      {
        name: 'held sink organization',
        locate: /org_id = \?(?= AND sink_id IS)/,
        neutral: '(? IS NOT NULL)',
        caseName: holdSink.name,
        copies: 1,
      },
      {
        name: 'hold highest generation organization',
        locate: /(?<=MAX\(generation\), 0\) FROM audit_sink WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: holdHighest.name,
        copies: 1,
      },
      {
        name: 'hold chain organization',
        locate: /c.org_id = \?(?=\s+AND c.chain_id)/,
        neutral: '(? IS NOT NULL)',
        caseName: holdChain.name,
        copies: 1,
      },
      {
        name: 'hold lease organization',
        locate: /job.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: holdLease.name,
        copies: 1,
      },
    ],
    waivers: [
      {
        locate: /(?:open_gap|stored|hidden)\.org_id = \?/,
        reason:
          'Delegated unchanged to createAuditLedgerRepository.statements; audit-ledger.ts mutation cases cover these predicates.',
      },
      {
        locate: /s.org_id = c.org_id/,
        reason: 'Join shape: both rows share the organization scoped by c.org_id.',
      },
    ],
  },
];
