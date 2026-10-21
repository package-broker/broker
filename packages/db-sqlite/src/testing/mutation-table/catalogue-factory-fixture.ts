import { orgOf, seeder, type CaseContext } from './harness.js';
import { seedProject, seedSource, seedPackage, seedVersion } from './fixtures.js';

export async function visiblePackage(
  context: CaseContext,
  foreignMembership = false,
): Promise<void> {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seedProject(seed, 'P', own.orgId);
  await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
  await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
  await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
  await seed(
    "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
    own.orgId,
  );
  await seed.forged(
    "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P' AS project_id, 'K' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
    foreignMembership ? foreign.orgId : own.orgId,
  );
}

export const packageQuery = { projectId: 'P', ecosystem: 'npm', key: 'widget' } as const;
