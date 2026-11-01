import { expect } from 'vitest';
import { createPublishesRepository } from '../../repositories/publishes.js';
import { executing } from './factory-cases.js';
import { seedSource, seedPackage, seedVersion, NOT_NULL, ALWAYS } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function isolation(
  method: 'get' | 'list' | 'listExpired' | 'actionable' | 'listScanQueued',
): ContractCase {
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
      if (method === 'actionable' || method === 'listScanQueued') {
        await seed(
          "UPDATE version SET status='quarantined' WHERE org_id=? AND id='V'",
          foreign.orgId,
        );
        await seed(
          "UPDATE publish_approval SET hold_scan=1,scan_state='queued' WHERE org_id=? AND id='approval'",
          foreign.orgId,
        );
      }
      const repo = createPublishesRepository(executing(context));
      if (method === 'get') await expect(repo.get(own, 'approval')).resolves.toBeNull();
      else if (method === 'actionable')
        await expect(repo.list(own, { limit: 10, actionable: true })).resolves.toMatchObject({
          items: [],
        });
      else if (method === 'listScanQueued')
        expect(await repo.listScanQueued(own, '2099-01-01T00:00:00.000Z')).toEqual([]);
      else if (method === 'list')
        await expect(repo.list(own, { limit: 10 })).resolves.toMatchObject({ items: [] });
      else expect(await repo.listExpired(own, '2099-01-01T00:00:00.000Z')).toEqual([]);
    },
  };
}
function foreignScanLease(): ContractCase {
  return {
    name: 'scan recovery ignores another organization live lease',
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
      await seed("UPDATE version SET status='quarantined' WHERE org_id=? AND id='V'", own.orgId);
      await seed(
        `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,expires_at,updated_at)
        VALUES ('approval',?,'K','V','S',1,1,'pending','running','service','principal','token','2099-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`,
        own.orgId,
      );
      await seed(
        "INSERT INTO job (id,org_id,type,state,resource_key,lease_owner,lease_until,fence) VALUES ('foreign-job',?,'core:publish-scan:v1','running','publish:V','owner','2999-01-01T00:00:00.000Z',1)",
        foreign.orgId,
      );
      expect(
        (
          await createPublishesRepository(executing(context)).listScanQueued(
            own,
            '2099-01-01T00:00:00.000Z',
          )
        ).map((item) => item.id),
      ).toEqual(['approval']);
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
      isolation('actionable'),
      isolation('listScanQueued'),
      foreignScanLease(),
      foreignLabels('user'),
      foreignLabels('service'),
    ],
    predicates: [
      {
        name: 'scan recovery leases belong to the approval organization',
        locate: /j\.org_id=pa\.org_id/,
        neutral: ALWAYS,
        copies: 1,
        caseName: foreignScanLease().name,
      },
      ...(['get', 'list', 'listExpired', 'actionable', 'listScanQueued'] as const).map(
        (method) => ({
          name: `${method} scopes publish inspection`,
          locate: /pa\.org_id=\?/,
          neutral: NOT_NULL,
          copies: 1,
          caseName: isolation(method).name,
        }),
      ),
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
