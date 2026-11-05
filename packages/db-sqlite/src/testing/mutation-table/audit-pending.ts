import { expect } from 'vitest';
import {
  auditPendingStatement,
  auditReserveStatements,
  auditOperationStatement,
} from '../../repositories/audit-pending.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

function contextOwnsRow(companion: boolean | 'operation'): ContractCase {
  return {
    name: `pending audit ${companion ? 'reserve' : 'ordinary'} inserts use the context organization despite foreign event data`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      await context.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = 'required', capacity_state = 'refusing' WHERE org_id = ?",
          params: [foreign.orgId],
        },
      ]);
      const event = {
        id: '01K7R5V0000000000000000001',
        occurredAt: '2026-10-17T10:00:00.000Z',
        actor: { type: 'system', id: foreign.orgId },
        tokenSelector: null,
        sourceIp: null,
        action: 'project.update',
        target: { type: 'project', id: foreign.orgId },
        projectId: foreign.orgId,
        payloadJson: JSON.stringify({ orgId: foreign.orgId }),
      } as const;
      const statements =
        companion === true
          ? auditReserveStatements(
              own,
              { ...event, id: '01K7R5V0000000000000000002', action: 'token.rotate' },
              { ...event, action: 'token.issue' },
              { sql: '0', params: [] },
            )
          : [
              companion === 'operation'
                ? auditOperationStatement(own, event, { sql: '0', params: [] })
                : auditPendingStatement(own, event),
            ];
      await expect(context.executor.batch(statements.map(context.mutate))).resolves.toBeDefined();
      expect(
        await context.executor.all({
          sql: 'SELECT org_id FROM audit_pending WHERE org_id = ?',
          params: [own.orgId],
        }),
      ).toEqual(Array.from({ length: 1 }, () => ({ org_id: own.orgId })));
      expect(
        await context.executor.all({
          sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
          params: [foreign.orgId],
        }),
      ).toEqual([]);
    },
  };
}

export const entries: readonly MutationEntry[] = ([false, true, 'operation'] as const).map(
  (companion) => {
    const testCase = contextOwnsRow(companion);
    return {
      builder:
        companion === 'operation'
          ? 'auditOperationStatement'
          : companion
            ? 'auditReserveStatements'
            : 'auditPendingStatement',
      file: 'repositories/audit-pending.ts',
      cases: [testCase],
      predicates: [
        {
          name: 'capacity checks only the context chain',
          locate: /audit_chain\.org_id = input\.pending_org_id/,
          neutral: '1 = 1',
          caseName: testCase.name,
        },
      ],
    };
  },
);
