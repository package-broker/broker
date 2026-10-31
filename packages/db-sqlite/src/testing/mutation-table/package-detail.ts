import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
import { expect } from 'vitest';
import { createPackageDetailRepository } from '../../repositories/package-detail.js';
import { executing, winnerWaivers } from './factory-cases.js';
import { NOT_NULL, seedPackage, seedProject, seedSource, seedVersion } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function contentCase(boundary: 'r' | 'v' | 'dt'): ContractCase {
  return {
    name: `package detail excludes foreign ${boundary} content`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', own.orgId);
      await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seedVersion(
        seed.forged,
        'V',
        boundary === 'v' ? foreign.orgId : own.orgId,
        'K',
        '1.0.0',
      );
      await seed(
        "INSERT INTO project_source (org_id,project_id,source_id) VALUES (?,'P','S')",
        own.orgId,
      );
      await seed(
        "INSERT INTO project_package (org_id,project_id,package_id,ecosystem,name,origin) VALUES (?,'P','K','npm','widget','subscription')",
        own.orgId,
      );
      await seed.forged(
        "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,'K','latest','V')",
        boundary === 'dt' ? foreign.orgId : own.orgId,
      );
      await seed.forged(
        "INSERT INTO version_readme (org_id,version_id,filename,body) VALUES (?,'V','README.md','foreign content')",
        boundary === 'r' ? foreign.orgId : own.orgId,
      );
      expect(
        await createPackageDetailRepository(executing(context)).readme(own, {
          projectId: 'P',
          packageId: 'K',
        }),
      ).toBeNull();
    },
  };
}
const nameCase: ContractCase = {
  name: 'package detail name lookup refuses a foreign package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', foreign.orgId, 'S', 'foreign', 'npm');
    expect(
      await createPackageDetailRepository(executing(context)).packageName(own, 'K'),
    ).toBeNull();
  },
};
const accessCase: ContractCase = {
  name: 'package access writer refuses a foreign target before mutation',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seedPackage(seed.forged, 'K', foreign.orgId, 'S', 'foreign', 'npm');
    const audit = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      action: 'package.access_update',
      actor: { type: 'user', id: ulid() },
      target: { type: 'package', id: ulid() },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    });
    if (!audit.ok) throw new Error('invalid fixture audit');
    const fence = mutationFence({ userId: 'U', sessionId: 'SES' } as AuthenticatedActor, {});
    expect(
      await createPackageDetailRepository(executing(context)).setAccess(own, fence, {
        packageId: 'K',
        visibleToNewProjects: false,
        newProjectAccessMode: 'request',
        revision: 1,
        audit: audit.event,
      }),
    ).toEqual({ ok: false, error: 'not_found' });
  },
};
const cases = (['r', 'v', 'dt'] as const).map(contentCase);
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/package-detail.ts',
    builder: 'createPackageDetailRepository',
    cases: [nameCase, accessCase, ...cases],
    predicates: [
      {
        name: accessCase.name,
        caseName: accessCase.name,
        locate: /(?<=package.source_id where )package.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: nameCase.name,
        caseName: nameCase.name,
        locate: /org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      ...(['r', 'v', 'dt'] as const).map((alias) => ({
        name: contentCase(alias).name,
        caseName: contentCase(alias).name,
        locate: new RegExp(`\\b${alias}\\.org_id = \\?`),
        neutral: NOT_NULL,
        copies: 1,
      })),
    ],
    waivers: [
      ...winnerWaivers,
      {
        locate: /"pp"\."org_id" = /,
        reason:
          'visibleWinner reuses the independently registered project-package visibility predicates.',
      },
      {
        locate: /(?<![\w.])org_id = \?/,
        reason:
          'The readme preliminary lookup repeats visibleWinner scope. Access writes repeat the scoped package lookup, revision predicate, and independently mutation-tested actorHolds authority inside one fenced batch; the contract tests exercise foreign targets and revoked authority.',
      },
      {
        locate: /"?(?:s|actor|i|guard_\w+)"?\."?org_id"? = /,
        reason:
          'Delegated actorHolds and rederiveStatements have independent organization mutation registrations.',
      },
    ],
  },
];
