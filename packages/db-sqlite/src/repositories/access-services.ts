import { createAuthModule, type AuthModule } from '@package-broker/core/auth/module';
import type { SessionService } from '@package-broker/core/auth/session';
import {
  createPersonalTokenService,
  type PersonalTokenService,
} from '@package-broker/core/authz/pat-service';
import {
  createProjectAdministration,
  type ProjectAdministration,
} from '@package-broker/core/authz/project-administration';
import { createProjectLister, type ProjectLister } from '@package-broker/core/authz/project-list';
import { reservedFirstSegments } from '@package-broker/core/authz/project-path';
import {
  createProjectService,
  type ProjectService,
} from '@package-broker/core/authz/project-service';
import {
  createServicePrincipalService,
  type ServicePrincipalService,
} from '@package-broker/core/authz/service-principal-service';
import {
  createServiceTokenService,
  type ServiceTokenService,
} from '@package-broker/core/authz/service-token-service';
import {
  createAdministration,
  type Administration,
} from '@package-broker/core/authz/administration';
import type { ProjectAdministrationDeps } from '@package-broker/core/authz/project-administration';
import type { TokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import { createGrantRepository } from './grant.js';
import { createRoleRepository } from './role.js';
import { createUserRepository } from './user.js';
import type { TokenReader } from '@package-broker/core/authz/token-read';
import {
  createTokenRevokeService,
  type TokenRevokeService,
} from '@package-broker/core/authz/token-revoke';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  providerAnchorsOf,
  type ConfiguredProviderAnchor,
  type ProviderAnchorReader,
} from '@package-broker/core/identity/provider-anchors';
import type { ProviderMap } from '@package-broker/core/identity/providers';
import type { Clock } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createAccessRepository } from './access.js';
import { createAuthRepositories } from './auth.js';
import { createOrganizationRepository } from './organization.js';
import { createProjectRepository } from './project.js';
import { createProjectGrantRepository } from './project-grant.js';
import { createReadableProjectRepository } from './project-readable.js';
import { createServicePrincipalRepository } from './service-principal.js';
import { createServicePrincipalAuthority } from './service-principal-authority.js';
import { createTokenRepository } from './token.js';
import { createTokenReader } from './token-read.js';
import { createUnlinkRepository } from './unlink.js';

export interface AccessServices {
  readonly engine: AuthorizationEngine;
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly administration: Administration;
  readonly lifetime: TokenLifetimePolicy;
  readonly projectGrants: ProjectAdministration;
  readonly projectList: ProjectLister;
  readonly personalTokens: PersonalTokenService;
  readonly servicePrincipals: ServicePrincipalService;
  readonly serviceTokens: ServiceTokenService;
  readonly tokenRevoke: TokenRevokeService;
  readonly tokenList: TokenReader;
}

function wired<T>(name: string, value: T | undefined): T {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${name} is not wired`);
  }
  return value;
}

function anchorReader(list: readonly ConfiguredProviderAnchor[]): ProviderAnchorReader {
  return Object.freeze({ anchors: () => Promise.resolve(list) });
}

export interface AccessServicesOptions {
  readonly tokens: {
    readonly lifetime: TokenLifetimePolicy;
    readonly offboarding: Pick<
      ProjectAdministrationDeps,
      'onUserOffboarded' | 'onProjectAccessLost'
    >;
  };
  readonly executor: SqlExecutor;
  readonly keyring: Keyring;
  readonly providers: ProviderMap;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: KernelLog;
  readonly dispatch: (run: () => Promise<void>) => void;
  readonly publicOrigin: string;
  readonly clientIp?: (request: Request) => string | null;
  readonly registration: Pick<Registration, 'hooks' | 'routes'>;
}

export interface AccessAssembly {
  readonly repositories: {
    readonly organizations: ReturnType<typeof createOrganizationRepository>;
    readonly projects: ReturnType<typeof createProjectRepository>;
    readonly users: ReturnType<typeof createUserRepository>;
    readonly grants: ReturnType<typeof createGrantRepository>;
    readonly principals: ReturnType<typeof createServicePrincipalRepository>;
  };
  readonly anchors: readonly ConfiguredProviderAnchor[];
  readonly module: AuthModule;
  readonly providerAnchors: ProviderAnchorReader;
  readonly services: AccessServices;
}

export function createAccessServices(options: AccessServicesOptions): AccessAssembly {
  const {
    executor,
    keyring,
    providers,
    clock,
    ids,
    log,
    dispatch,
    publicOrigin,
    registration,
    tokens,
  } = options;
  const anchorList = providerAnchorsOf(providers);
  const providerAnchors = anchorReader(anchorList);

  const module = createAuthModule({
    ...(options.clientIp === undefined ? {} : { clientIp: options.clientIp }),
    repositories: createAuthRepositories(executor, { ...tokens.offboarding, log }),
    keyring,
    clock,
    ids,
    publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
    access: {
      access: wired('access repository', createAccessRepository(executor)),
      providerAnchors: providerAnchors.anchors,
      dispatch,
    },
    unlink: {
      unlinks: wired(
        'unlink repository',
        createUnlinkRepository(executor, {
          holderInput: () => ({
            kind: 'fresh',
            providers: anchorList,
          }),
        }),
      ),
      providers: providerAnchors,
    },
  });

  const projectRepository = wired(
    'project repository',
    createProjectRepository(executor, {
      reservedSlugs: reservedFirstSegments([...registration.routes, ...module.coreRoutes]),
      providerAnchors: anchorList,
    }),
  );
  const tokenRepository = wired('token repository', createTokenRepository(executor));
  const principalRepository = wired(
    'service principal repository',
    createServicePrincipalRepository(executor),
  );
  const authority = wired(
    'service principal authority',
    createServicePrincipalAuthority({ executor, providerAnchors: anchorList }),
  );
  const organizations = wired('organization repository', createOrganizationRepository(executor));
  const users = wired('user repository', createUserRepository(executor));
  const grants = wired(
    'grant repository',
    createGrantRepository(executor, {
      providerAnchors: anchorList,
      holderInput: () => ({ kind: 'fresh', providers: anchorList }),
    }),
  );
  const repositories = Object.freeze({
    organizations,
    projects: projectRepository,
    users,
    grants,
    principals: principalRepository,
  });
  const common = { clock, ids, log };
  const servicePrincipals = createServicePrincipalService({
    sessions: module.sessions,
    principals: principalRepository,
    authority,
    directory: principalRepository,
    ...common,
  });
  const onCreatorOffboarded = servicePrincipals.creatorOffboarded;

  const services: AccessServices = Object.freeze({
    engine: module.authorization,
    sessions: module.sessions,
    projects: createProjectService({ projects: projectRepository, ...common }),
    lifetime: tokens.lifetime,
    administration: createAdministration({
      roles: createRoleRepository(executor, { providerAnchors: anchorList }),
      grants,
      users,
      providers,
      onCreatorOffboarded,
      ...(tokens.offboarding.onUserOffboarded === undefined
        ? {}
        : { onUserOffboarded: tokens.offboarding.onUserOffboarded }),
      ...common,
    }),
    projectGrants: createProjectAdministration({
      grants: wired(
        'project grant repository',
        createProjectGrantRepository(executor, { ...tokens.offboarding, log }),
      ),
      providers,
      providerAnchors: anchorList,
      onCreatorOffboarded,
      ...tokens.offboarding,
      ...common,
    }),
    projectList: createProjectLister({
      source: projectRepository,
      readable: wired(
        'readable project repository',
        createReadableProjectRepository(executor, { providerAnchors: anchorList }),
      ),
    }),
    personalTokens: createPersonalTokenService({
      tokens: tokenRepository,
      sessions: module.sessions,
      organizations,
      providers: providerAnchors,
      keyring,
      lifetime: tokens.lifetime,
      ...common,
    }),
    servicePrincipals,
    serviceTokens: createServiceTokenService({
      tokens: tokenRepository,
      principals: principalRepository,
      authority,
      sessions: module.sessions,
      organizations,
      providers: providerAnchors,
      keyring,
      lifetime: tokens.lifetime,
      ...common,
    }),
    tokenRevoke: createTokenRevokeService({
      ids,
      tokens: tokenRepository,
      authority,
      ownership: tokenRepository,
      clock,
      log,
    }),
    tokenList: wired('token reader', createTokenReader(executor)),
  });
  return Object.freeze({ repositories, module, providerAnchors, services, anchors: anchorList });
}
