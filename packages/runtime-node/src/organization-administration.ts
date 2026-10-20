import {
  createAdministration,
  type Administration,
  type AdministrationDeps,
} from '@package-broker/core/authz/administration';
import type { SqlExecutor } from '@package-broker/core/db/port';
import type { ConfiguredProviderAnchor } from '@package-broker/core/identity/provider-anchors';
import { createGrantRepository } from '@package-broker/db-sqlite/repositories/grant';
import { createRoleRepository } from '@package-broker/db-sqlite/repositories/role';
import { createUserRepository } from '@package-broker/db-sqlite/repositories/user';

export function createOrganizationAdministration(
  executor: SqlExecutor,
  providerAnchors: readonly ConfiguredProviderAnchor[],
  deps: Omit<AdministrationDeps, 'roles' | 'grants' | 'users'>,
): Administration {
  return createAdministration({
    roles: createRoleRepository(executor, { providerAnchors }),
    grants: createGrantRepository(executor, {
      providerAnchors,
      holderInput: () => ({ kind: 'fresh', providers: providerAnchors }),
    }),
    users: createUserRepository(executor),
    ...deps,
  });
}
