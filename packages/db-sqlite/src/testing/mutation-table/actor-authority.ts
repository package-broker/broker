import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import {
  actorAuthority,
  actorHolds,
  liveActorSession,
} from '../../repositories/actor-authority.js';
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

type AuthorityBuilder = typeof actorHolds;

const actorSessionIdentityOfForeignOrg = (build: AuthorityBuilder): ContractCase => ({
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
    await seed.forged(
      'UPDATE session SET identity_id = ? WHERE id = ?',
      'I-FOREIGN',
      bad.sessionId,
    );
    const guardFor = (subject: Subject) =>
      build(own, fenceOf(subject), {
        permission: ORG_PERMISSION,
        projectId: null,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control), false)).toBe(true);
    expect(await held(context, guardFor(bad), true)).toBe(false);
  },
});

const actorArchivedForeignProject = (build: AuthorityBuilder): ContractCase => ({
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
      build(own, fenceOf(subject), {
        permission: PROJECT_PERMISSION,
        projectId,
        allowArchived: true,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor(control, 'P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor(bad, 'P-FOREIGN'), true)).toBe(false);
  },
});

function authorityEntry(builder: string, build: AuthorityBuilder): MutationEntry {
  const identity = actorSessionIdentityOfForeignOrg(build);
  const project = actorArchivedForeignProject(build);
  return {
    builder,
    file: 'repositories/actor-authority.ts',
    cases: [identity, project],
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
        caseName: identity.name,
      },
      {
        name: 'the project of an archived-project check is scoped to the organization',
        locate: /(?<=from "project" where )"org_id" = \?/,
        neutral: NOT_NULL,
        caseName: project.name,
      },
    ],
  };
}

const sessionCases = (['actor', 'identity', 'session'] as const).map((layer): ContractCase => ({
  name: `live actor session refuses a foreign ${layer}`,
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    const subject = await seedSubject(context, 'actor');
    const guard = () => liveActorSession(own, fenceOf(subject));
    expect(await held(context, guard(), false)).toBe(true);
    if (layer === 'identity') {
      await seed.forged('UPDATE identity SET org_id = ? WHERE id = ?', foreign.orgId, 'I-actor');
      await seed.forged(
        'UPDATE session SET identity_id = ? WHERE id = ?',
        'I-actor',
        subject.sessionId,
      );
    } else {
      await seed.forged(
        'UPDATE user_account SET org_id = ? WHERE id = ?',
        foreign.orgId,
        subject.userId,
      );
      if (layer === 'session') {
        await seed.forged(
          'UPDATE session SET org_id = ? WHERE id = ?',
          foreign.orgId,
          subject.sessionId,
        );
      }
    }
    expect(await held(context, guard(), true)).toBe(false);
  },
}));

export const entries: readonly MutationEntry[] = [
  authorityEntry('actorHolds', actorHolds),
  authorityEntry('actorAuthority', actorAuthority),
  {
    builder: 'liveActorSession',
    file: 'repositories/actor-authority.ts',
    cases: sessionCases,
    predicates: sessionCases.map((contractCase, index) => ({
      name: contractCase.name,
      caseName: contractCase.name,
      locate: [
        /"actor"\."org_id" = "s"\."org_id"/,
        /"i"\."org_id" = "s"\."org_id"/,
        /"s"\."org_id" = \?/,
      ][index]!,
      neutral: index === 2 ? NOT_NULL : ALWAYS,
      copies: 1,
    })),
  },
];
