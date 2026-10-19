import { expect } from 'vitest';
import { auditPendingStatement } from '../../repositories/audit-pending.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const contextOwnsRow: ContractCase = {
  name: 'pending audit inserts use the context organization despite foreign event data',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      context.mutate(
        auditPendingStatement(own, {
          id: '01K7R5V0000000000000000001',
          occurredAt: '2026-10-17T10:00:00.000Z',
          actor: { type: 'system', id: foreign.orgId },
          tokenSelector: null,
          sourceIp: null,
          action: 'project.update',
          target: { type: 'project', id: foreign.orgId },
          projectId: foreign.orgId,
          payloadJson: JSON.stringify({ orgId: foreign.orgId }),
        }),
      ),
    ]);
    expect(
      await context.executor.all({
        sql: 'SELECT org_id FROM audit_pending WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ org_id: own.orgId }]);
    expect(
      await context.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'auditPendingStatement',
    file: 'repositories/audit-pending.ts',
    cases: [contextOwnsRow],
    predicates: [],
  },
];
