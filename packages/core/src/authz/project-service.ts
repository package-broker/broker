import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp, isUlid } from '../ids.js';
import type { ActorContext, AdminLog } from './administration.js';
import type { MutationFence } from './fence.js';
import type { ProjectActor } from './project-actor.js';

export const PROJECT_NAME_MAX_LENGTH = 100;
export const TOKEN_MAX_SCOPES = ['read', 'write', 'full'] as const;

export type TokenMaxScope = (typeof TOKEN_MAX_SCOPES)[number];
export type ProjectStatus = 'active' | 'archived';

export interface ProjectChanges {
  readonly name?: string;
  readonly tokenMaxScope?: TokenMaxScope;
  readonly requirePublishApproval?: boolean;
}

export interface ProjectCreateInput {
  readonly slug: string;
  readonly name: string;
  readonly tokenMaxScope?: TokenMaxScope;
  readonly requirePublishApproval?: boolean;
  readonly initialRoleId?: string;
}

/**
 * The fenced persistence the service drives; the db layer's project repository satisfies it.
 * `create` inserts the project and the creator's owner grant in one batch.
 */
export interface ProjectStore {
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: ProjectCreateInput & { readonly id: string; readonly now: string },
  ): Promise<
    | 'created'
    | 'duplicate'
    | 'invalid_slug'
    | 'reserved_slug'
    | 'initial_role_not_allowed'
    | 'authority'
    | 'indeterminate'
  >;
  update(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    changes: ProjectChanges,
    now: string,
  ): Promise<
    'updated' | 'unchanged' | 'archived' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'
  >;
  archive(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    now: string,
  ): Promise<'archived' | 'not_active' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'>;
  restore(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    now: string,
  ): Promise<
    'restored' | 'not_archived' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'
  >;
}

export type ProjectError =
  | 'forbidden'
  | 'invalid_name'
  | 'invalid_scope'
  | 'invalid_policy'
  | 'invalid_revision'
  | 'invalid_slug'
  | 'reserved_slug'
  | 'initial_role_not_allowed'
  | 'duplicate'
  | 'no_changes'
  | 'archived'
  | 'wrong_state'
  | 'not_found'
  | 'conflict'
  | 'indeterminate';

export type ProjectResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProjectError };

export interface ProjectService {
  createProject(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    input: ProjectCreateInput,
  ): Promise<ProjectResult<{ readonly id: string; readonly slug: string }>>;
  /** The fence must carry the expected `project` revision. */
  updateSettings(
    ctx: OrgContext,
    actor: ProjectActor,
    fence: MutationFence,
    id: string,
    changes: ProjectChanges,
  ): Promise<ProjectResult<null>>;
  /** The fence must carry the expected `project` revision. */
  archiveProject(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
  ): Promise<ProjectResult<null>>;
  /** The fence must carry the expected `project` revision; the store requires a fresh reauth. */
  restoreProject(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    id: string,
  ): Promise<ProjectResult<null>>;
}

export interface ProjectServiceDeps {
  readonly projects: ProjectStore;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

/** `narrow_write` is revoke or suspend only; any write that adds or widens access is `widening_write`. */
export type ProjectOperation =
  'registry' | 'token_issue' | 'inspect' | 'narrow_write' | 'widening_write';

const ARCHIVED_ALLOWED: ReadonlySet<ProjectOperation> = new Set(['inspect', 'narrow_write']);
const OPERATIONS: ReadonlySet<string> = new Set([
  'registry',
  'token_issue',
  'inspect',
  'narrow_write',
  'widening_write',
]);
interface OrgActor {
  readonly userId: string;
  readonly permissions: ReadonlySet<string>;
}

const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * Archive denies registry, token issuance and widening writes; organization-boundary inspection and narrow-only
 * writes (grant, token or principal revocation) stay allowed so an admin can prune before restore.
 */
export function projectOperationAllowed(
  status: ProjectStatus,
  operation: ProjectOperation,
): boolean {
  if (!OPERATIONS.has(operation)) return false;
  if (status === 'active') return true;
  return status === 'archived' && ARCHIVED_ALLOWED.has(operation);
}

const OK_NULL: ProjectResult<null> = Object.freeze({ ok: true, value: null });

function fail(error: ProjectError): ProjectResult<never> {
  return { ok: false, error };
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string' || UNSAFE_NAME_CHARACTER.test(name)) return false;
  const length = Array.from(name).length;
  return length >= 1 && length <= PROJECT_NAME_MAX_LENGTH;
}

function isScope(scope: unknown): scope is TokenMaxScope {
  return (TOKEN_MAX_SCOPES as readonly unknown[]).includes(scope);
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { projects, clock, ids } = deps;

  const now = (): string => isoTimestamp(clock.now());

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The change is already stored; a failing sink must not report it as failed.
    }
  }

  function changed(ctx: OrgContext, actor: OrgActor, action: string, projectId: string): void {
    emit({
      event: 'project.changed',
      action,
      orgId: ctx.orgId,
      projectId,
      actorUserId: actor.userId,
    });
  }

  function deny(ctx: OrgContext, actor: OrgActor | null, action: string): ProjectResult<never> {
    emit({ event: 'admin.denied', action, orgId: ctx.orgId, actorUserId: actor?.userId ?? null });
    return fail('forbidden');
  }

  function normalize(raw: unknown, scope: 'organization' | 'project'): OrgActor | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { userId, permissions, kind } = raw as Record<string, unknown>;
    if ((kind === 'project') !== (scope === 'project')) return null;
    if (typeof userId !== 'string' || userId === '' || !(permissions instanceof Set)) return null;
    return { userId, permissions: permissions as ReadonlySet<string> };
  }

  function requireFence(actor: OrgActor, fence: MutationFence | undefined): MutationFence {
    if (typeof fence !== 'object' || fence === null || fence.userId !== actor.userId) {
      throw new TypeError('the mutation fence must belong to the acting user');
    }
    return fence;
  }

  function hasRevision(fence: MutationFence): boolean {
    return Number.isSafeInteger(fence.expected['project']);
  }

  async function transition(
    ctx: OrgContext,
    rawActor: ActorContext,
    rawFence: MutationFence,
    id: string,
    action: 'archive' | 'restore',
  ): Promise<ProjectResult<null>> {
    const actor = normalize(rawActor, 'organization');
    if (actor === null || !actor.permissions.has('org:projects:archive')) {
      return deny(ctx, actor, `project.${action}`);
    }
    const fence = requireFence(actor, rawFence);
    if (!hasRevision(fence)) return fail('invalid_revision');
    if (!isUlid(id)) return fail('not_found');
    const answer =
      action === 'archive'
        ? await projects.archive(ctx, fence, id, now())
        : await projects.restore(ctx, fence, id, now());
    switch (answer) {
      case 'archived':
      case 'restored':
        changed(ctx, actor, action, id);
        return OK_NULL;
      case 'not_active':
      case 'not_archived':
        return fail('wrong_state');
      case 'authority':
        return deny(ctx, actor, `project.${action}`);
      default:
        return fail(answer);
    }
  }

  return {
    async createProject(ctx, rawActor, rawFence, input) {
      const actor = normalize(rawActor, 'organization');
      if (actor === null || !actor.permissions.has('org:projects:create')) {
        return deny(ctx, actor, 'project.create');
      }
      const fence = requireFence(actor, rawFence);
      if (!isValidName(input.name)) return fail('invalid_name');
      if (input.tokenMaxScope !== undefined && !isScope(input.tokenMaxScope)) {
        return fail('invalid_scope');
      }
      if (
        input.requirePublishApproval !== undefined &&
        typeof input.requirePublishApproval !== 'boolean'
      ) {
        return fail('invalid_policy');
      }
      if (input.initialRoleId !== undefined && !isUlid(input.initialRoleId)) {
        return fail('initial_role_not_allowed');
      }
      const id = ids.ulid();
      const answer = await projects.create(ctx, fence, { ...input, id, now: now() });
      if (answer === 'created') {
        changed(ctx, actor, 'create', id);
        return { ok: true, value: { id, slug: input.slug } };
      }
      return answer === 'authority' ? deny(ctx, actor, 'project.create') : fail(answer);
    },

    async updateSettings(ctx, rawActor, rawFence, id, changes) {
      const actor = normalize(rawActor, 'project');
      if (
        actor === null ||
        (rawActor as ProjectActor).kind !== 'project' ||
        (rawActor as ProjectActor).projectId !== id ||
        (rawActor as ProjectActor).orgId !== ctx.orgId ||
        !actor.permissions.has('project:settings:write')
      ) {
        return deny(ctx, actor, 'project.update');
      }
      const fence = requireFence(actor, rawFence);
      if (!hasRevision(fence)) return fail('invalid_revision');
      if (!isUlid(id)) return fail('not_found');
      if (
        changes.name === undefined &&
        changes.tokenMaxScope === undefined &&
        changes.requirePublishApproval === undefined
      ) {
        return fail('no_changes');
      }
      if (
        changes.requirePublishApproval !== undefined &&
        typeof changes.requirePublishApproval !== 'boolean'
      ) {
        return fail('invalid_policy');
      }
      if (changes.name !== undefined && !isValidName(changes.name)) return fail('invalid_name');
      if (changes.tokenMaxScope !== undefined && !isScope(changes.tokenMaxScope)) {
        return fail('invalid_scope');
      }
      const answer = await projects.update(ctx, fence, id, changes, now());
      switch (answer) {
        case 'updated':
          changed(ctx, actor, 'update', id);
          return OK_NULL;
        case 'unchanged':
          return OK_NULL;
        case 'authority':
          return deny(ctx, actor, 'project.update');
        default:
          return fail(answer);
      }
    },

    archiveProject: (ctx, actor, fence, id) => transition(ctx, actor, fence, id, 'archive'),

    restoreProject: (ctx, actor, fence, id) => transition(ctx, actor, fence, id, 'restore'),
  };
}
