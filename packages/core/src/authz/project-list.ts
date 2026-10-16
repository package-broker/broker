import type { OrgContext } from '../db/port.js';
import { isUlid } from '../ids.js';
import type { ActorContext } from './administration.js';
import type { ProjectStatus } from './project-service.js';

export const PROJECT_LIST_MAX_LIMIT = 200;

const MAX_SOURCE_READS = 10;

export interface ProjectListEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: ProjectStatus;
}

/** The project repository's `list` satisfies this; rows come back ordered by id. */
export interface ProjectListSource {
  list(
    ctx: OrgContext,
    page: { readonly afterId?: string; readonly limit: number; readonly status: ProjectStatus },
  ): Promise<readonly ProjectListEntry[]>;
}

export interface ReadableProjectPage {
  readonly afterId?: string;
  readonly limit: number;
  readonly status: ProjectStatus;
}

/**
 * Returns, in id order and at most `limit` rows, only projects of `status` after `afterId` on which
 * the actor holds `project:read` through its organization or project grants. One read per page.
 */
export interface ReadableProjectSource {
  listReadableProjects(
    ctx: OrgContext,
    actor: Pick<ActorContext, 'userId'>,
    page: ReadableProjectPage,
  ): Promise<readonly ProjectListEntry[]>;
}

/**
 * Project-scoped grants only; the lister unions them with the `project:` subset of the actor's
 * organization permissions, as the access engine does. An id missing from the map has no grant.
 */
export interface ProjectReadAccess {
  permissionsFor(
    ctx: OrgContext,
    userId: string,
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
}

export interface ProjectListRequest {
  readonly limit: number;
  readonly afterId?: string;
  readonly status?: ProjectStatus;
}

export interface ProjectListPage {
  readonly items: readonly ProjectListEntry[];
  readonly nextAfterId: string | null;
}

export type ProjectListError =
  | 'forbidden'
  | 'invalid_limit'
  | 'invalid_cursor'
  | 'invalid_status'
  | 'scan_incomplete'
  | 'source_invalid';

export type ProjectListResult =
  | { readonly ok: true; readonly value: ProjectListPage }
  | { readonly ok: false; readonly error: ProjectListError };

export interface ProjectLister {
  list(
    ctx: OrgContext,
    actor: ActorContext,
    request: ProjectListRequest,
  ): Promise<ProjectListResult>;
}

export interface ProjectListerDeps {
  readonly source: ProjectListSource;
  /**
   * Required when `readable` is absent and ignored when it is wired. Without `readable`, a caller
   * lacking organization `project:read` gets at most ten source reads per page and may see
   * `scan_incomplete`.
   */
  readonly access?: ProjectReadAccess;
  /** Lists project-grant readable projects for a caller lacking organization `project:read`. */
  readonly readable?: ReadableProjectSource;
}

function fail(error: ProjectListError): ProjectListResult {
  return { ok: false, error };
}

export function createProjectLister(deps: ProjectListerDeps): ProjectLister {
  const { source, access, readable } = deps as Partial<ProjectListerDeps>;
  if (
    source === undefined ||
    typeof source.list !== 'function' ||
    (readable !== undefined
      ? typeof readable.listReadableProjects !== 'function'
      : access === undefined || typeof access.permissionsFor !== 'function')
  ) {
    throw new TypeError(
      'project lister requires a source and a readable source or read-access port',
    );
  }

  return {
    async list(ctx, actor, request) {
      if (typeof actor !== 'object' || actor === null) return fail('forbidden');
      const { userId, isOrganizationAdmin } = actor;
      if (typeof userId !== 'string' || userId === '') return fail('forbidden');
      const admin = isOrganizationAdmin === true;

      const { limit, afterId } = request;
      if (!Number.isInteger(limit) || limit < 1 || limit > PROJECT_LIST_MAX_LIMIT) {
        return fail('invalid_limit');
      }
      if (afterId !== undefined && (typeof afterId !== 'string' || !isUlid(afterId))) {
        return fail('invalid_cursor');
      }
      const status = request.status ?? 'active';
      if (status !== 'active' && status !== 'archived') return fail('invalid_status');
      if (status === 'archived' && !admin) return fail('forbidden');

      const orgPermissions =
        actor.permissions instanceof Set ? actor.permissions : new Set<string>();
      const inheritsAll = orgPermissions.has('project:read');

      if (!inheritsAll && readable !== undefined) {
        const rows = await readable.listReadableProjects(
          ctx,
          { userId },
          { ...(afterId === undefined ? {} : { afterId }), limit, status },
        );
        const items: ProjectListEntry[] = [];
        let previous = afterId;
        for (const row of rows.slice(0, limit)) {
          if (row.status !== status || (previous !== undefined && row.id <= previous)) continue;
          items.push({ id: row.id, slug: row.slug, name: row.name, status: row.status });
          previous = row.id;
        }
        if (rows.length < limit) return { ok: true, value: { items, nextAfterId: null } };
        const last = items[items.length - 1];
        if (last === undefined) return fail('source_invalid');
        return { ok: true, value: { items, nextAfterId: last.id } };
      }

      const batch = inheritsAll ? limit : PROJECT_LIST_MAX_LIMIT;

      const items: ProjectListEntry[] = [];
      let cursor = afterId;
      let exhausted = false;
      for (
        let reads = 0;
        items.length < limit && !exhausted && reads < MAX_SOURCE_READS;
        reads += 1
      ) {
        const rows = await source.list(ctx, {
          ...(cursor === undefined ? {} : { afterId: cursor }),
          limit: batch,
          status,
        });
        const granted =
          inheritsAll || rows.length === 0
            ? null
            : await (access as ProjectReadAccess).permissionsFor(
                ctx,
                userId,
                rows.map((row) => row.id),
              );
        for (const row of rows) {
          if (items.length === limit) break;
          if (row.status !== status) continue;
          if (!inheritsAll && granted?.get(row.id)?.has('project:read') !== true) continue;
          items.push({ id: row.id, slug: row.slug, name: row.name, status: row.status });
        }
        exhausted = rows.length < batch;
        cursor = rows[rows.length - 1]?.id;
      }

      const lastItem = items[items.length - 1];
      if (lastItem === undefined) {
        return exhausted
          ? { ok: true, value: { items, nextAfterId: null } }
          : fail('scan_incomplete');
      }
      const drained = exhausted && items.length < limit;
      return { ok: true, value: { items, nextAfterId: drained ? null : lastItem.id } };
    },
  };
}
