import { expect } from 'vitest';
import { createApiRoutes } from '../../repositories/api-services.js';
import { apiContext, apiOptions } from '../api-services-fixture.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const auditIsolation: ContractCase = {
  name: 'assembled audit routes exclude foreign organization events',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    for (const [id, orgId] of [
      ['OWN', own.orgId],
      ['FOREIGN', foreign.orgId],
    ] as const) {
      await seed(
        `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
         VALUES (?, ?, 1, ?, ?, '2026-10-17T10:00:00.000Z', 'system', 'org.update', 'organization')`,
        id,
        orgId,
        '0'.repeat(64),
        '1'.repeat(64),
      );
    }
    const options = apiOptions({
      ...context.executor,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    const route = createApiRoutes(options).find((route) => route.path === '/_pb/audit')!;
    const response = await route.handler(apiContext(own, '/_pb/audit'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual(['OWN']);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/api-services.ts',
    builder: 'createApiRoutes',
    cases: [auditIsolation],
    predicates: [
      {
        name: 'assembled audit list scopes events by organization',
        locate: /(?<=FROM audit_event WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: auditIsolation.name,
      },
    ],
  },
];
