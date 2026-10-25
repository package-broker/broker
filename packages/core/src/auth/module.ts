import { reauthenticateWithIdentity } from './identity-reauth.js';
import type { IdentityReauthDeps } from './identity-reauth.js';
import { completeIdentityLogin } from './identity-login.js';
import type { IdentityLoginDeps } from './identity-login.js';
import { createLocalLoginService } from './local-login.js';
import type { LocalLoginService } from './local-login.js';
import { createLocalSetupService } from './local-setup.js';
import type { LocalSetupService } from './local-setup.js';
import { createLocalRoutes } from './routes-local.js';
import { createSsoRoutes } from './routes-sso.js';
import { createSessionService } from './session.js';
import type { SessionService } from './session.js';
import { AUTH_API } from '../api/auth-schemas.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { AuthorizationEngineDeps } from '../authz/engine.js';
import { createUnlinkService } from '../authz/unlink-service.js';
import type { UnlinkService, UnlinkServiceDeps } from '../authz/unlink-service.js';
import type { CredentialRepository } from '../db/credentials.js';
import type {
  LocalLoginReader,
  LocalLoginSetupWriter,
  LocalLoginSuccessWriter,
} from '../db/local-login.js';
import type { OrgContext } from '../db/port.js';
import type { SessionRepository } from '../db/sessions.js';
import type { LoginWriter, UserRepository } from '../db/users.js';
import type { Clock } from '../ids.js';
import type { ProviderMap } from '../identity/providers.js';
import type { HookErrorHandler } from '../kernel/access.js';
import { denyAllEngine } from '../kernel/authorize.js';
import type { AuthorizationEngine } from '../kernel/authorize.js';
import { reportableErrorName } from '../kernel/error-name.js';
import type { KernelLog } from '../kernel/errors.js';
import type { Registration } from '../kernel/registry.js';
import type { RouteDefinition } from '../plugin.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createCredentialStore } from '../secrets/credential-store.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import type { Keyring } from '../secrets/keyring.js';

export interface AuthRepositories {
  readonly sessions: SessionRepository;
  readonly users: UserRepository;
  readonly login: LoginWriter;
  readonly localReader: LocalLoginReader;
  readonly localSetup: LocalLoginSetupWriter;
  readonly localSuccess: LocalLoginSuccessWriter;
  readonly credentials: CredentialRepository;
}

export interface AuthModuleOptions {
  readonly repositories: AuthRepositories;
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly publicOrigin: string;
  readonly clientIp: (request: Request) => string | null;
  readonly providers: ProviderMap;
  readonly hooks: Registration['hooks'];
  readonly log: KernelLog;
  readonly access?: Pick<AuthorizationEngineDeps, 'access' | 'providerAnchors'> & {
    readonly dispatch: AuthorizationEngineDeps['tokenUse']['dispatch'];
  };
  readonly unlink?: Pick<UnlinkServiceDeps, 'unlinks' | 'providers'>;
}

export interface AuthModule {
  readonly coreRoutes: readonly RouteDefinition[];
  readonly sessions: SessionService;
  readonly credentials: CredentialStore;
  readonly authorization: AuthorizationEngine;
  readonly unlink: UnlinkService | null;
}

/** Only the provider list is answerable without an organization; every other route reads one. */
const ROUTE_NEEDS_ORG: Readonly<Record<string, boolean>> = Object.freeze({
  'GET /_pb/auth/providers': false,
  'POST /_pb/auth/sso/:provider/start': true,
  'GET /_pb/auth/sso/:provider/callback': true,
  'POST /_pb/auth/local/setup/start': true,
  'POST /_pb/auth/local/setup/finish': true,
  'POST /_pb/auth/local/login': true,
  'POST /_pb/auth/local/reauth': true,
  'POST /_pb/auth/logout': true,
  'GET /_pb/session': true,
});

interface LockScope {
  lockedUserId: string | null;
}

const REQUEST_LOG = Symbol('auth.requestLog');

type AuthOrgContext = OrgContext & { readonly [REQUEST_LOG]?: KernelLog };

function withNeedsOrg(route: RouteDefinition): RouteDefinition {
  const key = `${route.method} ${route.path}`;
  const needsOrg = ROUTE_NEEDS_ORG[key];
  if (needsOrg === undefined) {
    throw new TypeError('auth route has no needsOrg decision');
  }
  const api = AUTH_API[key];
  if (api === undefined) throw new TypeError('auth route has no api slot');
  return Object.freeze({ ...route, needsOrg, api });
}

export function createAuthModule(options: AuthModuleOptions): AuthModule {
  const { repositories, keyring, clock, ids, publicOrigin, providers, hooks } = options;

  const log: KernelLog = (entry) => {
    try {
      const { requestId, ...record } = entry;
      options.log(typeof requestId === 'string' ? { ...record, request_id: requestId } : entry);
    } catch {
      return;
    }
  };

  const logFor = (ctx: AuthOrgContext): KernelLog => ctx[REQUEST_LOG] ?? log;

  const onHookError =
    (ctx: OrgContext): HookErrorHandler =>
    (event) => {
      logFor(ctx)({
        level: 'warn',
        event: 'auth.hook.error',
        pluginId: event.plugin,
        error: reportableErrorName(event.error),
      });
    };

  const onDenied =
    (ctx: OrgContext): NonNullable<IdentityLoginDeps['onDenied']> =>
    (denial) => {
      logFor(ctx)({
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: denial.plugin,
        code: denial.code,
      });
    };

  const scopes = new WeakMap<OrgContext, LockScope>();

  async function withLockScope<R>(
    ctx: OrgContext,
    refused: (result: R) => boolean,
    run: (scoped: OrgContext) => Promise<R>,
  ): Promise<R> {
    const scope: LockScope = { lockedUserId: null };
    const scoped: OrgContext = Object.freeze({ ...ctx });
    scopes.set(scoped, scope);
    let succeeded = false;
    try {
      const result = await run(scoped);
      succeeded = !refused(result);
      return result;
    } finally {
      if (!succeeded && scope.lockedUserId !== null) {
        logFor(ctx)({
          level: 'warn',
          event: 'auth.local.locked',
          reason: 'attempts',
          user_id: scope.lockedUserId,
        });
      }
    }
  }

  const localReader: LocalLoginReader = {
    findByEmail: (ctx, email) => repositories.localReader.findByEmail(ctx, email),
    findBySetupHash: (ctx, setupHash, now) =>
      repositories.localReader.findBySetupHash(ctx, setupHash, now),
    async reserveAttempt(ctx, userId, now, lockUntil) {
      const reservation = await repositories.localReader.reserveAttempt(
        ctx,
        userId,
        now,
        lockUntil,
      );
      const scope = scopes.get(ctx);
      if (
        scope !== undefined &&
        reservation.reserved &&
        reservation.snapshot.lockedUntil === lockUntil
      ) {
        scope.lockedUserId = userId;
      }
      return reservation;
    },
  };

  const sessions = createSessionService({
    sessions: repositories.sessions,
    clock,
    publicOrigin,
  });
  const authorization =
    options.access === undefined
      ? denyAllEngine
      : createAuthorizationEngine({
          access: options.access.access,
          providerAnchors: options.access.providerAnchors,
          publicOrigin,
          patValidation: patValidationGate,
          tokenUse: {
            keyring,
            nowMs: () => clock.now().getTime(),
            dispatch: options.access.dispatch,
            log: (event) => log({ level: 'warn', event }),
          },
        });
  const unlink =
    options.unlink === undefined
      ? null
      : createUnlinkService({ ...options.unlink, sessions, clock, log });
  const credentials = createCredentialStore({
    repository: repositories.credentials,
    cipher: createSecretCipher(keyring, 'credential-encryption'),
    ids,
    clock,
  });
  const stateCipher = createSecretCipher(keyring, 'login-state');

  const loginDeps: IdentityLoginDeps = {
    users: repositories.users,
    writer: repositories.login,
    sessions,
    hooks,
    clock,
    ids,
  };
  const reauthDeps: IdentityReauthDeps = {
    users: repositories.users,
    sessions: repositories.sessions,
    clock,
    hooks,
  };

  const localService = createLocalLoginService({
    reader: localReader,
    writer: repositories.localSuccess,
    credentials,
    sessionCookies: sessions,
    sessions: repositories.sessions,
    keyring,
    clock,
    ids,
  });
  const setupService = createLocalSetupService({
    reader: localReader,
    writer: repositories.localSetup,
    credentials,
    sessions,
    keyring,
    clock,
    ids,
  });

  const local: LocalLoginService = {
    login: (ctx, input, meta) =>
      withLockScope(
        ctx,
        (result) => !result.ok,
        (scoped) => localService.login(scoped, input, meta),
      ),
    reauth: (ctx, session, input, meta) =>
      withLockScope(
        ctx,
        (result) => !result.ok,
        (scoped) => localService.reauth(scoped, session, input, meta),
      ),
  };
  const setup: LocalSetupService = {
    start: (ctx, token) => setupService.start(ctx, token),
    finish: (ctx, input, meta) =>
      withLockScope(
        ctx,
        (result) => !result.ok,
        (scoped) => setupService.finish(scoped, input, meta),
      ),
  };

  const sso = createSsoRoutes({
    providers,
    sessions,
    reauthSessions: repositories.sessions,
    login: (ctx, provider, identity, meta) =>
      completeIdentityLogin(
        { ...loginDeps, onHookError: onHookError(ctx), onDenied: onDenied(ctx) },
        ctx,
        provider,
        identity,
        meta,
      ),
    reauth: (ctx, session, provider, identity, loginState, meta) =>
      reauthenticateWithIdentity(
        { ...reauthDeps, onHookError: onHookError(ctx), onDenied: onDenied(ctx) },
        ctx,
        session,
        provider,
        identity,
        loginState,
        meta,
      ),
    stateCipher,
    clock,
    publicOrigin,
    clientIp: options.clientIp,
    localLoginAvailable: true,
    log,
  });
  const localRoutes = createLocalRoutes({
    local,
    setup,
    sessions,
    publicOrigin,
    log,
    clientIp: options.clientIp,
  });

  return Object.freeze({
    coreRoutes: Object.freeze(
      [...sso, ...localRoutes].map((route) =>
        withNeedsOrg({
          ...route,
          handler: (ctx) => {
            const scopedLog: KernelLog = (entry) => log({ ...entry, request_id: ctx.requestId });
            const org: AuthOrgContext | null =
              ctx.org === null ? null : Object.freeze({ ...ctx.org, [REQUEST_LOG]: scopedLog });
            return route.handler({ ...ctx, org });
          },
        }),
      ),
    ),
    sessions,
    credentials,
    authorization,
    unlink,
  });
}
