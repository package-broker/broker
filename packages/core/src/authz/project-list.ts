import type { OrgContext } from '../db/port.js';
import { isUlid } from '../ids.js';
import { isPermissionView } from './actor.js';
import type { ActorContext } from './administration.js';
import type { ProjectStatus } from './project-service.js';

export const PROJECT_LIST_MAX_LIMIT = 200;

export const PROJECT_LIST_PREFIX_MAX_LENGTH = 200;
// eslint-disable-next-line no-control-regex
export const PROJECT_LIST_PREFIX_PATTERN = /^[^%_\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;

export function isValidProjectListPrefix(q: unknown): q is string {
  return (
    typeof q === 'string' &&
    q.length <= PROJECT_LIST_PREFIX_MAX_LENGTH &&
    PROJECT_LIST_PREFIX_PATTERN.test(q)
  );
}

const RESTRICTED_CHUNK = 50;

export interface ProjectListEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly revision: number;
}

/** The project repository's `list` satisfies this; rows come back ordered by id. */
export interface ProjectListSource {
  list(
    ctx: OrgContext,
    page: {
      readonly q?: string;
      readonly afterId?: string;
      readonly limit: number;
      readonly status: ProjectStatus;
      readonly ids?: readonly string[];
    },
  ): Promise<readonly ProjectListEntry[]>;
}

export interface ReadableProjectPage {
  readonly q?: string;
  readonly afterId?: string;
  readonly limit: number;
  readonly status: ProjectStatus;
  /** Restricts the query to these bound ids before applying grants. */
  readonly ids?: readonly string[];
}

/**
 * Returns, in id order and at most `limit` rows, only projects of `status` after `afterId` on which
 * the actor holds `project:read` through project grants. One read per page.
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
  readonly q?: string;
  readonly limit: number;
  readonly afterId?: string;
  readonly status?: ProjectStatus;
  /** Lists nothing outside these project ids, and still only what the actor can read. */
  readonly restrictTo?: readonly string[];
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
  | 'invalid_query'
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
  /** Optional per-project permission lookup for restricted listings. */
  readonly access?: ProjectReadAccess;
  /** Lists project-grant readable projects for a caller lacking organization `project:read`. */
  readonly readable: ReadableProjectSource;
}

function fail(error: ProjectListError): ProjectListResult {
  return { ok: false, error };
}

export function createProjectLister(deps: ProjectListerDeps): ProjectLister {
  const { source, access, readable } = deps as Partial<ProjectListerDeps>;
  if (
    source === undefined ||
    typeof source.list !== 'function' ||
    readable === undefined ||
    typeof readable.listReadableProjects !== 'function' ||
    (access !== undefined && typeof access.permissionsFor !== 'function')
  ) {
    throw new TypeError('project lister requires a source and a readable source');
  }

  const pages: ProjectListSource = source;
  const grants: ReadableProjectSource = readable;

  async function listRestricted(
    ctx: OrgContext,
    userId: string,
    inheritsAll: boolean,
    page: ReadableProjectPage,
    restrictTo: unknown,
  ): Promise<ProjectListResult> {
    if (
      !Array.isArray(restrictTo) ||
      !restrictTo.every((id: unknown) => typeof id === 'string' && isUlid(id))
    ) {
      return fail('source_invalid');
    }
    const bound = [...new Set(restrictTo as string[])].sort();
    const lastBound = bound[bound.length - 1];
    const { limit, status } = page;
    const items: ProjectListEntry[] = [];
    const finish = (resume: string | undefined, exhausted: boolean): ProjectListResult => ({
      ok: true,
      value: {
        items,
        nextAfterId: exhausted || resume === lastBound ? null : (resume ?? null),
      },
    });

    let cursor = page.afterId;
    while (items.length < limit) {
      const start = cursor;
      const chunk = bound
        .filter((id) => start === undefined || id > start)
        .slice(0, RESTRICTED_CHUNK);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return finish(cursor, true);
      const query = {
        limit: chunk.length,
        status,
        ids: chunk,
        ...(page.q === undefined ? {} : { q: page.q }),
      };
      const rows =
        !inheritsAll && access === undefined
          ? await grants.listReadableProjects(ctx, { userId }, query)
          : await pages.list(ctx, query);
      const granted =
        inheritsAll || access === undefined
          ? null
          : await access.permissionsFor(
              ctx,
              userId,
              rows.map((row) => row.id),
            );
      cursor = last;
      for (const row of rows) {
        if (row.status !== status || !chunk.includes(row.id)) continue;
        if (granted !== null && granted.get(row.id)?.has('project:read') !== true) continue;
        items.push({
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: row.status,
          revision: row.revision,
        });
        if (items.length === limit) {
          cursor = row.id;
          break;
        }
      }
    }
    return finish(cursor, false);
  }

  return {
    async list(ctx, actor, request) {
      if (typeof actor !== 'object' || actor === null) return fail('forbidden');
      const { userId, isOrganizationAdmin } = actor;
      if (typeof userId !== 'string' || userId === '') return fail('forbidden');
      const orgPermissions = actor.permissions;
      if (!isPermissionView(orgPermissions)) return fail('forbidden');
      const admin = isOrganizationAdmin === true;

      const { limit, afterId, q } = request;
      if (q !== undefined && !isValidProjectListPrefix(q)) return fail('invalid_query');
      const prefix = q === undefined ? {} : { q };
      if (!Number.isInteger(limit) || limit < 1 || limit > PROJECT_LIST_MAX_LIMIT) {
        return fail('invalid_limit');
      }
      if (afterId !== undefined && (typeof afterId !== 'string' || !isUlid(afterId))) {
        return fail('invalid_cursor');
      }
      const status = request.status ?? 'active';
      if (status !== 'active' && status !== 'archived') return fail('invalid_status');
      if (status === 'archived' && !admin) return fail('forbidden');

      const inheritsAll = orgPermissions.has('project:read');

      if (request.restrictTo !== undefined) {
        if (request.restrictTo.length === 0) {
          return { ok: true, value: { items: [], nextAfterId: null } };
        }
        return listRestricted(
          ctx,
          userId,
          inheritsAll,
          { ...prefix, limit, status, ...(afterId === undefined ? {} : { afterId }) },
          request.restrictTo,
        );
      }

      if (!inheritsAll) {
        const rows = await readable.listReadableProjects(
          ctx,
          { userId },
          { ...prefix, ...(afterId === undefined ? {} : { afterId }), limit, status },
        );
        const items: ProjectListEntry[] = [];
        let previous = afterId;
        for (const row of rows.slice(0, limit)) {
          if (row.status !== status || (previous !== undefined && row.id <= previous)) continue;
          items.push({
            id: row.id,
            slug: row.slug,
            name: row.name,
            status: row.status,
            revision: row.revision,
          });
          previous = row.id;
        }
        if (rows.length < limit) return { ok: true, value: { items, nextAfterId: null } };
        const last = items[items.length - 1];
        if (last === undefined) return fail('source_invalid');
        return { ok: true, value: { items, nextAfterId: last.id } };
      }

      const rows = await source.list(ctx, {
        ...prefix,
        ...(afterId === undefined ? {} : { afterId }),
        limit,
        status,
      });
      const items = rows
        .filter((row) => row.status === status)
        .slice(0, limit)
        .map(({ id, slug, name, status, revision }) => ({ id, slug, name, status, revision }));
      return {
        ok: true,
        value: { items, nextAfterId: rows.length < limit ? null : (items.at(-1)?.id ?? null) },
      };
    },
  };
}
