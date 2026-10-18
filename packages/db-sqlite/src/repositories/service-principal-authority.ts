import { sql, type Kysely, type SqlBool } from 'kysely';
import type { FenceGuard, MutationFence } from '@package-broker/core/authz/fence';
import { catalogueTokenEligible } from '@package-broker/core/authz/catalogue';
import { isPermission } from '@package-broker/core/authz/permissions';
import type { ServicePrincipalAuthority } from '@package-broker/core/authz/service-principal-service';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { assertGuard, compile, db, type ProtectedHolderProvider } from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { permissionRows } from './access.js';

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

export interface ServicePrincipalGuardInput {
  /** The management permission the acting user must hold now. */
  readonly permission: string;
  /** Null checks organization grants only; an id adds that project's grants. */
  readonly projectId: string | null;
  /** Also requires the acting user to be a current holder of a protected organization role. */
  readonly organizationAdmin: boolean;
  /** Permissions the acting user must still hold when the batch commits. */
  readonly covers: readonly string[];
  /** Also requires every permission stored for this principal, read inside the batch, to be live. */
  readonly coversStoredOf?: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
  readonly allowArchived?: boolean;
}

function localSession(ctx: OrgContext, fence: MutationFence) {
  return sql<SqlBool>`exists ${loose
    .selectFrom('session as sa_session')
    .select(sql.lit(1).as('one'))
    .where('sa_session.org_id', '=', ctx.orgId)
    .where('sa_session.id', '=', fence.sessionId)
    .where('sa_session.user_id', '=', fence.userId)
    .where('sa_session.revoked_at', 'is', null)
    .where('sa_session.identity_id', 'is', null)}`;
}

/**
 * The head guard of a service-principal batch: a live session owned by the fence user, the
 * management permission, organization-admin status when required, and every covered permission,
 * all evaluated inside the batch against database time.
 */
export function servicePrincipalAuthorityGuard(
  ctx: OrgContext,
  fence: MutationFence,
  input: ServicePrincipalGuardInput,
): FenceGuard {
  if (input.projectId !== null && (typeof input.projectId !== 'string' || input.projectId === '')) {
    throw new TypeError('projectId must be null or a non-empty string');
  }
  if (!Array.isArray(input.providerAnchors)) {
    throw new TypeError('providerAnchors must be a list');
  }
  if (
    !Array.isArray(input.covers) ||
    !input.covers.every((name) => isPermission(name) && catalogueTokenEligible(name))
  ) {
    throw new TypeError('covers must be a list of token-eligible catalogue permissions');
  }
  if (
    input.coversStoredOf !== undefined &&
    (typeof input.coversStoredOf !== 'string' || input.coversStoredOf === '')
  ) {
    throw new TypeError('coversStoredOf must be a non-empty string');
  }
  const held = actorHolds(ctx, fence, {
    permission: input.permission,
    projectId: input.projectId,
    providerAnchors: input.providerAnchors,
    ...(input.allowArchived === true ? { allowArchived: true } : {}),
  });
  const localAdmin = localSession(ctx, fence);
  const admin = input.organizationAdmin
    ? sql<SqlBool>`exists ${loose
        .selectFrom(
          permissionRows(ctx, fence.userId, null, input.providerAnchors, { localAdmin }).as(
            'sa_admin' as never,
          ) as never,
        )
        .select(sql.lit(1).as('one'))
        .where(sql<SqlBool>`sa_admin.protects = 1`)}`
    : sql<SqlBool>`1`;
  const live = (alias: string) =>
    permissionRows(ctx, fence.userId, input.projectId, input.providerAnchors, { localAdmin }).as(
      alias as never,
    );
  const covered =
    input.covers.length === 0
      ? sql<SqlBool>`1`
      : sql<SqlBool>`not exists (
          select 1 from json_each(${JSON.stringify([...new Set(input.covers)].sort())}) wanted
          where wanted.value not in (select sa_live.permission from ${live('sa_live')}))`;
  const storedCovered =
    input.coversStoredOf === undefined
      ? sql<SqlBool>`1`
      : sql<SqlBool>`not exists (
          select 1 from service_principal_permission stored
          where stored.org_id = ${ctx.orgId} and stored.service_principal_id = ${input.coversStoredOf}
            and stored.permission not in (select sa_stored.permission from ${live('sa_stored')}))`;
  return assertGuard(sql<SqlBool>`(${held} and ${admin} and ${covered} and ${storedCovered})`, ctx);
}

export interface ServicePrincipalAuthorityOptions {
  readonly executor: ScalarSqlExecutor;
  /** Required; pass an empty list only for a deployment with no identity provider. */
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

/**
 * The production `ServicePrincipalAuthority`: the guard is `servicePrincipalAuthorityGuard` with the
 * configured anchors; `livePermissions` reads the fence user's effective permissions through
 * `permissionRows`, so stale group evidence and identities at a re-anchored provider drop out. It
 * ignores project status, so narrowing and suspension stay possible on an archived project.
 */
export function createServicePrincipalAuthority(
  options: ServicePrincipalAuthorityOptions,
): ServicePrincipalAuthority {
  const { executor, providerAnchors } = options;
  if (!Array.isArray(providerAnchors)) {
    throw new TypeError('providerAnchors must be a list');
  }
  const anchors = Object.freeze([...providerAnchors]);
  return {
    guard: (ctx, fence, requirement) =>
      servicePrincipalAuthorityGuard(ctx, fence, { ...requirement, providerAnchors: anchors }),

    async livePermissions(ctx, fence, projectId) {
      if (projectId !== null && (typeof projectId !== 'string' || projectId === '')) {
        throw new TypeError('projectId must be null or a non-empty string');
      }
      const rows = permissionRows(ctx, fence.userId, projectId, anchors, {
        localAdmin: localSession(ctx, fence),
      }).as('sp_live' as never);
      const found = await executor.all<{ permission: string }>(
        compile(
          loose
            .selectFrom(rows as never)
            .select(sql<string>`sp_live.permission`.as('permission'))
            .distinct(),
        ) as ScalarStatement,
      );
      return new Set(found.map((row) => row.permission));
    },
  };
}
