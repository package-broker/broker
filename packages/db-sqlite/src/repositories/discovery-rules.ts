import { discoveryRuleAudit } from '@package-broker/core/runtime/discovery-rule-jobs';
import { ulid } from '@package-broker/core/ids';
import { sql, type SqlBool } from 'kysely';
import type { MutationFence, DiscoveryRuleFence } from '@package-broker/core/authz/fence';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import type {
  DiscoveryRule,
  DiscoveryRuleOptions,
  DiscoveryRuleRepository,
  DiscoveryRuleState,
  DiscoveryRuleWriteResult,
} from '@package-broker/core/db/discovery-rules';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { ApiCall } from '@package-broker/core/api/idempotency';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';
import { discoveryRuleAuthority } from './discovery-rule-authority.js';

function statement(query: ReturnType<typeof sql>): Statement {
  return compile({ compile: () => query.compile(db) });
}
const probe = (condition: Guard): Statement =>
  compile(db.selectNoFrom(sql<number>`(${condition}) is not 1`.as('held')));
function options(value: DiscoveryRuleOptions): void {
  if (
    !value.name.trim() ||
    value.name !== value.name.trim() ||
    value.name.length > 80 ||
    Array.from(value.name).some(
      (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
    ) ||
    !/^[A-Za-z0-9._*?-]{1,100}$/.test(value.pattern) ||
    !['composer', 'npm', 'both'].includes(value.ecosystem) ||
    !Number.isSafeInteger(value.installationId) ||
    value.installationId < 1 ||
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds < 3600 ||
    value.intervalSeconds > 2592000 ||
    typeof value.enabled !== 'boolean' ||
    typeof value.includeForks !== 'boolean'
  )
    throw new TypeError('invalid discovery rule');
}
function optionSet(value: DiscoveryRuleOptions) {
  options(value);
  return sql`name=${value.name}, credential_id=${value.credentialId}, installation_id=${value.installationId},
    ecosystem=${value.ecosystem}, repository_pattern=${value.pattern}, include_forks=${Number(value.includeForks)},
    enabled=${Number(value.enabled)}, rescan_interval_seconds=${value.intervalSeconds}`;
}
function decode(row: Record<string, unknown>): DiscoveryRule {
  return {
    id: row.id as string,
    name: row.name as string,
    credentialId: row.credential_id as string,
    installationId: row.installation_id as number,
    ecosystem: row.ecosystem as DiscoveryRule['ecosystem'],
    pattern: row.repository_pattern as string,
    includeForks: row.include_forks === 1,
    enabled: row.enabled === 1,
    intervalSeconds: row.rescan_interval_seconds as number,
    revision: row.revision as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastRunAt: row.last_run_at as string | null,
    outcome: row.last_run_outcome as DiscoveryRule['outcome'],
    created: row.created_count as number,
    existing: row.existing_count as number,
    skipped: row.skipped_count as number,
    failed: row.failed_count as number,
    skips: JSON.parse(row.skip_details_json as string) as DiscoveryRule['skips'],
    pendingResults: JSON.parse(row.pending_results_json as string),
    consecutiveFailures: row.consecutive_failures as number,
    failureReason: row.failure_reason as string | null,
    completed: row.completed_json === null ? null : JSON.parse(row.completed_json as string),
    cursor: row.plan_cursor as string | null,
    remaining: JSON.parse(row.remaining_repositories_json as string) as string[],
    nextRunAt: row.next_run_at as string | null,
  };
}
export function createDiscoveryRuleRepository(
  executor: SqlExecutor,
  anchors: readonly ProtectedHolderProvider[],
): DiscoveryRuleRepository {
  const read = async (query: Statement) =>
    (await executor.all<Record<string, unknown>>(query)).map(decode);
  function authority(ctx: OrgContext, fence: MutationFence, fresh = false): Guard {
    return actorHolds(ctx, fence, {
      permission: 'org:sources:write',
      projectId: null,
      providerAnchors: anchors,
      ...(fresh
        ? {
            sessionCondition: (
              alias: string,
            ) => sql<SqlBool>`${sql.ref(`${alias}.reauth_at`)} is not null
        and ${sql.ref(`${alias}.reauth_at`)} >= strftime('%Y-%m-%dT%H:%M:%fZ','now',${`-${REAUTH_WINDOW_MS / 1000} seconds`})
        and ${sql.ref(`${alias}.reauth_at`)} <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          }
        : {}),
    });
  }
  function credential(ctx: OrgContext, value: DiscoveryRuleOptions): Guard {
    return sql<SqlBool>`exists(select 1 from credential where org_id=${ctx.orgId} and id=${value.credentialId} and kind='github_app' and project_id is null)`;
  }
  function current(ctx: OrgContext, id: string, revision: number): Guard {
    return sql<SqlBool>`exists(select 1 from source_discovery_rule where org_id=${ctx.orgId} and id=${id} and revision=${revision})`;
  }
  async function write(
    ctx: OrgContext,
    fence: MutationFence,
    allowed: Guard,
    condition: Guard,
    mutations: Statement[],
    audit: AuditEvent,
    call: ApiCall,
    duplicate?: Guard,
  ): Promise<DiscoveryRuleWriteResult> {
    const result = await runOrgFenced(
      executor,
      ctx,
      fence,
      assertGuard(allowed, ctx),
      [
        ...assertCheck(condition),
        ...mutations,
        auditPendingStatement(ctx, audit),
        ...(call.idempotency === undefined
          ? []
          : [idempotencyInsertStatement(ctx, call.idempotency)]),
      ],
      { authority: probe(allowed), conflict: probe(condition) },
    );
    if (
      !result.ok &&
      result.reason !== 'conflict' &&
      result.reason !== 'authority' &&
      result.reason !== 'indeterminate' &&
      duplicate !== undefined
    ) {
      const [row] = await executor.all<{ held: number }>(probe(duplicate));
      if (row?.held === 0) return 'duplicate';
    }
    return result.ok
      ? 'ok'
      : result.reason === 'authority'
        ? 'forbidden'
        : result.reason === 'indeterminate'
          ? 'indeterminate'
          : 'conflict';
  }
  return {
    list: (ctx, after, limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('invalid discovery limit');
      return read(
        statement(
          sql`select * from source_discovery_rule where org_id=${ctx.orgId} and (${after} is null or id > ${after}) order by id limit ${limit}`,
        ),
      );
    },
    async get(ctx, id) {
      return (
        (
          await read(
            statement(
              sql`select * from source_discovery_rule where org_id=${ctx.orgId} and id=${id}`,
            ),
          )
        )[0] ?? null
      );
    },
    async due(ctx, now) {
      const invalid = await executor.all<{ id: string }>(
        statement(sql`select id from source_discovery_rule
        where org_id=${ctx.orgId} and enabled=1
        and not (last_run_outcome is 'failed' and failure_reason is 'credential_unavailable')
        and not exists(select 1 from credential c where c.org_id=${ctx.orgId}
          and c.id=source_discovery_rule.credential_id and c.kind='github_app' and c.project_id is null) limit 10`),
      );
      for (const row of invalid) {
        const event = discoveryRuleAudit(
          { ids: { ulid }, clock: { now: () => new Date(now) } },
          row.id,
          'discovery_rule.run_finished',
        );
        await executor.batch([
          statement(sql`update source_discovery_rule set last_run_outcome='failed',failure_reason='credential_unavailable'
            where org_id=${ctx.orgId} and id=${row.id}
            and not (last_run_outcome is 'failed' and failure_reason is 'credential_unavailable')
            and not exists(select 1 from credential c where c.org_id=${ctx.orgId} and c.id=source_discovery_rule.credential_id and c.kind='github_app' and c.project_id is null)`),
          auditPendingStatement(ctx, event, { sql: 'changes() > 0', params: [] }),
        ]);
      }
      return read(
        statement(sql`select * from source_discovery_rule dr where dr.org_id=${ctx.orgId} and dr.enabled=1
        and (dr.next_run_at is null or dr.next_run_at <= ${now})
        and exists(select 1 from credential c where c.org_id=${ctx.orgId} and c.id=dr.credential_id and c.kind='github_app' and c.project_id is null)
        and not exists(select 1 from job j where j.org_id=${ctx.orgId} and j.resource_key='discovery-rule:' || dr.id and j.state='queued')
        and not exists(select 1 from job j where j.org_id=${ctx.orgId} and j.resource_key='discovery-rule:' || dr.id and j.state='running')
        order by dr.next_run_at, dr.id limit 10`),
      );
    },
    async create(ctx, fence, input) {
      const [access] = await executor.all<{ held: number }>(probe(authority(ctx, fence, true)));
      if (access?.held === 1) return 'forbidden';
      const [binding] = await executor.all<{ held: number }>(probe(credential(ctx, input.options)));
      if (binding?.held === 1) return 'not_found';
      const v = input.options;
      options(v);
      return write(
        ctx,
        fence,
        authority(ctx, fence, true),
        credential(ctx, v),
        [
          statement(sql`insert into source_discovery_rule
        (org_id,id,name,credential_id,installation_id,ecosystem,repository_pattern,include_forks,enabled,rescan_interval_seconds,created_at,updated_at)
        values (${ctx.orgId},${input.id},${v.name},${v.credentialId},${v.installationId},${v.ecosystem},${v.pattern},${Number(v.includeForks)},${Number(v.enabled)},${v.intervalSeconds},${input.now},${input.now})`),
        ],
        input.audit,
        input.call,
        sql<SqlBool>`exists(select 1 from source_discovery_rule where org_id=${ctx.orgId} and name=${v.name})`,
      );
    },
    async update(ctx, fence, input) {
      const [access] = await executor.all<{ held: number }>(probe(authority(ctx, fence)));
      if (access?.held === 1) return 'forbidden';
      const [binding] = await executor.all<{ held: number }>(probe(credential(ctx, input.options)));
      if (binding?.held === 1) return 'not_found';
      const v = input.options;
      const sameScan = sql<SqlBool>`(credential_id=${v.credentialId} and installation_id=${v.installationId} and repository_pattern=${v.pattern} and ecosystem=${v.ecosystem} and include_forks=${Number(v.includeForks)})`;
      const result = await write(
        ctx,
        fence,
        sql<SqlBool>`(${authority(ctx, fence)} and (exists(select 1 from source_discovery_rule where org_id=${ctx.orgId} and id=${input.id} and credential_id=${input.options.credentialId} and installation_id=${input.options.installationId}) or ${authority(ctx, fence, true)}))`,
        sql<SqlBool>`(${current(ctx, input.id, input.revision)} and ${credential(ctx, input.options)})`,
        [
          statement(sql`update source_discovery_rule set ${optionSet(input.options)}, revision=revision+1, updated_at=${input.now},
          next_run_at=case when ${sameScan} then next_run_at else null end,
          last_run_at=case when ${sameScan} then last_run_at else null end,
          last_run_outcome=case when not ${Number(v.enabled)} and last_run_outcome in ('running','rate_limited') then 'failed' when ${sameScan} then last_run_outcome else null end,
          failure_reason=case when not ${Number(v.enabled)} and last_run_outcome in ('running','rate_limited') then 'disabled' when ${sameScan} then failure_reason else null end,
          created_count=case when ${sameScan} then created_count else 0 end,
          existing_count=case when ${sameScan} then existing_count else 0 end,
          skipped_count=case when ${sameScan} then skipped_count else 0 end,
          failed_count=case when ${sameScan} then failed_count else 0 end,
          consecutive_failures=case when ${sameScan} then consecutive_failures else 0 end,
          skip_details_json=case when ${sameScan} then skip_details_json else '[]' end,
          pending_results_json=case when ${sameScan} then pending_results_json else '[]' end,
          plan_cursor=case when ${sameScan} then plan_cursor else null end,
          remaining_repositories_json=case when ${sameScan} then remaining_repositories_json else '[]' end
          where org_id=${ctx.orgId} and id=${input.id} and revision=${input.revision}`),
        ],
        input.audit,
        input.call,
        sql<SqlBool>`exists(select 1 from source_discovery_rule where org_id=${ctx.orgId} and name=${v.name} and id<>${input.id})`,
      );
      if (result === 'conflict') {
        const [binding] = await executor.all<{ held: number }>(
          probe(credential(ctx, input.options)),
        );
        if (binding?.held === 1) return 'not_found';
      }
      return result;
    },
    delete(ctx, fence, input) {
      return write(
        ctx,
        fence,
        authority(ctx, fence),
        current(ctx, input.id, input.revision),
        [
          statement(
            sql`delete from source_discovery_rule where org_id=${ctx.orgId} and id=${input.id} and revision=${input.revision}`,
          ),
        ],
        input.audit,
        input.call,
      );
    },
    async runNow(ctx, fence, input) {
      const [access] = await executor.all<{ held: number }>(probe(authority(ctx, fence)));
      if (access?.held === 1) return 'forbidden';
      if (
        (
          await read(
            statement(
              sql`select * from source_discovery_rule where org_id=${ctx.orgId} and id=${input.id}`,
            ),
          )
        ).length === 0
      )
        return 'not_found';
      const rule = await this.get(ctx, input.id);
      if (rule !== null && !rule.enabled) return 'discovery_rule_disabled';
      return write(
        ctx,
        fence,
        authority(ctx, fence),
        sql<SqlBool>`exists(select 1 from source_discovery_rule where org_id=${ctx.orgId} and id=${input.id} and enabled=1)`,
        [
          statement(
            sql`update source_discovery_rule set next_run_at=case when last_run_outcome in ('running','rate_limited') and next_run_at>${input.now} then next_run_at else ${input.now} end where org_id=${ctx.orgId} and id=${input.id} and enabled=1`,
          ),
        ],
        input.audit,
        input.call,
      );
    },
    async checkpoint(ctx: OrgContext, fence: DiscoveryRuleFence, state: DiscoveryRuleState, audit) {
      const allowed = discoveryRuleAuthority(ctx, fence);
      const completed =
        state.outcome === 'succeeded' || state.outcome === 'failed'
          ? JSON.stringify({
              lastRunAt: state.lastRunAt,
              outcome: state.outcome,
              created: state.created,
              existing: state.existing,
              skipped: state.skipped,
              failed: state.failed,
              skips: state.skips,
              failureReason: state.failureReason ?? null,
            })
          : null;
      const answer = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          statement(sql`update source_discovery_rule set last_run_at=${state.lastRunAt},last_run_outcome=${state.outcome},
          created_count=${state.created},existing_count=${state.existing},skipped_count=${state.skipped},failed_count=${state.failed},
          pending_results_json=${JSON.stringify(state.pendingResults ?? [])},
          consecutive_failures=${state.consecutiveFailures ?? 0},failure_reason=${state.failureReason ?? null},completed_json=coalesce(${completed},completed_json),
          skip_details_json=${JSON.stringify(state.skips)},plan_cursor=${state.cursor},remaining_repositories_json=${JSON.stringify(state.remaining)},next_run_at=${state.nextRunAt}
          where org_id=${ctx.orgId} and id=${fence.ruleId} and revision=${fence.revision}`),
          ...(audit === undefined
            ? []
            : (Array.isArray(audit) ? audit : [audit as AuditEvent]).map((event) =>
                auditPendingStatement(ctx, event),
              )),
        ],
        { authority: probe(allowed) },
      );
      return answer.ok;
    },
  };
}
