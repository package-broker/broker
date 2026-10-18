import { sql, type Compilable, type Expression, type Kysely } from 'kysely';
import {
  type FailureReason,
  type FenceGuard,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { DbError } from '@package-broker/core/db/errors';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { scopeAllows } from '@package-broker/core/authz/scope';
import type {
  RevocableToken,
  TokenOwnershipGuard,
  TokenRevokeStore,
} from '@package-broker/core/authz/token-revoke';
import type {
  ServiceTokenIssueOutcome,
  ServiceTokenStore,
  ServiceTokenStoreInput,
} from '@package-broker/core/authz/service-token-service';
import {
  adminEligibility,
  assertCheck,
  assertGuard,
  compile,
  db,
  EVIDENCE_FUTURE_SKEW_MS,
  newOpId,
  requireProviders,
  runOrgFenced,
  type Database,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { holdsPermission } from './access.js';
import {
  DEFAULT_IDLE_SECONDS,
  liveSessionCondition,
  requireIdleSeconds,
} from './session-liveness.js';
import { servicePrincipalAuthorityGuard } from './service-principal-authority.js';

const MAX_SELECTOR_ATTEMPTS = 3;
const MAX_PROJECTS = 200;
const REAUTH_WINDOW_SECONDS = 600;
const FRESHNESS_SECONDS = 86_400;
const MAX_EXPIRY_DAYS = 90;
const MAX_CI_READ_ONLY_EXPIRY_DAYS = 365;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELECTOR = /^[a-z2-7]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PLAINTEXT_PREFIX = 'pb_pat_';
const PLAINTEXT = /^pb_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;
const SERVICE_PLAINTEXT_PREFIX = 'pb_svc_';
const SERVICE_PLAINTEXT = /^pb_svc_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

interface TokenProjectTable {
  org_id: string;
  token_id: string;
  project_id: string;
}

const bindings = db as unknown as Kysely<Database & { token_project: TokenProjectTable }>;

export interface MintedToken {
  readonly selector: string;
  readonly hash: string;
  readonly pepperVersion: number;
  readonly plaintext: string;
}

export type TokenScope = 'read' | 'write' | 'full';

export type TokenValidation =
  { readonly kind: 'local' } | { readonly kind: 'sso'; readonly identityId: string };

export interface IssuePersonalTokenInput {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
  readonly expiresAt: string;
  readonly now: string;
  readonly validation: TokenValidation;
  readonly projectMode: 'all' | 'selected';
  /** Empty for `all`; 1 to 200 distinct project ids for `selected`. */
  readonly projectIds: readonly string[];
  /** Provider anchors of the organization, for the issuer's group and e-mail evidence. */
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export type IssueTokenResult =
  | { readonly status: 'issued'; readonly id: string; readonly plaintext: string }
  | {
      readonly status: 'refused';
      readonly reason: 'authority' | 'id_conflict' | 'selector_collision' | 'unclassified';
    }
  | { readonly status: 'indeterminate' };

export type IssueServiceTokenInput = ServiceTokenStoreInput;

export type IssueServiceTokenResult = ServiceTokenIssueOutcome;

export type RevokeTokenResult =
  | { readonly status: 'revoked'; readonly opId: string }
  | { readonly status: 'already_revoked' }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly reason: FailureReason }
  | { readonly status: 'indeterminate' };

export interface TokenRepository {
  /**
   * Inserts the token and its bindings in one guarded batch; `mint` is called again for a fresh
   * pair after a selector collision, at most three times in all. The plaintext of the stored
   * pair is returned once. TypeError before SQL for invalid input or an invalid minted pair.
   */
  issuePersonal(
    ctx: OrgContext,
    fence: MutationFence,
    input: IssuePersonalTokenInput,
    mint: () => MintedToken | Promise<MintedToken>,
  ): Promise<IssueTokenResult>;
  /**
   * Inserts one svc token bound to the principal and its project, with no token_project rows, in
   * one fenced batch. The batch requires on database time: a live, freshly reauthenticated session;
   * the issuer's live management permission and every covered permission; the principal active,
   * bound to `projectId`, at `principalRevision` and storing every covered permission; an active
   * project whose token_max_scope admits the scope; and an expiry within min(CI setting, 365) days
   * for a read token or min(default setting, 90) days otherwise. `conflict`: the principal changed.
   */
  issueService(
    ctx: OrgContext,
    fence: MutationFence,
    input: IssueServiceTokenInput,
    mint: () => MintedToken | Promise<MintedToken>,
  ): Promise<IssueServiceTokenResult>;
  /**
   * Runs `guard` and the update as one fenced batch, so a revoked session cannot revoke. The opId
   * on `revoked` is the marker that gates the audit event; repeats carry none. `indeterminate`:
   * the revoke may have been applied.
   */
  revoke(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    tokenId: string,
    now: string,
  ): Promise<RevokeTokenResult>;
  /** Revoked and expired tokens included; null when the id is not in the organization. */
  get(ctx: OrgContext, tokenId: string): Promise<RevocableToken | null>;
  /**
   * The head guard of a revoke batch: holds only for a live (not revoked, not expired) personal
   * token of `fence.userId` in the organization, on database time.
   */
  ownPersonalToken(ctx: OrgContext, fence: MutationFence, tokenId: string): FenceGuard;
}

interface RevocableRow {
  readonly id: string;
  readonly kind: string;
  readonly user_id: string | null;
  readonly project_id: string | null;
  readonly project_mode: string;
}

function revocable(row: RevocableRow): RevocableToken {
  if (row.kind === 'pat' && row.user_id !== null && row.project_id === null) {
    if (row.project_mode === 'all' || row.project_mode === 'selected') {
      return {
        id: row.id,
        kind: 'pat',
        userId: row.user_id,
        projectId: null,
        projectMode: row.project_mode,
      };
    }
  } else if (row.kind === 'svc' && row.user_id === null) {
    return { id: row.id, kind: 'svc', userId: null, projectId: row.project_id, projectMode: null };
  } else if (row.kind === 'cst') {
    return {
      id: row.id,
      kind: 'cst',
      userId: row.user_id,
      projectId: row.project_id,
      projectMode: null,
    };
  }
  throw new TypeError('the token row does not have the shape of a revocable token');
}

function timestamp(field: string, value: unknown): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function nonEmpty(field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function validateInput(input: IssuePersonalTokenInput): string {
  nonEmpty('id', input.id);
  requireProviders(input.providerAnchors);
  nonEmpty('name', input.name);
  if (input.scope !== 'read' && input.scope !== 'write' && input.scope !== 'full') {
    throw new TypeError('scope must be read, write or full');
  }
  const now = timestamp('now', input.now);
  if (timestamp('expiresAt', input.expiresAt) <= now) {
    throw new TypeError('expiresAt must be in the future');
  }
  if (input.validation.kind === 'sso') {
    nonEmpty('validation identity id', input.validation.identityId);
  } else if (input.validation.kind !== 'local') {
    throw new TypeError('validation kind must be sso or local');
  }
  if (input.projectMode === 'all') {
    if (input.projectIds.length !== 0) {
      throw new TypeError('an all-project token carries no project ids');
    }
  } else if (input.projectMode === 'selected') {
    if (input.projectIds.length < 1 || input.projectIds.length > MAX_PROJECTS) {
      throw new TypeError(`a selected token binds 1 to ${MAX_PROJECTS} projects`);
    }
    input.projectIds.forEach((id) => nonEmpty('project id', id));
    if (new Set(input.projectIds).size !== input.projectIds.length) {
      throw new TypeError('selected project ids must be distinct');
    }
  } else {
    throw new TypeError('projectMode must be all or selected');
  }
  return now;
}

function validateMinted(
  minted: MintedToken,
  plaintext: RegExp = PLAINTEXT,
  prefix: string = PLAINTEXT_PREFIX,
): void {
  if (
    typeof minted.selector !== 'string' ||
    !SELECTOR.test(minted.selector) ||
    typeof minted.hash !== 'string' ||
    !HASH.test(minted.hash) ||
    !Number.isSafeInteger(minted.pepperVersion) ||
    minted.pepperVersion < 1 ||
    typeof minted.plaintext !== 'string' ||
    !plaintext.test(minted.plaintext) ||
    minted.plaintext.slice(prefix.length, prefix.length + 12) !== minted.selector
  ) {
    throw new TypeError('minted token is malformed');
  }
}

const SCOPE_CEILINGS: Record<TokenScope, readonly string[]> = {
  read: ['read', 'write', 'full'],
  write: ['write', 'full'],
  full: ['full'],
};

interface Selection {
  readonly json: string;
  readonly count: number;
}

const EVIDENCE_SKEW_SECONDS = EVIDENCE_FUTURE_SKEW_MS / 1000;

function freshWithinSkew(column: string) {
  return sql`unixepoch(${sql.ref(column)}, 'subsec')
    between unixepoch('now', 'subsec') - ${sql.lit(FRESHNESS_SECONDS)}
      and unixepoch('now', 'subsec') + ${sql.lit(EVIDENCE_SKEW_SECONDS)}`;
}

interface Conditions {
  /** Goes into assertGuard: session, user, expiry, validation origin and selected-project policy. */
  readonly guard: Guard;
  /** Each goes into its own assertCheck so that no statement carries more than one permission scan. */
  readonly checks: readonly Guard[];
}

function conditions(
  ctx: OrgContext,
  fence: MutationFence,
  input: IssuePersonalTokenInput,
  selection: Selection,
  idleSeconds: number,
): Conditions {
  const allowedCaps = sql.join(SCOPE_CEILINGS[input.scope].map((cap) => sql.lit(cap)));
  const required = input.scope === 'read' ? 'project:packages:read' : 'project:packages:write';
  const other = input.scope === 'read' ? 'project:packages:write' : 'project:packages:read';
  const holds = (name: string, project: string) =>
    holdsPermission(ctx, {
      userId: sql.ref<string>('issuing_user.id'),
      permission: name,
      projectId: sql.ref<string>(project),
      providerAnchors: input.providerAnchors,
      projectState: 'active',
      session: sql.ref<string>('ip.session_id'),
    });
  const validation =
    input.validation.kind === 'sso'
      ? sql`issuing_session.identity_id = ip.identity_id
        and exists (
          select 1 from identity as bound_identity
          where bound_identity.id = issuing_session.identity_id
            and bound_identity.org_id = ip.org_id
            and bound_identity.user_id = issuing_user.id
            and bound_identity.email_verified = 1
            and bound_identity.email = issuing_user.email
            and exists (
              select 1 from identity_provider_binding as identity_binding
              join json_each(ip.anchors) as configured
                on json_extract(configured.value, '$.provider') = identity_binding.provider
                and json_extract(configured.value, '$.anchor') = identity_binding.anchor
              where identity_binding.org_id = ip.org_id
                and identity_binding.provider = bound_identity.provider)
            and ${freshWithinSkew('bound_identity.validated_at')})`
      : sql`issuing_session.identity_id is null
        and ${adminEligibility(ctx, sql.ref<string>('issuing_user.id'))}
        and exists (
          select 1 from local_login as own_login
          where own_login.user_id = issuing_user.id
            and own_login.org_id = ip.org_id
            and ${freshWithinSkew('own_login.last_login_at')})`;
  const selectedPolicy =
    input.projectMode === 'selected'
      ? sql`(
          select count(*) from project as target_project
          where target_project.org_id = ip.org_id
            and target_project.status = 'active'
            and target_project.token_max_scope in (${allowedCaps})
            and target_project.id in (select value from json_each(ip.projects))
        ) = ip.project_count
        and ip.project_count = json_array_length(ip.projects)`
      : sql`1`;
  const anchors = JSON.stringify(
    input.providerAnchors.map(({ provider, anchor }) => ({ provider, anchor })),
  );
  const guard = sql<boolean>`exists (
    with ip(org_id, session_id, user_id, identity_id, expires_at, projects, project_count, anchors) as (
      select ${ctx.orgId}, ${fence.sessionId}, ${fence.userId},
        ${input.validation.kind === 'sso' ? input.validation.identityId : null},
        ${input.expiresAt}, ${selection.json}, ${selection.count}, ${anchors}
    )
    select 1 from ip
    join session as issuing_session
      on issuing_session.id = ip.session_id and issuing_session.org_id = ip.org_id
      and issuing_session.user_id = ip.user_id
    join user_account as issuing_user
      on issuing_user.id = issuing_session.user_id and issuing_user.org_id = issuing_session.org_id
    join organization as issuing_org on issuing_org.id = issuing_session.org_id
    where ${liveSessionCondition('issuing_session', idleSeconds)}
      and unixepoch(issuing_session.reauth_at)
        between unixepoch('now') - ${sql.lit(REAUTH_WINDOW_SECONDS)} and unixepoch('now')
      and issuing_user.status = 'active'
      and unixepoch(ip.expires_at) > unixepoch('now')
      and unixepoch(ip.expires_at) <= unixepoch('now')
        + ${sql.lit(86_400)} * min(issuing_org.token_default_expiry_days, ${sql.lit(MAX_EXPIRY_DAYS)})
      and ${validation}
      and ${selectedPolicy})`;

  if (input.projectMode === 'selected') {
    const access = sql<boolean>`exists (
      with ip(org_id, session_id, user_id, projects) as (
        select ${ctx.orgId}, ${fence.sessionId}, ${fence.userId}, ${selection.json}
      )
      select 1 from ip join user_account as issuing_user on issuing_user.id = ip.user_id
      where not exists (
        select 1 from json_each(ip.projects) as selected_item
        where not (${holds(required, 'selected_item.value')})))`;
    return { guard, checks: [access] };
  }
  const projectScan = (extra: Expression<unknown>) => sql<boolean>`exists (
    with ip(org_id, session_id, user_id) as (select ${ctx.orgId}, ${fence.sessionId}, ${fence.userId})
    select 1 from ip join user_account as issuing_user on issuing_user.id = ip.user_id
    where not exists (
      select 1 from project as scoped_project
      where scoped_project.org_id = ip.org_id
        and scoped_project.status = 'active'
        and ${extra}))`;
  const caps = projectScan(
    sql`scoped_project.token_max_scope not in (${allowedCaps})
      and ((${holds('project:packages:read', 'scoped_project.id')})
        or (${holds('project:packages:write', 'scoped_project.id')}))`,
  );
  const permissions = projectScan(
    sql`(${holds(other, 'scoped_project.id')}) and not (${holds(required, 'scoped_project.id')})`,
  );
  return { guard, checks: [caps, permissions] };
}

function issueStatements(
  ctx: OrgContext,
  fence: MutationFence,
  input: IssuePersonalTokenInput,
  selection: Selection,
  checks: readonly Guard[],
  minted: MintedToken,
  opId: string,
): Statement[] {
  const selected = input.projectMode === 'selected';
  const statements: Compilable[] = [
    db.insertInto('token').values({
      id: input.id,
      org_id: ctx.orgId,
      kind: 'pat',
      selector: minted.selector,
      hash: minted.hash,
      pepper_version: minted.pepperVersion,
      name: input.name,
      scopes_json: JSON.stringify([input.scope]),
      read_only: input.scope === 'read' ? 1 : 0,
      user_id: fence.userId,
      service_principal_id: null,
      customer_id: null,
      project_id: null,
      created_by_user_id: fence.userId,
      expires_at: input.expiresAt,
      project_mode: input.projectMode,
      validation_kind: input.validation.kind,
      validation_identity_id: input.validation.kind === 'sso' ? input.validation.identityId : null,
      last_op_id: opId,
      created_at: input.now,
    }),
  ];
  if (selected) {
    statements.push(
      bindings
        .insertInto('token_project')
        .columns(['org_id', 'token_id', 'project_id'])
        .expression(
          bindings
            .selectFrom(sql<{ value: string }>`json_each(${selection.json})`.as('selected_project'))
            .select((eb) => [
              eb.val(ctx.orgId).as('org_id'),
              eb.val(input.id).as('token_id'),
              'selected_project.value as project_id',
            ]),
        ),
    );
  }
  const compiled = statements.map((statement) => compile(statement));
  const bindingCount = sql<boolean>`((
    select count(*) from token_project
    where token_id = ${input.id} and org_id = ${ctx.orgId}
  ) = ${selection.count} and ${selection.count} = json_array_length(${selection.json}))`;
  return [
    ...checks.flatMap((check) => assertCheck(check)),
    ...compiled,
    ...assertCheck(bindingCount),
  ];
}

function probes(tokenId: string, selector: string) {
  return {
    conflict: compile(
      db.selectNoFrom((eb) =>
        eb
          .exists(db.selectFrom('token').select(sql.lit(1).as('one')).where('id', '=', tokenId))
          .as('conflict'),
      ),
    ),
    collision: compile(
      db.selectNoFrom((eb) =>
        eb
          .exists(
            db.selectFrom('token').select(sql.lit(1).as('one')).where('selector', '=', selector),
          )
          .as('collision'),
      ),
    ),
  };
}

async function anyLost(executor: SqlExecutor, guards: readonly Guard[]): Promise<boolean> {
  try {
    for (const guard of guards) {
      const rows = await executor.all<Record<string, unknown>>(
        compile(db.selectNoFrom(sql<number>`(coalesce(${guard}, 0) = 0)`.as('lost'))),
      );
      if (Number(Object.values(rows[0] ?? {})[0] ?? 0) !== 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * The head guard's first statement inserts nothing while its condition holds and fails with a
 * UNIQUE error otherwise, so running it alone is a side-effect-free probe of that condition.
 */
async function headGuardLost(executor: SqlExecutor, guard: FenceGuard): Promise<boolean> {
  const check = guard[0];
  if (check === undefined) return false;
  try {
    await executor.batch([check]);
    return false;
  } catch (error) {
    return error instanceof DbError && error.kind === 'unique';
  }
}

function sessionLive(ctx: OrgContext, fence: MutationFence, idleSeconds: number): Guard {
  return sql<boolean>`exists (
    select 1 from session as live_session
    join user_account as live_user
      on live_user.id = live_session.user_id and live_user.org_id = live_session.org_id
    where live_session.id = ${fence.sessionId}
      and live_session.org_id = ${ctx.orgId}
      and live_session.user_id = ${fence.userId}
      and live_user.status = 'active'
      and ${liveSessionCondition('live_session', idleSeconds)})`;
}

function validateServiceInput(input: IssueServiceTokenInput): void {
  nonEmpty('id', input.id);
  nonEmpty('name', input.name);
  nonEmpty('servicePrincipalId', input.servicePrincipalId);
  if (input.projectId !== null) nonEmpty('projectId', input.projectId);
  requireProviders(input.providerAnchors);
  if (!Number.isSafeInteger(input.principalRevision) || input.principalRevision < 1) {
    throw new TypeError('principalRevision must be a safe integer >= 1');
  }
  if (input.scope !== 'read' && input.scope !== 'write' && input.scope !== 'full') {
    throw new TypeError('scope must be read, write or full');
  }
  if (input.readOnly !== (input.scope === 'read')) {
    throw new TypeError('readOnly must be true exactly for the read scope');
  }
  const now = timestamp('now', input.now);
  if (timestamp('expiresAt', input.expiresAt) <= now) {
    throw new TypeError('expiresAt must be in the future');
  }
  nonEmpty('authority permission', input.authority.permission);
  const { covers } = input.authority;
  if (!Array.isArray(covers) || covers.length === 0) {
    throw new TypeError('a service token covers at least one permission');
  }
  covers.forEach((name) => nonEmpty('covered permission', name));
  if (new Set(covers).size !== covers.length) {
    throw new TypeError('covered permissions must be distinct');
  }
  const mask = new Set(scopeMask(input));
  if (!covers.every((name) => mask.has(name))) {
    throw new TypeError('covered permissions must fit the scope at the principal boundary');
  }
}

/** Every permission a token of this scope may carry at the principal's boundary. */
function scopeMask(input: IssueServiceTokenInput): string[] {
  return PERMISSIONS.map(({ name }) => name).filter(
    (name) =>
      scopeAllows(input.scope, name) && (input.projectId === null || name.startsWith('project:')),
  );
}

function serviceIssuance(
  ctx: OrgContext,
  fence: MutationFence,
  input: IssueServiceTokenInput,
  idleSeconds: number,
): Guard {
  const allowedCaps = sql.join(SCOPE_CEILINGS[input.scope].map((cap) => sql.lit(cap)));
  return sql<boolean>`exists (
    with ip(org_id, session_id, user_id, principal_id, project_id, expires_at, read_only, covers, mask) as (
      select ${ctx.orgId}, ${fence.sessionId}, ${fence.userId}, ${input.servicePrincipalId},
        ${input.projectId}, ${input.expiresAt}, ${input.readOnly ? 1 : 0},
        ${JSON.stringify(input.authority.covers)}, ${JSON.stringify(scopeMask(input))}
    )
    select 1 from ip
    join session as issuing_session
      on issuing_session.id = ip.session_id and issuing_session.org_id = ip.org_id
      and issuing_session.user_id = ip.user_id
    join user_account as issuing_user
      on issuing_user.id = issuing_session.user_id and issuing_user.org_id = issuing_session.org_id
    join organization as issuing_org on issuing_org.id = issuing_session.org_id
    join service_principal as principal
      on principal.id = ip.principal_id and principal.org_id = ip.org_id
    where issuing_session.revoked_at is null
      and unixepoch(coalesce(issuing_session.last_seen_at, issuing_session.created_at), 'subsec')
        > unixepoch('now', 'subsec') - ${sql.lit(idleSeconds)}
      and unixepoch(issuing_session.expires_at) > unixepoch('now')
      and unixepoch(issuing_session.reauth_at)
        between unixepoch('now') - ${sql.lit(REAUTH_WINDOW_SECONDS)} and unixepoch('now')
      and issuing_user.status = 'active'
      and unixepoch(ip.expires_at, 'subsec') > unixepoch('now', 'subsec')
      and unixepoch(ip.expires_at, 'subsec') <= unixepoch('now', 'subsec') + ${sql.lit(86_400)} * (
        case when ip.read_only = 1
          then min(issuing_org.token_ci_readonly_expiry_days, ${sql.lit(MAX_CI_READ_ONLY_EXPIRY_DAYS)})
          else min(issuing_org.token_default_expiry_days, ${sql.lit(MAX_EXPIRY_DAYS)})
        end)
      and principal.status = 'active'
      and principal.project_id is ip.project_id
      and (principal.project_id is null or exists (
        select 1 from project as bound_project
        where bound_project.id = principal.project_id
          and bound_project.org_id = ip.org_id
          and bound_project.status = 'active'
          and bound_project.token_max_scope in (${allowedCaps})))
      and not exists (
        select 1 from json_each(ip.covers) as wanted
        where wanted.value not in (
          select stored.permission from service_principal_permission as stored
          where stored.org_id = principal.org_id and stored.service_principal_id = principal.id))
      and json_array_length(ip.covers) = (
        select count(*) from service_principal_permission as conferred
        where conferred.org_id = principal.org_id
          and conferred.service_principal_id = principal.id
          and conferred.permission in (select value from json_each(ip.mask))))`;
}

function principalUnchanged(ctx: OrgContext, input: IssueServiceTokenInput): Guard {
  return sql<boolean>`exists (
    select 1 from service_principal as current_principal
    where current_principal.id = ${input.servicePrincipalId}
      and current_principal.org_id = ${ctx.orgId}
      and current_principal.revision = ${input.principalRevision})`;
}

function serviceStatements(
  ctx: OrgContext,
  fence: MutationFence,
  input: IssueServiceTokenInput,
  checks: readonly Guard[],
  minted: MintedToken,
  opId: string,
): Statement[] {
  return [
    ...checks.flatMap((check) => assertCheck(check)),
    compile(
      db.insertInto('token').values({
        id: input.id,
        org_id: ctx.orgId,
        kind: 'svc',
        selector: minted.selector,
        hash: minted.hash,
        pepper_version: minted.pepperVersion,
        name: input.name,
        scopes_json: JSON.stringify([input.scope]),
        read_only: input.readOnly ? 1 : 0,
        user_id: null,
        service_principal_id: input.servicePrincipalId,
        customer_id: null,
        project_id: input.projectId,
        created_by_user_id: fence.userId,
        expires_at: input.expiresAt,
        project_mode: input.projectId === null ? 'all' : 'selected',
        validation_kind: null,
        validation_identity_id: null,
        last_op_id: opId,
        created_at: input.now,
      }),
    ),
  ];
}

export interface TokenRepositoryOptions {
  /** Longest idle time of the issuing session, 60 to 86400 seconds; default one hour. */
  readonly idleSeconds?: number;
}

export function createTokenRepository(
  executor: SqlExecutor,
  options: TokenRepositoryOptions = {},
): TokenRepository {
  const idleSeconds = requireIdleSeconds(options.idleSeconds ?? DEFAULT_IDLE_SECONDS);
  const repository = {
    async issuePersonal(ctx, fence, input, mint) {
      validateInput(input);
      const selection: Selection = {
        json: JSON.stringify(input.projectIds),
        count: input.projectIds.length,
      };
      const { guard, checks } = conditions(ctx, fence, input, selection, idleSeconds);
      for (let attempt = 1; attempt <= MAX_SELECTOR_ATTEMPTS; attempt += 1) {
        const minted = await mint();
        validateMinted(minted);
        const outcome = await runOrgFenced(
          executor,
          ctx,
          fence,
          assertGuard(guard, ctx),
          issueStatements(ctx, fence, input, selection, checks, minted, newOpId()),
          probes(input.id, minted.selector),
        );
        if (outcome.ok) {
          return { status: 'issued', id: input.id, plaintext: minted.plaintext };
        }
        if (outcome.reason === 'indeterminate') return { status: 'indeterminate' };
        if (await anyLost(executor, [guard, ...checks])) {
          return { status: 'refused', reason: 'authority' };
        }
        if (outcome.reason === 'collision') continue;
        if (outcome.reason === 'conflict') return { status: 'refused', reason: 'id_conflict' };
        return { status: 'refused', reason: outcome.reason };
      }
      return { status: 'refused', reason: 'selector_collision' };
    },

    async issueService(ctx, fence, input, mint) {
      validateServiceInput(input);
      const issuance = serviceIssuance(ctx, fence, input, idleSeconds);
      const unchanged = principalUnchanged(ctx, input);
      const guard = servicePrincipalAuthorityGuard(ctx, fence, {
        permission: input.authority.permission,
        projectId: input.projectId,
        organizationAdmin: input.authority.organizationAdmin,
        covers: input.authority.covers,
        providerAnchors: input.providerAnchors,
      });
      for (let attempt = 1; attempt <= MAX_SELECTOR_ATTEMPTS; attempt += 1) {
        const minted = await mint();
        validateMinted(minted, SERVICE_PLAINTEXT, SERVICE_PLAINTEXT_PREFIX);
        const outcome = await runOrgFenced(
          executor,
          ctx,
          fence,
          guard,
          serviceStatements(ctx, fence, input, [issuance, unchanged], minted, newOpId()),
          probes(input.id, minted.selector),
        );
        if (outcome.ok) {
          return { status: 'issued', id: input.id, plaintext: minted.plaintext };
        }
        if (outcome.reason === 'indeterminate') return { status: 'indeterminate' };
        if ((await headGuardLost(executor, guard)) || (await anyLost(executor, [issuance]))) {
          return { status: 'refused', reason: 'authority' };
        }
        if (await anyLost(executor, [unchanged])) return { status: 'refused', reason: 'conflict' };
        if (outcome.reason === 'collision') continue;
        if (outcome.reason === 'conflict') return { status: 'refused', reason: 'id_conflict' };
        return { status: 'refused', reason: 'unclassified' };
      }
      return { status: 'refused', reason: 'selector_collision' };
    },

    async revoke(ctx, fence, guard, tokenId, now) {
      nonEmpty('tokenId', tokenId);
      const stamp = timestamp('now', now);
      const opId = newOpId();
      const live = sessionLive(ctx, fence, idleSeconds);
      const tokenLive = sql<boolean>`exists (
        select 1 from token where id = ${tokenId} and org_id = ${ctx.orgId} and revoked_at is null)`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        guard,
        [
          ...assertCheck(live),
          ...assertCheck(tokenLive),
          compile(
            db
              .updateTable('token')
              .set({ revoked_at: stamp, last_op_id: opId })
              .where('id', '=', tokenId)
              .where('org_id', '=', ctx.orgId)
              .where('revoked_at', 'is', null)
              .returning('id'),
          ),
        ],
        {},
      );
      if (outcome.ok) return { status: 'revoked', opId };
      if (outcome.reason === 'indeterminate') return { status: 'indeterminate' };
      if (await anyLost(executor, [live])) return { status: 'refused', reason: 'authority' };
      const rows = await executor.all<{ revoked_at: string | null }>(
        compile(
          db
            .selectFrom('token')
            .select('revoked_at')
            .where('id', '=', tokenId)
            .where('org_id', '=', ctx.orgId),
        ),
      );
      const state = rows[0];
      if (state === undefined) return { status: 'not_found' };
      if (state.revoked_at !== null) return { status: 'already_revoked' };
      return { status: 'refused', reason: outcome.reason };
    },

    async get(ctx, tokenId) {
      nonEmpty('tokenId', tokenId);
      const rows = await executor.all<RevocableRow>(
        compile(
          db
            .selectFrom('token')
            .select(['id', 'kind', 'user_id', 'project_id', 'project_mode'])
            .where('id', '=', tokenId)
            .where('org_id', '=', ctx.orgId),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : revocable(row);
    },

    ownPersonalToken(ctx, fence, tokenId) {
      nonEmpty('tokenId', tokenId);
      nonEmpty('fence.userId', fence.userId);
      return assertGuard(
        sql<boolean>`exists (
          select 1 from token as owned_token
          where owned_token.id = ${tokenId}
            and owned_token.org_id = ${ctx.orgId}
            and owned_token.kind = 'pat'
            and owned_token.user_id = ${fence.userId}
            and owned_token.revoked_at is null
            and unixepoch(owned_token.expires_at, 'subsec') > unixepoch('now', 'subsec'))`,
        ctx,
      );
    },
  } satisfies TokenRepository & ServiceTokenStore & TokenRevokeStore & TokenOwnershipGuard;
  return repository;
}
