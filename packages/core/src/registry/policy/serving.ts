import type { ProjectActor } from '../../authz/project-actor.js';
import type { PolicyEcosystem } from '../../db/registry-policy.js';
import type { ReadKind, RequestContext } from '../../plugin.js';
import { normalizeClientHints } from './client-hints.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import { createOrganizationPolicyView, type OrganizationPolicyView } from './organization.js';
import {
  createRegistryReadSession,
  type RegistryReadSession,
  type RegistryReadSessionDeps,
} from './session.js';

/** Opens one read session per governed request; absent when registry policy is disabled. */
export interface PolicyServing {
  open(
    ctx: RequestContext,
    actor: ProjectActor,
    ecosystem: PolicyEcosystem,
    kind: ReadKind,
    options?: PolicyServingOptions,
  ): RegistryReadSession;
  /** Organization rules for an organization-wide view; opened per attempt. */
  organization(ctx: RequestContext, ecosystem: PolicyEcosystem): OrganizationPolicyView;
}

export interface PolicyServingOptions {
  /** False skips the client floor; every other rule and hook still applies. */
  readonly clientFloor?: boolean;
}

export function createPolicyServing(deps: Omit<RegistryReadSessionDeps, 'signal'>): PolicyServing {
  return {
    open(ctx, actor, ecosystem, kind, options = {}) {
      if (ctx.principal === null) throw new RegistryPolicyUnavailableError();
      return createRegistryReadSession(
        { ...deps, signal: ctx.request.signal },
        {
          actor,
          principal: ctx.principal,
          ecosystem,
          kind,
          client: normalizeClientHints(ctx.request.headers.get('user-agent'), ecosystem),
          requestId: ctx.requestId,
          ...(options.clientFloor === undefined ? {} : { clientFloor: options.clientFloor }),
        },
      );
    },
    organization(ctx, ecosystem) {
      if (ctx.org === null) throw new RegistryPolicyUnavailableError();
      return createOrganizationPolicyView(deps, ctx.org, ecosystem);
    },
  };
}
