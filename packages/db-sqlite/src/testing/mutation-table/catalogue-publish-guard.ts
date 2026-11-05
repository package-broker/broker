import { executing } from './factory-cases.js';
import { expect } from 'vitest';
import {
  createPublishWriteGuard,
  createPublishReads,
} from '../../repositories/catalogue-publish-guard.js';
import { seedProject, seedUser, seedSource, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const isolation: ContractCase = {
  name: 'publish token guard rejects a foreign token with forged own permission evidence',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seed(
      "INSERT INTO project_source (org_id,project_id,source_id) VALUES (?,'P','S')",
      own.orgId,
    );
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

const foreignSource: ContractCase = {
  name: 'publish reads exclude a foreign hosted source with forged own claim',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'hosted', 'npm');
    await seed.forged(
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('R',?,'S','npm','widget')",
      own.orgId,
    );
    expect(await createPublishReads(executing(context)).source(own, 'widget')).toEqual([]);
  },
};
const foreignClaim: ContractCase = {
  name: 'publish reads exclude a foreign claim on an own hosted source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seed.forged(
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('R',?,'S','npm','widget')",
      foreign.orgId,
    );
    expect(await createPublishReads(executing(context)).source(own, 'widget')).toEqual([]);
  },
};
const foreignToken: ContractCase = {
  name: 'publish reads exclude a foreign token package binding',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', foreign.orgId);
    await seed(
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('SP',?,'Publisher','U')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO token (id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at,package_name) VALUES ('T',?,'svc','SP','abcdefghijkl',?,1,'publish','all','[\"write\"]','2099-01-01T00:00:00.000Z','widget')",
      foreign.orgId,
      'a'.repeat(64),
    );
    expect(await createPublishReads(executing(context)).packageBinding(own, 'T')).toBeNull();
  },
};
const foreignBlob: ContractCase = {
  name: 'publish reads exclude a foreign blob digest',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO blob (id,org_id,sha256,size_bytes,storage_key) VALUES ('B',?,?,10,'b')",
      foreign.orgId,
      'a'.repeat(64),
    );
    expect(await createPublishReads(executing(context)).blobId(own, 'a'.repeat(64))).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/catalogue-publish-guard.ts',
    builder: 'createPublishReads',
    cases: [foreignSource, foreignClaim, foreignToken, foreignBlob],
    predicates: [
      {
        name: 'hosted source organization',
        locate: /"s"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
      {
        name: 'hosted claim organization',
        locate: /r\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignClaim.name,
      },
      {
        name: 'bound token organization',
        locate: /"pub_token"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignToken.name,
      },
      {
        name: 'promoted blob organization',
        locate: /"pub_blob"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignBlob.name,
      },
    ],
  },
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
          'Admission delegates admissionCondition and repeats the source/package identities; its organization isolation is covered by catalogue-predicates.ts. The foreign-token case has an attached own source so admission cannot mask a missing token scope predicate.',
      },
    ],
  },
];
