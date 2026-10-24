import { expressionBuilder, sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { LoginPlan, LoginWriter } from '@package-broker/core/db/users';
import {
  anchorMatches,
  compile,
  db,
  existsGuard,
  ownsIdentity,
  type Database,
  type Guard,
} from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { revokePreviousStatement, sessionInsertStatement } from './session.js';
import {
  notifyProjectAccessLost,
  selectedPatInvalidationStatement,
  type AccessLossOptions,
} from './access-loss.js';

const MAX_GROUPS = 1000;
const MAX_GROUP_NAME = 256;
const MAX_DISPLAY_NAME = 200;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const eb = expressionBuilder<Database>();

function timestamp(field: string, value: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function secretHash(field: string, value: string): string {
  if (typeof value !== 'string' || !SECRET_HASH.test(value)) {
    throw new TypeError(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function distinctGroups(groups: readonly string[]): string[] {
  const distinct = new Set<string>();
  for (const name of groups) {
    if (typeof name !== 'string' || LONE_SURROGATE.test(name)) {
      throw new TypeError('group names must be well-formed strings');
    }
    const length = Array.from(name).length;
    if (length < 1 || length > MAX_GROUP_NAME) {
      throw new RangeError(`a group name must have 1 to ${String(MAX_GROUP_NAME)} characters`);
    }
    distinct.add(name);
  }
  if (distinct.size > MAX_GROUPS) {
    throw new RangeError(`at most ${String(MAX_GROUPS)} distinct groups are allowed`);
  }
  return [...distinct];
}

function normalizedEmail(email: string): string {
  if (typeof email !== 'string' || email === '' || email !== email.toLowerCase()) {
    throw new TypeError('email must be a non-empty lower-case string');
  }
  return email;
}

function cappedDisplayName(displayName: string | null): string | null {
  if (displayName === null) return null;
  if (typeof displayName !== 'string') {
    throw new TypeError('displayName must be a string or null');
  }
  const points = Array.from(displayName);
  return points.length <= MAX_DISPLAY_NAME
    ? displayName
    : points.slice(0, MAX_DISPLAY_NAME).join('');
}

function invitationGuard(ctx: OrgContext, plan: LoginPlan, groups: readonly string[]): Guard {
  const json = JSON.stringify(groups);
  return existsGuard((database) =>
    database
      .selectFrom('access_grant as email_grant')
      .leftJoin('project as email_project', (join) =>
        join
          .onRef('email_project.id', '=', 'email_grant.project_id')
          .on('email_project.org_id', '=', ctx.orgId),
      )
      .select(sql.lit(1).as('one'))
      .where('email_grant.org_id', '=', ctx.orgId)
      .where('email_grant.subject_type', '=', 'email')
      .where('email_grant.subject_provider', 'is', null)
      .where(
        sql<string>`coalesce(email_project.status, iif(email_grant.project_id is null, 'active', 'unavailable'))`,
        '=',
        'active',
      )
      .where('email_grant.subject_value', '=', plan.email)
      .unionAll(
        database
          .selectFrom('access_grant as group_grant')
          .leftJoin('project as group_project', (join) =>
            join
              .onRef('group_project.id', '=', 'group_grant.project_id')
              .on('group_project.org_id', '=', ctx.orgId),
          )
          .select(sql.lit(1).as('one'))
          .where(
            sql<string>`coalesce(group_project.status, iif(group_grant.project_id is null, 'active', 'unavailable'))`,
            '=',
            'active',
          )
          .where('group_grant.org_id', '=', ctx.orgId)
          .where('group_grant.subject_type', '=', 'group')
          .where('group_grant.subject_provider', '=', plan.provider)
          .where(
            'group_grant.subject_value',
            'in',
            sql<string>`(select value from json_each(${json}))`,
          ),
      ),
  );
}

function bindingStatement(ctx: OrgContext, plan: LoginPlan): ScalarStatement {
  return compile(
    db
      .insertInto('identity_provider_binding')
      .columns(['org_id', 'provider', 'anchor'])
      .expression(
        db
          .selectNoFrom((values) => [
            values.val(ctx.orgId).as('org_id'),
            values.val(plan.provider).as('provider'),
            values.val(plan.trustAnchor).as('anchor'),
          ])
          .where(eb.not(blockedGuard(ctx, plan))),
      )
      .onConflict((conflict) => conflict.doNothing()),
  ) as ScalarStatement;
}

/**
 * `ON CONFLICT (org_id, email)` does not cover the primary key: a colliding `plan.userId` fails the
 * whole batch instead of being skipped.
 */
function createUserStatement(
  ctx: OrgContext,
  plan: LoginPlan,
  guards: readonly Guard[],
  now: string,
  displayName: string | null,
): ScalarStatement {
  let select = db
    .selectNoFrom((values) => [
      values.val(plan.userId).as('id'),
      values.val(ctx.orgId).as('org_id'),
      values.val(plan.email).as('email'),
      values.val(displayName).as('display_name'),
      values.val('active').as('status'),
      values.val(now).as('created_at'),
      values.val(now).as('updated_at'),
    ])
    .where(eb.not(foreignIdentityGuard(ctx, plan)));
  for (const guard of guards) select = select.where(guard);
  return compile(
    db
      .insertInto('user_account')
      .columns(['id', 'org_id', 'email', 'display_name', 'status', 'created_at', 'updated_at'])
      .expression(select)
      .onConflict((conflict) => conflict.columns(['org_id', 'email']).doNothing()),
  ) as ScalarStatement;
}

function foreignIdentityGuard(ctx: OrgContext, plan: LoginPlan): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity')
      .select(sql.lit(1).as('one'))
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.provider', '=', plan.provider)
      .where('identity.subject', '=', plan.subject)
      .where('identity.user_id', '<>', plan.userId),
  );
}

function blockedGuard(ctx: OrgContext, plan: LoginPlan): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity_block')
      .select(sql.lit(1).as('one'))
      .where('identity_block.org_id', '=', ctx.orgId)
      .where('identity_block.provider', '=', plan.provider)
      .where('identity_block.issuer', '=', plan.trustAnchor)
      .where('identity_block.subject', '=', plan.subject),
  );
}

function newerEvidenceGuard(ctx: OrgContext, plan: LoginPlan, evidenceTime: string): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity')
      .select(sql.lit(1).as('one'))
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.provider', '=', plan.provider)
      .where('identity.subject', '=', plan.subject)
      .where('identity.validated_at', '>', evidenceTime),
  );
}

function plannedIdentityGuard(ctx: OrgContext, plan: LoginPlan): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity')
      .select(sql.lit(1).as('one'))
      .where('identity.id', '=', plan.identityId)
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.provider', '=', plan.provider)
      .where('identity.subject', '=', plan.subject)
      .where('identity.user_id', '=', plan.userId),
  );
}

function otherSubjectGuard(ctx: OrgContext, plan: LoginPlan): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity')
      .select(sql.lit(1).as('one'))
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.user_id', '=', plan.userId)
      .where('identity.provider', '=', plan.provider)
      .where('identity.subject', '<>', plan.subject),
  );
}

function currentUserGuard(ctx: OrgContext, plan: LoginPlan): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('user_account')
      .select(sql.lit(1).as('one'))
      .where('user_account.id', '=', plan.userId)
      .where('user_account.org_id', '=', ctx.orgId)
      .where('user_account.status', '=', 'active')
      .where('user_account.email', '=', plan.email),
  );
}

function identityStatement(
  ctx: OrgContext,
  plan: LoginPlan,
  guards: readonly Guard[],
  now: string,
  evidenceTime: string,
): ScalarStatement {
  let select = db
    .selectFrom('user_account')
    .select((values) => [
      values.val(plan.identityId).as('id'),
      values.val(ctx.orgId).as('org_id'),
      'user_account.id as user_id',
      values.val(plan.provider).as('provider'),
      values.val(plan.subject).as('subject'),
      values.val(plan.email).as('email'),
      values.val(plan.emailVerified ? 1 : 0).as('email_verified'),
      values.val(evidenceTime).as('validated_at'),
      values.val(now).as('created_at'),
      values.val(now).as('updated_at'),
    ])
    .where('user_account.id', '=', plan.userId)
    .where('user_account.org_id', '=', ctx.orgId)
    .where('user_account.status', '=', 'active')
    .where('user_account.email', '=', plan.email);
  for (const guard of guards) select = select.where(guard);
  return compile(
    db
      .insertInto('identity')
      .columns([
        'id',
        'org_id',
        'user_id',
        'provider',
        'subject',
        'email',
        'email_verified',
        'validated_at',
        'created_at',
        'updated_at',
      ])
      .expression(select)
      .onConflict((conflict) =>
        conflict
          .columns(['org_id', 'provider', 'subject'])
          .doUpdateSet((values) => ({
            email: values.ref('excluded.email'),
            email_verified: values.ref('excluded.email_verified'),
            validated_at: values.ref('excluded.validated_at'),
            updated_at: values.ref('excluded.updated_at'),
          }))
          .whereRef('identity.user_id', '=', 'excluded.user_id')
          .whereRef('identity.id', '=', 'excluded.id')
          .where((values) =>
            values.or([
              values('identity.validated_at', 'is', null),
              values('identity.validated_at', '<=', evidenceTime),
            ]),
          ),
      ),
  ) as ScalarStatement;
}

function deleteGroupsStatement(
  ctx: OrgContext,
  plan: LoginPlan,
  guards: readonly Guard[],
): ScalarStatement {
  let query = db
    .deleteFrom('user_group')
    .where('user_group.org_id', '=', ctx.orgId)
    .where('user_group.user_id', '=', plan.userId)
    .where('user_group.provider', '=', plan.provider)
    .where(
      'user_group.group_name',
      'not in',
      sql<string>`(select value from json_each(${JSON.stringify(plan.groups)}))`,
    )
    .returning('user_id');
  for (const guard of guards) query = query.where(guard);
  return compile(query) as ScalarStatement;
}

function insertGroupsStatement(
  ctx: OrgContext,
  plan: LoginPlan,
  groups: readonly string[],
  guards: readonly Guard[],
  evidenceTime: string,
): ScalarStatement {
  let select = db
    .selectFrom('user_account')
    .crossJoin(sql<{ value: string }>`json_each(${JSON.stringify(groups)})`.as('member'))
    .select((values) => [
      values.val(ctx.orgId).as('org_id'),
      'user_account.id as user_id',
      values.val(plan.provider).as('provider'),
      'member.value as group_name',
      values.val(evidenceTime).as('refreshed_at'),
    ])
    .where('user_account.id', '=', plan.userId)
    .where('user_account.org_id', '=', ctx.orgId)
    .where('user_account.status', '=', 'active');
  for (const guard of guards) select = select.where(guard);
  return compile(
    db
      .insertInto('user_group')
      .columns(['org_id', 'user_id', 'provider', 'group_name', 'refreshed_at'])
      .expression(select)
      .onConflict((conflict) =>
        conflict
          .columns(['user_id', 'provider', 'group_name'])
          .doUpdateSet({ refreshed_at: evidenceTime })
          .where('user_group.org_id', '=', ctx.orgId),
      ),
  ) as ScalarStatement;
}

function createdSessionGuard(ctx: OrgContext, plan: LoginPlan, now: string): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('session as created')
      .select('created.id')
      .where('created.id', '=', plan.session.id)
      .where('created.org_id', '=', ctx.orgId)
      .where('created.secret_hash', '=', plan.session.secretHash)
      .where('created.created_at', '=', now),
  );
}

function touchUserStatement(
  ctx: OrgContext,
  plan: LoginPlan,
  guards: readonly Guard[],
  now: string,
  displayName: string | null,
): ScalarStatement {
  let query = db
    .updateTable('user_account')
    .set((values) => ({
      last_login_at: now,
      display_name: values.fn.coalesce(
        values.val(displayName),
        values.ref('user_account.display_name'),
      ),
      updated_at: now,
    }))
    .where('user_account.id', '=', plan.userId)
    .where('user_account.org_id', '=', ctx.orgId)
    .where('user_account.status', '=', 'active');
  for (const guard of guards) query = query.where(guard);
  return compile(query) as ScalarStatement;
}

export function createLoginWriter(
  executor: ScalarSqlExecutor,
  options: AccessLossOptions = {},
): LoginWriter {
  return {
    async commit(ctx: OrgContext, plan: LoginPlan): Promise<'created' | 'refused'> {
      const now = timestamp('now', plan.now);
      const evidenceTime = timestamp('evidenceTime', plan.evidenceTime);
      normalizedEmail(plan.email);
      const displayName = cappedDisplayName(plan.displayName);
      const groups = distinctGroups(plan.groups);
      if (plan.session.userId !== plan.userId) {
        throw new TypeError('the session must belong to the user of the plan');
      }
      if (plan.session.identityId !== plan.identityId) {
        throw new TypeError('the session must belong to the identity of the plan');
      }
      if (plan.session.now !== plan.now) {
        throw new TypeError('the session and the plan must share one login time');
      }
      const previousSecretHash =
        plan.previousSecretHash === null
          ? null
          : secretHash('previousSecretHash', plan.previousSecretHash);

      const anchorOk = anchorMatches(ctx, plan.provider, plan.trustAnchor);
      const owns = ownsIdentity(ctx, {
        provider: plan.provider,
        subject: plan.subject,
        userId: plan.userId,
      });
      const unblocked = eb.not(blockedGuard(ctx, plan));
      const guards = [
        owns,
        anchorOk,
        unblocked,
        plannedIdentityGuard(ctx, plan),
        currentUserGuard(ctx, plan),
      ];
      const identityGuards = [anchorOk, unblocked];
      if (!plan.createUser) {
        const singleSubject = eb.not(otherSubjectGuard(ctx, plan));
        guards.push(singleSubject);
        identityGuards.push(singleSubject);
      }
      const groupGuards = [...guards, eb.not(newerEvidenceGuard(ctx, plan, evidenceTime))];

      const statements: ScalarStatement[] = [bindingStatement(ctx, plan)];
      if (plan.createUser) {
        const creationGuards = [anchorOk, unblocked];
        if (plan.autoJoin !== true) creationGuards.push(invitationGuard(ctx, plan, groups));
        statements.push(createUserStatement(ctx, plan, creationGuards, now, displayName));
      }
      statements.push(identityStatement(ctx, plan, identityGuards, now, evidenceTime));
      let eligibility = db.selectNoFrom(sql<number>`1`.as('allowed'));
      for (const guard of groupGuards) eligibility = eligibility.where(guard);
      statements.push(
        selectedPatInvalidationStatement(ctx, {
          userId: plan.userId,
          at: now,
          opId: plan.session.id,
          membership: { provider: plan.provider, groups },
          when: compile(eligibility) as ScalarStatement,
        }),
      );
      const groupsIndex = statements.length;
      statements.push(deleteGroupsStatement(ctx, plan, groupGuards));
      if (groups.length > 0) {
        statements.push(insertGroupsStatement(ctx, plan, groups, groupGuards, evidenceTime));
      }
      const sessionIndex = statements.length;
      statements.push(sessionInsertStatement(ctx, plan.session, guards) as ScalarStatement);
      const auditGuard = compile(
        db.selectNoFrom(eb.and([createdSessionGuard(ctx, plan, now)]).as('allowed')),
      );
      statements.push(
        auditPendingStatement(ctx, plan.audit, {
          sql: `(${auditGuard.sql}) = 1`,
          params: auditGuard.params,
        }) as ScalarStatement,
      );
      if (previousSecretHash !== null) {
        statements.push(
          revokePreviousStatement(ctx, previousSecretHash, plan.session.id, now, [
            ...guards,
            createdSessionGuard(ctx, plan, now),
          ]),
        );
      }
      statements.push(touchUserStatement(ctx, plan, guards, now, displayName));

      const results = await executor.batch(statements);
      if ((results[sessionIndex]?.rows.length ?? 0) === 0) return 'refused';
      if ((results[groupsIndex]?.rows.length ?? 0) > 0) {
        await notifyProjectAccessLost(options, ctx, [plan.userId], now);
      }
      return 'created';
    },
  };
}
