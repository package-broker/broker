import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp } from '../ids.js';
import type { ActorContext, AdminLog } from './administration.js';
import { catalogueTokenEligible } from './catalogue.js';
import type { FenceGuard, MutationFence } from './fence.js';
import { isPermission } from './permissions.js';

export type ServicePrincipalError =
  | 'forbidden'
  | 'invalid_name'
  | 'invalid_permission'
  | 'invalid_revision'
  | 'project_mismatch'
  | 'duplicate'
  | 'not_found'
  | 'not_suspended'
  | 'conflict'
  | 'indeterminate';

export type ServicePrincipalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServicePrincipalError };

export interface ServicePrincipalRecord {
  readonly id: string;
  readonly name: string;
  readonly projectId: string | null;
  readonly createdByUserId: string;
  readonly status: 'active' | 'suspended';
  readonly revision: number;
  readonly permissions: readonly string[];
}

export interface GuardRequirement {
  readonly permission: string;
  readonly projectId: string | null;
  readonly organizationAdmin: boolean;
  /** Permissions the actor must still hold, live, when the batch commits. */
  readonly covers: readonly string[];
  /** Also covers the permissions stored for this principal, read inside the batch. */
  readonly coversStoredOf?: string;
  /** Narrowing and status changes stay possible on an archived project. */
  readonly allowArchived?: boolean;
}

export interface ServicePrincipalAuthority {
  /** Fence guard that re-reads the live session, the requirement and the covered permissions. */
  guard(ctx: OrgContext, fence: MutationFence, requirement: GuardRequirement): FenceGuard;
  /** The fence actor's live effective permissions at the boundary: organization grants plus the project's. */
  livePermissions(
    ctx: OrgContext,
    fence: MutationFence,
    projectId: string | null,
  ): Promise<ReadonlySet<string>>;
}

export interface ServicePrincipalStore {
  get(ctx: OrgContext, id: string): Promise<ServicePrincipalRecord | null>;
  create(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: {
      readonly id: string;
      readonly name: string;
      readonly projectId: string | null;
      readonly createdByUserId: string;
      readonly permissions: readonly string[];
      readonly now: string;
      readonly opId: string;
    },
  ): Promise<
    | 'created'
    | 'duplicate'
    | 'project_mismatch'
    | 'invalid_permissions'
    | 'authority'
    | 'indeterminate'
  >;
  setPermissions(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    permissions: readonly string[],
    now: string,
    opId: string,
  ): Promise<
    'updated' | 'not_found' | 'invalid_permissions' | 'conflict' | 'authority' | 'indeterminate'
  >;
  suspend(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    now: string,
    opId: string,
  ): Promise<'suspended' | 'unchanged' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'>;
  restore(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    now: string,
    opId: string,
  ): Promise<
    'restored' | 'not_suspended' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'
  >;
}

export interface ServicePrincipalDeps {
  readonly principals: ServicePrincipalStore;
  readonly authority: ServicePrincipalAuthority;
  readonly directory: {
    createdBy(
      ctx: OrgContext,
      userId: string,
    ): Promise<readonly { readonly id: string; readonly projectId: string | null }[]>;
  };
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

export type CreatorOffboardingCause = 'membership_removed' | 'suspended';

export interface ServicePrincipalService {
  create(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    input: { readonly name: string; readonly projectId: string | null },
  ): Promise<
    ServicePrincipalResult<{ readonly id: string; readonly permissions: readonly string[] }>
  >;
  setPermissions(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    permissions: readonly string[],
  ): Promise<ServicePrincipalResult<null>>;
  suspend(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
  ): Promise<ServicePrincipalResult<null>>;
  restore(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
  ): Promise<ServicePrincipalResult<null>>;
  /** Records that a creator left or was suspended; the principals they created keep working. */
  creatorOffboarded(
    ctx: OrgContext,
    input: { readonly userId: string; readonly cause: CreatorOffboardingCause },
  ): Promise<void>;
}

const NAME_MAX_LENGTH = 100;
const FORBIDDEN_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const PROJECT_MANAGE = 'project:service-principals:write';
const ORG_MANAGE = 'org:service-principals:write';

const OK: ServicePrincipalResult<null> = Object.freeze({ ok: true, value: null });

function fail(error: ServicePrincipalError): ServicePrincipalResult<never> {
  return { ok: false, error };
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string' || FORBIDDEN_NAME_CHARACTER.test(name)) return false;
  const length = Array.from(name).length;
  return length >= 1 && length <= NAME_MAX_LENGTH;
}

/** An organization-wide principal also carries the project: permissions of the admin's organization grants. */
function inBoundary(projectId: string | null, name: string): boolean {
  if (!catalogueTokenEligible(name)) return false;
  return projectId === null || name.startsWith('project:');
}

function requirementFor(projectId: string | null): {
  permission: string;
  organizationAdmin: boolean;
} {
  return projectId === null
    ? { permission: ORG_MANAGE, organizationAdmin: true }
    : { permission: PROJECT_MANAGE, organizationAdmin: false };
}

export function createServicePrincipalService(deps: ServicePrincipalDeps): ServicePrincipalService {
  const { principals, authority, directory, clock, ids } = deps;

  const now = (): string => isoTimestamp(clock.now());

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The change is already stored; a failing sink must not report it as failed.
    }
  }

  function deny(
    ctx: OrgContext,
    actor: ActorContext,
    action: string,
  ): ServicePrincipalResult<never> {
    emit({ event: 'admin.denied', action, orgId: ctx.orgId, actorUserId: actor.userId });
    return fail('forbidden');
  }

  function untagged(
    ctx: OrgContext,
    actor: ActorContext,
    action: string,
  ): ServicePrincipalResult<never> | null {
    if ((actor as { kind?: unknown } | null)?.kind === 'organization') return null;
    emit({ event: 'admin.denied', action, orgId: ctx.orgId, actorUserId: null });
    return fail('forbidden');
  }

  function requireFence(actor: ActorContext, fence: MutationFence | undefined): MutationFence {
    if (typeof fence !== 'object' || fence === null || fence.userId !== actor.userId) {
      throw new TypeError('the mutation fence must belong to the acting user');
    }
    return fence;
  }

  /** The actor's live set at the boundary when they may manage it; null when they may not. */
  async function manageable(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    projectId: string | null,
  ): Promise<ReadonlySet<string> | null> {
    const { permission, organizationAdmin } = requirementFor(projectId);
    if (organizationAdmin && actor.isOrganizationAdmin !== true) return null;
    const live = await authority.livePermissions(ctx, fence, projectId);
    return live.has(permission) ? live : null;
  }

  function changed(
    ctx: OrgContext,
    actor: ActorContext,
    action: string,
    servicePrincipalId: string,
    projectId: string | null,
  ): void {
    emit({
      event: 'service_principal.changed',
      action,
      orgId: ctx.orgId,
      servicePrincipalId,
      projectId,
      actorUserId: actor.userId,
    });
  }

  function refusal(
    ctx: OrgContext,
    actor: ActorContext,
    action: string,
    outcome: string,
  ): ServicePrincipalResult<never> {
    switch (outcome) {
      case 'authority':
        return deny(ctx, actor, action);
      case 'invalid_permissions':
        return fail('invalid_permission');
      case 'conflict':
      case 'indeterminate':
      case 'not_found':
      case 'not_suspended':
      case 'duplicate':
      case 'project_mismatch':
        return fail(outcome);
      default:
        throw new Error(`service principal ${action} answered unclassified (${outcome})`);
    }
  }

  /** An unknown id reveals nothing to an actor who manages nothing at organization scope. */
  async function missing(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    action: string,
  ): Promise<ServicePrincipalResult<never>> {
    const live = await authority.livePermissions(ctx, fence, null);
    return live.has(ORG_MANAGE) || live.has(PROJECT_MANAGE)
      ? fail('not_found')
      : deny(ctx, actor, action);
  }

  async function transition(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    action: 'suspended' | 'restored',
  ): Promise<ServicePrincipalResult<null>> {
    const refused = untagged(ctx, actor, action);
    if (refused !== null) return refused;
    const held = requireFence(actor, fence);
    const target = typeof id === 'string' && id !== '' ? await principals.get(ctx, id) : null;
    if (target === null) return missing(ctx, actor, held, action);
    const live = await manageable(ctx, actor, held, target.projectId);
    if (live === null) return deny(ctx, actor, action);
    if (action === 'restored') {
      const expected = held.expected['service_principal'];
      if (!Number.isSafeInteger(expected)) return fail('invalid_revision');
      if (expected !== target.revision) return fail('conflict');
      if (!target.permissions.every((name) => live.has(name))) return deny(ctx, actor, action);
    }
    const guard = authority.guard(ctx, held, {
      ...requirementFor(target.projectId),
      projectId: target.projectId,
      covers: [],
      ...(action === 'restored' ? { coversStoredOf: id } : {}),
      ...(action === 'suspended' ? { allowArchived: true } : {}),
    });
    const result: string =
      action === 'suspended'
        ? await principals.suspend(ctx, held, guard, id, now(), ids.ulid())
        : await principals.restore(ctx, held, guard, id, now(), ids.ulid());
    if (result === 'unchanged') return OK;
    if (result !== 'suspended' && result !== 'restored') {
      return refusal(ctx, actor, action, result);
    }
    changed(ctx, actor, action, id, target.projectId);
    return OK;
  }

  return {
    async create(ctx, actor, fence, input) {
      const refused = untagged(ctx, actor, 'created');
      if (refused !== null) return refused;
      const held = requireFence(actor, fence);
      if (!isValidName(input.name)) return fail('invalid_name');
      const { projectId } = input;
      if (projectId !== null && (typeof projectId !== 'string' || projectId === '')) {
        return fail('project_mismatch');
      }
      const live = await manageable(ctx, actor, held, projectId);
      if (live === null) return deny(ctx, actor, 'created');
      const snapshot = [...live].filter((name) => inBoundary(projectId, name)).sort();
      const guard = authority.guard(ctx, held, {
        ...requirementFor(projectId),
        projectId,
        covers: snapshot,
      });
      const id = ids.ulid();
      const result = await principals.create(ctx, held, guard, {
        id,
        name: input.name,
        projectId,
        createdByUserId: actor.userId,
        permissions: snapshot,
        now: now(),
        opId: ids.ulid(),
      });
      if (result !== 'created') return refusal(ctx, actor, 'created', result);
      changed(ctx, actor, 'created', id, projectId);
      return { ok: true, value: { id, permissions: snapshot } };
    },

    async setPermissions(ctx, actor, fence, id, permissions) {
      const refused = untagged(ctx, actor, 'permissions_changed');
      if (refused !== null) return refused;
      const held = requireFence(actor, fence);
      const target = typeof id === 'string' && id !== '' ? await principals.get(ctx, id) : null;
      if (target === null) return missing(ctx, actor, held, 'permissions_changed');
      const live = await manageable(ctx, actor, held, target.projectId);
      if (live === null) return deny(ctx, actor, 'permissions_changed');
      const expected = held.expected['service_principal'];
      if (!Number.isSafeInteger(expected)) return fail('invalid_revision');
      if (expected !== target.revision) return fail('conflict');
      if (
        !Array.isArray(permissions) ||
        new Set(permissions).size !== permissions.length ||
        !permissions.every(
          (name) =>
            typeof name === 'string' && isPermission(name) && inBoundary(target.projectId, name),
        )
      ) {
        return fail('invalid_permission');
      }
      if (!permissions.every((name) => live.has(name))) {
        return deny(ctx, actor, 'permissions_changed');
      }
      const next = [...permissions].sort();
      const narrowing = next.every((name) => target.permissions.includes(name));
      const guard = authority.guard(ctx, held, {
        ...requirementFor(target.projectId),
        projectId: target.projectId,
        covers: next,
        ...(narrowing ? { allowArchived: true } : {}),
      });
      const result = await principals.setPermissions(ctx, held, guard, id, next, now(), ids.ulid());
      if (result !== 'updated') return refusal(ctx, actor, 'permissions_changed', result);
      changed(ctx, actor, 'permissions_changed', id, target.projectId);
      return OK;
    },

    suspend: (ctx, actor, fence, id) => transition(ctx, actor, fence, id, 'suspended'),

    restore: (ctx, actor, fence, id) => transition(ctx, actor, fence, id, 'restored'),

    async creatorOffboarded(ctx, input) {
      let created: Awaited<ReturnType<ServicePrincipalDeps['directory']['createdBy']>>;
      try {
        created = await directory.createdBy(ctx, input.userId);
      } catch {
        emit({
          event: 'service_principal.offboarding_lookup_failed',
          orgId: ctx.orgId,
          userId: input.userId,
          cause: input.cause,
        });
        return;
      }
      for (const principal of created) {
        emit({
          event: 'service_principal.creator_offboarded',
          orgId: ctx.orgId,
          servicePrincipalId: principal.id,
          projectId: principal.projectId,
          userId: input.userId,
          cause: input.cause,
        });
      }
    },
  };
}
