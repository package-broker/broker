import { expect } from 'vitest';
import { createAuditPruneRepository } from '../../repositories/audit-prune.js';
import { createAuditSealRepository } from '../../repositories/audit-seal.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const isolated: ContractCase = {
  name: 'pruning preserves foreign events and verification',
  async run(context) {
    const { own, foreign } = orgOf(context);
    for (const org of [own, foreign]) {
      await context.executor.batch([
        {
          sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
          VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
          params: [org.orgId, org.orgId],
        },
      ]);
      await createAuditSealRepository(context.executor).seal(org);
      await context.executor.batch([
        {
          sql: "UPDATE audit_chain SET mode = 'export', verified_at = '2026-10-29T00:00:00.000Z' WHERE org_id = ?",
          params: [org.orgId],
        },
        {
          sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
          SELECT org_id, 'archive', 'audit', 'webhook', 1, ?, 1, 'ARCHIVE_URL', 'active',
          head_seq, head_hash, head_seq FROM audit_chain WHERE org_id = ?`,
          params: ['a'.repeat(64), org.orgId],
        },
      ]);
    }
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES ('foreign-next', ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [foreign.orgId],
      },
    ]);
    await createAuditSealRepository(context.executor).seal(foreign);
    await context.executor.batch([
      {
        sql: 'UPDATE audit_sink SET generation = 2, progress_seq = 0, inflight_from = 1, inflight_to = 1 WHERE org_id = ?',
        params: [foreign.orgId],
      },
    ]);
    await context.executor.batch([
      {
        sql: 'UPDATE audit_event SET prev_hash = CASE seq WHEN 1 THEN ? ELSE ? END WHERE org_id = ?',
        params: ['b'.repeat(64), 'c'.repeat(64), foreign.orgId],
      },
    ]);
    const before = await context.executor.all({
      sql: 'SELECT * FROM audit_event WHERE org_id = ?',
      params: [foreign.orgId],
    });
    const repository = createAuditPruneRepository({
      driver: context.executor.driver,
      all: (s) => context.executor.all(context.mutate(s)),
      batch: (s) => context.executor.batch(context.mutateBatch(s)),
    });
    expect(
      await repository.prune(own, {
        generation: 1,
        configuredSinkIds: ['archive'],
        trailActive: false,
      }),
    ).toEqual({ outcome: 'pruned', pruned: 1, boundarySeq: 2 });
    expect(
      await context.executor.all({
        sql: 'SELECT * FROM audit_event WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual(before);
    expect(
      await context.executor.all({
        sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ verified_at: '2026-10-29T00:00:00.000Z' }]);
  },
};
function foreignAuthorization(configured: boolean): ContractCase {
  return {
    name: configured
      ? 'foreign membership cannot supply a missing configured sink'
      : 'foreign durable custody cannot authorize pruning',
    async run(context) {
      const { own, foreign } = orgOf(context);
      for (const org of [own, foreign]) {
        await context.executor.batch([
          {
            sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
            VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
            params: [org.orgId, org.orgId],
          },
        ]);
        await createAuditSealRepository(context.executor).seal(org);
        await context.executor.batch([
          {
            sql: "UPDATE audit_chain SET mode = 'export' WHERE org_id = ?",
            params: [org.orgId],
          },
          {
            sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
            durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
            SELECT org_id, ?, 'audit', 'webhook', 1, ?, ?, 'ARCHIVE_URL', 'active', head_seq, head_hash, head_seq
            FROM audit_chain WHERE org_id = ?`,
            params: [
              org === own ? 'local' : 'archive',
              'a'.repeat(64),
              org === own && !configured ? 0 : 1,
              org.orgId,
            ],
          },
        ]);
      }
      const repository = createAuditPruneRepository({
        driver: context.executor.driver,
        all: (s) => context.executor.all(context.mutate(s)),
        batch: (s) => {
          expect.fail('ineligible pruning must not reach the mutation batch');
          return context.executor.batch(context.mutateBatch(s));
        },
      });
      expect(
        await repository.prune(own, {
          generation: 1,
          configuredSinkIds: configured ? ['archive'] : [],
          trailActive: false,
        }),
      ).toEqual({ outcome: 'retained' });
    },
  };
}
const membership = foreignAuthorization(true);
const custody = foreignAuthorization(false);
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditPruneRepository',
    file: 'repositories/audit-prune.ts',
    cases: [isolated, membership, custody],
    waivers: [
      {
        locate: /prefix\.org_id = \?/,
        reason:
          'Prefix count supplements the independently mutated exact row snapshots and deletion scope.',
      },
      {
        locate: /(?<=FROM audit_chain WHERE )org_id = \?/,
        reason:
          'Snapshot is fenced again by organization, chain identity and exact prefix bytes in the CAS; candidate and destructive scopes have executable mutations.',
      },
      {
        locate: /c\.org_id = \?/,
        reason:
          'Eligibility and CAS re-evaluate only organization-bound subqueries; the CAS also pins chain identity and the exact organization-bearing prefix snapshot.',
      },
      {
        locate: /[lgr]\.org_id = \?/,
        reason:
          'Ledger identity is additionally pinned to chain and epoch. Cross-organization rows are asserted untouched in this case; required, none and gap branches have repository tests.',
      },
    ],
    predicates: [
      {
        name: 'configured membership organization',
        locate: /s\.org_id = \?(?= AND s\.sink_id)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: membership.name,
      },
      {
        name: 'durable custody organization',
        locate: /d\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: custody.name,
      },
      {
        name: 'event prefix organizations',
        locate: /e\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 3,
        waivedCopies: {
          1: 'The hole scan is a refusal-only guard; duplicate foreign seqs add no holes. Prefix snapshot and deletion scopes are independently mutated.',
        },
        caseName: isolated.name,
      },
      {
        name: 'newer foreign sink generation is irrelevant',
        locate: /s\.org_id = \?(?= AND s\.generation)/,
        neutral: '(? IS NOT NULL)',
        copies: 2,
        caseName: isolated.name,
      },
      {
        name: 'foreign sink progress is irrelevant',
        locate: /s\.org_id = \?(?=\s+AND s\.state[^\n]*s\.progress_seq)/,
        neutral: '(? IS NOT NULL)',
        copies: 2,
        caseName: isolated.name,
      },
      {
        name: 'foreign in-flight ranges are irrelevant',
        locate: /s\.org_id = \?(?=\s+AND s\.state[^\n]*s\.inflight_from)/,
        neutral: '(? IS NOT NULL)',
        copies: 2,
        caseName: isolated.name,
      },
      {
        name: 'foreign hashes are not boundary anchors',
        locate: /(?:anchor|successor)\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 3,
        caseName: isolated.name,
      },
      {
        name: 'event deletion organization',
        locate: /(?<=DELETE FROM audit_event WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
      {
        name: 'verification clearing organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolated.name,
      },
    ],
  },
];
