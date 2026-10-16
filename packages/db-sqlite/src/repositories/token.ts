import { sql, type Compilable, type Expression, type Kysely } from 'kysely';
import {
  type FailureReason,
  type FenceGuard,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
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

const MAX_SELECTOR_ATTEMPTS = 3;
const MAX_PROJECTS = 200;
const REAUTH_WINDOW_SECONDS = 600;
const DEFAULT_IDLE_SECONDS = 3600;
const FRESHNESS_SECONDS = 86_400;
const MAX_EXPIRY_DAYS = 90;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELECTOR = /^[a-z2-7]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PLAINTEXT_PREFIX = 'pb_pat_';
const PLAINTEXT = /^pb_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

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

function validateMinted(minted: MintedToken): void {
  if (
    typeof minted.selector !== 'string' ||
    !SELECTOR.test(minted.selector) ||
    typeof minted.hash !== 'string' ||
    !HASH.test(minted.hash) ||
    !Number.isSafeInteger(minted.pepperVersion) ||
    minted.pepperVersion < 1 ||
    typeof minted.plaintext !== 'string' ||
    !PLAINTEXT.test(minted.plaintext) ||
    minted.plaintext.slice(PLAINTEXT_PREFIX.length, PLAINTEXT_PREFIX.length + 12) !==
      minted.selector
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
    where issuing_session.revoked_at is null
      and unixepoch(coalesce(issuing_session.last_seen_at, issuing_session.created_at), 'subsec')
        > unixepoch('now', 'subsec') - ${sql.lit(idleSeconds)}
      and unixepoch(issuing_session.expires_at) > unixepoch('now')
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

function sessionLive(ctx: OrgContext, fence: MutationFence, idleSeconds: number): Guard {
  return sql<boolean>`exists (
    select 1 from session as live_session
    join user_account as live_user
      on live_user.id = live_session.user_id and live_user.org_id = live_session.org_id
    where live_session.id = ${fence.sessionId}
      and live_session.org_id = ${ctx.orgId}
      and live_session.user_id = ${fence.userId}
      and live_session.revoked_at is null
      and live_user.status = 'active'
      and unixepoch(live_session.expires_at) > unixepoch('now')
      and unixepoch(coalesce(live_session.last_seen_at, live_session.created_at), 'subsec')
        > unixepoch('now', 'subsec') - ${sql.lit(idleSeconds)})`;
}

export interface TokenRepositoryOptions {
  /** Longest idle time of the issuing session, 60 to 86400 seconds; default one hour. */
  readonly idleSeconds?: number;
}

export function createTokenRepository(
  executor: SqlExecutor,
  options: TokenRepositoryOptions = {},
): TokenRepository {
  const idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
  if (!Number.isInteger(idleSeconds) || idleSeconds < 60 || idleSeconds > 86_400) {
    throw new RangeError('idleSeconds must be an integer from 60 to 86400');
  }
  return {
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
  };
}
