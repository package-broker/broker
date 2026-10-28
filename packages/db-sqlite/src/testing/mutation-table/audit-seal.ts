import { expect } from 'vitest';
import { AuditIntegrityError } from '@package-broker/core/audit/sealer';
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
    await expect(createAuditSealRepository(executor).seal(own)).resolves.toMatchObject({
      outcome: 'sealed',
      headSeq: 3,
      repaired: true,
    });
    expect(
      await context.executor.all({
        sql: 'SELECT journal_rows FROM audit_chain WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ journal_rows: 2 }]);
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

const integrityStopScope: ContractCase = {
  name: 'an integrity stop preserves foreign organization state',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed('UPDATE audit_chain SET boundary_seq = 2 WHERE org_id = ?', own.orgId);
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    await expect(createAuditSealRepository(executor).seal(own)).rejects.toEqual(
      new AuditIntegrityError('seq_gap'),
    );
    expect(
      await context.executor.all({
        sql: 'SELECT restore_pending FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ restore_pending: 0 }]);
    expect(
      await context.executor.all({
        sql: 'SELECT restore_pending FROM audit_chain WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ restore_pending: 1 }]);
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
      integrityStopScope,
      probeScope,
    ],
    predicates: [
      {
        name: 'integrity stops belong to the organization',
        locate: /(?<=SET restore_pending = 1 WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: integrityStopScope.name,
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
