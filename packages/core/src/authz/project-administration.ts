import type { GrantSubject } from '../db/grants.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp, isUlid } from '../ids.js';
import { normalizeEmail } from '../identity/policy.js';
import type { AdminLog, AdminResult, AdministrationDeps } from './administration.js';
import type { MutationFence } from './fence.js';
import type { ProjectActor } from './project-actor.js';

const WRITE_PERMISSION = 'project:grants:write';
const GROUP_VALUE_MAX_LENGTH = 256;
const UNSAFE_GROUP_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface ProviderAnchor {
  readonly provider: string;
  readonly anchor: string;
  readonly emailAuthoritative: boolean;
}

export interface ProjectGrantStore {
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly id: string;
      readonly projectId: string;
      readonly subject: GrantSubject;
      readonly roleId: string;
      readonly now: string;
      readonly providerAnchors: readonly ProviderAnchor[];
    },
  ): Promise<
    'created' | 'duplicate' | 'forbidden' | 'role_scope_mismatch' | 'conflict' | 'indeterminate'
  >;
  /**
   * The fence carries the grant revision at `access_grant:<id>` and the new role revision at `role:<roleId>`.
   * These keys are defined by projectGrantKey and projectGrantRoleKey in packages/db-sqlite, which core cannot import.
   */
  changeRole(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly id: string;
      readonly projectId: string;
      readonly roleId: string;
      readonly now: string;
      readonly providerAnchors: readonly ProviderAnchor[];
    },
  ): Promise<
    'updated' | 'forbidden' | 'role_scope_mismatch' | 'not_found' | 'conflict' | 'indeterminate'
  >;
  /** The fence carries the grant revision at `access_grant:<id>`. */
  delete(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly id: string;
      readonly projectId: string;
      readonly providerAnchors: readonly ProviderAnchor[];
    },
  ): Promise<
    | { readonly status: 'deleted'; readonly offboardedUserId: string | null }
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'indeterminate'
  >;
}

export interface ProjectGrantInput {
  readonly subject: GrantSubject;
  readonly roleId: string;
}

export interface ProjectGrantCreated {
  readonly id: string;
  readonly projectId: string;
  readonly subject: GrantSubject;
  readonly roleId: string;
}

/**
 * Takes a ProjectActor only. Authority is project:grants:write on the exact project from the union of
 * organization and project grants; the store re-checks it, and the replacement role's permissions
 * against the actor's live set, inside the write batch.
 */
export interface ProjectAdministration {
  grant(
    ctx: OrgContext,
    actor: ProjectActor,
    fence: MutationFence,
    projectId: string,
    input: ProjectGrantInput,
  ): Promise<AdminResult<ProjectGrantCreated>>;
  /** The fence must carry the expected grant revision and the new role's revision. */
  changeRole(
    ctx: OrgContext,
    actor: ProjectActor,
    fence: MutationFence,
    projectId: string,
    grantId: string,
    roleId: string,
  ): Promise<AdminResult<null>>;
  /** The fence must carry the expected grant revision. Narrow-only: allowed on an archived project. */
  revoke(
    ctx: OrgContext,
    actor: ProjectActor,
    fence: MutationFence,
    projectId: string,
    grantId: string,
  ): Promise<AdminResult<null>>;
}

export interface ProjectAdministrationDeps {
  readonly onCreatorOffboarded?: AdministrationDeps['onCreatorOffboarded'];
  readonly grants: ProjectGrantStore;
  readonly providers: Pick<ReadonlyMap<string, unknown>, 'has'>;
  readonly providerAnchors: readonly ProviderAnchor[];
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

const OK_NULL: AdminResult<null> = Object.freeze({ ok: true, value: null });

function fail(error: Extract<AdminResult<never>, { ok: false }>['error']): AdminResult<never> {
  return { ok: false, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createProjectAdministration(
  deps: ProjectAdministrationDeps,
): ProjectAdministration {
  const { grants, providers, providerAnchors, clock, ids } = deps;

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
    userId: string | null,
    action: string,
    projectId: string,
  ): AdminResult<never> {
    emit({ event: 'admin.denied', action, orgId: ctx.orgId, projectId, actorUserId: userId });
    return fail('forbidden');
  }

  function authorize(
    ctx: OrgContext,
    raw: unknown,
    projectId: string,
    action: string,
  ): ProjectActor | null {
    if (!isObject(raw)) {
      deny(ctx, null, action, projectId);
      return null;
    }
    const userId = typeof raw['userId'] === 'string' && raw['userId'] !== '' ? raw['userId'] : null;
    if (
      userId === null ||
      raw['kind'] !== 'project' ||
      raw['orgId'] !== ctx.orgId ||
      raw['projectId'] !== projectId ||
      !(raw['permissions'] instanceof Set) ||
      !raw['permissions'].has(WRITE_PERMISSION)
    ) {
      deny(ctx, userId, action, projectId);
      return null;
    }
    return raw as unknown as ProjectActor;
  }

  function requireFence(actor: ProjectActor, fence: MutationFence | undefined): MutationFence {
    if (typeof fence !== 'object' || fence === null || fence.userId !== actor.userId) {
      throw new TypeError('the mutation fence must belong to the acting user');
    }
    return fence;
  }

  function expects(fence: MutationFence, ...keys: string[]): boolean {
    return keys.every((key) => Number.isSafeInteger(fence.expected[key]));
  }

  function normalizeSubject(
    subject: unknown,
  ): GrantSubject | 'invalid_subject' | 'unknown_provider' {
    if (!isObject(subject)) return 'invalid_subject';
    if (subject['type'] === 'email') {
      const value = subject['value'];
      const email = typeof value === 'string' ? normalizeEmail(value) : null;
      return email === null ? 'invalid_subject' : { type: 'email', value: email };
    }
    if (subject['type'] !== 'group') return 'invalid_subject';
    const { provider, value } = subject;
    if (
      typeof provider !== 'string' ||
      !providers.has(provider) ||
      !providerAnchors.some((entry) => entry.provider === provider)
    ) {
      return 'unknown_provider';
    }
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      UNSAFE_GROUP_CHARACTER.test(value) ||
      Array.from(value).length < 1 ||
      Array.from(value).length > GROUP_VALUE_MAX_LENGTH
    ) {
      return 'invalid_subject';
    }
    return { type: 'group', provider, value };
  }

  function changed(
    ctx: OrgContext,
    actor: ProjectActor,
    action: string,
    grantId: string,
    roleId?: string,
  ): void {
    emit({
      event: 'project.grant.changed',
      action,
      orgId: ctx.orgId,
      projectId: actor.projectId,
      grantId,
      ...(roleId === undefined ? {} : { roleId }),
      actorUserId: actor.userId,
    });
  }

  function refused(
    ctx: OrgContext,
    actor: ProjectActor,
    action: string,
    answer: Exclude<
      Awaited<ReturnType<ProjectGrantStore[keyof ProjectGrantStore]>>,
      | 'created'
      | 'updated'
      | { readonly status: 'deleted'; readonly offboardedUserId: string | null }
    >,
  ): AdminResult<never> {
    switch (answer) {
      case 'forbidden':
        return deny(ctx, actor.userId, action, actor.projectId);
      case 'duplicate':
      case 'role_scope_mismatch':
      case 'not_found':
      case 'conflict':
      case 'indeterminate':
        return fail(answer);
    }
  }

  return {
    async grant(ctx, rawActor, rawFence, projectId, input) {
      const action = 'project.grant.create';
      const actor = authorize(ctx, rawActor, projectId, action);
      if (actor === null) return fail('forbidden');
      const fence = requireFence(actor, rawFence);
      const subject = normalizeSubject(input?.subject);
      if (typeof subject === 'string') return fail(subject);
      if (!isUlid(input.roleId)) return fail('role_scope_mismatch');
      const id = ids.ulid();
      const answer = await grants.create(ctx, fence, {
        id,
        projectId,
        subject,
        roleId: input.roleId,
        now: now(),
        providerAnchors,
      });
      if (answer !== 'created') return refused(ctx, actor, action, answer);
      changed(ctx, actor, 'create', id, input.roleId);
      return { ok: true, value: { id, projectId, subject, roleId: input.roleId } };
    },

    async changeRole(ctx, rawActor, rawFence, projectId, grantId, roleId) {
      const action = 'project.grant.change_role';
      const actor = authorize(ctx, rawActor, projectId, action);
      if (actor === null) return fail('forbidden');
      const fence = requireFence(actor, rawFence);
      if (!isUlid(grantId)) return fail('not_found');
      if (!isUlid(roleId)) return fail('role_scope_mismatch');
      if (!expects(fence, `access_grant:${grantId}`, `role:${roleId}`)) {
        return fail('invalid_revision');
      }
      const answer = await grants.changeRole(ctx, fence, {
        id: grantId,
        projectId,
        roleId,
        now: now(),
        providerAnchors,
      });
      if (answer !== 'updated') return refused(ctx, actor, action, answer);
      changed(ctx, actor, 'change_role', grantId, roleId);
      return OK_NULL;
    },

    async revoke(ctx, rawActor, rawFence, projectId, grantId) {
      const action = 'project.grant.revoke';
      const actor = authorize(ctx, rawActor, projectId, action);
      if (actor === null) return fail('forbidden');
      const fence = requireFence(actor, rawFence);
      if (!isUlid(grantId)) return fail('not_found');
      if (!expects(fence, `access_grant:${grantId}`)) return fail('invalid_revision');
      const answer = await grants.delete(ctx, fence, {
        id: grantId,
        projectId,
        providerAnchors,
      });
      if (typeof answer === 'string') return refused(ctx, actor, action, answer);
      changed(ctx, actor, 'revoke', grantId);
      if (answer.offboardedUserId !== null && deps.onCreatorOffboarded !== undefined) {
        const userId = answer.offboardedUserId;
        const cause = 'membership_removed';
        try {
          await deps.onCreatorOffboarded(ctx, { userId, cause });
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
            // The grant is deleted; callback and sink failures must not change the result.
          }
        }
      }
      return OK_NULL;
    },
  };
}
