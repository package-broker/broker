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

export function auditCall(ctx: RequestContext, deps: ApiRouteDeps): ApiCall {
  const access = accessContextOf(ctx);
  if (access === null) throw new TypeError('route requires an access context');
  return {
    audit: {
      opId: deps.ids.ulid(),
      requestId: ctx.requestId,
      sourceIp: deps.clientIp(ctx.request),
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
