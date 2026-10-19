import type { ApiCall, IdempotencyRecord } from '../api/idempotency.js';
import {
  auditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditEventInput,
} from '../audit/actions.js';
import { redactValue } from '../audit/redact.js';
import type { GrantRepository, GrantSubject, OrganizationGrant } from '../db/grants.js';
import type { OrgContext } from '../db/port.js';
import { ROLE_KEY_PATTERN, ROLE_NAME_MAX_LENGTH } from '../db/roles.js';
import type { Role, RoleRepository } from '../db/roles.js';
import type { UserRepository } from '../db/users.js';
import type { Clock } from '../ids.js';
import { isoTimestamp } from '../ids.js';
import type { IdentityProvider } from '../identity/port.js';
import { normalizeEmail } from '../identity/policy.js';
import { isPermissionView, type PermissionView } from './actor.js';
import type { MutationFence } from './fence.js';
import { DEFAULT_ROLES, isPermission, rolePermissionProblems } from './permissions.js';
import type { CreatorOffboardingCause } from './service-principal-service.js';

export type AdminError =
  | 'invalid_permission'
  | 'invalid_key'
  | 'invalid_name'
  | 'invalid_subject'
  | 'unknown_provider'
  | 'locked'
  | 'system_role'
  | 'in_use'
  | 'duplicate'
  | 'role_scope_mismatch'
  | 'last_holder'
  | 'not_found'
  | 'conflict'
  | 'invalid_revision'
  | 'indeterminate'
  | 'forbidden';

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdminError; readonly details?: readonly string[] };

export type AdminLog = (entry: Readonly<Record<string, unknown>>) => void;

export type Permission = string;

/** `permissions` holds the actor's organization-scope grants only; project-scoped grants never go in. */
export interface ActorContext {
  readonly kind: 'organization';
  readonly userId: string;
  readonly permissions: ReadonlySet<Permission>;
  /** True when the actor holds a protects-last-holder role through an e-mail or a group grant; computed by the caller. */
  readonly isOrganizationAdmin: boolean;
}

export interface Administration {
  listRoles(ctx: OrgContext): Promise<Role[]>;
  createRole(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    input: {
      readonly key: string;
      readonly name: string;
      readonly scope: 'organization' | 'project';
      readonly permissions: readonly string[];
    },
    call: ApiCall,
  ): Promise<AdminResult<Role>>;
  renameRole(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    name: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  setRolePermissions(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    permissions: readonly string[],
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  deleteRole(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  grantOrganization(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    input: { readonly subject: GrantSubject; readonly roleId: string },
    call: ApiCall,
  ): Promise<AdminResult<OrganizationGrant>>;
  revokeOrganizationGrant(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  changeGrantRole(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
    roleId: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  suspendUser(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    userId: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
  reactivateUser(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    userId: string,
    call: ApiCall,
  ): Promise<AdminResult<null>>;
}

export interface AdministrationDeps {
  readonly roles: RoleRepository;
  readonly grants: GrantRepository;
  readonly users: Pick<UserRepository, 'get'>;
  readonly providers: Pick<ReadonlyMap<string, IdentityProvider>, 'has'>;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
  /**
   * Runs after a user is suspended or loses their last organization grant; production passes
   * `ServicePrincipalService.creatorOffboarded`.
   */
  readonly onCreatorOffboarded?: (
    ctx: OrgContext,
    input: { readonly userId: string; readonly cause: CreatorOffboardingCause },
  ) => Promise<void> | void;
}

const GROUP_VALUE_MAX_LENGTH = 256;
const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_GROUP_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const DEFAULT_ROLE_KEYS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map(({ key }) => key));
const REPOSITORY_REFUSED_PERMISSIONS = ['The repository refused the permission list'];

const OK: AdminResult<null> = Object.freeze({ ok: true, value: null });

function fail(error: AdminError, details?: readonly string[]): AdminResult<never> {
  return details === undefined ? { ok: false, error } : { ok: false, error, details };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isAuditTargetId(value: unknown): value is string {
  if (!isId(value)) return false;
  const cleaned = redactValue(value, 200, 'id');
  return cleaned.ok && cleaned.value === value;
}

function isValidName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    !UNSAFE_NAME_CHARACTER.test(name) &&
    codePointLength(name) >= 1 &&
    codePointLength(name) <= ROLE_NAME_MAX_LENGTH
  );
}

function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && ROLE_KEY_PATTERN.test(key) && !DEFAULT_ROLE_KEYS.has(key);
}

function permissionProblems(scope: unknown, permissions: unknown): string[] {
  if (scope !== 'organization' && scope !== 'project') {
    return ['Role scope must be organization or project'];
  }
  if (!Array.isArray(permissions) || permissions.some((name) => typeof name !== 'string')) {
    return ['Permissions must be a list of strings'];
  }
  return rolePermissionProblems(scope, permissions as string[]);
}

type NormalizedSubject =
  | { readonly ok: true; readonly subject: GrantSubject }
  | { readonly ok: false; readonly error: 'invalid_subject' | 'unknown_provider' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface Actor {
  readonly userId: string;
  readonly permissions: PermissionView;
  readonly isAdmin: boolean;
}

function normalizeActor(raw: unknown): Actor | null {
  if (!isObject(raw)) return null;
  if (raw['kind'] !== 'organization') return null;
  const { userId, permissions, isOrganizationAdmin } = raw;
  if (!isId(userId) || !isPermissionView(permissions)) return null;
  return {
    userId,
    permissions,
    isAdmin: isOrganizationAdmin === true,
  };
}

function withinActor(actor: Actor, permissions: readonly string[]): boolean {
  return actor.isAdmin || permissions.every((name) => actor.permissions.has(name));
}

export function createAdministration(deps: AdministrationDeps): Administration {
  const { roles, grants, users, providers, clock, ids } = deps;

  const now = (): string => isoTimestamp(clock.now());

  function tryMutationAudit(
    call: ApiCall,
    actor: Actor,
    action: AuditAction,
    targetType: string,
    targetId: string,
    stamp: string,
    changes?: AuditEventInput['changes'],
  ): { audit: AuditEvent; idempotency?: IdempotencyRecord } | null {
    const result = auditEvent({
      id: ids.ulid(),
      now: stamp,
      action,
      actor: { type: 'user', id: actor.userId },
      context: call.audit,
      target: { type: targetType, id: targetId },
      ...(changes === undefined ? {} : { changes }),
    });
    if (!result.ok) return null;
    return {
      audit: result.event,
      ...(call.idempotency === undefined ? {} : { idempotency: call.idempotency }),
    };
  }

  function mutationAudit(
    ...args: Parameters<typeof tryMutationAudit>
  ): NonNullable<ReturnType<typeof tryMutationAudit>> {
    const result = tryMutationAudit(...args);
    if (result === null) throw new TypeError('Invalid administration audit event');
    return result;
  }

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The change is already stored; a failing sink must not report it as failed.
    }
  }

  const roleEvent = (ctx: OrgContext, actor: Actor, action: string, roleId: string): void =>
    emit({ event: 'role.changed', action, orgId: ctx.orgId, roleId, actorUserId: actor.userId });

  const grantEvent = (
    ctx: OrgContext,
    actor: Actor,
    action: string,
    grantId: string,
    roleId: string,
    previousRoleId?: string,
  ): void =>
    emit({
      event: 'grant.changed',
      action,
      orgId: ctx.orgId,
      grantId,
      roleId,
      ...(previousRoleId === undefined ? {} : { previousRoleId }),
      actorUserId: actor.userId,
    });

  const userEvent = (ctx: OrgContext, actor: Actor, action: string, userId: string): void =>
    emit({ event: 'user.changed', action, orgId: ctx.orgId, userId, actorUserId: actor.userId });

  async function creatorOffboarded(
    ctx: OrgContext,
    userId: string,
    cause: CreatorOffboardingCause,
  ): Promise<void> {
    const callback = deps.onCreatorOffboarded;
    if (callback === undefined) return;
    try {
      await callback(ctx, { userId, cause });
    } catch (error) {
      try {
        deps.log({
          level: 'warn',
          event: 'user.offboarding_callback_failed',
          orgId: ctx.orgId,
          userId,
          cause,
          error: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // The change is stored; neither the callback nor the sink may report it as failed.
      }
    }
  }

  function deny(ctx: OrgContext, actor: Actor | null, action: string): AdminResult<never> {
    emit({ event: 'admin.denied', action, orgId: ctx.orgId, actorUserId: actor?.userId ?? null });
    return fail('forbidden');
  }

  function requireFence(actor: Actor, fence: MutationFence | undefined): MutationFence {
    if (typeof fence !== 'object' || fence === null || fence.userId !== actor.userId) {
      throw new TypeError('the mutation fence must belong to the acting user');
    }
    return fence;
  }

  function expectsRevision(fence: MutationFence, key: 'role' | 'grant' = 'role'): boolean {
    return Number.isSafeInteger(fence.expected[key]);
  }

  function fencedFailure(
    ctx: OrgContext,
    actor: Actor,
    action: string,
    result: 'authority' | 'conflict' | 'indeterminate',
  ): AdminResult<never> {
    return result === 'authority' ? deny(ctx, actor, action) : fail(result);
  }

  function authorize(
    ctx: OrgContext,
    raw: unknown,
    action: string,
    permission: Permission,
  ): Actor | null {
    const actor = normalizeActor(raw);
    if (actor === null || !actor.permissions.has(permission)) {
      deny(ctx, actor, action);
      return null;
    }
    return actor;
  }

  function normalizeSubject(subject: unknown): NormalizedSubject {
    if (!isObject(subject)) return { ok: false, error: 'invalid_subject' };
    if (subject['type'] === 'email') {
      const value = subject['value'];
      const email = typeof value === 'string' ? normalizeEmail(value) : null;
      return email === null
        ? { ok: false, error: 'invalid_subject' }
        : { ok: true, subject: { type: 'email', value: email } };
    }
    if (subject['type'] === 'group') {
      const { provider, value } = subject;
      if (typeof provider !== 'string' || !providers.has(provider)) {
        return { ok: false, error: 'unknown_provider' };
      }
      if (
        typeof value !== 'string' ||
        value !== value.trim() ||
        UNSAFE_GROUP_CHARACTER.test(value) ||
        codePointLength(value) < 1 ||
        codePointLength(value) > GROUP_VALUE_MAX_LENGTH
      ) {
        return { ok: false, error: 'invalid_subject' };
      }
      return { ok: true, subject: { type: 'group', provider, value } };
    }
    return { ok: false, error: 'invalid_subject' };
  }

  async function findGrant(ctx: OrgContext, id: string): Promise<OrganizationGrant | null> {
    const all = await grants.listOrganization(ctx);
    return all.find((grant) => grant.id === id) ?? null;
  }

  async function changeStatus(
    ctx: OrgContext,
    rawActor: ActorContext,
    fence: MutationFence | undefined,
    action: string,
    userId: string,
    run: (actor: Actor, held: MutationFence) => Promise<AdminResult<null>>,
  ): Promise<AdminResult<null>> {
    const actor = authorize(ctx, rawActor, action, 'org:users:write');
    if (actor === null) return fail('forbidden');
    const held = requireFence(actor, fence);
    if (!isAuditTargetId(userId)) return fail('not_found');
    const user = await users.get(ctx, userId);
    if (user === null) return fail('not_found');
    if (!actor.isAdmin && (await grants.isProtectedHolder(ctx, userId))) {
      return deny(ctx, actor, action);
    }
    return run(actor, held);
  }

  return {
    listRoles: (ctx) => roles.list(ctx),

    async createRole(ctx, rawActor, fence, input, call) {
      const actor = authorize(ctx, rawActor, 'created', 'org:roles:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!isValidKey(input.key)) return fail('invalid_key');
      if (!isValidName(input.name)) return fail('invalid_name');
      const problems = permissionProblems(input.scope, input.permissions);
      if (problems.length > 0) return fail('invalid_permission', problems);
      if (!withinActor(actor, input.permissions)) return deny(ctx, actor, 'created');
      const id = ids.ulid();
      const stamp = now();
      const opId = ids.ulid();
      const audit = tryMutationAudit(call, actor, 'role.create', 'role', id, stamp, {
        key: { new: input.key },
        name: { new: input.name },
        scope: { new: input.scope },
        permissions: { new: [...input.permissions] },
      });
      if (audit === null) return fail('invalid_name');
      const result = await roles.create(ctx, held, {
        id,
        key: input.key,
        name: input.name,
        scope: input.scope,
        permissions: [...input.permissions],
        now: stamp,
        opId,
        ...audit,
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'created', result);
      }
      if (result === 'duplicate_key') return fail('duplicate');
      if (result === 'invalid_permissions') {
        return fail('invalid_permission', REPOSITORY_REFUSED_PERMISSIONS);
      }
      roleEvent(ctx, actor, 'created', id);
      return {
        ok: true,
        value: {
          id,
          key: input.key,
          name: input.name,
          scope: input.scope,
          isSystem: false,
          protectsLastHolder: false,
          revision: 1,
          permissions: [...input.permissions],
        },
      };
    },

    async renameRole(ctx, rawActor, fence, id, name, call) {
      const actor = authorize(ctx, rawActor, 'renamed', 'org:roles:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!expectsRevision(held)) return fail('invalid_revision');
      if (!isAuditTargetId(id)) return fail('not_found');
      if (!isValidName(name)) return fail('invalid_name');
      const stamp = now();
      const opId = ids.ulid();
      const audit = tryMutationAudit(call, actor, 'role.rename', 'role', id, stamp, {
        name: { new: name },
      });
      if (audit === null) return fail('invalid_name');
      if (!actor.isAdmin) {
        const role = await roles.get(ctx, id);
        if (role === null) return fail('not_found');
        if (!withinActor(actor, role.permissions.filter(isPermission)))
          return deny(ctx, actor, 'renamed');
      }
      const result = await roles.rename(ctx, held, {
        id,
        name,
        now: stamp,
        opId,
        ...audit,
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'renamed', result);
      }
      if (result !== 'renamed') return fail(result);
      roleEvent(ctx, actor, 'renamed', id);
      return OK;
    },

    async setRolePermissions(ctx, rawActor, fence, id, permissions, call) {
      const actor = authorize(ctx, rawActor, 'permissions_set', 'org:roles:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!expectsRevision(held)) return fail('invalid_revision');
      if (!isAuditTargetId(id)) return fail('not_found');
      const role = await roles.get(ctx, id);
      if (role === null) return fail('not_found');
      if (role.protectsLastHolder) return fail('locked');
      if (!withinActor(actor, role.permissions.filter(isPermission)))
        return deny(ctx, actor, 'permissions_set');
      const problems = permissionProblems(role.scope, permissions);
      if (problems.length > 0) return fail('invalid_permission', problems);
      if (!withinActor(actor, permissions)) return deny(ctx, actor, 'permissions_set');
      const stamp = now();
      const result = await roles.setPermissions(ctx, held, {
        id,
        permissions: [...permissions],
        now: stamp,
        opId: ids.ulid(),
        ...mutationAudit(call, actor, 'role.permissions_set', 'role', id, stamp, {
          permissions: { new: [...permissions] },
        }),
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'permissions_set', result);
      }
      if (result === 'invalid_permissions') {
        return fail('invalid_permission', REPOSITORY_REFUSED_PERMISSIONS);
      }
      if (result !== 'updated') return fail(result);
      roleEvent(ctx, actor, 'permissions_set', id);
      return OK;
    },

    async deleteRole(ctx, rawActor, fence, id, call) {
      const actor = authorize(ctx, rawActor, 'deleted', 'org:roles:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!expectsRevision(held)) return fail('invalid_revision');
      if (!isAuditTargetId(id)) return fail('not_found');
      if (!actor.isAdmin) {
        const role = await roles.get(ctx, id);
        if (role === null) return fail('not_found');
        if (!withinActor(actor, role.permissions.filter(isPermission)))
          return deny(ctx, actor, 'deleted');
      }
      const stamp = now();
      const result = await roles.delete(ctx, held, {
        id,
        opId: ids.ulid(),
        ...mutationAudit(call, actor, 'role.delete', 'role', id, stamp),
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'deleted', result);
      }
      if (result === 'system') return fail('system_role');
      if (result !== 'deleted') return fail(result);
      roleEvent(ctx, actor, 'deleted', id);
      return OK;
    },

    async grantOrganization(ctx, rawActor, fence, input, call) {
      const actor = authorize(ctx, rawActor, 'granted', 'org:grants:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      const normalized = normalizeSubject(input.subject);
      if (!normalized.ok) return fail(normalized.error);
      if (!isId(input.roleId)) return fail('role_scope_mismatch');
      const role = await roles.get(ctx, input.roleId);
      if (role === null || role.scope !== 'organization') return fail('role_scope_mismatch');
      if (!actor.isAdmin && role.protectsLastHolder) return deny(ctx, actor, 'granted');
      if (!withinActor(actor, role.permissions)) return deny(ctx, actor, 'granted');
      if ((await users.get(ctx, actor.userId)) === null) return deny(ctx, actor, 'granted');
      const id = ids.ulid();
      const createdAt = now();
      const result = await grants.createOrganization(ctx, held, {
        id,
        subject: normalized.subject,
        roleId: role.id,
        createdBy: actor.userId,
        now: createdAt,
        opId: ids.ulid(),
        ...mutationAudit(call, actor, 'grant.create', 'grant', id, createdAt, {
          subject_kind: { new: normalized.subject.type },
          role_id: { new: role.id },
        }),
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'granted', result);
      }
      if (result !== 'created') return fail(result);
      grantEvent(ctx, actor, 'granted', id, role.id);
      return {
        ok: true,
        value: {
          id,
          subject: normalized.subject,
          roleId: role.id,
          createdBy: actor.userId,
          createdAt,
          revision: 1,
        },
      };
    },

    async revokeOrganizationGrant(ctx, rawActor, fence, id, call) {
      const actor = authorize(ctx, rawActor, 'revoked', 'org:grants:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!expectsRevision(held, 'grant')) return fail('invalid_revision');
      if (!isAuditTargetId(id)) return fail('not_found');
      const grant = await findGrant(ctx, id);
      if (grant === null) return fail('not_found');
      if (!actor.isAdmin) {
        const role = await roles.get(ctx, grant.roleId);
        if (role === null || role.protectsLastHolder) return deny(ctx, actor, 'revoked');
      }
      const stamp = now();
      const result = await grants.deleteOrganization(ctx, held, {
        id,
        opId: ids.ulid(),
        ...mutationAudit(call, actor, 'grant.revoke', 'grant', id, stamp),
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'revoked', result);
      }
      if (typeof result === 'string') return fail(result);
      grantEvent(ctx, actor, 'revoked', id, grant.roleId);
      if (result.offboardedUserId !== null) {
        await creatorOffboarded(ctx, result.offboardedUserId, 'membership_removed');
      }
      return OK;
    },

    async changeGrantRole(ctx, rawActor, fence, id, roleId, call) {
      const actor = authorize(ctx, rawActor, 'role_changed', 'org:grants:write');
      if (actor === null) return fail('forbidden');
      const held = requireFence(actor, fence);
      if (!expectsRevision(held, 'grant')) return fail('invalid_revision');
      if (!isAuditTargetId(id)) return fail('not_found');
      const grant = await findGrant(ctx, id);
      if (grant === null) return fail('not_found');
      if (!isId(roleId)) return fail('role_scope_mismatch');
      const next = await roles.get(ctx, roleId);
      if (next === null || next.scope !== 'organization') return fail('role_scope_mismatch');
      if (!actor.isAdmin) {
        const current = await roles.get(ctx, grant.roleId);
        if (
          current === null ||
          current.protectsLastHolder ||
          next.protectsLastHolder ||
          !withinActor(actor, current.permissions) ||
          !withinActor(actor, next.permissions)
        ) {
          return deny(ctx, actor, 'role_changed');
        }
      }
      const stamp = now();
      const result = await grants.changeRole(ctx, held, {
        id,
        roleId,
        now: stamp,
        opId: ids.ulid(),
        ...mutationAudit(call, actor, 'grant.role_change', 'grant', id, stamp, {
          role_id: { new: roleId },
        }),
      });
      if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
        return fencedFailure(ctx, actor, 'role_changed', result);
      }
      if (result !== 'updated') return fail(result);
      grantEvent(ctx, actor, 'role_changed', id, roleId, grant.roleId);
      return OK;
    },

    suspendUser: (ctx, rawActor, fence, userId, call) =>
      changeStatus(ctx, rawActor, fence, 'suspended', userId, async (actor, held) => {
        const stamp = now();
        const result = await grants.suspendUser(ctx, held, {
          userId,
          now: stamp,
          ...mutationAudit(call, actor, 'user.suspend', 'user', userId, stamp),
        });
        if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
          return fencedFailure(ctx, actor, 'suspended', result);
        }
        if (result === 'unchanged') return OK;
        if (result !== 'suspended') return fail(result);
        userEvent(ctx, actor, 'suspended', userId);
        await creatorOffboarded(ctx, userId, 'suspended');
        return OK;
      }),

    reactivateUser: (ctx, rawActor, fence, userId, call) =>
      changeStatus(ctx, rawActor, fence, 'reactivated', userId, async (actor, held) => {
        const stamp = now();
        const result = await grants.reactivateUser(ctx, held, {
          userId,
          now: stamp,
          ...mutationAudit(call, actor, 'user.reactivate', 'user', userId, stamp),
        });
        if (result === 'authority' || result === 'conflict' || result === 'indeterminate') {
          return fencedFailure(ctx, actor, 'reactivated', result);
        }
        if (result === 'unchanged') return OK;
        if (result !== 'reactivated') return fail('not_found');
        userEvent(ctx, actor, 'reactivated', userId);
        return OK;
      }),
  };
}
