import type { OrgContext } from '../db/port.js';
import { isUlid } from '../ids.js';
import { isPermissionView } from './actor.js';
import type { ActorContext } from './administration.js';
import type { ProjectStatus } from './project-service.js';

export const PROJECT_LIST_MAX_LIMIT = 200;

const MAX_SOURCE_READS = 10;
const RESTRICTED_CHUNK = 50;

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
    page: {
      readonly afterId?: string;
      readonly limit: number;
      readonly status: ProjectStatus;
      readonly ids?: readonly string[];
    },
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
   * Required when `readable` is absent and ignored when it is wired. Without `readable`, an
   * unrestricted caller lacking organization `project:read` gets at most ten source reads per page
   * and may see `scan_incomplete`. A restricted listing never does: at its read cap it returns the
   * greatest bound id reached as the cursor.
   */
  readonly access?: ProjectReadAccess;
  /** Lists project-grant readable projects for a caller lacking organization `project:read`. */
  readonly readable?: ReadableProjectSource;
}

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The greatest id of the same length that sorts strictly below `id`, or null when none exists. */
function idBefore(id: string): string | null {
  for (let i = id.length - 1; i >= 0; i -= 1) {
    const at = ID_ALPHABET.indexOf(id[i] as string);
    if (at > 0) {
      return id.slice(0, i) + (ID_ALPHABET[at - 1] as string) + 'Z'.repeat(id.length - i - 1);
    }
    if (at < 0) return null;
  }
  return null;
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

  const pages: ProjectListSource = source;

  async function listRestricted(
    ctx: OrgContext,
    userId: string,
    inheritsAll: boolean,
    page: { readonly limit: number; readonly afterId?: string; readonly status: ProjectStatus },
    restrictTo: unknown,
  ): Promise<ProjectListResult> {
    if (
      !Array.isArray(restrictTo) ||
      !restrictTo.every((id: unknown) => typeof id === 'string' && isUlid(id))
    ) {
      return fail('source_invalid');
    }
    const bound = [...new Set(restrictTo as string[])].sort();
    const wanted = new Set(bound);
    const lastBound = bound[bound.length - 1] as string;
    const { limit, status } = page;
    const items: ProjectListEntry[] = [];
    const finish = (resume: string, exhausted: boolean): ProjectListResult => {
      const last = items[items.length - 1];
      const done = exhausted || (last !== undefined && last.id >= lastBound);
      return { ok: true, value: { items, nextAfterId: done ? null : resume } };
    };

    if (!inheritsAll && readable !== undefined) {
      let cursor = page.afterId;
      let resume = page.afterId;
      for (let reads = 0; reads < MAX_SOURCE_READS; reads += 1) {
        const at = cursor;
        const next = bound.find((id) => at === undefined || id > at);
        if (next === undefined) return finish(resume as string, true);
        const floor = idBefore(next);
        if (floor !== null && (at === undefined || floor > at)) cursor = floor;
        const from = cursor;
        const rows = await readable.listReadableProjects(
          ctx,
          { userId },
          {
            ...(from === undefined ? {} : { afterId: from }),
            limit: PROJECT_LIST_MAX_LIMIT,
            status,
          },
        );
        let passed = false;
        let scanned = from;
        for (const row of rows) {
          if (from !== undefined && row.id <= from) continue;
          if (row.id > lastBound) {
            passed = true;
            break;
          }
          scanned = row.id;
          if (row.status !== status || !wanted.has(row.id)) continue;
          items.push({ id: row.id, slug: row.slug, name: row.name, status: row.status });
          resume = row.id;
          if (items.length === limit) return finish(resume, false);
        }
        if (passed || rows.length < PROJECT_LIST_MAX_LIMIT) return finish(resume as string, true);
        if (scanned === from) return fail('source_invalid');
        cursor = scanned;
        const reached = [...bound].reverse().find((id) => id <= (scanned as string));
        if (reached !== undefined && (resume === undefined || reached > resume)) resume = reached;
      }
      if (resume === undefined || resume === page.afterId) return fail('source_invalid');
      return finish(resume, false);
    }

    let cursor = page.afterId;
    while (items.length < limit) {
      const start = cursor;
      const chunk = bound
        .filter((id) => start === undefined || id > start)
        .slice(0, RESTRICTED_CHUNK);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return finish(cursor as string, true);
      const rows = await pages.list(ctx, { limit: chunk.length, status, ids: chunk });
      const granted = inheritsAll
        ? null
        : await (access as ProjectReadAccess).permissionsFor(
            ctx,
            userId,
            rows.map((row) => row.id),
          );
      cursor = last;
      for (const row of rows) {
        if (row.status !== status || !wanted.has(row.id)) continue;
        if (granted !== null && granted.get(row.id)?.has('project:read') !== true) continue;
        items.push({ id: row.id, slug: row.slug, name: row.name, status: row.status });
        if (items.length === limit) {
          cursor = row.id;
          break;
        }
      }
    }
    return finish(cursor as string, false);
  }

  return {
    async list(ctx, actor, request) {
      if (typeof actor !== 'object' || actor === null) return fail('forbidden');
      const { userId, isOrganizationAdmin } = actor;
      if (typeof userId !== 'string' || userId === '') return fail('forbidden');
      const orgPermissions = actor.permissions;
      if (!isPermissionView(orgPermissions)) return fail('forbidden');
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

      const inheritsAll = orgPermissions.has('project:read');

      if (request.restrictTo !== undefined) {
        if (request.restrictTo.length === 0) {
          return { ok: true, value: { items: [], nextAfterId: null } };
        }
        return listRestricted(
          ctx,
          userId,
          inheritsAll,
          { limit, status, ...(afterId === undefined ? {} : { afterId }) },
          request.restrictTo,
        );
      }

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
