import { logAuditUnavailable } from '../../audit/effective.js';
import type { AuditTrailDefinition, AuditTrailRequest } from '../../audit/plugin-api.js';
import type { KernelLog } from '../../kernel/errors.js';
import type { AuditWithheldMarkerV1 } from '../../audit/plugin-api.js';
import type { EffectiveAuditConfig, OrgAuditResult } from '../../audit/effective.js';
import type { OrgContext } from '../../db/port.js';
import {
  createAuditTrailContext,
  type AuditTrailServices,
} from '../../internal/audit-trail-context.js';
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
  ): Promise<{ items: readonly (AuditRow | AuditWithheldMarkerV1)[]; next: string | null }>;
  head(ctx: RequestContext): Promise<{
    seq: number;
    hash: string;
    pendingCount: number;
    lastVerifiedAt: string | null;
    verification?: {
      fromSeq: number;
      throughSeq: number;
      bodies: number;
      withheld: number;
      verifiedAt: string;
    } | null;
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

function publicItem(row: AuditRow | AuditWithheldMarkerV1) {
  if ('kind' in row)
    return {
      kind: 'withheld' as const,
      id: 'id' in row ? row.id : row.markerId,
      seq: row.seq,
      reason: row.reasonCode === 'unreadable' ? ('unreadable' as const) : ('content' as const),
    };
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

export interface AuditTrailDispatch {
  readonly trail: { readonly definition: AuditTrailDefinition } | null;
  readonly effective: (
    org: OrgContext,
  ) => Promise<Pick<EffectiveAuditConfig, 'trailActive' | 'policy'> | OrgAuditResult>;
  readonly services: AuditTrailServices;
  readonly log: KernelLog;
}

export function auditRoutes(
  reader?: AuditReader,
  dispatch?: AuditTrailDispatch,
): readonly RouteDefinition[] {
  const handle = async (ctx: RequestContext, ...args: AuditTrailRequest): Promise<ApiOutcome> => {
    if (dispatch?.trail == null || ctx.org === null) return { error: 'audit_trail_unavailable' };
    let active: boolean;
    try {
      const result = await dispatch.effective(ctx.org);
      if ('ok' in result && !result.ok) throw new Error('Audit configuration refused');
      active = 'ok' in result ? result.effective.trailActive : result.trailActive;
      if (typeof active !== 'boolean') throw new Error('Audit configuration unavailable');
    } catch (error) {
      logAuditUnavailable(ctx.request, dispatch.log, error);
      return { error: 'audit_trail_unavailable' };
    }
    const context = createAuditTrailContext(ctx.org, active, dispatch.services);
    if (!context.active) return { error: 'audit_trail_unavailable' };
    const body = await dispatch.trail.definition.create(context).handle(...args);
    if (body !== null && typeof body === 'object' && 'error' in body) return body;
    const parsed =
      args[0] === 'auditHead'
        ? auditHeadResponse.safeParse(body)
        : auditListResponse.safeParse(body);
    return parsed.success
      ? { status: 200, body: parsed.data }
      : { error: 'audit_trail_invalid_response' };
  };
  const list = async (
    ctx: RequestContext,
    query: {
      actor?: string | undefined;
      action?: string | undefined;
      after?: string | undefined;
      limit?: string | undefined;
    },
    projectId: string | null,
    projectRoute = false,
  ): Promise<ApiOutcome> => {
    if (dispatch?.trail != null) {
      return !projectRoute || projectId === null
        ? handle(ctx, 'listAudit', { query, projectId })
        : handle(ctx, 'listProjectAudit', { query, projectId });
    }
    if (reader === undefined) return { error: 'audit_trail_unavailable' };
    const limit = validateInput(auditLimit, Number(query.limit ?? 50));
    if (!limit.ok)
      return {
        error: 'invalid_request',
        details: limit.details.map((detail) => ({ path: '/query/limit', code: detail.code })),
      };
    if (
      query.after !== undefined &&
      (!/^[0-9]+$/.test(query.after) || !Number.isSafeInteger(Number(query.after)))
    )
      return { error: 'invalid_request', details: [{ path: '/query/after', code: 'invalid' }] };
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
      async ({ ctx }) => {
        if (dispatch?.trail != null)
          return handle(ctx, 'auditHead', { query: undefined, projectId: null });
        if (reader === undefined) return { error: 'audit_trail_unavailable' };
        const head = await reader.head(ctx);
        return { status: 200, body: { ...head, verification: head.verification ?? null } };
      },
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
          : list(ctx, query, ctx.projectId, true),
    ),
  ];
}
