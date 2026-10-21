import type {
  PackageAdminReader,
  PackageListItem,
  PackageListQuery,
  VersionListItem,
} from '../../db/package-admin.js';
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

function publicVersion(item: VersionListItem): VersionListItem {
  const { id, version, stability, status, publishedAt, removedUpstreamAt, tombstonedAt, revision } =
    item;
  return { id, version, stability, status, publishedAt, removedUpstreamAt, tombstonedAt, revision };
}

export function packageRoutes(
  reader: Pick<PackageAdminReader, 'listProject' | 'listOrganization' | 'listVersions'>,
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
      return page === null
        ? { error: 'not_found' }
        : { status: 200, body: { items: page.items.map(publicVersion), next: page.next } };
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
