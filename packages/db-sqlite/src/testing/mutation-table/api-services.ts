import { expect } from 'vitest';
import { createApiRoutes } from '../../repositories/api-services.js';
import { apiContext, apiOptions } from '../api-services-fixture.js';
import { seedAuditJournal } from '../audit-journal-fixture.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const auditIsolation: ContractCase = {
  name: 'assembled audit routes exclude foreign organization events',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditJournal(context.executor, own, 1);
    await seedAuditJournal(context.executor, foreign, 2);
    const [ownRow] = await context.executor.all<{ id: string }>({
      sql: 'SELECT id FROM audit_event WHERE org_id = ? ORDER BY seq LIMIT 1',
      params: [own.orgId],
    });
    const options = apiOptions({
      ...context.executor,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    const route = createApiRoutes(options).find((route) => route.path === '/_pb/audit')!;
    const response = await Promise.resolve(route.handler(apiContext(own, '/_pb/audit'))).catch(
      () => null,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual([ownRow!.id]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/api-services.ts',
    builder: 'createApiRoutes',
    cases: [auditIsolation],
    predicates: [
      {
        name: 'assembled audit journal chain identity belongs to the event organization',
        locate: /chain\.org_id = event\.org_id/,
        neutral: '1 = 1',
        copies: 1,
        caseName: auditIsolation.name,
      },
      {
        name: 'assembled audit list scopes events by organization',
        locate: /event\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: auditIsolation.name,
      },
    ],
  },
];
