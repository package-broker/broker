import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import { actorHolds } from '../../repositories/actor-authority.js';
import {
  seedBindings,
  seedSubject,
  type Subject,
  fenceOf,
  ORG_PERMISSION,
  ANCHORS,
  held,
  seedProject,
  PROJECT_PERMISSION,
  permissionRowsWaiver,
  ref,
  ALWAYS,
  NOT_NULL,
} from './fixtures.js';

const actorSessionIdentityOfForeignOrg: ContractCase = {
  name: 'a session bound to an identity of another organization does not make the actor hold a permission',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    const control = await seedSubject(context, 'ok');
    const bad = await seedSubject(context, 'bad');
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES ('I-FOREIGN', ?, ?, 'oidc', 'sub-foreign', 'bad@example.test')",
      foreign.orgId,
      bad.userId,
    );
    await seed('UPDATE session SET identity_id = ? WHERE id = ?', 'I-FOREIGN', bad.sessionId);
    const guardFor = (subject: Subject) =>
      actorHolds(own, fenceOf(subject), {
        permission: ORG_PERMISSION,
        projectId: null,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control), false)).toBe(true);
    expect(await held(context, guardFor(bad), true)).toBe(false);
  },
};

const actorArchivedForeignProject: ContractCase = {
  name: 'a project of another organization does not exist for an archived-project check',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seed, 'P-OWN', own.orgId);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    const control = await seedSubject(context, 'ok', { projectId: 'P-OWN' });
    const bad = await seedSubject(context, 'bad', { projectId: 'P-FOREIGN' });
    const guardFor = (subject: Subject, projectId: string) =>
      actorHolds(own, fenceOf(subject), {
        permission: PROJECT_PERMISSION,
        projectId,
        allowArchived: true,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control, 'P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor(bad, 'P-FOREIGN'), true)).toBe(false);
  },
};

const actorHoldsEntry: MutationEntry = {
  builder: 'actorHolds',
  file: 'repositories/actor-authority.ts',
  cases: [actorSessionIdentityOfForeignOrg, actorArchivedForeignProject],
  waivers: [
    permissionRowsWaiver,
    {
      locate: ref('actor', 'org_id', '"s"\\."org_id"'),
      reason:
        'the actor row must also be the permission user, whom permissionRows scopes by organization',
    },
    {
      locate: ref('s', 'org_id', '\\?'),
      reason:
        'the actor join and permissionRows both refuse a session of another organization; either alone suffices',
    },
    {
      locate: ref('hp_session', 'org_id', '\\?'),
      reason: 'local-admin eligibility only; no case seeds a local login yet',
    },
  ],
  predicates: [
    {
      name: 'the session identity joins within the session organization',
      locate: ref('i', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: actorSessionIdentityOfForeignOrg.name,
    },
    {
      name: 'the project of an archived-project check is scoped to the organization',
      locate: /(?<=from "project" where )"org_id" = \?/,
      neutral: NOT_NULL,
      caseName: actorArchivedForeignProject.name,
    },
  ],
};

export const entries: readonly MutationEntry[] = [actorHoldsEntry];
