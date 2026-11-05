import { expect } from 'vitest';
import { createAuditFailureRepository } from '../../repositories/audit-failure.js';
import { orgOf, type MutationEntry } from './harness.js';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditFailureRepository',
    file: 'repositories/audit-failure.ts',
    predicates: [],
    cases: [
      {
        name: 'failure staging inserts only in the context organization',
        async run(context) {
          const { own, foreign } = orgOf(context);
          const repository = createAuditFailureRepository({
            driver: context.executor.driver,
            all: (statement) => context.executor.all(context.mutate(statement)),
            batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
          });
          await repository.stage(own, {
            id: '01K7R5V0000000000000000001',
            occurredAt: '2026-10-30T10:00:00.000Z',
            action: 'session.login_failed',
            actor: { type: 'system', id: null },
            target: { type: 'session', id: null },
            tokenSelector: null,
            sourceIp: null,
            projectId: null,
            payloadJson: '{}',
          });
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
      },
    ],
  },
];
