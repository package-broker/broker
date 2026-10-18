import type { ActorContext } from '../authz/administration.js';
import type { ProjectActor } from '../authz/project-actor.js';
import {
  CATALOGUE_KEY_LIST_MAX,
  CATALOGUE_PAGE_MAX,
  type CatalogueReader,
  type EdgeCursor,
  type KeyClass,
} from '../db/catalogue.js';
import { isoTimestamp, type Clock } from '../ids.js';
import {
  computeClosure,
  dependencyNames,
  type ClosureEdge,
  type ClosureReport,
  type DependencyFields,
} from './closure.js';
import { packageKey, type NameEcosystem } from './names.js';

const MAX_SCANNED_VERSIONS = 20_000;

type ClosureReader = Pick<CatalogueReader, 'listVisible' | 'pageEdges' | 'classify'>;

export interface DependencyClosureReport extends ClosureReport {
  readonly projectId: string;
  readonly ecosystem: NameEcosystem;
  readonly generatedAt: string;
  readonly scannedPackages: number;
  readonly scannedVersions: number;
  readonly unresolvableSpecs: number;
}

export async function buildClosureReport(
  reader: ClosureReader,
  actor: ProjectActor,
  organizationPermissions: ActorContext['permissions'],
  ecosystem: NameEcosystem,
  clock: Clock,
): Promise<DependencyClosureReport> {
  if (actor.kind !== 'project' || !actor.permissions.has('project:packages:read')) {
    throw new Error('forbidden');
  }
  const canSeeOrganizationSources = organizationPermissions.has('org:sources:read');
  const ctx = { orgId: actor.orgId };
  const scope = { projectId: actor.projectId, ecosystem };
  const visible = new Set<string>();
  let after: string | undefined;
  do {
    const page = await reader.listVisible(ctx, {
      ...scope,
      limit: CATALOGUE_PAGE_MAX,
      ...(after === undefined ? {} : { after }),
    });
    for (const item of page.items) visible.add(item.key);
    after = page.next ?? undefined;
  } while (after !== undefined);

  const edges: ClosureEdge[] = [];
  let scannedVersions = 0;
  let unresolvableSpecs = 0;
  let cursor: EdgeCursor | undefined;
  do {
    const page = await reader.pageEdges(ctx, {
      ...scope,
      limit: Math.min(CATALOGUE_PAGE_MAX, MAX_SCANNED_VERSIONS - scannedVersions),
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    for (const row of page.rows) {
      scannedVersions += 1;
      if (row.deps === null) continue;
      const parsed = JSON.parse(row.deps) as DependencyFields['require'] | DependencyFields;
      const fields =
        ecosystem === 'composer'
          ? { require: parsed as NonNullable<DependencyFields['require']> }
          : (parsed as DependencyFields);
      const names = dependencyNames(ecosystem, fields);
      unresolvableSpecs += names.unresolvable;
      for (const dependency of names.keys) {
        edges.push({ dependency, requirer: row.requirerKey, version: row.version });
      }
    }
    cursor = page.next ?? undefined;
  } while (cursor !== undefined && scannedVersions < MAX_SCANNED_VERSIONS);

  const options = { ecosystem, canSeeOrganizationSources };
  const classes = new Map<string, KeyClass>();
  const report = computeClosure(visible, edges, () => 'not_available', options);
  if (canSeeOrganizationSources) {
    const keys = report.missing.map(({ name }) =>
      packageKey(name, { ecosystem, legacyCase: ecosystem === 'npm' }),
    );
    for (let offset = 0; offset < keys.length; offset += CATALOGUE_KEY_LIST_MAX) {
      const classifications = await reader.classify(ctx, {
        ...scope,
        keys: keys.slice(offset, offset + CATALOGUE_KEY_LIST_MAX),
      });
      for (const item of classifications) classes.set(item.key, item.class);
    }
    for (const missing of report.missing) {
      const key = packageKey(missing.name, { ecosystem, legacyCase: ecosystem === 'npm' });
      missing.status = classes.get(key) ?? 'not_available';
    }
  }
  return {
    ...report,
    projectId: actor.projectId,
    ecosystem,
    generatedAt: isoTimestamp(clock.now()),
    scannedPackages: visible.size,
    scannedVersions,
    unresolvableSpecs,
    truncated: report.truncated || scannedVersions >= MAX_SCANNED_VERSIONS,
  };
}
