import { expect } from 'vitest';
import {
  createPackageAdminReader,
  readPackageDetail,
} from '../../repositories/package-admin-read.js';
import { executing } from './factory-cases.js';
import { NOT_NULL, seedPackage, seedProject, seedSource, seedVersion } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

type Operation = 'list' | 'versions' | 'manage' | 'detail';
type Boundary = 'pkg' | 'src' | 'v';
function boundaryCase(operation: Operation, boundary: Boundary): ContractCase {
  return {
    name: `package admin ${operation} excludes a foreign ${boundary} row referencing own rows`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(
        seed,
        'S',
        boundary === 'src' ? foreign.orgId : own.orgId,
        'npm_registry',
        'npm',
      );
      await seedPackage(
        seed.forged,
        'K',
        boundary === 'pkg' ? foreign.orgId : own.orgId,
        'S',
        'widget',
        'npm',
      );
      await seedVersion(
        seed.forged,
        'V',
        boundary === 'v' ? foreign.orgId : own.orgId,
        'K',
        '1.0.0',
      );
      const reader = createPackageAdminReader(executing(context));
      if (operation === 'detail') {
        const item = await readPackageDetail(executing(context), own, {
          packageId: 'K',
          projectId: null,
        });
        if (boundary === 'v') expect(item).toMatchObject({ latestVersion: null, versionCount: 0 });
        else expect(item).toBeNull();
      } else if (operation === 'list') {
        const page = await reader.listOrganization(own, { limit: 10 });
        if (boundary === 'v') {
          expect(page.items[0]).toMatchObject({ latestVersion: null, versionCount: 0 });
        } else expect(page.items).toEqual([]);
      } else if (operation === 'versions') {
        const page = await reader.listVersions(own, { packageId: 'K', projectId: null, limit: 10 });
        expect(page).toEqual(boundary === 'v' ? { items: [], next: null } : null);
      } else {
        expect(
          await reader.findManagedVersion(own, { packageId: 'K', versionId: 'V', projectId: null }),
        ).toBeNull();
      }
    },
  };
}

type ProjectOperation = 'listProject' | 'listVersions' | 'findManagedVersion' | 'detail';
function projectBoundaryCase(operation: ProjectOperation, boundary: Boundary | 'p'): ContractCase {
  return {
    name: `package admin ${operation} project branch excludes foreign ${boundary} rows`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', boundary === 'p' ? foreign.orgId : own.orgId);
      await seedSource(
        seed,
        'S',
        boundary === 'src' ? foreign.orgId : own.orgId,
        'npm_registry',
        'npm',
      );
      await seed.forged("UPDATE source SET project_id = 'P' WHERE id = 'S'");
      const budget = operation === 'listProject' && (boundary === 'pkg' || boundary === 'src');
      for (let i = 0; i < (budget ? 500 : 1); i++) {
        await seedPackage(
          seed.forged,
          `K${i}`,
          boundary === 'pkg' ? foreign.orgId : own.orgId,
          'S',
          `widget${i}`,
          'npm',
        );
      }
      await seedVersion(
        seed.forged,
        'V',
        boundary === 'v' ? foreign.orgId : own.orgId,
        'K0',
        '1.0.0',
      );
      await seed.forged(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        own.orgId,
      );
      await seed.forged(
        "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P' AS project_id, 'K0' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
        own.orgId,
      );
      const reader = createPackageAdminReader(executing(context));
      if (operation === 'detail') {
        await seed("DELETE FROM project_package WHERE project_id = 'P'");
        const item = await readPackageDetail(executing(context), own, {
          packageId: 'K0',
          projectId: 'P',
        });
        if (boundary === 'v') expect(item).toMatchObject({ latestVersion: null, versionCount: 0 });
        else expect(item).toBeNull();
      } else if (operation === 'listProject') {
        const page = await reader.listProject(own, 'P', { limit: 10 });
        if (boundary === 'v')
          expect(page.items[0]).toMatchObject({ latestVersion: null, versionCount: 0 });
        else expect(page).toEqual({ items: [], next: null });
      } else if (operation === 'listVersions') {
        // Exercise ownership independently of the delegated winner subquery.
        await seed("DELETE FROM project_package WHERE project_id = 'P'");
        expect(
          await reader.listVersions(own, { packageId: 'K0', projectId: 'P', limit: 10 }),
        ).toEqual(boundary === 'v' ? { items: [], next: null } : null);
      } else {
        expect(
          await reader.findManagedVersion(own, { packageId: 'K0', versionId: 'V', projectId: 'P' }),
        ).toBeNull();
      }
    },
  };
}
const projectCases = (
  ['listProject', 'listVersions', 'findManagedVersion', 'detail'] as const
).flatMap((operation) =>
  (['pkg', 'src', 'v', 'p'] as const).map((boundary) => ({
    operation,
    boundary,
    contract: projectBoundaryCase(operation, boundary),
  })),
);
const mixedStatus: ContractCase = {
  name: 'package admin keeps active plus tombstoned versions active',
  async run(context) {
    const { own } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed, 'A', own.orgId, 'K', '1.0.0');
    await seedVersion(seed, 'T', own.orgId, 'K', '2.0.0');
    await seed(
      "UPDATE version SET status = 'tombstoned', tombstoned_at = '2020-01-01' WHERE id = 'T'",
    );
    const page = await createPackageAdminReader(executing(context)).listOrganization(own, {
      limit: 10,
    });
    expect(page.items[0]?.status).toBe('active');
  },
};

function statusCase(status: 'quarantined' | 'tombstoned' | 'active'): ContractCase {
  return {
    name: `package admin ignores foreign ${status} versions when deriving status`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      if (status === 'active') {
        await seedVersion(seed, 'OWN', own.orgId, 'K', '1.0.0');
        await seed(
          "UPDATE version SET status = 'tombstoned', tombstoned_at = '2020-01-01' WHERE id = 'OWN'",
        );
      }
      await seedVersion(seed.forged, 'FOREIGN', foreign.orgId, 'K', '2.0.0');
      if (status !== 'active')
        await seed.forged(
          "UPDATE version SET status = ?, tombstoned_at = ? WHERE id = 'FOREIGN'",
          status,
          status === 'tombstoned' ? '2020-01-01' : null,
        );
      const page = await createPackageAdminReader(executing(context)).listOrganization(own, {
        limit: 10,
      });
      expect(page.items[0]?.status).toBe(status === 'active' ? 'tombstoned' : 'active');
    },
  };
}

function attachmentCase(foreignProject: boolean): ContractCase {
  return {
    name: `package admin ignores a foreign ${foreignProject ? 'project' : 'attachment'} in attachment filtering`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', foreignProject ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seed.forged(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        foreignProject ? own.orgId : foreign.orgId,
      );
      expect(
        (
          await createPackageAdminReader(executing(context)).listOrganization(own, {
            projectId: 'P',
            limit: 10,
          })
        ).items,
      ).toEqual([]);
    },
  };
}

function attributionCase(alias: 'pu' | 'sp' | 'au' | 'dt' | 'pending' | 'sealed'): ContractCase {
  return {
    name: `version attribution excludes foreign ${alias} rows`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
      await seed(
        "INSERT INTO user_account (id,org_id,email,display_name) VALUES ('U',?,'foreign@example.test','Foreign name')",
        foreign.orgId,
      );
      if (alias === 'sp') {
        await seed(
          "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('SP',?,'Foreign service','U')",
          foreign.orgId,
        );
      }
      if (alias === 'dt') {
        await seed.forged(
          "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,'K','foreign','V')",
          foreign.orgId,
        );
      } else if (alias === 'pending' || alias === 'sealed') {
        const fields = alias === 'sealed' ? ', seq, prev_hash, hash' : '';
        const values =
          alias === 'sealed' ? ", 1, '" + 'a'.repeat(64) + "', '" + 'b'.repeat(64) + "'" : '';
        await seed.forged(
          `INSERT INTO ${alias === 'pending' ? 'audit_pending' : 'audit_event'} (id,org_id,created_at,actor_type,actor_id,action,target_type,target_id,payload_json${fields}) VALUES ('A',?,'2026-01-01T00:00:00.000Z','system',NULL,'package.publish','version','V','{"changes":{"version":{"new":"1.0.0"}}}'${values})`,
          foreign.orgId,
        );
      } else {
        await seed.forged(
          "INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,decided_by_user_id,decided_at,expires_at) VALUES ('PA',?,'K','V','S',1,0,'approved','not_required',?,?,'token','U','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
          own.orgId,
          alias === 'sp' ? 'service' : 'user',
          alias === 'sp' ? 'SP' : 'U',
        );
      }
      const page = await createPackageAdminReader(executing(context)).listVersions(own, {
        packageId: 'K',
        projectId: null,
        limit: 10,
      });
      const item = page!.items[0]!;
      if (alias === 'dt') expect(item.distTags).toEqual([]);
      else if (alias === 'pending' || alias === 'sealed') expect(item.publishedBy).toBeNull();
      else if (alias === 'au') expect(item.approvedBy?.displayName).toBe('User');
      else
        expect(item.publishedBy?.displayName).toBe(alias === 'sp' ? 'Service principal' : 'User');
    },
  };
}
const attributionCases = (['pu', 'sp', 'au', 'dt', 'pending', 'sealed'] as const).map((alias) => ({
  alias,
  contract: attributionCase(alias),
}));

const boundaryCases = (['list', 'versions', 'manage', 'detail'] as const).flatMap((operation) =>
  (['pkg', 'src', 'v'] as const).map((boundary) => ({
    operation,
    boundary,
    contract: boundaryCase(operation, boundary),
  })),
);
const statusCases = (['quarantined', 'tombstoned', 'active'] as const).map((status) => ({
  status,
  contract: statusCase(status),
}));
const attachments = [attachmentCase(false), attachmentCase(true)];
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/package-admin-read.ts',
    builder: 'createPackageAdminReader',
    cases: [
      ...attributionCases.map((item) => item.contract),
      ...boundaryCases.map((item) => item.contract),
      ...statusCases.map((item) => item.contract),
      ...attachments,
      ...projectCases.map((item) => item.contract),
    ],
    predicates: [
      ...attributionCases.map(({ alias, contract }) => ({
        name: contract.name,
        caseName: contract.name,
        locate:
          alias === 'pending'
            ? /org_id = \?(?= and target_type = 'version' and action = 'package.publish'\s+union)/
            : alias === 'sealed'
              ? /org_id = \?(?= and target_type = 'version' and action = 'package.publish'\s+\))/
              : new RegExp(`\\b${alias}\\.org_id = \\?`),
        neutral: NOT_NULL,
        copies: 1,
      })),
      ...boundaryCases.map(({ operation, boundary, contract }) => ({
        name: contract.name,
        caseName: contract.name,
        locate: new RegExp(`(?<![\\w.])${boundary}\\.org_id = \\?`),
        neutral: NOT_NULL,
        copies: (operation === 'list' || operation === 'detail') && boundary === 'v' ? 2 : 1,
      })),
      ...projectCases
        .filter(({ operation, boundary }) => operation !== 'listProject' || boundary !== 'p')
        .map(({ operation, boundary, contract }) => ({
          name: contract.name,
          caseName: contract.name,
          locate: new RegExp(`(?<![\\w.])${boundary}\\.org_id = \\?`),
          neutral: NOT_NULL,
          copies:
            operation === 'listProject' || (operation === 'detail' && boundary === 'v') ? 2 : 1,
          ...(operation === 'listProject' && (boundary === 'pkg' || boundary === 'src')
            ? {
                waivedCopies: {
                  1: 'The resolved winner is already scoped by the w-aliased winner subquery; the scan guard is independently mutated.',
                },
              }
            : {}),
        })),
      ...statusCases.map(({ status, contract }) => ({
        name: contract.name,
        caseName: contract.name,
        locate: new RegExp(
          `vs\\.org_id = \\?(?=\\s+and vs\\.package_id = c\\.id and vs\\.status ${status === 'active' ? "<> 'tombstoned'" : `= '${status}'`})`,
        ),
        neutral: NOT_NULL,
        copies: 1,
      })),
      ...attachments.map((contract, index) => ({
        name: contract.name,
        caseName: contract.name,
        locate: new RegExp(`(?<![\\w.])${index === 0 ? 'ps' : 'p'}\\.org_id = \\?`),
        neutral: NOT_NULL,
        copies: 1,
      })),
    ],
    waivers: [
      {
        locate: /pa\.org_id = \?/,
        reason:
          'The publish-approval lookup repeats the independently scoped version identity; the composite organization/version FK prevents a foreign approval for a scoped version. Publish-reader contracts cover held-version filtering.',
      },
      {
        locate: /"?guard_\w+"?\."?org_id"? = /,
        reason:
          'Delegated catalogue-predicates scopes inside the w-aliased winner subquery have independent mutation registrations.',
      },
      {
        locate: /"?w(?:pp|pkg|src|ps)"?\."?org_id"? = /,
        reason:
          'The w-aliased visible-winner subquery reuses the independently registered catalogue predicates.',
      },
    ],
    sqlDecisions: [
      {
        name: mixedStatus.name,
        pattern:
          /and not exists \(select 1 from version as vs indexed\s+by version_package_status where vs\.org_id = \?\s+and vs\.package_id = c\.id and vs\.status <> 'tombstoned'\s+and not \(vs\.status = 'quarantined' and exists \(select 1 from publish_approval pa where pa\.org_id = \? and pa\.version_id = vs\.id\)\)\)/,
        replacement: 'and (? is not null and ? is not null)',
        expected: 1,
        case: mixedStatus,
      },
    ],
  },
];
