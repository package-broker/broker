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
  readonly providers: ProviderMap;
  readonly hooks: Registration['hooks'];
  readonly log: KernelLog;
}

export interface AuthModule {
  readonly coreRoutes: readonly RouteDefinition[];
  readonly sessions: SessionService;
  readonly credentials: CredentialStore;
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

const REPORTABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
]);

function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'NonError';
    const name: unknown = error.name;
    return typeof name === 'string' && REPORTABLE_ERROR_NAMES.has(name) ? name : 'Error';
  } catch {
    return 'NonError';
  }
}

interface LockScope {
  lockedUserId: string | null;
}

function withNeedsOrg(route: RouteDefinition): RouteDefinition {
  const needsOrg = ROUTE_NEEDS_ORG[`${route.method} ${route.path}`];
  if (needsOrg === undefined) {
    throw new TypeError('auth route has no needsOrg decision');
  }
  return Object.freeze({ ...route, needsOrg });
}

export function createAuthModule(options: AuthModuleOptions): AuthModule {
  const { repositories, keyring, clock, ids, publicOrigin, providers, hooks } = options;

  const log: KernelLog = (entry) => {
    try {
      options.log(entry);
    } catch {
      return;
    }
  };

  const onHookError: HookErrorHandler = (event) => {
    log({
      level: 'warn',
      event: 'auth.hook.error',
      pluginId: event.plugin,
      error: errorName(event.error),
    });
  };

  const onDenied: NonNullable<IdentityLoginDeps['onDenied']> = (denial) => {
    log({
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
        log({
          level: 'warn',
          event: 'auth.local.locked',
          reason: 'attempts',
          userId: scope.lockedUserId,
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
    onHookError,
    onDenied,
  };
  const reauthDeps: IdentityReauthDeps = {
    users: repositories.users,
    sessions: repositories.sessions,
    clock,
    hooks,
    onHookError,
    onDenied,
  };

  const localService = createLocalLoginService({
    reader: localReader,
    writer: repositories.localSuccess,
    credentials,
    sessions,
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
    reauth: (ctx, session, input) =>
      withLockScope(
        ctx,
        (result) => !result.ok,
        (scoped) => localService.reauth(scoped, session, input),
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
    login: (ctx, provider, identity, meta) =>
      completeIdentityLogin(loginDeps, ctx, provider, identity, meta),
    reauth: (ctx, session, provider, identity, loginState) =>
      reauthenticateWithIdentity(reauthDeps, ctx, session, provider, identity, loginState),
    stateCipher,
    clock,
    publicOrigin,
    localLoginAvailable: true,
    log,
  });
  const localRoutes = createLocalRoutes({ local, setup, sessions, publicOrigin, log });

  return Object.freeze({
    coreRoutes: Object.freeze([...sso, ...localRoutes].map(withNeedsOrg)),
    sessions,
    credentials,
  });
}
