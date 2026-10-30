import { expect } from 'vitest';
import { createPublishesRepository } from '../../repositories/publishes.js';
import { executing } from './factory-cases.js';
import { seedSource, seedPackage, seedVersion, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function isolation(method: 'get' | 'list'): ContractCase {
  return {
    name: `publish ${method} excludes another organization`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', foreign.orgId, 'hosted', 'npm');
      await seedPackage(seed, 'K', foreign.orgId, 'S', 'widget', 'npm');
      await seedVersion(seed, 'V', foreign.orgId, 'K', '1.0.0');
      await seed(
        `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,expires_at)
      VALUES ('approval',?,'K','V','S',1,0,'pending','not_required','service','principal','token','2099-01-01T00:00:00.000Z')`,
        foreign.orgId,
      );
      const repo = createPublishesRepository(executing(context));
      if (method === 'get') expect(await repo.get(own, 'approval')).toBeNull();
      else expect((await repo.list(own, { limit: 10 })).items).toEqual([]);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/publishes.ts',
    builder: 'createPublishesRepository',
    cases: [isolation('get'), isolation('list')],
    predicates: (['get', 'list'] as const).map((method) => ({
      name: `${method} scopes publish inspection`,
      locate: /"org_id" = \?/,
      neutral: NOT_NULL,
      copies: 1,
      caseName: isolation(method).name,
    })),
  },
];
