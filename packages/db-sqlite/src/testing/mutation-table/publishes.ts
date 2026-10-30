import { expect } from 'vitest';
import { createPublishesRepository } from '../../repositories/publishes.js';
import { executing } from './factory-cases.js';
import { seedSource, seedPackage, seedVersion, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function isolation(method: 'get' | 'list' | 'listExpired'): ContractCase {
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
      if (method === 'get') await expect(repo.get(own, 'approval')).resolves.toBeNull();
      else if (method === 'list')
        await expect(repo.list(own, { limit: 10 })).resolves.toMatchObject({ items: [] });
      else expect(await repo.listExpired(own, '2099-01-01T00:00:00.000Z')).toEqual([]);
    },
  };
}
function foreignLabels(type: 'user' | 'service'): ContractCase {
  return {
    name: `publish inspection hides foreign ${type} labels`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
      await seed(
        "INSERT INTO user_account (id,org_id,email,display_name) VALUES ('F',?,'foreign@example.test','Foreign user')",
        foreign.orgId,
      );
      await seed(
        "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('SP',?,'Foreign service','F')",
        foreign.orgId,
      );
      await seed(
        "INSERT INTO project (id,org_id,slug,name) VALUES ('PR',?,'foreign','Foreign project')",
        foreign.orgId,
      );
      await seed(
        `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,decided_by_user_id,route_project_id,expires_at)
        VALUES ('approval',?,'K','V','S',1,0,'pending','not_required',?,?,'token',NULL,NULL,'2099-01-01T00:00:00.000Z')`,
        own.orgId,
        type,
        type === 'user' ? 'F' : 'SP',
      );
      const item = await createPublishesRepository(executing(context)).get(own, 'approval');
      expect(item).toMatchObject({
        requestedBy: { name: type === 'user' ? 'User' : 'Service' },
        decidedBy: null,
        project: null,
      });
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/publishes.ts',
    builder: 'createPublishesRepository',
    cases: [
      isolation('get'),
      isolation('list'),
      isolation('listExpired'),
      foreignLabels('user'),
      foreignLabels('service'),
    ],
    predicates: [
      ...(['get', 'list', 'listExpired'] as const).map((method) => ({
        name: `${method} scopes publish inspection`,
        locate: /pa\.org_id=\?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: isolation(method).name,
      })),
      ...(['u', 'sp'] as const).map((alias) => ({
        name: `${alias} labels are organization scoped`,
        locate: new RegExp(`\\b${alias}\\.org_id=pa\\.org_id`),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignLabels(alias === 'sp' ? 'service' : 'user').name,
      })),
    ],
    waivers: [
      {
        locate: /\b(?:p|v|s|d|pr)\.org_id=pa\.org_id/,
        reason:
          'Package, version, source, decider and project repeat the approval row’s composite organization foreign keys; the approval organization predicate is mutation-tested for each read.',
      },
    ],
  },
];
