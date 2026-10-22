import { expect } from 'vitest';
import { sourceAttachmentCountsStatement } from '../../repositories/source-attachment-counts.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, permissionRowsWaiver, seedProject, seedSource, seedUser } from './fixtures.js';

function foreignRow(table: 'attachment' | 'attached_source' | 'attached_project'): ContractCase {
  return {
    name: `attachment counts exclude foreign ${table} rows`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', table === 'attached_project' ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S', table === 'attached_source' ? foreign.orgId : own.orgId, 'vcs');
      await seed.forged(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        table === 'attachment' ? foreign.orgId : own.orgId,
      );
      expect(
        await context.executor.all(
          context.mutate(
            sourceAttachmentCountsStatement(own, {
              sourceIds: ['S'],
              userId: 'U',
              allProjects: true,
              includeArchived: true,
              providerAnchors: [],
            }),
          ),
        ),
      ).toEqual([]);
    },
  };
}

const tables = ['attachment', 'attached_source', 'attached_project'] as const;
const serviceTables = ['count_service', 'count_service_permission'] as const;

function foreignServiceRow(table: (typeof serviceTables)[number]): ContractCase {
  return {
    name: `attachment counts exclude foreign ${table} rows`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedUser(seed, 'U', own.orgId);
      await seedProject(seed, 'P', own.orgId);
      await seedSource(seed, 'S', own.orgId, 'vcs');
      await seed(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        own.orgId,
      );
      await seed.forged(
        "INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES ('SP', ?, 'source-reader', 'P', 'U')",
        table === 'count_service' ? foreign.orgId : own.orgId,
      );
      await seed.forged(
        "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'SP', 'project:read')",
        table === 'count_service_permission' ? foreign.orgId : own.orgId,
      );
      expect(
        await context.executor.all(
          context.mutate(
            sourceAttachmentCountsStatement(own, {
              sourceIds: ['S'],
              userId: 'SP',
              servicePrincipalId: 'SP',
              allProjects: false,
              includeArchived: false,
              providerAnchors: [],
            }),
          ),
        ),
      ).toEqual([]);
    },
  };
}

const cases = [...tables.map(foreignRow), ...serviceTables.map(foreignServiceRow)];

export const entries: readonly MutationEntry[] = [
  {
    builder: 'sourceAttachmentCountsStatement',
    file: 'repositories/source-attachment-counts.ts',
    cases,
    waivers: [permissionRowsWaiver],
    predicates: [...tables, ...serviceTables].map((table) => ({
      name: `${table} belongs to the organization`,
      locate: new RegExp(`"${table}"\\."org_id" = \\?`),
      neutral: NOT_NULL,
      copies: 1,
      caseName: `attachment counts exclude foreign ${table} rows`,
    })),
  },
];
