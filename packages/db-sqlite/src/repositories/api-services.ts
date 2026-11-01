import { createTrustedPublisherStore, createTrustedPublisherLookup } from './trusted-publishers.js';
import type { TrustedPublisherRouteDeps } from '@package-broker/core/api/routes/trusted-publishers';
import { createPackageDetailRepository } from './package-detail.js';
import { npmLoginRoutes } from '@package-broker/core/api/routes/npm-login';
import { createPublishesRepository } from './publishes.js';
import { createPackageAccessRequestRepository } from './package-access-requests.js';
import { createSourcePackageStore } from './source-package-request.js';
import type { SourcePackageProbe } from '@package-broker/core/ingest/source-package';
import { createProjectGrantReader } from './project-grant-read.js';
import type { createVulnerabilityRuntime } from '@package-broker/core/runtime/vulnerability';
import { createApiModule, ApiModuleDependencyError } from '@package-broker/core/api/module';
import type { AuditReader } from '@package-broker/core/api/routes/audit';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import type { VcsProvider } from '@package-broker/core/sources/config';
import { createSourceService } from '@package-broker/core/sources/source-service';
import type { OutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createIdempotencyRepository } from './idempotency.js';
import { createAuditQueryRepository } from './audit-query.js';
import { createPackageAdminReader } from './package-admin-read.js';
import { createProjectSourceReader } from './project-source-read.js';
import { createRegisteredNameRepository } from './registered-name.js';
import type { RouteDefinition } from '@package-broker/core/plugin';
import type { CatalogueReader } from '@package-broker/core/db/catalogue';
import type { VisibilityService } from '@package-broker/core/catalogue/visibility-service';
import type { TokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createPackageManageService } from '@package-broker/core/catalogue/package-manage-service';
import { createImportCredentialService } from '@package-broker/core/import/credentials';
import { createImportRunService } from '@package-broker/core/import/run-service';
import { importWriteTokenFence } from '@package-broker/core/kernel/import-token-fence';
import { auditPendingStatement } from './audit-pending.js';
import { createImportCredentialRepository } from './import-credential.js';
import { createImportRunStore } from './import-run.js';
import type { CoreBlobStore as BlobStore } from '@package-broker/core/platform/blob';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createCredentialRepository } from './credential.js';
import { createSourceRepository } from './source.js';
import { createVisibilityStore } from './catalogue-writer.js';
import type { AccessAssembly } from './access-services.js';

function auditReader(executor: SqlExecutor): AuditReader {
  const audit = createAuditQueryRepository(executor);
  const organization = (ctx: Parameters<AuditReader['list']>[0]): OrgContext => {
    if (ctx.org === null) throw new TypeError('route requires an organization context');
    return ctx.org;
  };
  return {
    list: (ctx, query) =>
      audit.list(organization(ctx), {
        limit: query.limit,
        ...(query.projectId === null ? {} : { projectId: query.projectId }),
        ...(query.actor === undefined ? {} : { actor: query.actor }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.after === undefined ? {} : { afterId: query.after }),
      }),
    async head(ctx) {
      const head = await audit.head(organization(ctx));
      return {
        seq: head?.seq ?? 0,
        hash: head?.hash ?? AUDIT_GENESIS_HASH,
        pendingCount: head?.pending ?? 0,
        lastVerifiedAt: head?.lastVerifiedAt ?? null,
      };
    },
  };
}

export interface ApiRoutesOptions {
  readonly runtime: 'node' | 'cloudflare';
  readonly clientIp: (request: Request) => string | null;
  readonly executor: SqlExecutor;
  readonly keyring: Keyring;
  readonly access: AccessAssembly;
  readonly packages: { readonly reader: CatalogueReader; readonly visibility: VisibilityService };
  readonly vulnerability: Pick<ReturnType<typeof createVulnerabilityRuntime>, 'readStatuses'>;
  readonly policy: OutboundPolicy;
  readonly lifetime: TokenLifetimePolicy;
  readonly log: KernelLog;
  readonly blob: BlobStore | undefined;
  readonly sourcePackageProbe?: SourcePackageProbe;
  readonly trustedPublisherLookup?: (
    ctx: OrgContext,
    sourceId: string,
    repository: string,
    signal: AbortSignal,
  ) => ReturnType<TrustedPublisherRouteDeps['lookup']>;
  /** The VCS providers the runtime has registered and serves, read per request. */
  readonly vcsProviders?: () => readonly VcsProvider[];
  readonly refuseVcsProvider?: (provider: VcsProvider) => boolean;
}

export function createApiRoutes(input: ApiRoutesOptions): readonly RouteDefinition[] {
  const { executor, access, packages, lifetime, log, blob } = input;
  const { services } = access;
  const anchors = access.anchors;
  const common = { ids: { ulid }, clock: systemClock, clientIp: input.clientIp };
  const { organizations, projects, users, grants, principals } = access.repositories;
  const idempotency = createIdempotencyRepository(executor);
  const sources = createSourceRepository(executor);
  const credentialRepository = createCredentialRepository(executor);
  const registeredNames = createRegisteredNameRepository(executor);
  const credentialStore = createCredentialStore({
    repository: credentialRepository,
    cipher: createSecretCipher(input.keyring, 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  });
  const sourceService = createSourceService({
    ...(input.sourcePackageProbe === undefined ? {} : { claimProbe: input.sourcePackageProbe }),
    sources,
    organizations,
    registeredNames,
    credentials: credentialStore,
    credentialRepository,
    catalogue: packages.reader,
    policy: input.policy,
    providerAnchors: anchors,
    ids: { ulid },
    log,
  });
  if (blob === undefined) {
    log({ level: 'info', event: 'api.import_routes_omitted', reason: 'blob_store_not_configured' });
  }
  try {
    const module = createApiModule({
      npmLogin: access.npmLogin,
      trustedPublishers: {
        ...common,
        store: createTrustedPublisherStore(executor, anchors),
        lookup: createTrustedPublisherLookup(
          executor,
          input.trustedPublisherLookup ?? (async () => null),
        ),
      },
      publishes: { ...common, publishes: createPublishesRepository(executor, anchors) },
      packageAccessRequests: {
        ...common,
        repository: createPackageAccessRequestRepository(executor, anchors),
      },
      organization: {
        ...common,
        organizations,
        users,
        administration: services.administration,
        lifetime,
      },
      projects: {
        ...common,
        lister: services.projectList,
        service: services.projects,
        projects,
        idempotency,
      },
      access: {
        ...common,
        administration: services.administration,
        grants,
      },
      projectAccess: {
        ...common,
        projectAdministration: services.projectGrants,
        reader: createProjectGrantReader(executor),
        roles: {
          get: async (ctx, id) =>
            (await services.administration.listRoles(ctx)).find((role) => role.id === id) ?? null,
        },
      },
      tokens: {
        ...common,
        tokens: {
          personal: services.personalTokens,
          service: services.serviceTokens,
          revoke: services.tokenRevoke,
        },
        reader: services.tokenList,
        idempotency,
        sessions: services.sessions,
        organizations,
        lifetime,
      },
      servicePrincipals: {
        ...common,
        servicePrincipals: services.servicePrincipals,
        principals,
      },
      sources: {
        ...common,
        service: sourceService,
        sources,
        projectSources: createProjectSourceReader(executor),
        projects,
        sessions: services.sessions,
        ...(input.vcsProviders === undefined ? {} : { vcsProviders: input.vcsProviders }),
        ...(input.refuseVcsProvider === undefined
          ? {}
          : { refuseVcsProvider: input.refuseVcsProvider }),
      },
      sourceNames: {
        ...common,
        service: sourceService,
        sources,
        registeredNames,
        visibility: packages.visibility,
        projectSources: createProjectSourceReader(executor),
        projects,
      },
      sourcePackages: {
        ...common,
        sources,
        projects,
        projectSources: createProjectSourceReader(executor),
        store: createSourcePackageStore(executor, anchors),
        probe: input.sourcePackageProbe ?? (async () => 'unavailable'),
      },
      sourceAttachments: {
        ...common,
        proxyClaims: {
          sources,
          registeredNames,
          ...(input.sourcePackageProbe === undefined
            ? {}
            : { claimProbe: input.sourcePackageProbe }),
        },
        sources,
        visibility: packages.visibility,
        projectSources: createProjectSourceReader(executor),
        projects,
      },
      packageDetail: {
        ...common,
        repository: createPackageDetailRepository(executor, anchors),
        idempotency,
      },
      packages: {
        ...createPackageAdminReader(executor),
        readStatuses: input.vulnerability.readStatuses,
      },
      audit: auditReader(executor),
      packageManage: {
        ...common,
        service: createPackageManageService({
          reader: createPackageAdminReader(executor),
          store: createVisibilityStore(executor, { providerAnchors: anchors }),
          sessions: services.sessions,
          clock: systemClock,
          ids: { ulid },
          log,
        }),
        sessions: services.sessions,
        idempotency,
      },
      ...(blob === undefined
        ? {}
        : {
            imports: {
              ...common,
              service: createImportRunService({
                store: createImportRunStore({
                  executor,
                  blobs: blob,
                  providerAnchors: anchors,
                }),
                ids: { ulid },
                clock: systemClock,
              }),
              credentials: createImportCredentialService({
                store: createImportCredentialRepository(executor, {
                  blobs: blob,
                  providerAnchors: anchors,
                }),
                credentials: credentialStore,
                runtime: input.runtime,
                ids: { ulid },
                auditStatement: auditPendingStatement,
              }),
              auditStatement: auditPendingStatement,
              tokenFence: importWriteTokenFence,
            },
          }),
    });
    return [
      ...npmLoginRoutes(access.npmLogin).filter((route) => !route.path.startsWith('/_pb/')),
      ...module.routes,
    ];
  } catch (error) {
    if (error instanceof ApiModuleDependencyError) {
      throw new KernelConfigError([error.message]);
    }
    throw error;
  }
}
