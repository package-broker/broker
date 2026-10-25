import { isIpLiteral } from '../../audit/actions.js';
import {
  accessContextOf,
  authenticatedActorOf,
  organizationActorOf,
} from '../../authz/access-context.js';
import type { OrganizationActor } from '../../authz/actor.js';
import { mutationFence } from '../../authz/fence.js';
import type { MutationFence } from '../../authz/fence.js';
import type { OrgContext } from '../../db/port.js';
import type { Clock } from '../../ids.js';
import type { RequestContext } from '../../plugin.js';
import type { ApiCall } from '../idempotency.js';

export interface ApiRouteDeps {
  readonly ids: { ulid(): string };
  readonly clock: Clock;
  readonly clientIp: (request: Request) => string | null;
}

export function hasOrganizationAdminAuthority(ctx: RequestContext): boolean {
  const access = accessContextOf(ctx);
  if (ctx.org === null || access?.boundary !== 'organization') return false;
  if (organizationActorOf(ctx)?.isOrganizationAdmin === true) return true;
  const token = access.token;
  return (
    access.principal?.kind === 'user' &&
    token?.kind === 'pat' &&
    token.scope === 'full' &&
    !token.readOnly &&
    token.projectMode === 'all' &&
    token.organizationAdmin === true
  );
}

export function auditCall(ctx: RequestContext, deps: ApiRouteDeps): ApiCall {
  const access = accessContextOf(ctx);
  if (access === null) throw new TypeError('route requires an access context');
  const sourceIp = deps.clientIp(ctx.request);
  return {
    audit: {
      opId: deps.ids.ulid(),
      requestId: ctx.requestId,
      sourceIp: isIpLiteral(sourceIp) ? sourceIp : null,
      tokenSelector: access.rateKey.stage === 'authenticated' ? access.rateKey.tokenSelector : null,
    },
  };
}

export function callContext(
  ctx: RequestContext,
  deps: ApiRouteDeps,
  expected: Readonly<Record<string, number>> = {},
): {
  readonly org: OrgContext;
  readonly actor: OrganizationActor;
  readonly fence: MutationFence;
  readonly call: ApiCall;
} {
  const org = ctx.org;
  const access = accessContextOf(ctx);
  const actor = organizationActorOf(ctx);
  const authenticated = authenticatedActorOf(ctx);
  if (org === null || access === null || actor === null || authenticated === null) {
    throw new TypeError('route requires an organization session context');
  }
  return {
    org,
    actor,
    fence: mutationFence(authenticated, expected),
    call: auditCall(ctx, deps),
  };
}

const emptyPermissionSet = new Set<string>();
const EMPTY_PERMISSIONS: ReadonlySet<string> = Object.freeze({
  size: 0,
  has: (permission: string) => emptyPermissionSet.has(permission),
  forEach: () => undefined,
  entries: () => emptyPermissionSet.entries(),
  keys: () => emptyPermissionSet.keys(),
  values: () => emptyPermissionSet.values(),
  [Symbol.iterator]: () => emptyPermissionSet.values(),
});

/** The actor carries identity only; authority is the kernel's project decision plus the service's live, fenced check. */
export function projectSessionCallContext(
  ctx: RequestContext,
  deps: ApiRouteDeps,
  expected: Readonly<Record<string, number>> = {},
): {
  readonly org: OrgContext;
  readonly projectId: string;
  readonly actor: OrganizationActor;
  readonly fence: MutationFence;
  readonly call: ApiCall;
} {
  const org = ctx.org;
  const access = accessContextOf(ctx);
  const projectId = ctx.projectId;
  const authenticated = authenticatedActorOf(ctx);
  if (
    org === null ||
    access === null ||
    access.boundary !== 'project' ||
    projectId === null ||
    access.projectId === null ||
    access.projectId !== projectId ||
    authenticated === null ||
    access.actor === null
  ) {
    throw new TypeError('route requires a project session context');
  }
  const actor: OrganizationActor = Object.freeze({
    kind: 'organization',
    userId: authenticated.userId,
    sessionId: authenticated.sessionId,
    permissions: EMPTY_PERMISSIONS,
    isOrganizationAdmin: false,
  });
  return {
    org,
    projectId,
    actor,
    fence: mutationFence(authenticated, expected),
    call: auditCall(ctx, deps),
  };
}
