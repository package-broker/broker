import { clientIpOf } from '@package-broker/core/auth/session';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { resolveTokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import { createVisibilityService } from '@package-broker/core/catalogue/visibility-service';
import { systemClock, ulid } from '@package-broker/core/ids';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { RequestContext } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createAccessServices } from '../repositories/access-services.js';
import type { ApiRoutesOptions } from '../repositories/api-services.js';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { createVisibilityStore } from '../repositories/catalogue-writer.js';

export function apiOptions(executor: SqlExecutor): ApiRoutesOptions {
  const registration = collectRegistrations([]);
  const keyring = createKeyring([
    parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
  ]);
  const lifetime = resolveTokenLifetimePolicy(undefined);
  const log = () => undefined;
  const access = createAccessServices({
    executor,
    keyring,
    registration,
    clock: systemClock,
    ids: { ulid },
    log,
    publicOrigin: 'https://broker.example.test',
    dispatch: () => undefined,
    providers: buildIdentityProviders(registration, [], {
      fetch: (request) => fetch(request),
      clock: systemClock,
      env: () => undefined,
    }),
    tokens: { lifetime, offboarding: {} },
  });
  return {
    executor,
    keyring,
    access,
    lifetime,
    log,
    runtime: 'cloudflare',
    clientIp: clientIpOf,
    blob: undefined,
    packages: {
      reader: createCatalogueReader(executor),
      visibility: createVisibilityService({
        store: createVisibilityStore(executor, { providerAnchors: access.anchors }),
        log,
      }),
    },
    vulnerability: { readStatuses: async () => new Map() },
    policy: createOutboundPolicy({ runtime: 'cloudflare', allowPrivateHosts: [], selfOrigins: [] }),
  };
}

export function apiContext(org: OrgContext | null, path: string): RequestContext {
  return {
    org,
    request: new Request(`https://broker.example.test${path}`),
    requestId: 'request',
    principal: null,
    projectId: null,
    params: {},
    ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
  };
}
