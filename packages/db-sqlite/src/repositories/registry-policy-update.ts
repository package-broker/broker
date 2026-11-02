import { sql, type SqlBool } from 'kysely';
import { fenceKind, type MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  POLICY_OVERRIDE_REASONS,
  RegistryPolicyInputError,
  comparePolicyClientVersions,
  isPolicyRuleId,
  isPolicyTimestamp,
  validatePolicyRulePatch,
  type PolicyAuditEnvelope,
  type PolicyOverrideReason,
  type PolicyRuleKind,
  type PolicyRulePatch,
  type PolicyRuleScope,
  type PolicyWriteOutcome,
  type RegistryPolicyUpdater,
} from '@package-broker/core/db/registry-policy';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { AnyMutationFence } from '@package-broker/core/authz/fence';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';
import {
  policyAuditEvent,
  refused,
  type PolicyAuditAction,
  type PolicyAuditChanges,
} from './registry-policy-audit.js';
import { policyAuthorityGuard } from './registry-policy-authority.js';

interface CurrentRule {
  readonly project_id: string | null;
  readonly kind: PolicyRuleKind;
  readonly min_age_seconds: number | null;
  readonly client_min_version: string | null;
  readonly deny_unknown: number;
  readonly reason_code: string;
  readonly incident_id: string | null;
  readonly expires_at: string | null;
  readonly disabled_at: string | null;
  readonly revision: number;
}

const COLUMNS = {
  minAgeSeconds: 'min_age_seconds',
  clientMinVersion: 'client_min_version',
  denyUnknown: 'deny_unknown',
  reasonCode: 'reason_code',
  incidentId: 'incident_id',
  expiresAt: 'expires_at',
} as const;

const failed = (guard: Guard) =>
  compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));

/** True when the patch lets more versions or clients through than the stored rule did. */
function weakens(rule: CurrentRule, patch: PolicyRulePatch): boolean {
  if (patch.minAgeSeconds !== undefined && patch.minAgeSeconds < (rule.min_age_seconds ?? 0)) {
    return true;
  }
  if (
    patch.clientMinVersion !== undefined &&
    rule.client_min_version !== null &&
    comparePolicyClientVersions(patch.clientMinVersion, rule.client_min_version) < 0
  ) {
    return true;
  }
  if (patch.denyUnknown === false && rule.deny_unknown === 1) return true;
  if (patch.expiresAt !== undefined && patch.expiresAt !== null) {
    return rule.expires_at === null || patch.expiresAt < rule.expires_at;
  }
  return false;
}

/** The rule left the revision a refused batch expected: it changed, was disabled or is gone. */
function movedSince(ctx: OrgContext, id: string, revision: number): Guard {
  return sql<SqlBool>`not exists ${db
    .selectFrom('registry_policy_rule')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .where('revision', '=', revision)
    .where('disabled_at', 'is', null)}`;
}

function scopeOf(rule: CurrentRule): PolicyRuleScope {
  return rule.project_id === null
    ? { kind: 'organization' }
    : { kind: 'project', projectId: rule.project_id };
}

function expected(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RegistryPolicyInputError('expectedRevision');
  }
  return value;
}

function stored(field: keyof typeof COLUMNS, rule: CurrentRule) {
  const value = rule[COLUMNS[field]];
  return field === 'denyUnknown' ? value === 1 : value;
}

export function createRegistryPolicyUpdater(
  executor: SqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[],
): RegistryPolicyUpdater {
  async function current(ctx: OrgContext, id: string): Promise<CurrentRule | undefined> {
    const [row] = await executor.all<CurrentRule>(
      compile(
        db
          .selectFrom('registry_policy_rule as r')
          .select([
            'r.project_id',
            'r.kind',
            'r.min_age_seconds',
            'r.client_min_version',
            'r.deny_unknown',
            'r.reason_code',
            'r.incident_id',
            'r.expires_at',
            'r.disabled_at',
            'r.revision',
          ])
          .where('r.org_id', '=', ctx.orgId)
          .where('r.id', '=', id),
      ),
    );
    return row;
  }

  async function write(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly id: string;
      readonly revision: number;
      readonly rule: CurrentRule;
      readonly weakening: boolean;
      readonly set: Record<string, unknown>;
      readonly action: PolicyAuditAction;
      readonly fields: PolicyAuditChanges;
      readonly audit: PolicyAuditEnvelope;
      readonly idempotency: IdempotencyRecord | undefined;
    },
  ): Promise<PolicyWriteOutcome> {
    const scope = scopeOf(input.rule);
    const authority = (fresh: boolean) =>
      policyAuthorityGuard(ctx, fence, { scope, kind: input.rule.kind, fresh, providerAnchors });
    const held = authority(input.weakening);
    const event = policyAuditEvent(
      input.audit,
      fence.userId,
      input.action,
      input.id,
      input.rule.project_id,
      { ...input.fields, revision: { old: input.revision, new: input.revision + 1 } },
    );
    const update: Statement = compile(
      db
        .updateTable('registry_policy_rule')
        .set({ ...input.set, revision: sql<number>`revision + 1` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .where('revision', '=', input.revision)
        .where('disabled_at', 'is', null),
    );
    const outcome = await runOrgFenced(
      executor,
      ctx,
      fence,
      assertGuard(held, ctx),
      [
        update,
        ...assertCheck(sql<SqlBool>`changes() = 1`),
        auditPendingStatement(ctx, event),
        ...(input.idempotency === undefined
          ? []
          : [idempotencyInsertStatement(ctx, input.idempotency)]),
      ],
      { authority: failed(held) },
    );
    if (outcome.ok) return { ok: true, revision: input.revision + 1 };
    if (outcome.reason === 'indeterminate') return refused('indeterminate');
    const [state] = await executor.all<{ live: number; replayed: number; moved: number }>(
      compile(
        db.selectNoFrom([
          sql<number>`${authority(false)}`.as('live'),
          sql<number>`${liveIdempotencyCollision(ctx, input.idempotency)}`.as('replayed'),
          sql<number>`${movedSince(ctx, input.id, input.revision)}`.as('moved'),
        ]),
      ),
    );
    if (outcome.reason === 'authority') {
      return refused(input.weakening && state?.live === 1 ? 'reauth_required' : 'forbidden');
    }
    if (state?.replayed === 1) return refused('replayed');
    return refused(state?.moved === 1 ? 'conflict' : 'indeterminate');
  }

  async function prepared(
    ctx: OrgContext,
    fence: AnyMutationFence,
    id: unknown,
    revision: unknown,
    now: unknown,
  ): Promise<
    | { readonly ok: true; readonly fence: MutationFence; readonly rule: CurrentRule }
    | PolicyWriteOutcome
  > {
    if (!isPolicyRuleId(id)) throw new RegistryPolicyInputError('id');
    const expectedRevision = expected(revision);
    if (!isPolicyTimestamp(now)) throw new RegistryPolicyInputError('now');
    if (fenceKind(fence) !== 'session' || !('sessionId' in fence)) return refused('forbidden');
    const rule = await current(ctx, id);
    if (rule === undefined) return refused('not_found');
    if (rule.disabled_at !== null || rule.revision !== expectedRevision) return refused('conflict');
    return { ok: true, fence, rule };
  }

  return {
    async update(ctx, fence, input) {
      if (
        input.overrideReason !== undefined &&
        !(POLICY_OVERRIDE_REASONS as readonly string[]).includes(input.overrideReason)
      ) {
        throw new RegistryPolicyInputError('overrideReason');
      }
      const ready = await prepared(ctx, fence, input.id, input.expectedRevision, input.now);
      if (!('fence' in ready)) return ready;
      const patch = validatePolicyRulePatch(ready.rule.kind, input.patch, input.now);
      const set: Record<string, unknown> = { updated_at: input.now };
      const fields: PolicyAuditChanges = {};
      const changed: string[] = [];
      for (const field of Object.keys(patch) as (keyof typeof COLUMNS)[]) {
        const value = patch[field];
        if (stored(field, ready.rule) === value) continue;
        set[COLUMNS[field]] = field === 'denyUnknown' ? (value ? 1 : 0) : value;
        fields[COLUMNS[field]] = {
          old: stored(field, ready.rule) as never,
          new: value as never,
        };
        changed.push(COLUMNS[field]);
      }
      if (changed.length === 0) {
        policyAuditEvent(
          input.audit,
          ready.fence.userId,
          'registry_policy.update',
          input.id,
          ready.rule.project_id,
          {},
        );
        const [state] = await executor.all<{ live: number }>(
          compile(
            db.selectNoFrom(
              sql<number>`${policyAuthorityGuard(ctx, ready.fence, {
                scope: scopeOf(ready.rule),
                kind: ready.rule.kind,
                fresh: false,
                providerAnchors,
              })}`.as('live'),
            ),
          ),
        );
        return state?.live === 1
          ? { ok: true, revision: input.expectedRevision, unchanged: true }
          : refused('forbidden');
      }
      if ('expires_at' in set) set['expiry_audited_at'] = null;
      return write(ctx, ready.fence, {
        id: input.id,
        revision: input.expectedRevision,
        rule: ready.rule,
        weakening: weakens(ready.rule, patch),
        set,
        action: 'registry_policy.update',
        fields: {
          ...fields,
          changed_fields: { new: changed },
          ...(input.overrideReason === undefined
            ? {}
            : { override_reason: { new: input.overrideReason } }),
        },
        audit: input.audit,
        idempotency: input.idempotency,
      });
    },

    async disable(ctx, fence, input) {
      const reason: PolicyOverrideReason = input.reason;
      if (!(POLICY_OVERRIDE_REASONS as readonly string[]).includes(reason)) {
        throw new RegistryPolicyInputError('overrideReason');
      }
      const ready = await prepared(ctx, fence, input.id, input.expectedRevision, input.now);
      if (!('fence' in ready)) return ready;
      return write(ctx, ready.fence, {
        id: input.id,
        revision: input.expectedRevision,
        rule: ready.rule,
        weakening: true,
        set: { updated_at: input.now, disabled_at: input.now, disabled_reason: reason },
        action:
          ready.rule.kind === 'quarantine' ? 'registry_policy.release' : 'registry_policy.disable',
        fields: {
          kind: { new: ready.rule.kind },
          changed_fields: { new: ['disabled'] },
          override_reason: { new: reason },
        },
        audit: input.audit,
        idempotency: input.idempotency,
      });
    },
  };
}
