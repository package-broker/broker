import { entries as identityBlockEntries } from './mutation-table/identity-block.js';
import { entries as loginEntries } from './mutation-table/login.js';
import { entries as localLoginSuccessEntries } from './mutation-table/local-login-success.js';
import { entries as localLoginSetupEntries } from './mutation-table/local-login-setup.js';
import { entries as visibilitySubsetEntries } from './mutation-table/visibility-subset.js';
import { entries as visibilityAttachFactoryEntries } from './mutation-table/visibility-attach-factory.js';
import { entries as registeredNameFactoryEntries } from './mutation-table/registered-name-factory.js';
import { entries as importCredentialEntries } from './mutation-table/import-credential.js';
import { entries as importAuthorityEntries } from './mutation-table/import-authority.js';
import { entries as scopedAdmissionEntries } from './mutation-table/scoped-admission.js';
import { entries as proxyAdmissionFactoryEntries } from './mutation-table/proxy-admission-factory.js';
import { entries as finalizeListingEntries } from './mutation-table/finalize-listing.js';
import { entries as jobFactoryEntries } from './mutation-table/job-factory.js';
import { entries as representationClockEntries } from './mutation-table/representation-clock.js';
import { entries as blobReferencesFactoryEntries } from './mutation-table/blob-references-factory.js';
import { entries as cacheEpochFactoryEntries } from './mutation-table/cache-epoch-factory.js';
import { entries as catalogueListFactoryEntries } from './mutation-table/catalogue-list-factory.js';
import { entries as closureEdgesFactoryEntries } from './mutation-table/closure-edges-factory.js';
import { entries as catalogueReadFactoryEntries } from './mutation-table/catalogue-read-factory.js';
import { entries as catalogueLookupFactoryEntries } from './mutation-table/catalogue-lookup-factory.js';
import { entries as localLoginFactoryEntries } from './mutation-table/local-login-factory.js';
import { entries as existingVersionsFactoryEntries } from './mutation-table/existing-versions-factory.js';
import { entries as userFactoryEntries } from './mutation-table/user-factory.js';
import { entries as sessionFactoryEntries } from './mutation-table/session-factory.js';
import { entries as roleFactoryEntries } from './mutation-table/role-factory.js';
import { entries as grantFactoryEntries } from './mutation-table/grant-factory.js';
import { entries as jobScheduleFactoryEntries } from './mutation-table/job-schedule-factory.js';
import { entries as fetchLeaseFactoryEntries } from './mutation-table/fetch-lease-factory.js';
import { entries as credentialFactoryEntries } from './mutation-table/credential-factory.js';
import { entries as blobFactoryEntries } from './mutation-table/blob-factory.js';
import { entries as blobAccessFactoryEntries } from './mutation-table/blob-access-factory.js';
import { entries as catalogueDistEntries } from './mutation-table/catalogue-dist.js';
import { entries as sourceFactoryEntries } from './mutation-table/source-factory.js';
import { entries as upstreamStateEntries } from './mutation-table/upstream-state.js';
import { entries as ingestSessionFactoriesEntries } from './mutation-table/ingest-session-factories.js';
import { entries as idempotencyEntries } from './mutation-table/idempotency.js';
import { entries as removedBlobsEntries } from './mutation-table/removed-blobs.js';
import { entries as catalogueReconcileEntries } from './mutation-table/catalogue-reconcile.js';
import { entries as catalogueWriterEntries } from './mutation-table/catalogue-writer.js';
import { entries as attachedProxyEntries } from './mutation-table/source-attached-proxy.js';
import { entries as importRunEntries } from './mutation-table/import-run.js';
import { entries as projectReadableEntries } from './mutation-table/project-readable.js';
import { entries as catalogueStatusEntries } from './mutation-table/catalogue-status-statements.js';
import { entries as catalogueStatusRepositoryEntries } from './mutation-table/catalogue-status.js';
import { entries as visibilityDeriveEntries } from './mutation-table/visibility-derive.js';
import { entries as visibilityAttachEntries } from './mutation-table/visibility-attach.js';
import { entries as roleEntries } from './mutation-table/role.js';
import { entries as proxyAdmissionEntries } from './mutation-table/proxy-admission.js';
import { entries as catalogueReaderEntries } from './mutation-table/catalogue-reader.js';
import { entries as catalogueReadEntries } from './mutation-table/catalogue-read.js';
import { kyselyEntries } from './mutation-table/kysely.js';
import { entries as epochEntries } from './mutation-table/cache-epoch-bump.js';
import { entries as sessionEntries } from './mutation-table/session.js';
import { entries as blobLeaseEntries } from './mutation-table/blob-lease-guard.js';
import { entries as fetchLeaseEntries } from './mutation-table/fetch-lease.js';
import { entries as jobLeaseEntries } from './mutation-table/job-lease-guard.js';
import { entries as catalogueWriteDistEntries } from './mutation-table/catalogue-write-dist.js';
import { entries as ingestSessionEntries } from './mutation-table/ingest-session.js';
import { entries as cataloguePredicatesEntries } from './mutation-table/catalogue-predicates.js';
import { entries as registeredNameEntries } from './mutation-table/registered-name.js';
import { entries as catalogueWriteTagsEntries } from './mutation-table/catalogue-write-tags.js';
import { entries as accessBuilderEntries } from './mutation-table/access-builders.js';
import { entries as accessEntries } from './mutation-table/access.js';
import { entries as actorAuthorityEntries } from './mutation-table/actor-authority.js';
import { entries as servicePrincipalAuthorityEntries } from './mutation-table/service-principal-authority.js';
import { entries as blobReferencesEntries } from './mutation-table/blob-references.js';
import { entries as catalogueWritePackageEntries } from './mutation-table/catalogue-write-package.js';
import { entries as catalogueWriteVersionInsertEntries } from './mutation-table/catalogue-write-version-insert.js';
import { entries as catalogueWriteVersionUpdateEntries } from './mutation-table/catalogue-write-version-update.js';
import { entries as catalogueEpochEntries } from './mutation-table/catalogue-epoch.js';
import { entries as cacheEpochEntries } from './mutation-table/cache-epoch.js';
import { entries as sourceEntries } from './mutation-table/source.js';
import { entries as auditPendingEntries } from './mutation-table/audit-pending.js';
import { entries as auditSealEntries } from './mutation-table/audit-seal.js';
import { entries as auditVerifyEntries } from './mutation-table/audit-verify.js';
import { entries as auditQueryEntries } from './mutation-table/audit-query.js';
import { entries as catalogueReblobEntries } from './mutation-table/catalogue-reblob.js';
import {
  checkCompleteness as checkInventory,
  builderAllowlist,
} from './mutation-table/inventory.js';
import type { MutationEntry } from './mutation-table/harness.js';

export * from './mutation-table/harness.js';
export { builderAllowlist, exportedBuilders, builderNames } from './mutation-table/inventory.js';

export const mutationTable: readonly MutationEntry[] = [
  ...identityBlockEntries,
  ...loginEntries,
  ...localLoginSuccessEntries,
  ...localLoginSetupEntries,
  ...visibilitySubsetEntries,
  ...visibilityAttachFactoryEntries,
  ...registeredNameFactoryEntries,
  ...importCredentialEntries,
  ...importAuthorityEntries,
  ...scopedAdmissionEntries,
  ...proxyAdmissionFactoryEntries,
  ...finalizeListingEntries,
  ...jobFactoryEntries,
  ...representationClockEntries,
  ...blobReferencesFactoryEntries,
  ...cacheEpochFactoryEntries,
  ...catalogueListFactoryEntries,
  ...closureEdgesFactoryEntries,
  ...catalogueReadFactoryEntries,
  ...catalogueLookupFactoryEntries,
  ...ingestSessionFactoriesEntries,
  ...upstreamStateEntries,
  ...sourceFactoryEntries,
  ...catalogueDistEntries,
  ...blobAccessFactoryEntries,
  ...blobFactoryEntries,
  ...credentialFactoryEntries,
  ...fetchLeaseFactoryEntries,
  ...jobScheduleFactoryEntries,
  ...grantFactoryEntries,
  ...roleFactoryEntries,
  ...sessionFactoryEntries,
  ...userFactoryEntries,
  ...existingVersionsFactoryEntries,
  ...localLoginFactoryEntries,

  ...idempotencyEntries,
  ...removedBlobsEntries,
  ...catalogueWriterEntries,
  ...catalogueReconcileEntries,
  ...importRunEntries,
  ...projectReadableEntries,
  ...catalogueStatusEntries,
  ...catalogueStatusRepositoryEntries,
  ...visibilityDeriveEntries,
  ...visibilityAttachEntries,
  ...roleEntries,
  ...proxyAdmissionEntries,
  ...catalogueReadEntries,
  ...catalogueReaderEntries,
  ...catalogueWriteDistEntries,
  ...ingestSessionEntries,
  ...cataloguePredicatesEntries,
  ...registeredNameEntries,
  ...catalogueWriteTagsEntries,
  ...accessEntries,
  ...accessBuilderEntries,
  ...actorAuthorityEntries,
  ...servicePrincipalAuthorityEntries,
  ...blobReferencesEntries,
  ...catalogueWritePackageEntries,
  ...catalogueWriteVersionInsertEntries,
  ...catalogueWriteVersionUpdateEntries,
  ...cacheEpochEntries,
  ...catalogueEpochEntries,
  ...sourceEntries,
  ...attachedProxyEntries,
  ...auditPendingEntries,
  ...auditSealEntries,
  ...auditVerifyEntries,
  ...auditQueryEntries,
  ...catalogueReblobEntries,
  ...blobLeaseEntries,
  ...fetchLeaseEntries,
  ...jobLeaseEntries,
  ...kyselyEntries,
  ...epochEntries,
  ...sessionEntries,
];

export function checkCompleteness(
  sources: Readonly<Record<string, string>>,
  table: readonly MutationEntry[] = mutationTable,
  allowlist: Readonly<Record<string, string>> = builderAllowlist,
): string[] {
  return checkInventory(sources, table, allowlist);
}
