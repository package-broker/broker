import { expect } from 'vitest';
import { AUDIT_GENESIS_HASH, verifyChain, type AuditRow } from '@package-broker/core/audit/chain';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditLedgerRepository } from '../../repositories/audit-ledger.js';
import { entries as ledgerEntries } from './audit-ledger.js';
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
    const chain = (orgId: string) =>
      executor.all({ sql: 'SELECT * FROM audit_chain WHERE org_id = ?', params: [orgId] });
    const foreignChainBefore = await chain(foreign.orgId);
    const foreignPendingBefore = await pending(foreign.orgId);
    const foreignEventsBefore = await events(foreign.orgId);
    const mutating: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(context.mutate(statement)),
      batch: (statements) => executor.batch(context.mutateBatch(statements)),
    };

    const result = createAuditSealRepository(mutating).seal(own, 1);
    await expect(result).resolves.toMatchObject({ outcome: 'sealed' });
    const outcome = await result;

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
    expect(await chain(foreign.orgId)).toEqual(foreignChainBefore);
    expect(await chain(own.orgId)).toEqual([
      expect.objectContaining({
        journal_rows: 1,
        journal_bytes: new TextEncoder().encode(JSON.stringify(ownEvents[0])).length,
      }),
    ]);
  },
};

const ageSparesForeign: ContractCase = {
  name: 'pending age excludes older foreign rows',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    for (const [id, orgId, time] of [
      ['own-age', own.orgId, 'now'],
      ['foreign-age', foreign.orgId, '-1 day'],
    ] as const) {
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?), 'system', 'org.update', 'organization')`,
        id,
        orgId,
        time === 'now' ? '+0 seconds' : time,
      );
    }
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    expect(await createAuditSealRepository(executor).pendingOldestAgeSeconds(own)).toBeLessThan(60);
  },
};

const casSparesForeign: ContractCase = {
  name: 'chain CAS isolates even organizations with identical chain state',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const { executor } = context;
    const seed = seeder(executor);
    await seed(
      'UPDATE audit_chain SET chain_id = (SELECT chain_id FROM audit_chain WHERE org_id = ?) WHERE org_id = ?',
      own.orgId,
      foreign.orgId,
    );
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('cas-own', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    const before = await executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [foreign.orgId],
    });
    const mutating: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(context.mutate(statement)),
      batch: (statements) => executor.batch(context.mutateBatch(statements)),
    };
    await expect(createAuditSealRepository(mutating).seal(own)).resolves.toMatchObject({
      outcome: 'sealed',
      sealed: 1,
    });
    expect(
      await executor.all({
        sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual(before);
  },
};

const indexedReads: ContractCase = {
  name: 'indexed journal reads and repair use only the organization journal',
  async run(context) {
    const own = context.orgs.b;
    const foreign = context.orgs.a;
    const seed = seeder(context.executor);
    for (const seq of [1, 2, 9])
      await seed(
        `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
       VALUES (?, ?, ?, ?, ?, '2026-10-17T09:00:00.000Z', 'system', 'org.update', 'organization')`,
        `foreign-${seq}`,
        foreign.orgId,
        seq,
        String(seq).repeat(64),
        String(seq).repeat(64),
      );
    for (const id of ['own-1', 'own-2'])
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
       VALUES (?, ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
        id,
        own.orgId,
      );
    await createAuditSealRepository(context.executor).seal(own);
    await seed(
      'UPDATE audit_chain SET boundary_seq = 2, boundary_prev_hash = (SELECT hash FROM audit_event WHERE org_id = ? AND seq = 1), journal_rows = 0, journal_bytes = 0 WHERE org_id = ?',
      own.orgId,
      own.orgId,
    );
    await seed('DELETE FROM audit_event WHERE org_id = ? AND seq = 1', own.orgId);
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('own-3', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toEqual({
      outcome: 'sealed',
      sealed: 1,
      headSeq: 3,
      headHash: expect.any(String),
      repaired: true,
    });
    expect(
      await context.executor.all({
        sql: 'SELECT journal_rows, boundary_seq, boundary_reason FROM audit_chain WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ journal_rows: 2, boundary_seq: 2, boundary_reason: null }]);
    expect(await createAuditLedgerRepository(context.executor).page(own, null, 100)).toEqual([]);
  },
};

const deleteScope: ContractCase = {
  name: 'deletion selects sealed event ids only from the organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('moved', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    let raced = false;
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await seed("UPDATE audit_pending SET org_id = ? WHERE id = 'moved'", foreign.orgId);
        }
        return context.executor.batch(context.mutateBatch(statements));
      },
    };
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toEqual({
      outcome: 'contended',
    });
    expect(
      await context.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ id: 'moved' }]);
  },
};

const headScope: ContractCase = {
  name: 'a foreign chain cannot supply the organization head',
  async run(context) {
    const own = context.orgs.b;
    const seed = seeder(context.executor);
    await seed(
      'UPDATE audit_chain SET head_seq = 8, boundary_seq = 9, head_hash = ?, boundary_prev_hash = ? WHERE org_id = ?',
      'f'.repeat(64),
      'f'.repeat(64),
      context.orgs.a.orgId,
    );
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('head-own', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toMatchObject({
      outcome: 'sealed',
      headSeq: 1,
    });
    expect(
      await context.executor.all({
        sql: 'SELECT seq, prev_hash FROM audit_event WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ seq: 1, prev_hash: AUDIT_GENESIS_HASH }]);
  },
};

const integrityRecoveryScope: ContractCase = {
  name: 'integrity recovery preserves foreign organization state',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed('UPDATE audit_chain SET boundary_seq = 2 WHERE org_id = ?', own.orgId);
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toMatchObject({
      outcome: 'empty',
      repaired: true,
    });
    expect(
      await context.executor.all({
        sql: 'SELECT boundary_seq FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ boundary_seq: 1 }]);
    expect(
      await context.executor.all({
        sql: 'SELECT boundary_seq FROM audit_chain WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ boundary_seq: 1 }]);
  },
};

const probeScope: ContractCase = {
  name: 'pending failure classification ignores changed foreign snapshots',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('probe', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    let raced = false;
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await seed(
            `UPDATE audit_pending SET org_id = ?, payload_json = '{"moved":true}' WHERE id = 'probe'`,
            foreign.orgId,
          );
        }
        return context.executor.batch(context.mutateBatch(statements));
      },
    };
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toEqual({
      outcome: 'contended',
    });
  },
};

const gapRecoveryScope: ContractCase = {
  name: 'gap recovery reads and writes only the organization journal and ledger',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'UPDATE audit_chain SET chain_id = (SELECT chain_id FROM audit_chain WHERE org_id = ?) WHERE org_id = ?',
      own.orgId,
      foreign.orgId,
    );
    for (const [seq, orgId] of [
      [1, own.orgId],
      [3, own.orgId],
      [2, foreign.orgId],
    ] as const)
      await seed(
        `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
        VALUES (?, ?, ?, ?, ?, '2026-10-17T09:00:00.000Z', 'system', 'org.update', 'organization')`,
        `gap-${seq}`,
        orgId,
        seq,
        seq === 1 ? AUDIT_GENESIS_HASH : String(seq).repeat(64),
        'a'.repeat(64),
      );
    await seed(
      'UPDATE audit_chain SET head_seq = 3, head_hash = ?, journal_rows = 2, journal_bytes = 1 WHERE org_id = ?',
      'a'.repeat(64),
      own.orgId,
    );
    const [chain] = await context.executor.all<{ chain_id: string }>({
      sql: 'SELECT chain_id FROM audit_chain WHERE org_id = ?',
      params: [own.orgId],
    });
    if (chain === undefined) throw new Error('missing chain');
    const ledger = createAuditLedgerRepository(context.executor);
    await ledger.append(foreign, [
      {
        id: '01K7R5V0000000000000000001',
        kind: 'gap',
        chainId: chain.chain_id,
        epoch: 0,
        fromSeq: 2,
        toSeq: 2,
        count: 1,
        sinkId: null,
        reasonCode: 'seq_gap',
        policy: 'availability',
        modeGeneration: 0,
        actorType: 'system',
        actorId: null,
        createdAt: '2026-10-28T10:00:00.000Z',
      },
    ]);
    const before = await ledger.page(foreign, null, 100);
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    expect(await createAuditSealRepository(executor).seal(own)).toMatchObject({
      outcome: 'empty',
      repaired: true,
    });
    expect(await ledger.page(own, null, 100)).toEqual([
      expect.objectContaining({ kind: 'gap', fromSeq: 2, toSeq: 2, count: 1 }),
    ]);
    expect(await ledger.page(foreign, null, 100)).toEqual(before);
  },
};

const resetFenceScope: ContractCase = {
  name: 'a foreign reset cannot suppress the organization pending reset',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'UPDATE audit_chain SET chain_id = (SELECT chain_id FROM audit_chain WHERE org_id = ?) WHERE org_id = ?',
      own.orgId,
      foreign.orgId,
    );
    const [chain] = await context.executor.all<{ chain_id: string }>({
      sql: 'SELECT chain_id FROM audit_chain WHERE org_id = ?',
      params: [own.orgId],
    });
    if (chain === undefined) throw new Error('missing chain');
    const ledger = createAuditLedgerRepository(context.executor);
    await ledger.append(foreign, [
      {
        id: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ',
        kind: 'chain_reset',
        chainId: chain.chain_id,
        epoch: 0,
        fromSeq: 1,
        toSeq: 1,
        count: 0,
        sinkId: null,
        reasonCode: 'tamper_detected',
        policy: 'availability',
        modeGeneration: 0,
        actorType: 'system',
        actorId: null,
        createdAt: '2026-10-28T10:00:00.000Z',
      },
    ]);
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('reset-own', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    let changed = false;
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: async (statements) => {
        if (!changed) {
          changed = true;
          await seed(
            `UPDATE audit_pending SET payload_json = '{"changed":true}' WHERE org_id = ?`,
            own.orgId,
          );
        }
        return context.executor.batch(context.mutateBatch(statements));
      },
    };
    expect(await createAuditSealRepository(executor).seal(own)).toMatchObject({
      outcome: 'sealed',
      sealed: 1,
      integrity: ['head_mismatch'],
    });
    expect(await ledger.page(own, null, 100)).toEqual([
      expect.objectContaining({ kind: 'chain_reset', fromSeq: 1, toSeq: 1 }),
    ]);
  },
};

const gapAboveScope: ContractCase = {
  name: 'only the organization recorded gaps keep its head above them',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      'UPDATE audit_chain SET chain_id = (SELECT chain_id FROM audit_chain WHERE org_id = ?) WHERE org_id = ?',
      own.orgId,
      foreign.orgId,
    );
    const [chain] = await context.executor.all<{ chain_id: string }>({
      sql: 'SELECT chain_id FROM audit_chain WHERE org_id = ?',
      params: [own.orgId],
    });
    if (chain === undefined) throw new Error('missing chain');
    await createAuditLedgerRepository(context.executor).append(foreign, [
      {
        id: '01K7R5V0000000000000000009',
        kind: 'gap',
        chainId: chain.chain_id,
        epoch: 0,
        fromSeq: 5,
        toSeq: 9,
        count: 5,
        sinkId: null,
        reasonCode: 'seq_gap',
        policy: 'availability',
        modeGeneration: 0,
        actorType: 'system',
        actorId: null,
        createdAt: '2026-10-28T10:00:00.000Z',
      },
    ]);
    for (const id of ['above-1', 'above-2', 'above-3'])
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
        id,
        own.orgId,
      );
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    await seed('UPDATE audit_chain SET journal_bytes = 1 WHERE org_id = ?', own.orgId);
    expect(await createAuditSealRepository(executor).seal(own)).toEqual({
      outcome: 'sealed',
      sealed: 3,
      headSeq: 3,
      headHash: expect.any(String),
      repaired: true,
    });
    const plain = createAuditSealRepository(context.executor);
    await seed('DELETE FROM audit_event WHERE org_id = ? AND seq = 3', own.orgId);
    await plain.seal(own);
    await seed(
      'UPDATE audit_chain SET head_seq = 2, head_hash = (SELECT hash FROM audit_event WHERE org_id = ? AND seq = 2) WHERE org_id = ?',
      own.orgId,
      own.orgId,
    );
    await seed(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('above-4', ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
      own.orgId,
    );
    expect(await createAuditSealRepository(executor).seal(own)).toMatchObject({
      outcome: 'sealed',
      sealed: 1,
      headSeq: 4,
      integrity: ['head_mismatch'],
    });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditSealRepository',
    file: 'repositories/audit-seal.ts',
    cases: [
      sealSparesForeign,
      ageSparesForeign,
      casSparesForeign,
      indexedReads,
      deleteScope,
      headScope,
      integrityRecoveryScope,
      probeScope,
      gapRecoveryScope,
      resetFenceScope,
      gapAboveScope,
      ...ledgerEntries.flatMap((entry) => entry.cases),
    ],
    predicates: [
      ...ledgerEntries.flatMap((entry) => entry.predicates),
      {
        name: 'gap detection reads only the organization journal',
        locate: /org_id = \?(?= AND seq BETWEEN)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: gapRecoveryScope.name,
      },
      {
        name: 'recorded gaps are read only from the organization ledger',
        locate: /org_id = \?(?= AND chain_id = \? AND epoch = \?\s+AND reason_code)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: gapRecoveryScope.name,
      },
      {
        name: 'recorded gaps above the head are read only from the organization ledger',
        locate: /t\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 5,
        waivedCopies: {
          2: 'the own recorded gap already refuses this allocation; copy 2 kills the same fence with only a foreign gap above the head',
        },
        caseName: gapAboveScope.name,
      },
      {
        name: 'gap recovery fences only the organization ledger',
        locate: /g\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: gapRecoveryScope.name,
      },
      {
        name: 'snapshot probes belong to the organization',
        locate: /org_id = \?(?= AND id IN)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: probeScope.name,
      },

      {
        name: 'the chain read belongs to the organization',
        locate: /c\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: headScope.name,
      },
      {
        name: 'deletion selects sealed event ids only from the organization',
        locate: /org_id = \?(?=\s+AND audit_pending.id)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: deleteScope.name,
      },
      {
        name: 'the first retained journal row belongs to the organization',
        locate: /org_id = \?(?= ORDER BY seq LIMIT)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: indexedReads.name,
      },
      {
        name: 'the retained anchor belongs to the organization',
        locate: /org_id = \?(?= AND seq = c.head_seq)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: indexedReads.name,
      },

      {
        name: 'the chain CAS belongs to the organization',
        locate: /org_id = \?(?= AND head_seq)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: casSparesForeign.name,
      },
      {
        name: 'the journal head belongs to the organization',
        locate: /org_id = \?(?= ORDER BY seq DESC)/,
        neutral: '(? is not null)',
        copies: 6,
        caseName: indexedReads.name,
      },
      {
        name: 'journal summary belongs to the organization',
        locate: /e\.org_id = \?(?=$)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: indexedReads.name,
      },
      {
        name: 'pending rows belong to the organization',
        locate: /org_id = \?(?= ORDER BY id LIMIT)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
      {
        name: 'byte counters include only organization events',
        locate: /e\.org_id = \?(?= AND e\.seq BETWEEN)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
      {
        name: 'counter updates preserve foreign chains',
        locate: /(?<=\) WHERE )org_id = \?(?=$)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: sealSparesForeign.name,
      },
      {
        name: 'pending age belongs to the organization',
        locate: /org_id = \?(?=$)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: ageSparesForeign.name,
      },
    ],
  },
];
