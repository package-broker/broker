import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import { servicePrincipalAuthorityGuard } from '../../repositories/service-principal-authority.js';
import {
  seedBindings,
  seedSubject,
  fenceOf,
  ORG_PERMISSION,
  ANCHORS,
  guardPasses,
  permissionRowsWaiver,
  ref,
  ALWAYS,
  GROUP_BRANCH,
} from './fixtures.js';

const spCoversForeignPermission: ContractCase = {
  name: 'a permission row of another organization does not count as covered',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    const subject = await seedSubject(context, 'ok');
    const seed = seeder(context.executor);
    const insertPermission =
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)';
    await seed(insertPermission, own.orgId, 'R-ok', 'org:users:read');
    await seed(insertPermission, foreign.orgId, 'R-ok', 'org:roles:read');
    const guardFor = (covers: readonly string[]) =>
      servicePrincipalAuthorityGuard(own, fenceOf(subject), {
        permission: ORG_PERMISSION,
        projectId: null,
        organizationAdmin: false,
        covers,
        providerAnchors: ANCHORS,
      });
    expect(await guardPasses(context, guardFor(['org:users:read']), false)).toBe(true);
    expect(await guardPasses(context, guardFor(['org:roles:read']), true)).toBe(false);
  },
};

const SESSION_GATE = 'redundant with the session check of the same guard, which fails first';

const servicePrincipalGuardEntry: MutationEntry = {
  builder: 'servicePrincipalAuthorityGuard',
  file: 'repositories/service-principal-authority.ts',
  cases: [spCoversForeignPermission],
  waivers: [
    permissionRowsWaiver,
    { locate: ref('s', 'org_id', '\\?'), reason: 'registered under actorHolds' },
    { locate: ref('i', 'org_id', '"s"\\."org_id"'), reason: 'registered under actorHolds' },
    { locate: ref('actor', 'org_id', '"s"\\."org_id"'), reason: 'registered under actorHolds' },
    { locate: ref('hp_session', 'org_id', '\\?'), reason: SESSION_GATE },
    { locate: ref('sa_session', 'org_id', '\\?'), reason: SESSION_GATE },
    {
      locate: /(?<=\(randomblob\(16\)\) where )"org_id" = \?/,
      reason: 'the cache epoch bump of the fence guard, not a scoping predicate of this builder',
    },
  ],
  predicates: [
    {
      name: 'covered permission rows join within the role organization',
      locate: ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
      neutral: ALWAYS,
      caseName: spCoversForeignPermission.name,
      waivedCopies: {
        0: 'the actor permission, which the management permission check already decides',
        1: GROUP_BRANCH,
        3: GROUP_BRANCH,
      },
    },
  ],
};

export const entries: readonly MutationEntry[] = [servicePrincipalGuardEntry];
