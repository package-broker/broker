import type {
  PackageAdminReader,
  PackageListItem,
  PackageListQuery,
  VersionListItem,
} from '../../db/package-admin.js';
import type { OrgContext } from '../../db/port.js';
import { accessContextOf } from '../../authz/access-context.js';
import { buildOrganizationActor } from '../../authz/actor.js';
import type { VulnerabilityStatus } from '../../db/vulnerability.js';
import { isUlid } from '../../ids.js';
import { envelopeResponse } from '../../kernel/errors.js';
import { contextPackageActorOf } from '../../internal/package-actor.js';
import {
  createOrganizationPolicyViews,
  createPolicyViews,
  type PackageViewPolicy,
  type PolicyPackageSummary,
} from '../../catalogue/policy-views.js';
import { policyErrorResponse } from '../../registry/policy/http.js';
import { withPolicyRetry } from '../../registry/policy/session.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { PACKAGE_API_SPECS } from './packages-schemas.js';

function publicPackage(item: PackageListItem | PolicyPackageSummary, organization: boolean) {
  const { id, ecosystem, name, latestVersion, status, versionCount, lastSyncedAt } = item;
  return {
    id,
    ...(organization
      ? {
          visibleToNewProjects: item.visibleToNewProjects,
          newProjectAccessMode: item.newProjectAccessMode,
          revision: item.revision,
        }
      : {}),
    ecosystem,
    name,
    latestVersion,
    status,
    versionCount,
    ...('versionCountTruncated' in item
      ? { versionCountTruncated: item.versionCountTruncated }
      : {}),
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
    integrity: item.integrity,
    distTags: item.distTags,
    publishedBy:
      item.publishedBy === null
        ? null
        : { kind: item.publishedBy.kind, displayName: item.publishedBy.displayName },
    approvedBy:
      item.approvedBy === null
        ? null
        : { displayName: item.approvedBy.displayName, decidedAt: item.approvedBy.decidedAt },
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

/** Holders of the organization package-management permission keep the unfiltered view. */
export function inspects(ctx: Parameters<RouteDefinition['handler']>[0]): boolean {
  const snapshot = accessContextOf(ctx)?.actor;
  if (snapshot === null || snapshot === undefined) return false;
  return (
    buildOrganizationActor('organization', snapshot)?.permissions.has('org:packages:manage') ===
    true
  );
}

/**
 * `policy` is present only when `registry.policy.enabled`; it filters the project views, and the
 * organization views for callers without the organization package-management permission.
 */
export function packageRoutes(
  reader: Pick<PackageAdminReader, 'listProject' | 'listOrganization' | 'listVersions'> & {
    readonly readStatuses?: (
      ctx: OrgContext,
      visibleVersionIds: readonly string[],
    ) => Promise<ReadonlyMap<string, VulnerabilityStatus>>;
  },
  policy?: PackageViewPolicy,
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
      if (spec.boundary === 'project' && policy !== undefined) {
        const actor = contextPackageActorOf(ctx);
        if (actor === null) return { error: 'not_found' };
        const org = ctx.org;
        const views = createPolicyViews(policy, ctx, actor, 'listing');
        const filtered = await withPolicyRetry(async () => {
          const items: PolicyPackageSummary[] = [];
          let after = input.after;
          for (;;) {
            const raw = await reader.listProject(org, actor.projectId, {
              ...input,
              ...(after === undefined ? {} : { after }),
            });
            for (const item of raw.items) {
              const summary = await views.summarize(item);
              if (summary !== null) items.push(summary);
            }
            if (items.length > 0 || raw.next === null || !views.fits(input.limit)) {
              await views.seal();
              return { items, next: raw.next };
            }
            after = raw.next;
          }
        });
        return {
          status: 200,
          body: {
            items: filtered.items.map((item) => publicPackage(item, false)),
            next: filtered.next,
          },
        };
      }
      const listOrganization = (after: string | undefined) =>
        reader.listOrganization(ctx.org!, {
          ...input,
          ...(after === undefined ? {} : { after }),
          ...('project' in query && typeof query.project === 'string'
            ? { projectId: query.project }
            : {}),
        });
      if (spec.boundary === 'organization' && policy !== undefined && !inspects(ctx)) {
        const filtered = await withPolicyRetry(async () => {
          const views = createOrganizationPolicyViews(policy, ctx);
          const items: PolicyPackageSummary[] = [];
          let after = input.after;
          for (;;) {
            const raw = await listOrganization(after);
            for (const item of raw.items) {
              const summary = await views.summarize(item);
              if (summary !== null) items.push(summary);
            }
            if (items.length > 0 || raw.next === null) {
              await views.seal();
              return { items, next: raw.next };
            }
            after = raw.next;
          }
        });
        return {
          status: 200,
          body: {
            items: filtered.items.map((item) => publicPackage(item, true)),
            next: filtered.next,
          },
        };
      }
      const page =
        spec.boundary === 'project'
          ? await reader.listProject(ctx.org, ctx.projectId!, input)
          : await listOrganization(input.after);
      return {
        status: 200,
        body: {
          items: page.items.map((item) => publicPackage(item, spec.boundary === 'organization')),
          next: page.next,
        },
      };
    }),
  );
  const versions = [projectVersions, orgVersions].map((spec) =>
    apiRoute(spec, async ({ ctx, params, query }) => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      if (!isUlid(params.package) || (spec.boundary === 'project' && ctx.projectId === null)) {
        return { error: 'not_found' };
      }
      const read = (after: string | undefined) =>
        reader.listVersions(ctx.org!, {
          packageId: params.package,
          projectId: spec.boundary === 'project' ? ctx.projectId : null,
          limit: Number(query.limit ?? 50),
          ...(after === undefined ? {} : { after }),
        });
      let page: Awaited<ReturnType<typeof read>>;
      if (spec.boundary === 'project' && policy !== undefined) {
        const actor = contextPackageActorOf(ctx);
        if (actor === null) return { error: 'not_found' };
        const views = createPolicyViews(policy, ctx, actor, 'metadata');
        page = await withPolicyRetry(async () => {
          if (!(await views.admits(params.package))) {
            await views.seal();
            return query.after === undefined ? null : { items: [], next: null };
          }
          let after = query.after;
          for (;;) {
            const raw = await read(after);
            if (raw === null) return null;
            const items = await views.versions(params.package, raw.items);
            if (items.length > 0 || raw.next === null) {
              await views.seal();
              return items.length === 0 && query.after === undefined
                ? null
                : { items, next: raw.next };
            }
            after = raw.next;
          }
        });
      } else if (spec.boundary === 'organization' && policy !== undefined && !inspects(ctx)) {
        page = await withPolicyRetry(async () => {
          const views = createOrganizationPolicyViews(policy, ctx);
          let after = query.after;
          for (;;) {
            const raw = await read(after);
            if (raw === null) return null;
            const items = await views.versions(params.package, raw.items);
            if (items.length > 0 || raw.next === null) {
              await views.seal();
              return items.length === 0 && query.after === undefined
                ? null
                : { items, next: raw.next };
            }
            after = raw.next;
          }
        });
      } else {
        page = await read(query.after);
      }
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
      let response: Response;
      try {
        response = await route.handler(ctx);
      } catch (error) {
        const refused = policyErrorResponse(error, ctx.requestId);
        if (refused !== null) return refused;
        throw error;
      }
      return response.status === 404
        ? envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId)
        : response;
    },
  }));
}
