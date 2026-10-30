import { expect } from 'vitest';
import { createAuditStatusReader } from '../../repositories/audit-status.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

export const isolation: ContractCase = {
  name: 'status excludes foreign chain, pending, sinks and ledger',
  async run(context) {
    const { own: foreign, foreign: own } = orgOf(context);
    await context.executor.batch([
      { sql: "UPDATE audit_chain SET mode = 'trail' WHERE org_id = ?", params: [own.orgId] },
      { sql: "UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", params: [foreign.orgId] },
      {
        sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
          VALUES (?, 'pending', 'now', 'system', 'org.update', 'organization')`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
          VALUES (?, 'sink', 'sink', 'webhook', 0, 'fingerprint', 1, 'build', 'blocked', 0, ?, 0, 'now', 'now')`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
          SELECT org_id, 'incident', 'gap', chain_id, epoch, 1, 1, 1, 'seq_gap', policy, mode_generation, 'system', 'now' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
    ]);
    const reader = createAuditStatusReader({
      ...context.executor,
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    const status = await reader.read(own);
    const [chain] = await context.executor.all<{ chain_id: string }>({
      sql: 'SELECT chain_id FROM audit_chain WHERE org_id = ?',
      params: [own.orgId],
    });
    expect(status).toMatchObject({
      chainId: chain!.chain_id,
      mode: 'trail',
      pendingCount: 0,
      sinks: [],
      ledger: [],
      capacity: { state: 'ok', journalRows: 0, journalBytes: 0 },
      verification: null,
    });
  },
};
const ledgerIsolation: ContractCase = {
  name: 'status incidents isolate the chain lookup and resolutions as well as ledger rows',
  async run(context) {
    const { own: foreign, foreign: own } = orgOf(context);
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
          VALUES (?, 'sink', 'sink', 'webhook', 0, 'fingerprint', 1, 'build', 'active', 0, ?, 0, 'now', 'now')`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          reason_code, policy, mode_generation, actor_type, created_at)
          SELECT org_id, 'gap', 'gap', chain_id, epoch, 1, 1, 2, 'seq_gap', policy, mode_generation,
            'system', 'now' FROM audit_chain WHERE org_id IN (?, ?)`,
        params: [own.orgId, foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          reason_code, policy, mode_generation, actor_type, created_at)
          SELECT org_id, 'shared', 'uncertain', chain_id, epoch, 1, 1, 3, 'test_reason', policy,
            mode_generation, 'system', 'now' FROM audit_chain WHERE org_id IN (?, ?)`,
        params: [own.orgId, foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          reason_code, policy, mode_generation, actor_type, created_at)
          SELECT f.org_id, 'foreign-history', 'gap', o.chain_id, o.epoch, 1, 1, 9, 'seq_gap',
            f.policy, f.mode_generation, 'system', 'now' FROM audit_chain f, audit_chain o
          WHERE f.org_id = ? AND o.org_id = ?`,
        params: [foreign.orgId, own.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          sink_id, resolves_id, reason_code, policy, mode_generation, actor_type, created_at)
          SELECT org_id, 'resolution', 'replay', chain_id, epoch, 1, 1, 3, 'sink', 'shared',
            'test_reason', policy, mode_generation, 'system', 'now' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
    ]);
    const reader = createAuditStatusReader({
      ...context.executor,
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    expect((await reader.read(own)).ledger).toEqual([
      { kind: 'gap', count: 2 },
      { kind: 'uncertain', count: 3 },
    ]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditStatusReader',
    file: 'repositories/audit-status.ts',
    cases: [isolation, ledgerIsolation],
    predicates: [
      ...['audit_chain', 'audit_pending', 'audit_sink'].map((table) => ({
        name: `${table} status belongs to the organization`,
        locate: new RegExp(`(?<=FROM ${table}\\s+WHERE )org_id = \\?`),
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolation.name,
      })),
      ...[
        {
          name: 'ledger incidents belong to the organization',
          locate: /(?<=FROM audit_ledger\s+WHERE )org_id = \?/,
        },
        { name: 'current chain belongs to the organization', locate: /current_chain.org_id = \?/ },
        {
          name: 'incident resolutions belong to the organization',
          locate: /resolution.org_id = \?/,
        },
      ].map((predicate) => ({
        ...predicate,
        neutral: '(? is not null)',
        copies: 1,
        caseName: ledgerIsolation.name,
      })),
    ],
  },
];
