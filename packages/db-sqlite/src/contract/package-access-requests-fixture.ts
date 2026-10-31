import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { seedTwoOrganizations } from './two-organizations.js';
import { seeder, type CaseContext } from '../testing/mutation-table/harness.js';
import {
  ANCHORS,
  seedBindings,
  seedSubject,
  seedProject,
  seedSource,
  seedPackage,
  fenceOf,
} from '../testing/mutation-table/fixtures.js';
import { createPackageAccessRequestRepository } from '../repositories/package-access-requests.js';

export async function accessFixture(executor: SqlExecutor, provided?: CaseContext) {
  const orgs = provided?.orgs ?? (await seedTwoOrganizations(executor));
  const context: CaseContext = provided ?? {
    executor,
    orgs,
    mutate: (s) => s,
    mutateBatch: (s) => s,
  };
  const org = orgs.a;
  const seed = seeder(executor);
  await seedBindings(context);
  await seedProject(seed, 'PROJECT', org.orgId);
  await seedSource(seed, 'SOURCE', org.orgId, 'hosted', 'npm');
  await seedPackage(seed, 'PACKAGE', org.orgId, 'SOURCE', 'widget', 'npm');
  await seed("UPDATE package SET visible_to_new_projects = 0, new_project_access_mode = 'request'");
  await seed(
    "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'PROJECT', 'SOURCE')",
    org.orgId,
  );
  const requester = await seedSubject(context, 'requester', { projectId: 'PROJECT' });
  const decider = await seedSubject(context, 'decider');
  await seed(
    "UPDATE role_permission SET permission = 'project:packages:manage' WHERE role_id = 'R-requester'",
  );
  await seed(
    "UPDATE role_permission SET permission = 'org:packages:manage' WHERE role_id = 'R-decider'",
  );
  const now = new Date().toISOString();
  const event = (
    action: 'package.access_request' | 'package.access_decide',
    system = false,
  ): AuditEvent => ({
    id: ulid(),
    occurredAt: now,
    action,
    actor: system
      ? { type: 'system', id: 'package-access-expire' }
      : {
          type: 'user',
          id: action === 'package.access_request' ? requester.userId : decider.userId,
        },
    target: { type: 'package', id: 'PACKAGE' },
    projectId: 'PROJECT',
    tokenSelector: null,
    sourceIp: null,
    payloadJson: '{}',
  });
  const repo = createPackageAccessRequestRepository(executor, ANCHORS);
  const input = () => ({
    id: ulid(),
    packageId: 'PACKAGE',
    projectId: 'PROJECT',
    requestedByUserId: requester.userId,
    now,
    expiresAt: new Date(Date.parse(now) + 30 * 86400_000).toISOString(),
    event: event('package.access_request'),
  });
  return {
    org,
    orgs,
    seed,
    repo,
    now,
    input,
    event,
    requester,
    decider,
    requestFence: fenceOf(requester),
    decideFence: fenceOf(decider),
  };
}
