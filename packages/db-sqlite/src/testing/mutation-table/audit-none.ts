import { expect } from 'vitest';
import { validateAuditBuild } from '@package-broker/core/audit/effective';
import { enterAuditNone, type AuditNonePort } from '@package-broker/core/audit/none';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditNoneRepository } from '../../repositories/audit-none.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

function mutated(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (s) => context.executor.all(context.mutate(s)),
    batch: (s) => context.executor.batch(context.mutateBatch(s)),
  };
}
const options = {
  audit: {
    build: validateAuditBuild(
      { platform: 'cloudflare', plugins: [], audit: { acceptNoDurableAudit: true } },
      () => undefined,
      'cloudflare',
    ),
    sinks: [],
    alertPathActive: false,
  },
  generation: 3,
  now: '2026-10-30T12:00:00.000Z',
  ids: [
    '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  ] as const,
};
const read: ContractCase = {
  name: 'none snapshot reads only the requested organization',
  async run(context) {
    const { foreign } = orgOf(context);
    const expected = await createAuditNoneRepository(context.executor).snapshot(foreign);
    expect(await createAuditNoneRepository(mutated(context)).snapshot(foreign)).toEqual(expected);
  },
};
const isolated: ContractCase = {
  name: 'none transition ignores foreign generation and preserves foreign state',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
          VALUES (?, 'archive', 'audit', 'webhook', 9, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, ?, 0)`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
      {
        sql: 'UPDATE audit_chain SET verified_at = ? WHERE org_id = ?',
        params: [options.now, foreign.orgId],
      },
      {
        sql: 'UPDATE organization SET audit_last_verified_at = ? WHERE id = ?',
        params: [options.now, foreign.orgId],
      },
    ]);
    const before = await context.executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [foreign.orgId],
    });
    expect(
      await enterAuditNone(createAuditNoneRepository(mutated(context)), own, options),
    ).toMatchObject({ outcome: 'degraded' });
    expect(
      await context.executor.all({
        sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual(before);
    expect(
      await context.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: options.now }]);
  },
};
const guard: ContractCase = {
  name: 'none refuses the own restored chain even when a matching foreign chain is safe',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const plain = createAuditNoneRepository(context.executor);
    const snapshot = await plain.snapshot(own);
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ?, incarnation = ? WHERE org_id = ?',
        params: [snapshot.chainId, snapshot.incarnation, foreign.orgId],
      },
      { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [own.orgId] },
    ]);
    const target = createAuditNoneRepository(mutated(context));
    const port: AuditNonePort = {
      snapshot: async () => snapshot,
      record: (...args) => target.record(...args),
    };
    expect(await enterAuditNone(port, own, options)).toEqual({ outcome: 'contended' });
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditNoneRepository',
    file: 'repositories/audit-none.ts',
    cases: [read, isolated, guard],
    predicates: [
      {
        name: 'snapshot organization',
        locate: /(?<=policy FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: read.name,
      },
      {
        name: 'snapshot guard organization',
        locate: /c\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: guard.name,
      },
      {
        name: 'generation organization',
        locate: /s\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
      {
        name: 'mode update organization',
        locate: /org_id = \?(?= RETURNING org_id)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
      {
        name: 'verification organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
      {
        name: 'organization verification scope',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
    ],
    waivers: [
      {
        locate: /(?:open_gap|stored|hidden)\.org_id = \?/,
        reason:
          'Existing ledger statement scopes are mutation-tested by the ledger repository registration; none uses those unchanged statements.',
      },
    ],
  },
];
