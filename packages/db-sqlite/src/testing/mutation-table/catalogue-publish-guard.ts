import { expect } from 'vitest';
import { createPublishWriteGuard } from '../../repositories/catalogue-publish-guard.js';
import { seedProject, seedUser, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const isolation: ContractCase = {
  name: 'publish token guard rejects a foreign token with forged own permission evidence',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedUser(seed, 'U', foreign.orgId);
    await seed(
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('SP',?,'Publisher','U')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO token (id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at) VALUES ('T',?,'svc','SP','abcdefghijkl',?,1,'publish','all','[\"write\"]','2099-01-01T00:00:00.000Z')",
      foreign.orgId,
      'a'.repeat(64),
    );
    await seed.forged(
      "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,'SP','org:packages:publish')",
      own.orgId,
    );
    const guard = createPublishWriteGuard(
      own,
      {
        tokenId: 'T',
        selector: 'abcdefghijkl',
        projectSlug: 'p',
        routeProjectId: 'P',
        sourceId: 'S',
        key: 'widget',
      },
      [],
    );
    await expect(context.executor.batch(context.mutateBatch(guard))).rejects.toThrow();
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/catalogue-publish-guard.ts',
    builder: 'createPublishWriteGuard',
    cases: [isolation],
    predicates: [
      {
        name: 'publish token belongs to organization',
        locate: /"t"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: isolation.name,
      },
    ],
    waivers: [
      {
        locate: /(?:ev_i|ev_l|spv|tp)\.org_id = /,
        reason:
          'Token validation evidence and token/project membership repeat the scoped token identity; lookupTokenStatement has independent organization mutation registrations.',
      },
      {
        locate: /"(?!t")[\w]+"\."org_id" = /,
        reason:
          'lookupTokenStatement owns its permission, principal, project and validation-evidence scopes; access.ts independently mutates those guards. This guard tests the envelope token organization with forged permission evidence.',
      },
      {
        locate: /(?:pub_source|pp|pkg|guard_\w+)\.org_id = \?|(?<![\w.])org_id = \?/,
        reason:
          'The project-admission branch delegates admissionCondition and repeats the source/package identities; its organization isolation is covered by catalogue-predicates.ts. The foreign-token case takes the independent organization-publish branch.',
      },
    ],
  },
];
