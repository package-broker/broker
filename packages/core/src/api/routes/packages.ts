import type {
  PackageAdminReader,
  PackageListItem,
  PackageListQuery,
  VersionListItem,
} from '../../db/package-admin.js';
import type { OrgContext } from '../../db/port.js';
import type { VulnerabilityStatus } from '../../db/vulnerability.js';
import { isUlid } from '../../ids.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { PACKAGE_API_SPECS } from './packages-schemas.js';

function publicPackage(item: PackageListItem): PackageListItem {
  const { id, ecosystem, name, latestVersion, status, versionCount, lastSyncedAt } = item;
  return {
    id,
    ecosystem,
    name,
    latestVersion,
    status,
    versionCount,
    lastSyncedAt,
    source: {
      id: item.source.id,
      name: item.source.name,
      type: item.source.type,
      projectId: item.source.projectId,
    },
  };
}

const MASKED_VULNERABILITY: VulnerabilityStatus = Object.freeze({
  status: 'unknown',
  reason: 'not_checked',
  source: null,
  fetchedAt: null,
  lastKnownStatus: null,
  advisoryCount: 0,
  advisories: [],
  detailsComplete: false,
  advisoriesTruncated: false,
});

function publicVersion(item: VersionListItem, vulnerability: VulnerabilityStatus) {
  const { id, version, stability, status, publishedAt, removedUpstreamAt, tombstonedAt, revision } =
    item;
  return {
    id,
    version,
    stability,
    status,
    publishedAt,
    removedUpstreamAt,
    tombstonedAt,
    revision,
    vulnerability: {
      status: vulnerability.status,
      reason: vulnerability.reason,
      source: vulnerability.source,
      fetchedAt: vulnerability.fetchedAt,
      lastKnownStatus: vulnerability.lastKnownStatus,
      advisoryCount: vulnerability.advisoryCount,
      advisories: vulnerability.advisories.map((advisory) => ({
        id: advisory.id,
        url: advisory.url,
        severity: {
          level: advisory.severity.level,
          entries: advisory.severity.entries.map(({ type, score }) => ({ type, score })),
        },
        detailsFetchedAt: advisory.detailsFetchedAt,
      })),
      detailsComplete: vulnerability.detailsComplete,
      advisoriesTruncated: vulnerability.advisoriesTruncated,
    },
  };
}

export function packageRoutes(
  reader: Pick<PackageAdminReader, 'listProject' | 'listOrganization' | 'listVersions'> & {
    readonly readStatuses?: (
      ctx: OrgContext,
      visibleVersionIds: readonly string[],
    ) => Promise<ReadonlyMap<string, VulnerabilityStatus>>;
  },
): readonly RouteDefinition[] {
  const [projectList, projectVersions, orgList, orgVersions] = PACKAGE_API_SPECS;
  const lists = [projectList, orgList].map((spec) =>
    apiRoute(spec, async ({ ctx, query }) => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      if (spec.boundary === 'project' && ctx.projectId === null) return { error: 'not_found' };
      if (query.after?.includes('\0')) {
        return { error: 'invalid_request', details: [{ path: '/query/after', code: 'invalid' }] };
      }
      if (query.q !== undefined && (query.q !== query.q.toLowerCase() || query.q.includes('\0'))) {
        return { error: 'invalid_request', details: [{ path: '/query/q', code: 'invalid' }] };
      }
      const input: PackageListQuery = {
        limit: Number(query.limit ?? 50),
        ...(query.after === undefined ? {} : { after: query.after }),
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.source === undefined ? {} : { sourceId: query.source }),
        ...(query.ecosystem === undefined ? {} : { ecosystem: query.ecosystem }),
      };
      const page =
        spec.boundary === 'project'
          ? await reader.listProject(ctx.org, ctx.projectId!, input)
          : await reader.listOrganization(ctx.org, {
              ...input,
              ...('project' in query && typeof query.project === 'string'
                ? { projectId: query.project }
                : {}),
            });
      return { status: 200, body: { items: page.items.map(publicPackage), next: page.next } };
    }),
  );
  const versions = [projectVersions, orgVersions].map((spec) =>
    apiRoute(spec, async ({ ctx, params, query }) => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      if (!isUlid(params.package) || (spec.boundary === 'project' && ctx.projectId === null)) {
        return { error: 'not_found' };
      }
      const page = await reader.listVersions(ctx.org, {
        packageId: params.package,
        projectId: spec.boundary === 'project' ? ctx.projectId : null,
        limit: Number(query.limit ?? 50),
        ...(query.after === undefined ? {} : { after: query.after }),
      });
      if (page === null) return { error: 'not_found' };
      let statuses: ReadonlyMap<string, VulnerabilityStatus> = new Map();
      try {
        statuses =
          (await reader.readStatuses?.(
            ctx.org,
            page.items.map((item) => item.id),
          )) ?? statuses;
      } catch {
        // A failed provenance read cannot disclose cached findings.
      }
      return {
        status: 200,
        body: {
          items: page.items.map((item) =>
            publicVersion(item, statuses.get(item.id) ?? MASKED_VULNERABILITY),
          ),
          next: page.next,
        },
      };
    }),
  );
  return [lists[0]!, versions[0]!, lists[1]!, versions[1]!].map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      return response.status === 404
        ? envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId)
        : response;
    },
  }));
}
