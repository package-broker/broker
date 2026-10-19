import { clearPackageActor, setPackageActor } from '../internal/package-actor.js';
import type { ActorAccessSnapshot } from './actor.js';
import { catalogueTokenEligible } from './catalogue.js';
import { assertCsrfToken, assertSameOrigin, UNSAFE_METHODS } from '../auth/csrf.js';
import { SESSION_COOKIE, readCookie } from '../auth/cookies.js';
import { parseAuthorization } from '../auth/credential-parser.js';
import { sha256Hex } from '../auth/primitives.js';
import type { OrgContext } from '../db/port.js';
import type {
  AuthorizationDecision,
  AuthorizationEngine,
  AuthorizationRequest,
} from '../kernel/authorize.js';
import type { Principal } from '../plugin.js';
import { decidePatValidation } from './pat-validation.js';
import type { PatValidationDecision, PatValidationView } from './pat-validation.js';
import type { ScopeLevel } from './scope.js';
import { isValidProjectSlug } from './project-path.js';
import { authenticateToken } from './token-use.js';
import type { TokenAccessView, TokenUseDeps } from './token-use.js';

export interface EngineGrant {
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly tokenSelector: string | null;
  readonly token: {
    readonly kind: 'pat' | 'svc';
    readonly scope: ScopeLevel | null;
    readonly readOnly: boolean;
  } | null;
  readonly actor: ActorAccessSnapshot | null;
}

const grants = new WeakMap<AuthorizationRequest, EngineGrant>();
export function engineGrantOf(request: AuthorizationRequest): EngineGrant | null {
  return grants.get(request) ?? null;
}

export interface EngineProviderAnchor {
  readonly provider: string;
  readonly anchor: string;
  readonly emailAuthoritative: boolean;
}

interface EngineAccessCommon {
  readonly project: { readonly id: string } | null;
  readonly organizationPermissions: readonly string[];
  readonly projectPermissions: readonly string[];
}

export interface EngineSessionAccess extends EngineAccessCommon {
  readonly identity: {
    readonly id: string;
    readonly provider: string;
    readonly fresh: boolean;
  } | null;
  readonly protectedHolder: boolean;
  readonly session: { readonly id: string; readonly csrfHash: string };
  readonly user: { readonly id: string };
}

export interface EngineTokenAccess extends EngineAccessCommon, TokenAccessView, PatValidationView {
  readonly token: TokenAccessView['token'] & {
    readonly userId: string | null;
    readonly servicePrincipalId: string | null;
    readonly bindingOk: boolean;
    readonly projectMode: 'all' | 'selected' | null;
    readonly scope: { readonly level: ScopeLevel; readonly readOnly: boolean } | null;
  };
}

export type EngineBoundary = 'organization' | 'project';

export interface EngineLookupInput {
  readonly boundary: EngineBoundary;
  readonly projectSlug: string | null;
  readonly providerAnchors: readonly EngineProviderAnchor[];
}

/** Every method is one primary-consistent read; nothing here may be served from a replica or a cache. */
export interface EngineAccessPort {
  lookupSession(
    ctx: OrgContext,
    input: EngineLookupInput & { readonly secretHash: string },
  ): Promise<EngineSessionAccess | null>;
  touchSession(ctx: OrgContext, sessionId: string): Promise<boolean>;
  touchToken(ctx: OrgContext, tokenId: string, kind: 'pat' | 'svc'): Promise<boolean>;
  lookupToken(
    ctx: OrgContext,
    input: EngineLookupInput & { readonly selector: string },
  ): Promise<EngineTokenAccess | null>;
}

export interface PatValidationGate {
  readonly decide: (access: PatValidationView) => PatValidationDecision;
}

export const patValidationGate: PatValidationGate = Object.freeze({ decide: decidePatValidation });

export interface AuthorizationEngineDeps {
  readonly access: EngineAccessPort;
  readonly tokenUse: Omit<TokenUseDeps, 'touch'>;
  readonly patValidation: PatValidationGate;
  readonly publicOrigin: string;
  /** Read on every request so a provider rebind takes effect on the next lookup. */
  readonly providerAnchors: (ctx: OrgContext) => Promise<readonly EngineProviderAnchor[]>;
}

const FORBIDDEN: AuthorizationDecision = Object.freeze({ allow: false, status: 403 });
const NOT_FOUND: AuthorizationDecision = Object.freeze({ allow: false, status: 404 });
const UNAUTHORIZED: AuthorizationDecision = Object.freeze({ allow: false, status: 401 });
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

function requireWired(deps: AuthorizationEngineDeps): void {
  const { access, tokenUse, patValidation } = deps as Partial<AuthorizationEngineDeps>;
  if (
    access === undefined ||
    !isFunction(access.lookupSession) ||
    !isFunction(access.lookupToken) ||
    !isFunction(access.touchSession) ||
    !isFunction(access.touchToken)
  ) {
    throw new TypeError('authorization engine requires an access port');
  }
  if (
    tokenUse === undefined ||
    tokenUse.keyring === undefined ||
    !isFunction(tokenUse.nowMs) ||
    !isFunction(tokenUse.dispatch) ||
    !isFunction(tokenUse.log)
  ) {
    throw new TypeError('authorization engine requires the token-use gate');
  }
  if (patValidation === undefined || !isFunction(patValidation.decide)) {
    throw new TypeError('authorization engine requires the PAT validation gate');
  }
  if (!isFunction(deps.providerAnchors)) {
    throw new TypeError('authorization engine requires provider anchors');
  }
  if (deps.publicOrigin === 'null' || new URL(deps.publicOrigin).origin !== deps.publicOrigin) {
    throw new TypeError('publicOrigin must be a canonical origin');
  }
  probePatGate(patValidation);
}

function probePatGate(gate: PatValidationGate): void {
  const stale: PatValidationView = {
    token: { kind: 'pat' },
    validation: { kind: 'local', identityId: null, fresh: false, evidenceAt: null },
  };
  const fresh: PatValidationView = {
    token: { kind: 'pat' },
    validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
  };
  const none: PatValidationView = { token: { kind: 'pat' }, validation: null };
  if (
    gate.decide(stale).allowed !== false ||
    gate.decide(none).allowed !== false ||
    gate.decide(fresh).allowed !== true
  ) {
    throw new TypeError('authorization engine PAT validation gate fails to refuse stale tokens');
  }
}

function principalOf(access: EngineTokenAccess): Principal | undefined {
  const { token } = access;
  if (token.kind === 'svc') {
    return token.servicePrincipalId === null
      ? undefined
      : { kind: 'service', id: token.servicePrincipalId };
  }
  return token.userId === null ? undefined : { kind: 'user', id: token.userId };
}

interface Authenticated {
  readonly principal: Principal;
  readonly project: { readonly id: string } | null;
  readonly effective: ReadonlySet<string>;
  readonly projectVisible: boolean;
}

function projectOnly(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('project:'));
}

function sessionEffective(found: EngineSessionAccess, boundary: EngineBoundary): Set<string> {
  return boundary === 'organization'
    ? new Set(found.organizationPermissions)
    : new Set([...found.projectPermissions, ...projectOnly(found.organizationPermissions)]);
}

function tokenEffective(found: EngineTokenAccess, boundary: EngineBoundary): Set<string> {
  return new Set(
    boundary === 'organization' ? found.organizationPermissions : found.projectPermissions,
  );
}

function decideFrom(
  found: Authenticated,
  permission: string | null,
  boundary: EngineBoundary,
  slugValid: boolean,
): AuthorizationDecision {
  if (permission === null) return { allow: true, principal: found.principal, projectId: null };
  if (boundary === 'organization') {
    return found.effective.has(permission)
      ? { allow: true, principal: found.principal, projectId: null }
      : FORBIDDEN;
  }
  if (!slugValid) return NOT_FOUND;
  if (found.project === null || found.effective.size === 0) {
    return found.projectVisible ? FORBIDDEN : NOT_FOUND;
  }
  return found.effective.has(permission)
    ? { allow: true, principal: found.principal, projectId: found.project.id }
    : FORBIDDEN;
}

export function createAuthorizationEngine(deps: AuthorizationEngineDeps): AuthorizationEngine {
  requireWired(deps);
  const { access, tokenUse, patValidation, publicOrigin } = deps;

  function logTouchFailure(): void {
    try {
      tokenUse.log('token_touch_failed');
    } catch {
      return;
    }
  }

  function dispatchSafely(run: () => Promise<void>): void {
    try {
      tokenUse.dispatch(run);
    } catch {
      logTouchFailure();
    }
  }

  async function sessionDecision(
    request: AuthorizationRequest,
    secret: string,
    input: EngineLookupInput,
    permission: string | null,
    slugValid: boolean,
  ): Promise<AuthorizationDecision> {
    const found = await access.lookupSession(request.org, {
      ...input,
      secretHash: await sha256Hex(secret),
    });
    if (found === null) return UNAUTHORIZED;
    if (
      (request.route.boundary === 'authenticated' || request.route.boundary === 'self') &&
      found.identity !== null &&
      !found.identity.fresh
    ) {
      return FORBIDDEN;
    }
    if (UNSAFE_METHODS.has(request.request.method.toUpperCase())) {
      try {
        assertSameOrigin(request.request, publicOrigin);
        await assertCsrfToken(request.request, found.session.csrfHash);
      } catch {
        return FORBIDDEN;
      }
    }
    const effective = sessionEffective(found, input.boundary);
    const decision = decideFrom(
      {
        principal: { kind: 'user', id: found.user.id },
        project: found.project,
        effective,
        projectVisible: false,
      },
      permission,
      input.boundary,
      slugValid,
    );
    if (decision.allow) {
      dispatchSafely(async () => {
        try {
          await access.touchSession(request.org, found.session.id);
        } catch {
          logTouchFailure();
        }
      });
    }
    if (decision.allow) {
      setPackageActor(request, decision, effective, false);
      grants.set(
        request,
        Object.freeze({
          principal: Object.freeze(decision.principal),
          projectId: decision.projectId,
          sessionId: found.session.id,
          tokenSelector: null,
          token: null,
          actor: Object.freeze({
            session: Object.freeze({ id: found.session.id, userId: found.user.id }),
            user: Object.freeze({ id: found.user.id }),
            organizationPermissions: Object.freeze([...found.organizationPermissions]),
            projectPermissions: Object.freeze([...found.projectPermissions]),
            protectedHolder: found.protectedHolder,
          }),
        }),
      );
    }
    return decision;
  }

  async function tokenDecision(
    request: AuthorizationRequest,
    token: { readonly canonical: string; readonly selector: string },
    scheme: 'bearer' | 'basic',
    input: EngineLookupInput,
    permission: string | null,
    slugValid: boolean,
  ): Promise<AuthorizationDecision> {
    if (scheme === 'basic' && UNSAFE_METHODS.has(request.request.method.toUpperCase())) {
      try {
        assertSameOrigin(request.request, publicOrigin);
      } catch {
        return UNAUTHORIZED;
      }
    }
    const deferred: (() => Promise<void>)[] = [];
    const gate: TokenUseDeps = {
      ...tokenUse,
      touch: (tokenId, kind) => access.touchToken(request.org, tokenId, kind),
      log: logTouchFailure,
      dispatch: (run) => {
        deferred.push(run);
      },
    };
    const result = await authenticateToken(
      gate,
      token.canonical,
      (selector) => access.lookupToken(request.org, { ...input, selector }),
      (found) => patValidation.decide(found).allowed,
    );
    if (!result.ok) return UNAUTHORIZED;
    const found = result.access;
    if (
      permission === null &&
      (!found.token.bindingOk || found.token.scope === null || found.token.projectMode === null)
    ) {
      return UNAUTHORIZED;
    }
    const principal = principalOf(found);
    if (principal === undefined) return UNAUTHORIZED;
    const effective = tokenEffective(found, input.boundary);
    const decision = decideFrom(
      {
        principal,
        project: found.project,
        effective,
        projectVisible: found.projectVisible === true,
      },
      permission,
      input.boundary,
      slugValid,
    );
    if (!decision.allow) return decision;
    if (permission !== null && !catalogueTokenEligible(permission)) return FORBIDDEN;
    for (const run of deferred) dispatchSafely(run);
    setPackageActor(request, decision, effective, true);
    grants.set(
      request,
      Object.freeze({
        principal: Object.freeze(decision.principal),
        projectId: decision.projectId,
        sessionId: null,
        tokenSelector: token.selector,
        token: Object.freeze({
          kind: found.token.kind,
          scope: found.token.scope?.level ?? null,
          readOnly: found.token.scope?.readOnly ?? false,
        }),
        actor: null,
      }),
    );
    return { ...decision, tokenId: found.token.id };
  }

  async function selfBearerDecision(
    request: AuthorizationRequest,
    token: { readonly canonical: string },
    input: EngineLookupInput,
  ): Promise<AuthorizationDecision> {
    const gate: TokenUseDeps = {
      ...tokenUse,
      touch: () => Promise.resolve(true),
      log: logTouchFailure,
      dispatch: () => undefined,
    };
    const result = await authenticateToken(
      gate,
      token.canonical,
      (selector) => access.lookupToken(request.org, { ...input, selector }),
      (found) => patValidation.decide(found).allowed,
    );
    if (!result.ok) return UNAUTHORIZED;
    const { token: held } = result.access;
    if (!held.bindingOk || held.scope === null || held.projectMode === null) return UNAUTHORIZED;
    if (principalOf(result.access) === undefined) return UNAUTHORIZED;
    return FORBIDDEN;
  }

  return Object.freeze({
    async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
      grants.delete(request);
      clearPackageActor(request);
      const { boundary: routeBoundary } = request.route;
      if (
        routeBoundary !== 'organization' &&
        routeBoundary !== 'project' &&
        routeBoundary !== 'authenticated' &&
        routeBoundary !== 'self'
      ) {
        return FORBIDDEN;
      }
      const permissionFree = routeBoundary === 'authenticated' || routeBoundary === 'self';
      const permission = permissionFree ? null : request.route.permission;
      const boundary: EngineBoundary = routeBoundary === 'project' ? 'project' : 'organization';
      const slug = boundary === 'project' ? request.params['project'] : undefined;
      const slugValid = boundary === 'organization' || isValidProjectSlug(slug);
      const credential = parseAuthorization(request.request.headers.get('authorization'));
      if (credential.outcome === 'invalid') return UNAUTHORIZED;
      if (routeBoundary === 'self' && credential.outcome === 'token') {
        if (credential.scheme !== 'bearer') return UNAUTHORIZED;
        return selfBearerDecision(request, credential.token, {
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: await deps.providerAnchors(request.org),
        });
      }
      const secret =
        credential.outcome === 'none' ? readCookie(request.request, SESSION_COOKIE) : null;
      if (
        credential.outcome === 'none' &&
        (secret === null || !SESSION_SECRET_PATTERN.test(secret))
      ) {
        return UNAUTHORIZED;
      }
      const input: EngineLookupInput = {
        boundary,
        projectSlug: boundary === 'project' && isValidProjectSlug(slug) ? slug : null,
        providerAnchors: await deps.providerAnchors(request.org),
      };
      if (credential.outcome === 'token') {
        return tokenDecision(
          request,
          credential.token,
          credential.scheme,
          input,
          permission,
          slugValid,
        );
      }
      return sessionDecision(request, secret ?? '', input, permission, slugValid);
    },
  });
}
