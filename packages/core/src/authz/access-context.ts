import type { Principal, RequestContext, RouteBoundary } from '../plugin.js';
import { buildOrganizationActor } from './actor.js';
import type { ActorAccessSnapshot, OrganizationActor } from './actor.js';

export type AccessRouteClass = Exclude<RouteBoundary, 'package'>;

/** PB-94 request key: the authenticated credential once known, otherwise the client address. */
export type AccessRateKey =
  | {
      readonly stage: 'authenticated';
      readonly tokenSelector: string | null;
      readonly principalId: string;
      readonly routeClass: AccessRouteClass;
    }
  | {
      readonly stage: 'anonymous';
      readonly ip: string | null;
      readonly routeClass: AccessRouteClass;
    };

/** Core-only view of an authorized request; never handed to plugins. */
export interface AccessContextSnapshot {
  readonly principal: Principal | null;
  readonly projectId: string | null;
  readonly boundary: AccessRouteClass;
  readonly sessionId: string | null;
  readonly actor: ActorAccessSnapshot | null;
  readonly rateKey: AccessRateKey;
}

const snapshots = new WeakMap<RequestContext, AccessContextSnapshot>();

const ROUTE_CLASSES = [
  'none',
  'organization',
  'project',
  'self',
] as const satisfies readonly AccessRouteClass[];
const PRINCIPAL_KINDS = [
  'user',
  'service',
  'customer',
] as const satisfies readonly Principal['kind'][];

function refuse(): never {
  throw new TypeError('invalid access context snapshot');
}

function oneOf<T>(values: readonly T[], value: unknown): T {
  return (values as readonly unknown[]).includes(value) ? (value as T) : refuse();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : refuse();
}

function text(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : refuse();
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function names(value: unknown): readonly string[] {
  return Array.isArray(value) ? Object.freeze(value.map(text)) : refuse();
}

function principalOf(value: unknown): Principal | null {
  if (value === null) return null;
  const raw = record(value);
  return Object.freeze({ kind: oneOf(PRINCIPAL_KINDS, raw['kind']), id: text(raw['id']) });
}

function actorOf(value: unknown): ActorAccessSnapshot | null {
  if (value === null) return null;
  const raw = record(value);
  const session = record(raw['session']);
  const userId = text(record(raw['user'])['id']);
  if (Object.hasOwn(session, 'userId') && session['userId'] !== userId) refuse();
  if (typeof raw['protectedHolder'] !== 'boolean') refuse();
  return Object.freeze({
    session: Object.freeze(
      Object.hasOwn(session, 'userId')
        ? { id: text(session['id']), userId }
        : { id: text(session['id']) },
    ),
    user: Object.freeze({ id: userId }),
    organizationPermissions: names(raw['organizationPermissions']),
    projectPermissions: names(raw['projectPermissions']),
    protectedHolder: raw['protectedHolder'],
  });
}

function rateKeyOf(
  value: unknown,
  principal: Principal | null,
  boundary: AccessRouteClass,
): AccessRateKey {
  const raw = record(value);
  if (raw['routeClass'] !== boundary) refuse();
  if (principal === null) {
    if (raw['stage'] !== 'anonymous') refuse();
    return Object.freeze({ stage: 'anonymous', ip: optionalText(raw['ip']), routeClass: boundary });
  }
  if (raw['stage'] !== 'authenticated' || raw['principalId'] !== principal.id) refuse();
  const tokenSelector = optionalText(raw['tokenSelector']);
  if (principal.kind === 'service' && tokenSelector === null) refuse();
  return Object.freeze({
    stage: 'authenticated',
    tokenSelector,
    principalId: principal.id,
    routeClass: boundary,
  });
}

function samePrincipal(a: Principal | null, b: Principal | null): boolean {
  return a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id;
}

function checkConsistency(ctx: RequestContext, snapshot: AccessContextSnapshot): void {
  const { principal, projectId, boundary, sessionId, actor } = snapshot;
  if (!samePrincipal(principal, ctx.principal) || projectId !== ctx.projectId) refuse();
  if ((boundary === 'project') !== (projectId !== null)) refuse();
  if (boundary !== 'none' && principal === null) refuse();
  if (boundary === 'none' && (actor !== null || sessionId !== null)) refuse();
  if (principal?.kind !== 'user' && (actor !== null || sessionId !== null)) refuse();
  if (actor !== null && (actor.user.id !== principal?.id || actor.session.id !== sessionId)) {
    refuse();
  }
}

/**
 * Records the snapshot once per kernel-owned context. A second call, a malformed snapshot, or one
 * that disagrees with the context's principal or project throws and stores nothing.
 */
export function setAccessContext(ctx: RequestContext, snapshot: AccessContextSnapshot): void {
  if (snapshots.has(ctx)) refuse();
  const raw = record(snapshot);
  const boundary = oneOf(ROUTE_CLASSES, raw['boundary']);
  const principal = principalOf(raw['principal']);
  const stored: AccessContextSnapshot = Object.freeze({
    principal,
    projectId: optionalText(raw['projectId']),
    boundary,
    sessionId: optionalText(raw['sessionId']),
    actor: actorOf(raw['actor']),
    rateKey: rateKeyOf(raw['rateKey'], principal, boundary),
  });
  checkConsistency(ctx, stored);
  snapshots.set(ctx, stored);
}

export function accessContextOf(ctx: RequestContext): AccessContextSnapshot | null {
  return snapshots.get(ctx) ?? null;
}

function readOnlyView<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const values = new Set(source);
  const view: ReadonlySet<T> = {
    get size() {
      return values.size;
    },
    has: (value) => values.has(value),
    forEach: (callback, thisArg?: unknown) => {
      values.forEach((value) => callback.call(thisArg, value, value, view));
    },
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    [Symbol.iterator]: () => values.values(),
  };
  return Object.freeze(view);
}

export function organizationActorOf(ctx: RequestContext): OrganizationActor | null {
  const snapshot = snapshots.get(ctx);
  if (snapshot?.actor == null || snapshot.boundary !== 'organization') return null;
  const actor = buildOrganizationActor('organization', snapshot.actor);
  if (actor === null) return null;
  return Object.freeze({ ...actor, permissions: readOnlyView(actor.permissions) });
}
