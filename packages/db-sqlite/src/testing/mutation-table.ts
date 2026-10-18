import { entries as catalogueReconcileEntries } from './mutation-table/catalogue-reconcile.js';
import { entries as projectReadableEntries } from './mutation-table/project-readable.js';
import { entries as catalogueStatusEntries } from './mutation-table/catalogue-status-statements.js';
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
import { entries as auditSealEntries } from './mutation-table/audit-seal.js';
import { entries as auditVerifyEntries } from './mutation-table/audit-verify.js';
import { entries as auditQueryEntries } from './mutation-table/audit-query.js';
import {
  checkCompleteness as checkInventory,
  builderAllowlist,
} from './mutation-table/inventory.js';
import type { MutationEntry } from './mutation-table/harness.js';

export * from './mutation-table/harness.js';
export { builderAllowlist, exportedBuilders, builderNames } from './mutation-table/inventory.js';

export const mutationTable: readonly MutationEntry[] = [
  ...catalogueReconcileEntries,
  ...projectReadableEntries,
  ...catalogueStatusEntries,
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
  ...actorAuthorityEntries,
  ...servicePrincipalAuthorityEntries,
  ...blobReferencesEntries,
  ...catalogueWritePackageEntries,
  ...catalogueWriteVersionInsertEntries,
  ...catalogueWriteVersionUpdateEntries,
  ...cacheEpochEntries,
  ...catalogueEpochEntries,
  ...sourceEntries,
  ...auditSealEntries,
  ...auditVerifyEntries,
  ...auditQueryEntries,
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
