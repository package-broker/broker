import { isReauthSessionActive } from './identity-reauth.js';
import {
  START_FAILURE_DETAILS,
  FINISH_FAILURE_DETAILS,
  IDENTITY_FAILURES,
  LOGIN_REFUSALS,
  REAUTH_REFUSALS,
} from './reason-codes.js';
import { CsrfError, assertSameOrigin } from './csrf.js';
import type { LoginOutcome } from './identity-login.js';
import { clearLoginState, openLoginState, safeReturnTo, sealLoginState } from './login-state.js';
import type { LoginState } from './login-state.js';
import { sessionMetaOf } from './session.js';
import type { AuthenticatedSession, SessionMeta, SessionService } from './session.js';
import type { OrgContext } from '../db/port.js';
import type { SessionRepository } from '../db/sessions.js';
import type { Clock } from '../ids.js';
import type { ProviderMap } from '../identity/providers.js';
import { isValidProviderId } from '../identity/port.js';
import type {
  IdentityFailureDetail,
  IdentityProvider,
  LoginStateData,
  VerifiedIdentity,
} from '../identity/port.js';
import { ssoStartBody } from '../api/auth-schemas.js';
import { apiError } from '../api/response.js';
import { validateInput, type ValidationResult } from '../api/validate.js';
import { reportableErrorName } from '../kernel/error-name.js';
import { envelopeResponse, errorResponse } from '../kernel/errors.js';
import type { KernelLog } from '../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../plugin.js';
import type { SecretCipher } from '../secrets/cipher.js';

export type ReauthOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface SsoRouteDeps {
  readonly providers: ProviderMap;
  readonly sessions: SessionService;
  /** Re-authentication fails closed when the session reader is unavailable. */
  readonly reauthSessions?: Pick<SessionRepository, 'findActiveById'>;
  readonly login: (
    ctx: OrgContext,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    meta: SessionMeta,
  ) => Promise<LoginOutcome>;
  /** `state` is the opened login state of the callback; the service binds it to this session. */
  readonly reauth: (
    ctx: OrgContext,
    session: AuthenticatedSession,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    state: LoginState,
  ) => Promise<ReauthOutcome>;
  readonly stateCipher: SecretCipher;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly clientIp?: (request: Request) => string | null;
  readonly localLoginAvailable: boolean;
  readonly log: KernelLog;
}

const MAX_BODY_BYTES = 8192;
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

type Purpose = 'login' | 'reauth';
type Verified =
  | { readonly identity: VerifiedIdentity }
  | { readonly reason: string; readonly error?: unknown; readonly detail?: IdentityFailureDetail };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startFailureDetail(error: unknown): string | null {
  try {
    if (typeof error !== 'object' || error === null) return null;
    const detail: unknown = (error as { detail?: unknown }).detail;
    return typeof detail === 'string' && (START_FAILURE_DETAILS as ReadonlySet<string>).has(detail)
      ? detail
      : null;
  } catch {
    return null;
  }
}

function knownReason(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4.test(hostname);
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const response = new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store' },
  });
  return withCookies(response, cookies);
}

function prefersJson(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (!Number.isFinite(weight) || weight <= 0) continue;
    return range === 'application/json';
  }
  return false;
}

function locationResponse(location: string, cookies: readonly string[]): Response {
  return withCookies(json(200, { location }), cookies);
}

function varyOnAccept(response: Response): Response {
  response.headers.set('vary', 'Accept');
  return response;
}

async function readBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

async function readStartBody(
  request: Request,
): Promise<
  ValidationResult<{ readonly purpose: Purpose; readonly returnTo?: string | undefined }>
> {
  const text = await readBody(request);
  let parsed: unknown;
  try {
    if (text === null) throw new TypeError('bad_body');
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, details: [{ path: '', code: 'invalid_json' }] };
  }
  return validateInput(ssoStartBody, parsed);
}

type StartOutcome =
  | { readonly kind: 'direct' }
  | { readonly kind: 'redirect'; readonly location: string; readonly state: LoginStateData };

function readStartResult(result: unknown): StartOutcome | null {
  if (!isRecord(result)) return null;
  if (result['kind'] === 'direct') return { kind: 'direct' };
  const location = result['location'];
  const state = result['state'];
  if (result['kind'] !== 'redirect' || typeof location !== 'string' || !isRecord(state)) {
    return null;
  }
  try {
    const url = new URL(location);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return null;
    }
  } catch {
    return null;
  }
  return { kind: 'redirect', location, state: state as LoginStateData };
}

export function createSsoRoutes(deps: SsoRouteDeps): readonly RouteDefinition[] {
  const { providers, sessions, stateCipher, clock, publicOrigin } = deps;

  const log = (entry: Readonly<Record<string, unknown>>): void => {
    try {
      deps.log(entry);
    } catch {
      return;
    }
  };

  async function activeReauthSession(ctx: OrgContext, id: string): Promise<boolean> {
    return (
      deps.reauthSessions !== undefined &&
      isReauthSessionActive({ sessions: deps.reauthSessions, clock }, ctx, id)
    );
  }

  function orgOf(rc: RequestContext): OrgContext {
    if (rc.org === null) throw new TypeError('SSO routes need an organization');
    return rc.org;
  }

  function logRefusal(
    requestId: string,
    provider: string | null,
    reason: string,
    error?: unknown,
    startPath = false,
    detail?: IdentityFailureDetail,
  ): void {
    log({
      level: 'warn',
      event: 'auth.login.refused',
      requestId,
      provider,
      reason,
      ...(error === undefined ? {} : { error: reportableErrorName(error) }),
      ...(startPath ? { detail: startFailureDetail(error) } : {}),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  function loginFailed(
    rc: RequestContext,
    provider: string | null,
    reason: string,
    cookies: readonly string[] = [],
    error?: unknown,
    detail?: IdentityFailureDetail,
  ): Response {
    logRefusal(rc.requestId, provider, reason, error, false, detail);
    return withCookies(
      envelopeResponse(401, 'login_failed', 'Login failed', rc.requestId),
      cookies,
    );
  }

  function forbidden(rc: RequestContext, provider: string, error: CsrfError): Response {
    logRefusal(rc.requestId, isValidProviderId(provider) ? provider : null, error.reason);
    return envelopeResponse(403, 'forbidden', 'Forbidden', rc.requestId);
  }

  function callbackUrl(provider: IdentityProvider): string {
    return `${publicOrigin}/_pb/auth/sso/${provider.id}/callback`;
  }

  async function verify(
    rc: RequestContext,
    provider: IdentityProvider,
    data: LoginStateData | null,
  ): Promise<Verified> {
    try {
      const result: unknown = await provider.finish({
        request: rc.request,
        state: data,
        callbackUrl: callbackUrl(provider),
      });
      if (!isRecord(result)) return { reason: 'provider_error' };
      if (result['ok'] === true) {
        const identity = result['identity'];
        return isRecord(identity)
          ? { identity: identity as unknown as VerifiedIdentity }
          : { reason: 'provider_error' };
      }
      const reason = result['reason'];
      const detail = reason === 'provider_error' ? result['detail'] : undefined;
      return {
        reason:
          typeof reason === 'string' && (IDENTITY_FAILURES as ReadonlySet<string>).has(reason)
            ? reason
            : 'provider_error',
        ...(typeof detail === 'string' &&
        (FINISH_FAILURE_DETAILS as ReadonlySet<string>).has(detail)
          ? { detail: detail as IdentityFailureDetail }
          : {}),
      };
    } catch (error) {
      return { reason: 'provider_error', error };
    }
  }

  async function completeLogin(
    rc: RequestContext,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    returnTo: string,
    cookies: readonly string[],
    asLocation = false,
  ): Promise<Response> {
    const outcome = await deps.login(
      orgOf(rc),
      provider,
      identity,
      await sessionMetaOf(rc.request, deps.clientIp),
    );
    if (!outcome.ok) {
      const reason: unknown = outcome.reason;
      return loginFailed(
        rc,
        provider.id,
        knownReason(reason, LOGIN_REFUSALS, 'login_refused'),
        cookies,
      );
    }
    log({
      level: 'info',
      event: 'auth.login.succeeded',
      requestId: rc.requestId,
      provider: provider.id,
      userId: outcome.userId,
      sessionId: outcome.sessionId,
    });
    const issued = [...outcome.cookies, ...cookies];
    return asLocation ? locationResponse(returnTo, issued) : redirect(returnTo, issued);
  }

  async function start(rc: RequestContext): Promise<Response> {
    const { request } = rc;
    const providerId = rc.params['provider'] ?? '';
    try {
      assertSameOrigin(request, publicOrigin);
    } catch (error) {
      if (error instanceof CsrfError) return forbidden(rc, providerId, error);
      throw error;
    }
    const provider = providers.get(providerId);
    if (provider === undefined) {
      return envelopeResponse(404, 'not_found', 'Unknown provider', rc.requestId);
    }
    const body = await readStartBody(request);
    if (!body.ok) {
      const response = apiError(
        'invalid_request',
        rc.requestId,
        body.details.map((detail) => ({ ...detail, path: `/body${detail.path}` })),
      );
      response.headers.set('x-request-id', rc.requestId);
      return response;
    }
    const { purpose } = body.data;
    const returnTo = safeReturnTo(body.data.returnTo ?? null);

    let session: AuthenticatedSession | null = null;
    if (purpose === 'reauth') {
      session = await sessions.authenticate(orgOf(rc), request);
      if (session === null) return loginFailed(rc, provider.id, 'no_session');
      try {
        await sessions.assertCsrf(request, session);
      } catch (error) {
        if (error instanceof CsrfError) return forbidden(rc, provider.id, error);
        throw error;
      }
      if (!(await activeReauthSession(orgOf(rc), session.session.id))) {
        return loginFailed(rc, provider.id, 'session_inactive');
      }
      if (!provider.supportsReauth) {
        return envelopeResponse(
          400,
          'reauth_unsupported',
          'Re-authentication is not supported',
          rc.requestId,
        );
      }
    }

    let started: StartOutcome | null;
    let startError: unknown;
    try {
      started = readStartResult(
        await provider.start({ request, purpose, callbackUrl: callbackUrl(provider) }),
      );
    } catch (error) {
      started = null;
      startError = error;
    }
    if (started === null) return providerFailed(rc, provider.id, startError);

    if (started.kind === 'direct') {
      if (purpose === 'reauth') return loginFailed(rc, provider.id, 'direct_reauth');
      const verified = await verify(rc, provider, null);
      if ('reason' in verified) {
        return loginFailed(rc, provider.id, verified.reason, [], verified.error, verified.detail);
      }
      return varyOnAccept(
        await completeLogin(rc, provider, verified.identity, returnTo, [], prefersJson(request)),
      );
    }

    let sealed: string;
    try {
      sealed = await sealLoginState(stateCipher, {
        provider: provider.id,
        purpose,
        returnTo,
        issuedAt: clock.now().getTime(),
        sessionId: session === null ? null : session.session.id,
        data: started.state,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return providerFailed(rc, provider.id, error);
      }
      throw error;
    }
    return varyOnAccept(
      prefersJson(request)
        ? locationResponse(started.location, [sealed])
        : redirect(started.location, [sealed]),
    );
  }

  function providerFailed(rc: RequestContext, provider: string, error: unknown): Response {
    logRefusal(rc.requestId, provider, 'provider_error', error, true);
    return envelopeResponse(502, 'provider_error', 'Identity provider error', rc.requestId);
  }

  async function callback(rc: RequestContext): Promise<Response> {
    const cleared = [clearLoginState()];
    const provider = providers.get(rc.params['provider'] ?? '');
    if (provider === undefined) {
      return withCookies(
        envelopeResponse(404, 'not_found', 'Unknown provider', rc.requestId),
        cleared,
      );
    }
    try {
      return await finishCallback(rc, provider, cleared);
    } catch (error) {
      return withCookies(errorResponse(error, rc.requestId, log), cleared);
    }
  }

  async function finishCallback(
    rc: RequestContext,
    provider: IdentityProvider,
    cleared: readonly string[],
  ): Promise<Response> {
    const org = orgOf(rc);
    const session = await sessions.authenticate(org, rc.request);
    const state = await openLoginState(
      stateCipher,
      rc.request,
      { provider: provider.id, sessionId: session === null ? null : session.session.id },
      clock.now().getTime(),
    );
    if (state === null) return loginFailed(rc, provider.id, 'state_invalid', cleared);

    if (state.purpose === 'reauth' && session === null) {
      return loginFailed(rc, provider.id, 'no_session', cleared);
    }
    if (
      state.purpose === 'reauth' &&
      session !== null &&
      !(await activeReauthSession(org, session.session.id))
    ) {
      return loginFailed(rc, provider.id, 'session_inactive', cleared);
    }
    const verified = await verify(rc, provider, state.data);
    if ('reason' in verified) {
      return loginFailed(
        rc,
        provider.id,
        verified.reason,
        cleared,
        verified.error,
        verified.detail,
      );
    }
    if (state.purpose === 'login' || session === null) {
      return completeLogin(rc, provider, verified.identity, state.returnTo, cleared);
    }
    const outcome: unknown = await deps.reauth(org, session, provider, verified.identity, state);
    if (!isRecord(outcome) || outcome['ok'] !== true) {
      const reason = isRecord(outcome)
        ? knownReason(outcome['reason'], REAUTH_REFUSALS, 'reauth_refused')
        : 'reauth_refused';
      return loginFailed(rc, provider.id, reason, cleared);
    }
    log({
      level: 'info',
      event: 'auth.reauth.succeeded',
      requestId: rc.requestId,
      provider: provider.id,
      userId: session.session.userId,
      sessionId: session.session.id,
    });
    return redirect(state.returnTo, cleared);
  }

  async function logout(rc: RequestContext): Promise<Response> {
    try {
      return await endSession(rc);
    } catch (error) {
      return withCookies(errorResponse(error, rc.requestId, log), sessions.clearCookies());
    }
  }

  function logoutRefused(rc: RequestContext, error: CsrfError): Response {
    log({
      level: 'warn',
      event: 'auth.logout.refused',
      requestId: rc.requestId,
      reason: error.reason,
    });
    return envelopeResponse(403, 'forbidden', 'Forbidden', rc.requestId);
  }

  async function endSession(rc: RequestContext): Promise<Response> {
    try {
      assertSameOrigin(rc.request, publicOrigin);
    } catch (error) {
      if (error instanceof CsrfError) return logoutRefused(rc, error);
      throw error;
    }
    const org = orgOf(rc);
    const session = await sessions.authenticate(org, rc.request);
    if (session === null) {
      return withCookies(
        envelopeResponse(401, 'unauthorized', 'Unauthorized', rc.requestId),
        sessions.clearCookies(),
      );
    }
    try {
      await sessions.assertCsrf(rc.request, session);
    } catch (error) {
      if (error instanceof CsrfError) return logoutRefused(rc, error);
      throw error;
    }
    const cookies = await sessions.logout(org, rc.request);
    return withCookies(
      new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
      cookies,
    );
  }

  async function currentSession(rc: RequestContext): Promise<Response> {
    const session = await sessions.authenticate(orgOf(rc), rc.request);
    if (session === null) {
      return envelopeResponse(401, 'unauthorized', 'Unauthorized', rc.requestId);
    }
    const { user, expiresAt } = session.session;
    return json(200, {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      reauthFresh: sessions.isReauthFresh(session),
      expiresAt,
    });
  }

  function listProviders(): Response {
    return json(200, {
      providers: [...providers.values()].map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        supportsReauth: provider.supportsReauth,
      })),
      local: deps.localLoginAvailable,
    });
  }

  return Object.freeze([
    Object.freeze({
      method: 'GET',
      path: '/_pb/auth/providers',
      permission: null,
      needsOrg: false,
      handler: listProviders,
    }),
    Object.freeze({
      method: 'POST',
      path: '/_pb/auth/sso/:provider/start',
      permission: null,
      handler: start,
    }),
    Object.freeze({
      method: 'GET',
      path: '/_pb/auth/sso/:provider/callback',
      permission: null,
      handler: callback,
    }),
    Object.freeze({
      method: 'POST',
      path: '/_pb/auth/logout',
      permission: null,
      handler: logout,
    }),
    Object.freeze({
      method: 'GET',
      path: '/_pb/session',
      permission: null,
      handler: currentSession,
    }),
  ] satisfies RouteDefinition[]);
}
