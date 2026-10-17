import { sql, type Kysely } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { resolveScope } from '@package-broker/core/authz/scope';
import {
  TOKEN_LIST_MAX_LIMIT,
  type TokenListItem,
  type TokenListPage,
  type TokenListStatus,
  type TokenPage,
  type TokenReader,
} from '@package-broker/core/authz/token-read';
import { compile, db, type Database } from '../kysely.js';
import { tokenProjectMode } from './access.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface TokenProjectTable {
  org_id: string;
  token_id: string;
  project_id: string;
}

const reads = db as unknown as Kysely<Database & { token_project: TokenProjectTable }>;

interface Row {
  readonly id: string;
  readonly kind: 'pat' | 'svc';
  readonly name: string;
  readonly scopes_json: string;
  readonly read_only: number;
  readonly project_mode: string;
  readonly principal_project_id: string | null;
  readonly project_count: number;
  readonly project_id: string | null;
  readonly user_id: string | null;
  readonly created_by_user_id: string | null;
  readonly service_principal_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

interface Filter {
  readonly kinds: readonly ('pat' | 'svc')[];
  readonly userId?: string;
  readonly projectId?: string;
}

function requireId(value: unknown, name: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireNow(now: unknown): void {
  if (
    typeof now !== 'string' ||
    !TIMESTAMP.test(now) ||
    Number.isNaN(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    throw new TypeError('now must be an ISO timestamp with milliseconds and Z');
  }
}

function requirePage(page: TokenListPage): void {
  requireNow(page.now);
  if (page.after !== null) requireId(page.after, 'after');
  if (page.status !== undefined && !['active', 'expired', 'revoked'].includes(page.status)) {
    throw new TypeError('status must be active, expired or revoked');
  }
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > TOKEN_LIST_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${TOKEN_LIST_MAX_LIMIT}`);
  }
}

function baseQuery(ctx: OrgContext, filter: Filter) {
  let query = reads
    .selectFrom('token as t')
    .leftJoin('service_principal as sp', (join) =>
      join.onRef('sp.id', '=', 't.service_principal_id').onRef('sp.org_id', '=', 't.org_id'),
    )
    .select([
      't.id as id',
      't.kind as kind',
      't.name as name',
      't.scopes_json as scopes_json',
      't.read_only as read_only',
      't.project_mode as project_mode',
      'sp.project_id as principal_project_id',
      sql<number>`(select count(*) from token_project as tp where tp.org_id = ${ctx.orgId} and tp.token_id = t.id)`.as(
        'project_count',
      ),
      't.project_id as project_id',
      't.user_id as user_id',
      't.created_by_user_id as created_by_user_id',
      't.service_principal_id as service_principal_id',
      't.created_at as created_at',
      't.expires_at as expires_at',
      't.last_used_at as last_used_at',
      't.revoked_at as revoked_at',
    ])
    .where('t.org_id', '=', ctx.orgId)
    .where('t.kind', 'in', ['pat', 'svc'])
    .where('t.kind', 'in', [...filter.kinds]);
  if (filter.userId !== undefined) query = query.where('t.user_id', '=', filter.userId);
  if (filter.projectId !== undefined) query = query.where('t.project_id', '=', filter.projectId);
  return query;
}

function statement(ctx: OrgContext, filter: Filter, page: TokenListPage) {
  let query = baseQuery(ctx, filter);
  if (page.after !== null) query = query.where('t.id', '>', page.after);
  if (page.status === 'revoked') query = query.where('t.revoked_at', 'is not', null);
  if (page.status === 'expired') {
    query = query.where('t.revoked_at', 'is', null).where('t.expires_at', '<=', page.now);
  }
  if (page.status === 'active') {
    query = query
      .where('t.revoked_at', 'is', null)
      .where((eb) => eb.or([eb('t.expires_at', 'is', null), eb('t.expires_at', '>', page.now)]));
  }
  return compile(query.orderBy('t.id').limit(page.limit + 1));
}

function statusOf(row: Row, now: string): TokenListStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'active';
}

function scopeOf(row: Row): { level: TokenListItem['scope']; readOnly: boolean } {
  try {
    const resolved = resolveScope(JSON.parse(row.scopes_json), row.read_only === 1 ? 1 : 0);
    if (resolved.ok) return { level: resolved.level, readOnly: resolved.readOnly };
  } catch {
    // an unreadable scope is shown at the lowest level
  }
  return { level: 'read', readOnly: true };
}

function toItem(row: Row, now: string): TokenListItem {
  const scope = scopeOf(row);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scope: scope.level,
    readOnly: scope.readOnly,
    status: statusOf(row, now),
    projectMode: tokenProjectMode(row.kind, row.project_mode, row.principal_project_id),
    projectCount: Number(row.project_count),
    projectId: row.project_id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id,
    servicePrincipalId: row.service_principal_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createTokenReader(executor: SqlExecutor): TokenReader {
  async function list(ctx: OrgContext, filter: Filter, page: TokenListPage): Promise<TokenPage> {
    const rows = await executor.all<Row>(statement(ctx, filter, page));
    const more = rows.length > page.limit;
    const items = rows.slice(0, page.limit).map((row) => toItem(row, page.now));
    return { items, next: more ? (items[items.length - 1]?.id ?? null) : null };
  }

  async function get(ctx: OrgContext, filter: Filter, tokenId: string, now: string) {
    requireId(tokenId, 'tokenId');
    requireNow(now);
    const query = baseQuery(ctx, filter).where('t.id', '=', tokenId).limit(1);
    const rows = await executor.all<Row>(compile(query));
    return rows[0] === undefined ? null : toItem(rows[0], now);
  }

  return {
    async getOwn(ctx, userId, tokenId, now) {
      requireId(userId, 'userId');
      return get(ctx, { kinds: ['pat'], userId }, tokenId, now);
    },
    async getProject(ctx, projectId, tokenId, now) {
      requireId(projectId, 'projectId');
      return get(ctx, { kinds: ['svc'], projectId }, tokenId, now);
    },
    async getOrganization(ctx, tokenId, now) {
      return get(ctx, { kinds: ['pat', 'svc'] }, tokenId, now);
    },
    async listOwn(ctx, userId, page) {
      requireId(userId, 'userId');
      requirePage(page);
      return list(ctx, { kinds: ['pat'], userId }, page);
    },
    async listProject(ctx, projectId, page) {
      requireId(projectId, 'projectId');
      requirePage(page);
      return list(ctx, { kinds: ['svc'], projectId }, page);
    },
    async listOrganization(ctx, page) {
      requirePage(page);
      if (page.kind !== undefined && page.kind !== 'pat' && page.kind !== 'svc') {
        throw new TypeError('kind must be pat or svc');
      }
      return list(ctx, { kinds: page.kind === undefined ? ['pat', 'svc'] : [page.kind] }, page);
    },
  };
}
