import { logAuditUnavailable } from '../../audit/effective.js';
import type { AuditTrailDefinition, AuditTrailRequest } from '../../audit/plugin-api.js';
import type { KernelLog } from '../../kernel/errors.js';
import type { EffectiveAuditConfig, OrgAuditResult } from '../../audit/effective.js';
import type { OrgContext } from '../../db/port.js';
import {
  createAuditTrailContext,
  type AuditTrailServices,
} from '../../internal/audit-trail-context.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import {
  auditQuery,
  projectAuditQuery,
  projectAuditParams,
  auditListResponse,
  auditHeadResponse,
} from './audit.schemas.js';

export interface AuditTrailDispatch {
  readonly trail: { readonly definition: AuditTrailDefinition } | null;
  readonly effective: (
    org: OrgContext,
  ) => Promise<Pick<EffectiveAuditConfig, 'trailActive' | 'policy'> | OrgAuditResult>;
  readonly services: AuditTrailServices;
  readonly log: KernelLog;
}

export function auditRoutes(dispatch?: AuditTrailDispatch): readonly RouteDefinition[] {
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
    return !projectRoute || projectId === null
      ? handle(ctx, 'listAudit', { query, projectId })
      : handle(ctx, 'listProjectAudit', { query, projectId });
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
      ({ ctx }) => handle(ctx, 'auditHead', { query: undefined, projectId: null }),
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
