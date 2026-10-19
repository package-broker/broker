import { auditEvent, type AuditAction, type AuditEventInput } from '../../audit/actions.js';
import type { AuditRow } from '../../audit/chain.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { validateInput } from '../validate.js';
import {
  auditQuery,
  projectAuditQuery,
  projectAuditParams,
  auditLimit,
  auditListResponse,
  auditHeadResponse,
} from './audit.schemas.js';

export interface AuditReader {
  list(
    ctx: RequestContext,
    query: {
      projectId: string | null;
      actor?: string;
      action?: string;
      after?: string;
      limit: number;
    },
  ): Promise<{ items: readonly AuditRow[]; next: string | null }>;
  head(ctx: RequestContext): Promise<{
    seq: number;
    hash: string;
    pendingCount: number;
    lastVerifiedAt: string | null;
  }>;
}

function payloadOf(row: AuditRow): Record<string, unknown> {
  if (new TextEncoder().encode(row.payload_json).length > 4096) return {};
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object') return {};
    if (Object.keys(payload).some((key) => !['op_id', 'request_id', 'changes'].includes(key)))
      return {};
    const result = auditEvent({
      id: row.id,
      now: row.created_at,
      action: row.action as AuditAction,
      actor: { type: row.actor_type, id: row.actor_id },
      target: { type: row.target_type, id: row.target_id },
      projectId: row.project_id,
      context: {
        opId: payload['op_id'] as string,
        requestId: payload['request_id'] as string,
        sourceIp: null,
        tokenSelector: null,
      },
      ...(payload['changes'] === undefined
        ? {}
        : { changes: payload['changes'] as NonNullable<AuditEventInput['changes']> }),
    });
    return result.ok ? (JSON.parse(result.event.payloadJson) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function publicItem(row: AuditRow) {
  return {
    id: row.id,
    seq: row.seq,
    action: row.action,
    actor: { type: row.actor_type, id: row.actor_id },
    targetType: row.target_type,
    targetId: row.target_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    payload: payloadOf(row),
  };
}

export function auditRoutes(reader: AuditReader): readonly RouteDefinition[] {
  const list = async (
    ctx: RequestContext,
    query: {
      actor?: string | undefined;
      action?: string | undefined;
      after?: string | undefined;
      limit?: string | undefined;
    },
    projectId: string | null,
  ): Promise<ApiOutcome> => {
    const limit = validateInput(auditLimit, Number(query.limit ?? 50));
    if (!limit.ok)
      return {
        error: 'invalid_request',
        details: limit.details.map((detail) => ({ path: '/query/limit', code: detail.code })),
      };
    const page = await reader.list(ctx, {
      projectId,
      limit: limit.data,
      ...(query.actor === undefined ? {} : { actor: query.actor }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
    return { status: 200, body: { items: page.items.map(publicItem), next: page.next } };
  };
  return [
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit',
        permission: 'org:audit:read',
        boundary: 'organization',
        api: {
          operationId: 'listAudit',
          summary: 'List audit events',
          tags: ['audit'],
          query: auditQuery,
          responses: { 200: auditListResponse },
        },
      },
      ({ ctx, query }) => list(ctx, query, query.project ?? null),
    ),
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit/head',
        permission: 'org:audit:read',
        boundary: 'organization',
        api: {
          operationId: 'auditHead',
          summary: 'Read audit chain head',
          tags: ['audit'],
          responses: { 200: auditHeadResponse },
        },
      },
      async ({ ctx }) => ({ status: 200, body: await reader.head(ctx) }),
    ),
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/projects/:project/audit',
        permission: 'project:audit:read',
        boundary: 'project',
        api: {
          operationId: 'listProjectAudit',
          summary: 'List project audit events',
          tags: ['audit'],
          params: projectAuditParams,
          query: projectAuditQuery,
          responses: { 200: auditListResponse },
        },
      },
      ({ ctx, query }) =>
        ctx.projectId === null
          ? Promise.resolve({ error: 'not_found' })
          : list(ctx, query, ctx.projectId),
    ),
  ];
}
