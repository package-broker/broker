import { sql, type SqlBool } from 'kysely';
import {
  validateAuditEvent,
  type AuditAction,
  type AuditEvent,
} from '@package-broker/core/audit/actions';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import { fenceKind, type MutationFence } from '@package-broker/core/authz/fence';
import { isValidPattern } from '@package-broker/core/catalogue/patterns';
import {
  MAX_NOTIFICATION_ENDPOINTS,
  NotificationRepositoryError,
  isNotificationEndpointName,
  notificationEventSelection,
  notificationMethod,
  type NotificationPublicOptions,
  type NotificationSealedConfiguration,
  type NotificationWriteRepository,
  type NotificationWriteResult,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';

const ID = /^[0-9A-Za-z_-]{1,64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DB_TIME = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const AFTER_CHANGE = { sql: 'changes() = 1', params: [] };

function invalid(): never {
  throw new NotificationRepositoryError('invalid_request');
}

function id(value: unknown): string {
  return typeof value === 'string' && ID.test(value) ? value : invalid();
}

function instant(value: unknown): string {
  return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value
    ? value
    : invalid();
}

function revision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : invalid();
}

function options(value: NotificationPublicOptions) {
  if (!isNotificationEndpointName(value.name)) invalid();
  if (typeof value.packagePattern !== 'string' || !isValidPattern(value.packagePattern)) invalid();
  return {
    name: value.name,
    method: notificationMethod(value.method),
    events_json: JSON.stringify(notificationEventSelection(value.events)),
    package_pattern: value.packagePattern,
  };
}

function configuration(value: NotificationSealedConfiguration) {
  if (
    typeof value.headersConfigured !== 'boolean' ||
    typeof value.templateConfigured !== 'boolean' ||
    typeof value.statement?.sql !== 'string' ||
    !/^INSERT INTO "?credential"? /i.test(value.statement.sql) ||
    value.statement.params[0] !== value.credentialId
  )
    invalid();
  return {
    credential_id: id(value.credentialId),
    headers_configured: value.headersConfigured ? (1 as const) : (0 as const),
    template_configured: value.templateConfigured ? (1 as const) : (0 as const),
  };
}

function audit(
  event: AuditEvent,
  action: AuditAction,
  endpointId: string,
  projectId: string,
  actorId: string,
): AuditEvent {
  let checked: AuditEvent;
  try {
    checked = validateAuditEvent(event);
  } catch {
    invalid();
  }
  if (
    checked.action !== action ||
    checked.target.type !== 'notification_endpoint' ||
    checked.target.id !== endpointId ||
    checked.projectId !== projectId ||
    checked.actor.type !== 'user' ||
    checked.actor.id !== actorId
  )
    invalid();
  return checked;
}

function probe(guard: Guard): Statement {
  return compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));
}

function current(
  ctx: OrgContext,
  projectId: string,
  endpointId: string,
  alias: 'ready' | 'lookup',
) {
  return db
    .selectFrom(`notification_endpoint as ${alias}`)
    .select([`${alias}.revision`, `${alias}.state`])
    .where(`${alias}.org_id`, '=', ctx.orgId)
    .where(`${alias}.project_id`, '=', projectId)
    .where(`${alias}.id`, '=', endpointId)
    .where(`${alias}.state`, '<>', 'deleted');
}

/** Configuration writes for one project's endpoints, fenced on the actor's live authority. */
export function createNotificationWriteRepository(
  executor: SqlExecutor,
  anchors: readonly ProtectedHolderProvider[],
): NotificationWriteRepository {
  function authority(
    ctx: OrgContext,
    fence: MutationFence,
    projectId: string,
    reauthenticated: boolean,
  ): Guard {
    if (fenceKind(fence) !== 'session') throw new NotificationRepositoryError('forbidden');
    return actorHolds(ctx, fence, {
      permission: 'project:settings:write',
      projectId,
      providerAnchors: anchors,
      ...(reauthenticated
        ? {
            sessionCondition: (
              alias: string,
            ) => sql<SqlBool>`(${sql.ref(`${alias}.reauth_at`)} is not null
              and ${sql.ref(`${alias}.reauth_at`)} >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${REAUTH_WINDOW_MS / 1000} seconds`})
              and ${sql.ref(`${alias}.reauth_at`)} <= ${DB_TIME})`,
          }
        : {}),
    });
  }

  async function settle(
    ctx: OrgContext,
    fence: MutationFence,
    projectId: string,
    endpointId: string,
    held: Guard,
    ready: Guard,
    mutations: readonly Statement[],
    expected: number,
  ): Promise<NotificationWriteResult> {
    const outcome = await runOrgFenced(
      executor,
      ctx,
      fence,
      assertGuard(sql<SqlBool>`(${held} and ${ready})`, ctx),
      mutations,
      { authority: probe(held), conflict: probe(ready) },
    );
    if (outcome.ok) return { changed: true, revision: expected + 1 };
    if (outcome.reason === 'authority') throw new NotificationRepositoryError('forbidden');
    if (outcome.reason !== 'conflict') throw new NotificationRepositoryError('unavailable');
    const [row] = await executor.all<{ revision: number }>(
      compile(current(ctx, projectId, endpointId, 'lookup')),
    );
    if (row === undefined) throw new NotificationRepositoryError('not_found');
    return { changed: false, revision: row.revision };
  }

  function revisionReady(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
    expected: number,
    states: readonly ('enabled' | 'disabled')[],
  ): Guard {
    return sql<SqlBool>`exists ${current(ctx, projectId, endpointId, 'ready')
      .where('ready.revision', '=', expected)
      .where('ready.state', 'in', states)}`;
  }

  async function transition(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<NotificationWriteRepository['enable']>[2],
    kind: 'enable' | 'disable' | 'delete',
  ): Promise<NotificationWriteResult> {
    const projectId = id(input.projectId);
    const endpointId = id(input.id);
    const expected = revision(input.expectedRevision);
    const now = instant(input.now);
    const event = audit(input.event, `notification.${kind}`, endpointId, projectId, fence.userId);
    const held = authority(ctx, fence, projectId, kind === 'delete');
    const from =
      kind === 'enable'
        ? ['disabled' as const]
        : kind === 'disable'
          ? ['enabled' as const]
          : ['enabled' as const, 'disabled' as const];
    const update = compile(
      db
        .updateTable('notification_endpoint')
        .set({
          state: kind === 'enable' ? 'enabled' : kind === 'disable' ? 'disabled' : 'deleted',
          disabled_reason: kind === 'enable' ? null : 'manual',
          ...(kind === 'enable' ? { failure_streak: 0 } : {}),
          revision: sql<number>`revision + 1`,
          updated_at: now,
          last_op_id: event.id,
        })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', projectId)
        .where('id', '=', endpointId)
        .where('revision', '=', expected)
        .where('state', 'in', from),
    );
    const mutations = [update, auditPendingStatement(ctx, event, AFTER_CHANGE)];
    if (kind === 'delete')
      mutations.push(
        compile(
          db
            .updateTable('notification_delivery')
            .set({ state: 'cancelled', outcome_code: 'deleted', finished_at: now })
            .where('org_id', '=', ctx.orgId)
            .where('project_id', '=', projectId)
            .where('endpoint_id', '=', endpointId)
            .where('state', '=', 'pending'),
        ),
      );
    return settle(
      ctx,
      fence,
      projectId,
      endpointId,
      held,
      revisionReady(ctx, projectId, endpointId, expected, from),
      mutations,
      expected,
    );
  }

  return {
    async create(ctx, fence, input) {
      const projectId = id(input.projectId);
      const endpointId = id(input.id);
      const now = instant(input.now);
      const values = { ...options(input.options), ...configuration(input.configuration) };
      const event = audit(input.event, 'notification.create', endpointId, projectId, fence.userId);
      const held = authority(ctx, fence, projectId, true);
      const room = sql<SqlBool>`(select count(*) from notification_endpoint as cap
        where cap.org_id = ${ctx.orgId} and cap.project_id = ${projectId} and cap.state <> 'deleted') < ${MAX_NOTIFICATION_ENDPOINTS}
        and not exists (select 1 from notification_endpoint as taken where taken.org_id = ${ctx.orgId} and taken.id = ${endpointId})`;
      const insert = compile(
        db.insertInto('notification_endpoint').values({
          org_id: ctx.orgId,
          project_id: projectId,
          id: endpointId,
          ...values,
          disabled_reason: null,
          last_op_id: event.id,
          created_at: now,
          updated_at: now,
        }),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(sql<SqlBool>`(${held} and ${room})`, ctx),
        [input.configuration.statement, insert, auditPendingStatement(ctx, event, AFTER_CHANGE)],
        { authority: probe(held), conflict: probe(room) },
      );
      if (outcome.ok) return { changed: true, revision: 1 };
      if (outcome.reason === 'authority') throw new NotificationRepositoryError('forbidden');
      if (outcome.reason !== 'conflict') throw new NotificationRepositoryError('unavailable');
      const [taken] = await executor.all(
        compile(
          db
            .selectFrom('notification_endpoint')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', endpointId),
        ),
      );
      throw new NotificationRepositoryError(taken === undefined ? 'endpoint_limit' : 'conflict');
    },

    async update(ctx, fence, input) {
      const projectId = id(input.projectId);
      const endpointId = id(input.id);
      const expected = revision(input.expectedRevision);
      const now = instant(input.now);
      if (input.options === undefined && input.configuration === undefined) invalid();
      const replaced = input.configuration === undefined ? {} : configuration(input.configuration);
      const event = audit(
        input.event,
        input.configuration === undefined ? 'notification.update' : 'notification.credential_set',
        endpointId,
        projectId,
        fence.userId,
      );
      const held = authority(ctx, fence, projectId, input.configuration !== undefined);
      const update = compile(
        db
          .updateTable('notification_endpoint')
          .set({
            ...(input.options === undefined ? {} : options(input.options)),
            ...replaced,
            ...(input.configuration === undefined
              ? {}
              : { state: 'disabled' as const, disabled_reason: 'configuration_changed' as const }),
            revision: sql<number>`revision + 1`,
            updated_at: now,
            last_op_id: event.id,
          })
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', projectId)
          .where('id', '=', endpointId)
          .where('revision', '=', expected)
          .where('state', '<>', 'deleted'),
      );
      return settle(
        ctx,
        fence,
        projectId,
        endpointId,
        held,
        revisionReady(ctx, projectId, endpointId, expected, ['enabled', 'disabled']),
        [
          ...(input.configuration === undefined ? [] : [input.configuration.statement]),
          update,
          auditPendingStatement(ctx, event, AFTER_CHANGE),
        ],
        expected,
      );
    },

    enable: (ctx, fence, input) => transition(ctx, fence, input, 'enable'),
    disable: (ctx, fence, input) => transition(ctx, fence, input, 'disable'),
    delete: (ctx, fence, input) => transition(ctx, fence, input, 'delete'),
  };
}
