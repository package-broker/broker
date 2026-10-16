import type { ActorContext } from './administration.js';

export type { ActorContext } from './administration.js';
export type { ProjectActor } from './project-actor.js';

export type ActorLookupBoundary = 'organization' | 'project';

/** The slice of a session lookup that an actor is built from. */
export interface ActorAccessSnapshot {
  readonly session: { readonly id: string; readonly userId?: string };
  readonly user: { readonly id: string };
  /** Permissions of organization-scope grant rows only, `project:*` names included. */
  readonly organizationPermissions: readonly string[];
  readonly projectPermissions: readonly string[];
  /** Whether a current organization-scope grant's stored role protects the last holder. */
  readonly protectedHolder: boolean;
}

export interface OrganizationActor extends ActorContext {
  readonly sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function idOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  return nonEmptyString(id) ? id : null;
}

function sessionOwnerMatches(session: unknown, userId: string): boolean {
  if (!isRecord(session) || !('userId' in session)) return true;
  return session['userId'] === userId;
}

/**
 * Null unless `boundary` is `'organization'` and `snapshot` is well formed. `projectPermissions`
 * never contributes, whatever the names look like.
 */
export function buildOrganizationActor(
  boundary: ActorLookupBoundary,
  snapshot: ActorAccessSnapshot,
): OrganizationActor | null {
  const raw: unknown = snapshot;
  if (boundary !== 'organization' || !isRecord(raw)) return null;
  const userId = idOf(raw['user']);
  const sessionId = idOf(raw['session']);
  const names = raw['organizationPermissions'];
  if (userId === null || sessionId === null || !Array.isArray(names)) return null;
  if (!sessionOwnerMatches(raw['session'], userId)) return null;
  const permissions = new Set<string>();
  for (const name of names as readonly unknown[]) {
    if (!nonEmptyString(name)) return null;
    permissions.add(name);
  }
  return Object.freeze({
    kind: 'organization',
    userId,
    sessionId,
    permissions,
    isOrganizationAdmin: raw['protectedHolder'] === true,
  });
}
