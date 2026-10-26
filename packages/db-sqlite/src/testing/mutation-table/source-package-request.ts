import { expect } from 'vitest';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import {
  createSourcePackageStore,
  sourcePackagePresentStatement,
} from '../../repositories/source-package-request.js';
import {
  orgOf,
  seeder,
  type ContractCase,
  type MutationEntry,
  type CaseContext,
} from './harness.js';
import {
  ANCHORS,
  NOT_NULL,
  seedSource,
  seedPackage,
  seedProject,
  seedBindings,
  seedSubject,
  fenceOf,
} from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

function foreignPackage(layer: 'source' | 'package'): ContractCase {
  return {
    name: `complete packages exclude a foreign ${layer}`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedSource(
        seed,
        'S',
        layer === 'source' ? foreign.orgId : own.orgId,
        'npmjs_proxy',
        'npm',
      );
      await seedPackage(
        seed.forged,
        'PKG',
        layer === 'package' ? foreign.orgId : own.orgId,
        'S',
        'widget',
        'npm',
      );
      await seed("UPDATE package SET last_synced_at = '2026-10-26T00:00:00.000Z' WHERE id = 'PKG'");
      expect(
        await context.executor.all(
          context.mutate(sourcePackagePresentStatement(own, 'S', 'widget')),
        ),
      ).toEqual([]);
    },
  };
}

export async function seedRequest(context: CaseContext) {
  const seed = seeder(context.executor);
  const { own } = orgOf(context);
  await seedProject(seed, 'PROJECT', own.orgId);
  await seedSource(seed, 'SOURCE', own.orgId, 'npmjs_proxy', 'npm');
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
    own.orgId,
    'PROJECT',
    'SOURCE',
  );
  await seedBindings(context);
  const subject = await seedSubject(context, 'package-request', { projectId: 'PROJECT' });
  await seed(
    "UPDATE role_permission SET permission = 'project:sources:write' WHERE role_id = 'R-package-request'",
  );
  const audit: AuditEvent = {
    id: '01JA0000000000000000000001',
    occurredAt: new Date().toISOString(),
    action: 'source.package_requested',
    actor: { type: 'user', id: subject.userId },
    target: { type: 'source', id: 'SOURCE' },
    projectId: 'PROJECT',
    tokenSelector: null,
    sourceIp: null,
    payloadJson: JSON.stringify({ changes: { package_name: { new: 'widget' } } }),
  };
  return {
    org: own,
    fence: fenceOf(subject),
    input: { sourceId: 'SOURCE', projectId: 'PROJECT', audit },
  };
}

function foreignRequest(layer: 'source' | 'attachment'): ContractCase {
  return {
    name: `request refuses a foreign ${layer} before writing audit`,
    async run(context) {
      const { foreign } = orgOf(context);
      const fixture = await seedRequest(context);
      const seed = seeder(context.executor);
      await seed.forged(
        `UPDATE ${layer === 'source' ? 'source' : 'project_source'} SET org_id = ?`,
        foreign.orgId,
      );
      expect(
        await createSourcePackageStore(executing(context), ANCHORS).request(
          fixture.org,
          fixture.fence,
          fixture.input,
        ),
      ).toBe('not_found');
      expect(
        await context.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] }),
      ).toEqual([]);
    },
  };
}
const otherProjectAttachment: ContractCase = {
  name: 'request requires attachment to the authorized project, not another project',
  async run(context) {
    const fixture = await seedRequest(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'OTHER', fixture.org.orgId);
    await seed("UPDATE project_source SET project_id = 'OTHER'");
    expect(
      await createSourcePackageStore(executing(context), ANCHORS).request(
        fixture.org,
        fixture.fence,
        fixture.input,
      ),
    ).toBe('not_found');
    expect(await context.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
      [],
    );
  },
};
const packageCase = foreignPackage('package');
const sourceCase = foreignPackage('source');
const sourceRequest = foreignRequest('source');
const attachmentRequest = foreignRequest('attachment');
const authorityWaivers = [
  {
    locate: /"guard_\w+"\."org_id" = /,
    reason:
      'Delegated permissionRows, identity eligibility and local login guards have independent mutation registrations.',
  },
  {
    locate: /"(?:actor|i|s)"\."org_id" = /,
    reason:
      'Delegated liveActorSession checks for the session, account and identity are registered in actor-authority.',
  },
  {
    locate: /"org_id" = \?/,
    reason: 'runOrgFenced owns the organization cache epoch check and has its own registration.',
  },
  {
    locate: /project\.org_id = \?/,
    reason:
      'actorHolds independently requires this exact project to be active and owned by the organization in the same atomic guard.',
  },
];

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/source-package-request.ts',
    builder: 'sourcePackagePresentStatement',
    cases: [packageCase, sourceCase],
    predicates: [
      {
        name: 'package organization',
        locate: /"p"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: packageCase.name,
      },
      {
        name: 'source organization',
        locate: /"s"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: sourceCase.name,
      },
    ],
  },
  factoryEntry(
    'source-package-request',
    'createSourcePackageStore',
    sourceRequest,
    /target\.org_id = \?/,
    [
      ...authorityWaivers,
      {
        locate: /attachment\.org_id = \?/,
        reason: 'The independent foreign attachment factory entry tests this predicate.',
      },
    ],
    NOT_NULL,
    2,
  ),
  factoryEntry(
    'source-package-request',
    'createSourcePackageStore',
    attachmentRequest,
    /attachment\.org_id = \?/,
    [
      ...authorityWaivers,
      {
        locate: /target\.org_id = \?/,
        reason: 'The independent foreign source factory entry tests this predicate.',
      },
    ],
    NOT_NULL,
    2,
  ),
  factoryEntry(
    'source-package-request',
    'createSourcePackageStore',
    otherProjectAttachment,
    /attachment\.project_id = \?/,
    [
      ...authorityWaivers,
      { locate: /target\.org_id = \?/, reason: 'Covered by the foreign source factory entry.' },
      {
        locate: /attachment\.org_id = \?/,
        reason: 'Covered by the foreign attachment factory entry.',
      },
    ],
    NOT_NULL,
    2,
  ),
];
