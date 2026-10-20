import { PACKAGE_BOUNDARY_PERMISSIONS, type ProjectActor } from '../authz/project-actor.js';
import { catalogueTokenEligible } from '../authz/catalogue.js';
import type { RequestContext } from '../plugin.js';
import type { AuthorizationDecision, AuthorizationRequest } from '../kernel/authorize.js';

const packageActors = new WeakMap<AuthorizationRequest, ProjectActor>();

export function packageActorOf(request: AuthorizationRequest): ProjectActor | null {
  return packageActors.get(request) ?? null;
}

function packagePermissionView(names: readonly string[]): ReadonlySet<string> {
  const values = new Set(names);
  const view: ReadonlySet<string> = {
    size: values.size,
    has: (name) => values.has(name),
    forEach: (callback, thisArg?: unknown) => {
      values.forEach((name) => callback.call(thisArg, name, name, view));
    },
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    [Symbol.iterator]: () => values.values(),
  };
  return Object.freeze(view);
}

export function setPackageActor(
  request: AuthorizationRequest,
  decision: Extract<AuthorizationDecision, { allow: true }>,
  effective: ReadonlySet<string>,
  token: boolean,
): void {
  if (request.route.boundary !== 'project' || decision.projectId === null) return;
  packageActors.set(
    request,
    Object.freeze({
      kind: 'project',
      userId: decision.principal.id,
      orgId: request.org.orgId,
      projectId: decision.projectId,
      permissions: packagePermissionView(
        [...effective].filter(
          (name) =>
            PACKAGE_BOUNDARY_PERMISSIONS.has(name) && (!token || catalogueTokenEligible(name)),
        ),
      ),
    }),
  );
}

export function clearPackageActor(request: AuthorizationRequest): void {
  packageActors.delete(request);
}

const contextActors = new WeakMap<RequestContext, ProjectActor>();

export function setContextPackageActor(ctx: RequestContext, actor: ProjectActor): void {
  if (contextActors.has(ctx)) throw new TypeError('package actor is already set');
  contextActors.set(ctx, actor);
}

export function contextPackageActorOf(ctx: RequestContext): ProjectActor | null {
  return contextActors.get(ctx) ?? null;
}

export function narrowPackageActor(actor: ProjectActor, permission: string | null): ProjectActor {
  return Object.freeze({
    ...actor,
    permissions: packagePermissionView(
      [...actor.permissions].filter((name) => name === permission),
    ),
  });
}
