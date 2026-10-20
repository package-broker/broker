import { expect } from 'vitest';
import { visibilityAuditStatements } from '../../repositories/visibility-audit.js';
import { visibilityAudit } from '../visibility-audit.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const scopedAudit: ContractCase = {
  name: 'visibility audit and idempotency use the context organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const input = {
      audit: { ...visibilityAudit(), projectId: foreign.orgId },
      idempotency: {
        principalKey: `user:${foreign.orgId}`,
        key: 'visibility',
        route: '/visibility',
        requestHash: 'a'.repeat(64),
        status: 204,
        responseJson: 'null',
        createdAt: '2026-10-19T00:00:00.000Z',
        expiresAt: '2026-10-20T00:00:00.000Z',
      },
    };
    await context.executor.batch([
      { sql: 'UPDATE cache_epoch SET version = version WHERE org_id = ?', params: [own.orgId] },
      ...context.mutateBatch(visibilityAuditStatements(own, input)),
    ]);
    for (const table of ['audit_pending', 'api_idempotency']) {
      expect(
        await context.executor.all({ sql: `SELECT org_id FROM ${table}`, params: [] }),
      ).toEqual([{ org_id: own.orgId }]);
    }
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/visibility-audit.ts',
    builder: 'visibilityAuditStatements',
    cases: [scopedAudit],
    predicates: [],
    waivers: [
      {
        locate: /org_id = \?(?= AND principal_key = \? AND key = \? AND expires_at)/,
        reason: 'the idempotency live-row lookup is judged by the idempotencyInsertStatement entry',
      },
    ],
  },
];
