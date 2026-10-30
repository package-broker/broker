import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Review {
  reason: string;
  parents: readonly string[];
}

// Keys use expression text and occurrence, so unrelated line shifts need no re-review.
// All changes accesses are conservative candidates, including domain values and test helpers.
const REVIEWED: Readonly<Record<string, Review>> = {
  'db-sqlite/src/contract/catalogue-read-contract.ts:results[index]?.changes #1': {
    reason: 'Fixture asserts only project_package inserts; inserts cannot fire FK actions.',
    parents: ['project_package'],
  },
  'db-sqlite/src/contract/executor-contract.ts:results[2]?.changes #1': {
    reason:
      'Executor contract assertions on its isolated item table, with no inbound foreign keys.',
    parents: [],
  },
  'db-sqlite/src/contract/executor-contract.ts:results[3]?.changes #1': {
    reason:
      'Executor contract assertions on its isolated item table, with no inbound foreign keys.',
    parents: [],
  },
  'db-sqlite/src/internal/catalogue-status-statements.ts:results[1]?.changes #1': {
    reason: 'Version status/revision update; referenced version id is unchanged.',
    parents: ['version'],
  },
  'db-sqlite/src/repositories/blob-access.ts:result?.changes #1': {
    reason: 'Blob last_accessed_at update; referenced blob keys are unchanged.',
    parents: ['blob'],
  },
  'db-sqlite/src/repositories/blob.ts:result?.changes #1': {
    reason: 'Lifecycle updates leave referenced blob keys unchanged.',
    parents: ['blob'],
  },
  'db-sqlite/src/repositories/blob.ts:result?.changes #2': {
    reason: 'Unschedule clears purge_after, leaving referenced blob keys unchanged.',
    parents: ['blob'],
  },
  'db-sqlite/src/repositories/blob.ts:result?.changes #3': {
    reason: 'Orphan scheduling sets purge_after, leaving referenced blob keys unchanged.',
    parents: ['blob'],
  },
  'db-sqlite/src/repositories/catalogue-reconcile.ts:result.changes #1': {
    reason:
      'Fallback counts version listing-marker updates with referenced id and org_id unchanged; removals with RETURNING use rows.',
    parents: ['package', 'version'],
  },
  'db-sqlite/src/repositories/catalogue-reconcile.ts:results[updateIndex]?.changes #1': {
    reason:
      'Counts listing marker and status/revision updates on package/version; referenced ids are unchanged.',
    parents: ['package', 'version'],
  },
  'db-sqlite/src/repositories/catalogue-reconcile.ts:results[restorationIndex]?.changes #1': {
    reason:
      'Counts listing marker and status/revision updates on package/version; referenced ids are unchanged.',
    parents: ['package', 'version'],
  },
  'db-sqlite/src/repositories/catalogue-reconcile.ts:results[flip]?.changes #1': {
    reason:
      'Counts listing marker and status/revision updates on package/version; referenced ids are unchanged.',
    parents: ['package', 'version'],
  },
  'db-sqlite/src/repositories/catalogue-write-dist.ts:results[attachIndex]?.changes #1': {
    reason:
      'Version dist attachment changes blob_id and last_op_id, leaving referenced version id unchanged.',
    parents: ['version'],
  },
  'db-sqlite/src/repositories/catalogue-write-tags.ts:result.changes #1': {
    reason:
      'Counts dist_tag writes and dist_tag_history insert; neither table has inbound foreign keys.',
    parents: ['dist_tag', 'dist_tag_history'],
  },
  'db-sqlite/src/repositories/catalogue-write-tags.ts:results[setOffset + sets.length]?.changes #1':
    {
      reason:
        'Counts dist_tag writes and dist_tag_history insert; neither table has inbound foreign keys.',
      parents: ['dist_tag', 'dist_tag_history'],
    },
  'db-sqlite/src/repositories/catalogue-write-version-insert.ts:result.changes #1': {
    reason:
      'Counts the version INSERT slice, excluding later package updates; no FK action on insert.',
    parents: ['version'],
  },
  'db-sqlite/src/repositories/catalogue-write-version-update.ts:result.changes #1': {
    reason:
      'Counts revision inserts and in-place metadata updates; referenced version id is unchanged.',
    parents: ['version', 'version_revision'],
  },
  'db-sqlite/src/repositories/fetch-lease.ts:result?.changes #1': {
    reason: 'Fetch lease row mutation; fetch_lease has no inbound foreign keys.',
    parents: ['fetch_lease'],
  },
  'db-sqlite/src/repositories/idempotency.ts:result?.changes #1': {
    reason:
      'Counts expired api_idempotency deletions; api_idempotency has no inbound foreign keys.',
    parents: ['api_idempotency'],
  },
  'db-sqlite/src/repositories/ingest-finalize.ts:results[index]?.changes #1': {
    reason:
      'Counts only upstream_state validator upsert slots; upstream_state has no inbound foreign keys.',
    parents: ['upstream_state'],
  },
  'db-sqlite/src/repositories/ingest-finalize.ts:results[acceptanceAuditIndex]?.changes #1': {
    reason: 'Counts the conditional audit_pending insert; inserts cannot fire FK actions.',
    parents: ['audit_pending'],
  },
  'db-sqlite/src/repositories/ingest-session.ts:result?.changes #1': {
    reason: 'Ingest session update/delete; ingest_session has no inbound foreign keys.',
    parents: ['ingest_session'],
  },
  'db-sqlite/src/repositories/ingest-session.ts:abandoned?.changes #1': {
    reason: 'Ingest session update/delete; ingest_session has no inbound foreign keys.',
    parents: ['ingest_session'],
  },
  'db-sqlite/src/repositories/ingest-session.ts:deleted?.changes #1': {
    reason: 'Ingest session update/delete; ingest_session has no inbound foreign keys.',
    parents: ['ingest_session'],
  },
  'db-sqlite/src/repositories/job-schedule.ts:results[insertAt]?.changes #1': {
    reason: 'Counts the job INSERT slot only; no FK action on insert.',
    parents: ['job'],
  },
  'db-sqlite/src/repositories/job.ts:first.changes #1': {
    reason:
      'Job inserts and state/lease/attempt updates; referenced job id is unchanged, job_attempt has no inbound FK.',
    parents: ['job', 'job_attempt'],
  },
  'db-sqlite/src/repositories/job.ts:last.changes #1': {
    reason:
      'Job inserts and state/lease/attempt updates; referenced job id is unchanged, job_attempt has no inbound FK.',
    parents: ['job', 'job_attempt'],
  },
  'db-sqlite/src/repositories/job.ts:inserted?.changes #1': {
    reason:
      'Job inserts and state/lease/attempt updates; referenced job id is unchanged, job_attempt has no inbound FK.',
    parents: ['job', 'job_attempt'],
  },
  'db-sqlite/src/repositories/job.ts:result.changes #1': {
    reason:
      'Job inserts and state/lease/attempt updates; referenced job id is unchanged, job_attempt has no inbound FK.',
    parents: ['job', 'job_attempt'],
  },
  'db-sqlite/src/repositories/keyring-verifier.ts:result?.changes #1': {
    reason: 'Verifier inserts; no FK actions on insert and no inbound foreign keys.',
    parents: ['keyring_verifier'],
  },
  'db-sqlite/src/repositories/keyring-verifier.ts:results[0]?.changes #1': {
    reason: 'Verifier inserts; no FK actions on insert and no inbound foreign keys.',
    parents: ['keyring_verifier'],
  },
  'db-sqlite/src/repositories/local-login-setup.ts:results[3]?.changes #1': {
    reason:
      'Reads only local_login update and session insert slots, never the credential deletion slot.',
    parents: ['local_login', 'session'],
  },
  'db-sqlite/src/repositories/local-login-setup.ts:results[1]?.changes #1': {
    reason:
      'Reads only local_login update and session insert slots, never the credential deletion slot.',
    parents: ['local_login', 'session'],
  },
  'db-sqlite/src/repositories/local-login-success.ts:results[0]?.changes #1': {
    reason: 'Password hash/revision update on local_login; no inbound foreign keys.',
    parents: ['local_login'],
  },
  'db-sqlite/src/repositories/local-login-success.ts:results[1]?.changes #1': {
    reason: 'Reads the session reauthentication update; session has no inbound foreign keys.',
    parents: ['session'],
  },
  'db-sqlite/src/repositories/project.ts:changes #1': {
    reason: 'Destructures domain update input, not an executor result.',
    parents: [],
  },
  'db-sqlite/src/repositories/provider-binding.ts:results[BINDING]?.changes #1': {
    reason:
      'Reads provider_binding update and session deletion only; identity deletion uses RETURNING rows.',
    parents: ['identity_provider_binding', 'session'],
  },
  'db-sqlite/src/repositories/provider-binding.ts:results[SESSIONS]?.changes #1': {
    reason:
      'Reads provider_binding update and session deletion only; identity deletion uses RETURNING rows.',
    parents: ['identity_provider_binding', 'session'],
  },
  'db-sqlite/src/repositories/registered-name.ts:outcome.results[outcome.results.length - (input.idempotency === undefined ? 3 : 4)] ?.changes #1':
    {
      reason: 'Reads the final source status update, leaving referenced source id unchanged.',
      parents: ['source'],
    },
  'db-sqlite/src/repositories/source.ts:input.changes #1': {
    reason: 'Domain source update input, not an executor result.',
    parents: [],
  },
  'db-sqlite/src/repositories/source.ts:input.changes #2': {
    reason: 'Domain source update input, not an executor result.',
    parents: [],
  },
  'db-sqlite/src/repositories/source.ts:result?.changes #1': {
    reason: 'Source poll/defer update leaves referenced id and org_id unchanged.',
    parents: ['source'],
  },
  'db-sqlite/src/repositories/visibility-subset.ts:results[GUARD_STATEMENTS + index]?.changes #1': {
    reason:
      'Counts project source/pattern membership rows; those tables have no inbound foreign keys.',
    parents: ['project_source', 'project_package', 'project_package_pattern'],
  },
  'db-sqlite/src/repositories/vulnerability.ts:r.changes #1': {
    reason:
      'Pruning reports aggregate work including FK cascades; the job ignores this value, never using it as a parent row count.',
    parents: ['vulnerability_result', 'vulnerability_refresh', 'vulnerability_advisory'],
  },
  'db-sqlite/src/repositories/webhook-delivery.ts:insert?.changes #1': {
    reason: 'Delivery insert reports new versus duplicate; inserts cannot fire FK actions.',
    parents: ['webhook_delivery'],
  },
  'db-sqlite/src/testing/catalogue-fixture.ts:results[index]?.changes #1': {
    reason: 'Fixture checks only project_package insert slots; inserts cannot fire FK actions.',
    parents: ['project_package'],
  },
  'db-sqlite/src/testing/mutation-table/blob-references.ts:...changes #1': {
    reason: 'Object spread of domain reference changes, not an executor result.',
    parents: [],
  },
  'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:result?.changes #1': {
    reason:
      'Mutation assertions on revision inserts and blob/revision/package clock updates; referenced ids are unchanged.',
    parents: ['package', 'version', 'version_revision'],
  },
  'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:result?.changes #2': {
    reason:
      'Mutation assertions on revision inserts and blob/revision/package clock updates; referenced ids are unchanged.',
    parents: ['package', 'version', 'version_revision'],
  },
  'db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:result?.changes #1': {
    reason: 'Mutation assertions on version dist attachment; referenced version id is unchanged.',
    parents: ['version'],
  },
  'db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:result?.changes #2': {
    reason: 'Mutation assertions on version dist attachment; referenced version id is unchanged.',
    parents: ['version'],
  },
  'db-sqlite/src/testing/mutation-table/harness.ts:result?.changes #1': {
    reason:
      'Mutation harness checks only project_package insert slots; inserts cannot fire FK actions.',
    parents: ['project_package'],
  },
  'db-sqlite/src/testing/node-sqlite-executor.ts:changes #1': {
    reason:
      'Test driver adapts native node:sqlite changes; repository callers remain subject to this inventory.',
    parents: [],
  },
  'runtime-cloudflare/src/db/d1-executor.ts:result.meta?.changes #1': {
    reason:
      'D1 adapter exposes raw meta.changes; consumers must review FK actions before treating it as a row count.',
    parents: [],
  },
};

// Runtime dependency closure of readers, including re-exports and aliased imports.
const REVIEWED_IMPORTS: readonly string[] = [
  'db-sqlite/src/contract/count-calls.ts',
  'db-sqlite/src/contract/two-organizations.ts',
  'db-sqlite/src/internal/catalogue-write-guard.ts',
  'db-sqlite/src/internal/lease-time.ts',
  'db-sqlite/src/kysely.ts',
  'db-sqlite/src/migrations/lock.ts',
  'db-sqlite/src/migrations/plan.ts',
  'db-sqlite/src/migrations/runner.ts',
  'db-sqlite/src/migrations/source.ts',
  'db-sqlite/src/migrations/split.ts',
  'db-sqlite/src/repositories/access.ts',
  'db-sqlite/src/repositories/actor-authority.ts',
  'db-sqlite/src/repositories/audit-pending.ts',
  'db-sqlite/src/repositories/blob-lease-guard.ts',
  'db-sqlite/src/repositories/blob-references.ts',
  'db-sqlite/src/repositories/blob-replacer.ts',
  'db-sqlite/src/repositories/blob.ts',
  'db-sqlite/src/repositories/catalogue-dist.ts',
  'db-sqlite/src/repositories/catalogue-list.ts',
  'db-sqlite/src/repositories/catalogue-lookup.ts',
  'db-sqlite/src/repositories/catalogue-predicates.ts',
  'db-sqlite/src/repositories/catalogue-read.ts',
  'db-sqlite/src/repositories/catalogue-reblob.ts',
  'db-sqlite/src/repositories/catalogue-reconcile.ts',
  'db-sqlite/src/repositories/catalogue-write-dist.ts',
  'db-sqlite/src/repositories/catalogue-write-package.ts',
  'db-sqlite/src/repositories/catalogue.ts',
  'db-sqlite/src/repositories/closure-edges.ts',
  'db-sqlite/src/repositories/credential.ts',
  'db-sqlite/src/repositories/fetch-lease.ts',
  'db-sqlite/src/repositories/idempotency.ts',
  'db-sqlite/src/repositories/ingest-session.ts',
  'db-sqlite/src/repositories/job-lease-guard.ts',
  'db-sqlite/src/repositories/proxy-admission.ts',
  'db-sqlite/src/repositories/registered-name.ts',
  'db-sqlite/src/repositories/session-liveness.ts',
  'db-sqlite/src/repositories/session.ts',
  'db-sqlite/src/repositories/source-attachment-counts.ts',
  'db-sqlite/src/repositories/source-removal.ts',
  'db-sqlite/src/repositories/source-selection-revision.ts',
  'db-sqlite/src/repositories/source-selection.ts',
  'db-sqlite/src/repositories/source.ts',
  'db-sqlite/src/repositories/upstream-state.ts',
  'db-sqlite/src/repositories/visibility-attach.ts',
  'db-sqlite/src/repositories/visibility-audit.ts',
  'db-sqlite/src/repositories/visibility-derive.ts',
  'db-sqlite/src/sql/project-prefix.ts',
  'db-sqlite/src/sql/scan.ts',
  'db-sqlite/src/testing/foreign-keys-off.ts',
  'db-sqlite/src/testing/migrated-database.ts',
  'db-sqlite/src/testing/mutation-table/fixtures.ts',
  'db-sqlite/src/testing/mutation-table/harness.ts',
  'db-sqlite/src/testing/node-sqlite-executor.ts',
  'db-sqlite/src/testing/sql-snapshot.ts',
];

// Mutation targets in readers and imported statement builders; no whole-source pins.
const REVIEWED_TARGETS: Readonly<Record<string, string>> = {
  'db-sqlite/src/contract/catalogue-read-contract.ts':
    'DELETE FROM package; DELETE FROM project_package x2; DELETE FROM project_package_pattern; DELETE FROM project_source; DELETE FROM registered_name x2; DELETE FROM version; INSERT INTO blob; INSERT INTO dist_tag; INSERT INTO package; INSERT INTO project x3; INSERT INTO project_package; INSERT INTO project_package_pattern; INSERT INTO project_source; INSERT INTO registered_name x2; INSERT INTO source x2; INSERT INTO version; INSERT INTO version_revision x2; UPDATE package; UPDATE project x3; UPDATE project_package; UPDATE project_source x3; UPDATE source x6; UPDATE version x5; UPDATE version_revision',
  'db-sqlite/src/contract/count-calls.ts': '',
  'db-sqlite/src/contract/executor-contract.ts':
    'INSERT INTO child x3; INSERT INTO item x9; INSERT INTO value_row; UPDATE item x2',
  'db-sqlite/src/contract/two-organizations.ts':
    'INSERT INTO cache_epoch; INSERT INTO organization',
  'db-sqlite/src/internal/catalogue-status-statements.ts':
    "insertInto('version_revision'); updateTable('cache_epoch'); updateTable('package'); updateTable('version')",
  'db-sqlite/src/internal/catalogue-write-guard.ts': '',
  'db-sqlite/src/internal/lease-time.ts': '',
  'db-sqlite/src/kysely.ts': "insertInto('access_mutation_guard') x2; updateTable('cache_epoch')",
  'db-sqlite/src/migrations/lock.ts':
    'INSERT INTO migration_lock; INSERT OR IGNORE INTO migration_lock; UPDATE migration_lock x3',
  'db-sqlite/src/migrations/plan.ts': '',
  'db-sqlite/src/migrations/runner.ts': 'INSERT INTO schema_migration',
  'db-sqlite/src/migrations/source.ts': '',
  'db-sqlite/src/migrations/split.ts': '',
  'db-sqlite/src/repositories/access.ts': "updateTable('session'); updateTable('token')",
  'db-sqlite/src/repositories/actor-authority.ts': '',
  'db-sqlite/src/repositories/audit-pending.ts': 'INSERT INTO audit_pending',
  'db-sqlite/src/repositories/blob-access.ts': "updateTable('blob')",
  'db-sqlite/src/repositories/blob-lease-guard.ts': '',
  'db-sqlite/src/repositories/blob-references.ts': '',
  'db-sqlite/src/repositories/blob-replacer.ts': '',
  'db-sqlite/src/repositories/blob.ts':
    "UPDATE blob; insertInto('blob') [onConflict:doUpdateSet]; updateTable('blob') x7",
  'db-sqlite/src/repositories/catalogue-dist.ts': '',
  'db-sqlite/src/repositories/catalogue-list.ts': '',
  'db-sqlite/src/repositories/catalogue-lookup.ts': '',
  'db-sqlite/src/repositories/catalogue-predicates.ts': '',
  'db-sqlite/src/repositories/catalogue-read.ts': '',
  'db-sqlite/src/repositories/catalogue-reblob.ts':
    "insertInto('version_revision'); updateTable('package'); updateTable('version')",
  'db-sqlite/src/repositories/catalogue-reconcile.ts':
    'INSERT INTO version_revision; UPDATE blob; UPDATE cache_epoch; UPDATE package x9; UPDATE source; UPDATE version x3',
  'db-sqlite/src/repositories/catalogue-write-dist.ts':
    "updateTable('package'); updateTable('version')",
  'db-sqlite/src/repositories/catalogue-write-package.ts':
    "insertInto('package') [onConflict:doNothing]; updateTable('package')",
  'db-sqlite/src/repositories/catalogue-write-tags.ts':
    "deleteFrom('dist_tag'); insertInto('dist_tag') [onConflict:doUpdateSet]; insertInto('dist_tag_history') x2; updateTable('package')",
  'db-sqlite/src/repositories/catalogue-write-version-insert.ts':
    "insertInto('version') [onConflict:doNothing]; updateTable('package')",
  'db-sqlite/src/repositories/catalogue-write-version-update.ts':
    "insertInto('version_revision'); updateTable('package'); updateTable('version') x2",
  'db-sqlite/src/repositories/catalogue.ts': '',
  'db-sqlite/src/repositories/closure-edges.ts': '',
  'db-sqlite/src/repositories/credential.ts':
    "deleteFrom('credential'); insertInto('credential'); updateTable('credential')",
  'db-sqlite/src/repositories/fetch-lease.ts':
    "deleteFrom('fetch_lease') x2; insertInto('fetch_lease') [onConflict:doUpdateSet]; updateTable('fetch_lease')",
  'db-sqlite/src/repositories/idempotency.ts':
    'DELETE FROM api_idempotency; INSERT INTO api_idempotency',
  'db-sqlite/src/repositories/ingest-finalize.ts':
    "UPDATE ingest_session; UPDATE source x2; updateTable('audit_pending')",
  'db-sqlite/src/repositories/ingest-session.ts':
    "deleteFrom('ingest_session') x3; insertInto('ingest_session') [onConflict:doUpdateSet]; updateTable('ingest_session') x6",
  'db-sqlite/src/repositories/job-lease-guard.ts': '',
  'db-sqlite/src/repositories/job-schedule.ts':
    'INSERT INTO job; INSERT INTO job_schedule x2; UPDATE job_schedule x3',
  'db-sqlite/src/repositories/job.ts':
    'INSERT INTO job; INSERT INTO job_attempt; INSERT INTO source_sync_package; UPDATE job x7; UPDATE job_attempt x4',
  'db-sqlite/src/repositories/keyring-verifier.ts': 'INSERT INTO keyring_verifier x2',
  'db-sqlite/src/repositories/local-login-setup.ts':
    "deleteFrom('credential'); insertInto('credential'); updateTable('local_login') x3",
  'db-sqlite/src/repositories/local-login-success.ts':
    "updateTable('local_login') x2; updateTable('session')",
  'db-sqlite/src/repositories/project.ts':
    "insertInto('access_grant'); insertInto('project'); updateTable('project') x2",
  'db-sqlite/src/repositories/provider-binding.ts':
    "deleteFrom('identity'); deleteFrom('session'); deleteFrom('user_group'); insertInto('identity_block') [onConflict:doNothing]; updateTable('identity_provider_binding'); updateTable('token')",
  'db-sqlite/src/repositories/proxy-admission.ts': '',
  'db-sqlite/src/repositories/registered-name.ts':
    "deleteFrom('registered_name'); insertInto('registered_name'); updateTable('registered_name'); updateTable('source') x2",
  'db-sqlite/src/repositories/session-liveness.ts': '',
  'db-sqlite/src/repositories/session.ts':
    "deleteFrom('session'); insertInto('session'); updateTable('session') x6",
  'db-sqlite/src/repositories/source-attachment-counts.ts': '',
  'db-sqlite/src/repositories/source-removal.ts': 'UPDATE source',
  'db-sqlite/src/repositories/source-selection-revision.ts': '',
  'db-sqlite/src/repositories/source-selection.ts': '',
  'db-sqlite/src/repositories/source.ts':
    "DELETE FROM source_sync_package; deleteFrom('project_package_pattern'); deleteFrom('project_source'); deleteFrom('source'); insertInto('source'); updateTable('source') x9",
  'db-sqlite/src/repositories/upstream-state.ts':
    "insertInto('upstream_state') [onConflict:doUpdateSet]; updateTable('upstream_state') x2",
  'db-sqlite/src/repositories/visibility-attach.ts':
    "deleteFrom('project_package'); deleteFrom('project_package_pattern'); deleteFrom('project_source'); insertInto('project_source') [onConflict:doNothing/doUpdateSet]; insertInto('project_source') [onConflict:doNothing]; updateTable('package'); updateTable('project'); updateTable('project_source') x2",
  'db-sqlite/src/repositories/visibility-audit.ts': '',
  'db-sqlite/src/repositories/visibility-derive.ts':
    "deleteFrom('project_package'); insertInto('project_package') [orIgnore]; updateTable('project_package')",
  'db-sqlite/src/repositories/visibility-subset.ts':
    "deleteFrom('project_package'); deleteFrom('project_package_pattern'); insertInto('project_package') [onConflict:doUpdateSet]; insertInto('project_package_pattern') [onConflict:doNothing]",
  'db-sqlite/src/repositories/vulnerability.ts':
    'DELETE FROM vulnerability_advisory; DELETE FROM vulnerability_match x2; DELETE FROM vulnerability_refresh x3; DELETE FROM vulnerability_result; INSERT INTO vulnerability_advisory x3; INSERT INTO vulnerability_match; INSERT INTO vulnerability_refresh; INSERT INTO vulnerability_result x2; INSERT INTO vulnerability_sync_state; UPDATE vulnerability_refresh; UPDATE vulnerability_result; UPDATE vulnerability_sync_state x12',
  'db-sqlite/src/repositories/webhook-delivery.ts':
    'INSERT INTO webhook_delivery; UPDATE webhook_delivery',
  'db-sqlite/src/sql/project-prefix.ts': '',
  'db-sqlite/src/sql/scan.ts': '',
  'db-sqlite/src/testing/catalogue-fixture.ts':
    'INSERT INTO cache_epoch; INSERT INTO organization; INSERT INTO package; INSERT INTO project; INSERT INTO project_package x2; INSERT INTO project_package_pattern; INSERT INTO project_source; INSERT INTO registered_name; INSERT INTO source; INSERT INTO version',
  'db-sqlite/src/testing/foreign-keys-off.ts': '',
  'db-sqlite/src/testing/migrated-database.ts': '',
  'db-sqlite/src/testing/mutation-table/blob-references.ts':
    'INSERT INTO blob; INSERT INTO ingest_session x2; INSERT INTO upstream_state x2; INSERT INTO version x2; INSERT INTO version_revision x2; UPDATE blob; UPDATE organization; UPDATE package; UPDATE source',
  'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts':
    'INSERT INTO blob x3; INSERT INTO job; INSERT INTO version_revision x2; UPDATE job x2; UPDATE package; UPDATE version x7',
  'db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts':
    'INSERT INTO blob x2; UPDATE version x2',
  'db-sqlite/src/testing/mutation-table/fixtures.ts':
    'INSERT INTO access_grant; INSERT INTO identity; INSERT INTO identity_provider_binding x2; INSERT INTO package; INSERT INTO project; INSERT INTO role; INSERT INTO role_permission; INSERT INTO session x2; INSERT INTO source; INSERT INTO user_account x2; INSERT INTO version',
  'db-sqlite/src/testing/mutation-table/harness.ts': '',
  'db-sqlite/src/testing/node-sqlite-executor.ts': '',
  'db-sqlite/src/testing/sql-snapshot.ts': '',
  'runtime-cloudflare/src/db/d1-executor.ts': '',
};

// Inbound edges after applying migrations in order, including ALTER TABLE/rebuilt tables.
// Empty entries pin the absence of inbound FKs just as explicitly as existing actions.
const REVIEWED_PARENTS: Readonly<Record<string, readonly string[]>> = {
  audit_pending: [],
  api_idempotency: [],
  blob: [
    'version(blob_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'version_revision(blob_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
  ],
  dist_tag: [],
  dist_tag_history: [],
  fetch_lease: [],
  identity_provider_binding: [],
  ingest_session: [],
  job: [
    'job_attempt(job_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'source_sync_package(job_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
  ],
  job_attempt: [],
  local_login: [],
  package: [
    'bundle_item(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'customer_grant(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'package_access_request(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'package_access_request(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_package(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_package(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'upstream_state(package_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'version(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'version(package_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'vulnerability_result(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_result(package_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
  ],
  project_package: [],
  project_package_pattern: [],
  project_source: [],
  session: [],
  source: [
    'ingest_session(source_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'package(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'package(source_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_package_pattern(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_package_pattern(source_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_source(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'project_source(source_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(source_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'registered_name(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'registered_name(source_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'source_sync_package(source_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'webhook_delivery(source_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
  ],
  upstream_state: [],
  version: [
    'dist_tag(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag(version_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(previous_version_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'dist_tag_history(version_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(org_id) -> (org_id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'publish_approval(version_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'version_readme(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'version_readme(version_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'version_revision(version_id) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
    'vulnerability_result(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_result(version_id) -> (id): ON DELETE CASCADE; ON UPDATE NO ACTION',
  ],
  version_revision: [],
  webhook_delivery: [],
  keyring_verifier: [],
  vulnerability_result: [
    'vulnerability_match(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_match(source) -> (source): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_match(version_id) -> (version_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_refresh(org_id) -> (org_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_refresh(source) -> (source): ON DELETE CASCADE; ON UPDATE NO ACTION',
    'vulnerability_refresh(version_id) -> (version_id): ON DELETE CASCADE; ON UPDATE NO ACTION',
  ],
  vulnerability_refresh: [],
  vulnerability_advisory: [],
};

// Scan source and shared testing helpers; unit-test files contain scanner fixtures themselves.
function modules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? modules(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
  });
}

interface ReadSite {
  expression: string;
  line: number;
}

const READ_CACHE = new Map<string, ReadSite[]>();

function staticStrings(
  file: ts.SourceFile,
): (node: ts.Node, rawSql?: boolean) => string[] | undefined {
  let checker: ts.TypeChecker | undefined;
  function resolve(node: ts.Node, rawSql = false, seen = new Set<ts.Node>()): string[] | undefined {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (
      rawSql &&
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql' &&
      ts.isNoSubstitutionTemplateLiteral(node.template)
    ) {
      return [node.template.text];
    }
    if (ts.isConditionalExpression(node)) {
      const yes = resolve(node.whenTrue, rawSql, new Set(seen));
      const no = resolve(node.whenFalse, rawSql, new Set(seen));
      return yes && no ? [...new Set([...yes, ...no])].sort() : undefined;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return resolve(node.expression, rawSql, seen);
    }
    if (ts.isIdentifier(node)) {
      if (!checker) {
        // Bind only this file so constant lookup respects shadowing without loading imports.
        const options = { noLib: true, noResolve: true, types: [] };
        const host = ts.createCompilerHost(options);
        host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
        checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
      }
      const declarations = checker.getSymbolAtLocation(node)?.declarations;
      const declaration = declarations?.length === 1 ? declarations[0] : undefined;
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        declaration.initializer
      ) {
        return resolve(declaration.initializer, rawSql, seen);
      }
    }
    return undefined;
  }
  return resolve;
}

function reads(source: string): ReadSite[] {
  const cached = READ_CACHE.get(source);
  if (cached) return cached;
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const staticString = staticStrings(file);
  const found: ReadSite[] = [];
  function isChanges(name: ts.Node): boolean {
    return (
      ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'changes') ||
      (ts.isComputedPropertyName(name) &&
        staticString(name.expression)?.includes('changes') === true)
    );
  }
  const assignmentReads = new Set<ts.Node>();
  function assignmentTarget(node: ts.Node): void {
    if (ts.isParenthesizedExpression(node)) {
      assignmentTarget(node.expression);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (isChanges(property.name)) assignmentReads.add(property);
          assignmentTarget(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property) && isChanges(property.name)) {
          assignmentReads.add(property);
        } else if (ts.isSpreadAssignment(property)) {
          assignmentTarget(property.expression);
        }
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) assignmentTarget(element);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignmentTarget(node.left);
    }
  }
  function findAssignments(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assignmentTarget(node.left);
    }
    ts.forEachChild(node, findAssignments);
  }
  findAssignments(file);
  function visit(node: ts.Node): void {
    if (
      assignmentReads.has(node) ||
      (ts.isPropertyAccessExpression(node) && isChanges(node.name)) ||
      (ts.isElementAccessExpression(node) &&
        staticString(node.argumentExpression)?.includes('changes') === true) ||
      (ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        node.dotDotDotToken === undefined &&
        isChanges(node.propertyName ?? node.name)) ||
      (ts.isSpreadAssignment(node) &&
        ts.isIdentifier(node.expression) &&
        isChanges(node.expression))
    ) {
      found.push({
        expression: node.getText(file).replace(/\s+/g, ' '),
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  READ_CACHE.set(source, found);
  return found;
}

// These expressions require human review: syntax alone cannot prove their row-count semantics.
// Keys preserve exact expression text, including SQL whitespace and interpolation expressions.
const REVIEWED_UNCERTAIN: Readonly<Record<string, string>> = Object.fromEntries(
  [
    {
      reason:
        'The contract dispatches three named status writers and asserts their typed outcomes; the imported purge constant is a numeric retention interval. Neither site reads executor change counts.',
      sites: [
        "db-sqlite/src/contract/npm-publish-writer-contract.ts:computed builder call: store[method](ctx, h.fence, {\n              ...base,\n              audit: { ...h.input.event, id: ulid() },\n              expectedStatus,\n              reason: method === 'quarantineVersion' ? 'admin_quarantine' : 'admin_tombstone',\n            } as never) #1",
        "db-sqlite/src/repositories/blob-references.ts:opaque dependency: import { PUBLISH_PURGE_WINDOW_DAYS } from '@package-broker/core/db/publishes'; #1",
      ],
    },
    {
      reason:
        'Token lookup composes a typed read condition; blob publication uses returned rows and a transactional before-image for cleanup; tag lookup selects active patch targets. None reads executor change counts.',
      sites: [
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${loose.selectFrom(tokenLookupQuery(ctx, input).as('pa')).select(sql.lit(1).as('one')).where(condition)}` #1",
        'db-sqlite/src/repositories/blob.ts:builder variable: const [before, written, current] = await executor.batch([\n        statement(previous),\n        statement(upsert),\n        statement(existing),\n      ]); #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`(SELECT version.id FROM version\n    WHERE version.package_id = ${packageId} AND version.org_id = ${ctx.orgId}\n      AND version.version_normalized = ${target} AND ${request.mode === 'patch' ? sql<boolean>`version.status = 'active'` : sql<boolean>`version.status != 'tombstoned'`})` #1",
      ],
    },
    {
      reason:
        'Publish authorization and batch assembly use prepared statement parameters and metadata records; these sites neither inspect executor changes nor infer success from change counts. Held-package filtering and tag patching preserve the existing returned-row decisions.',
      sites: [
        "db-sqlite/src/contract/npm-publish-writer-contract.ts:opaque object access: Object.assign(input.version, {\n              metadata: {\n                ...input.version.metadata,\n                json: JSON.stringify({ name: 'widget', description: 'x'.repeat(262144) }),\n              },\n            }) #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`(\n    ${at(pkg.package, 'held_until_active')} = 0 and\n    exists (\n      select 1 from project as ${sql.id(a.p)}\n      where ${at(a.p, 'id')} = ${projectRef} and ${at(a.p, 'org_id')} = ${ctx.orgId} and ${at(a.p, 'status')} = 'active'\n    )\n    and (\n      ${status} = 'active'\n      or (${status} = 'removed_upstream' and ${at(pkg.source, 'removal_policy')} = 'flag')\n    )\n  )` #1",
        'db-sqlite/src/repositories/catalogue-publish.ts:opaque object access: Object.entries(input.distTags) #1',
        'db-sqlite/src/repositories/catalogue-publish.ts:opaque object access: Object.entries(a.distTags) #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:SQL text: 'replace' #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: const groups = [\n    head,\n    ...probes.map((probe) => [probe]),\n    ...valid.map((_, index) => sets.slice(index * 2, index * 2 + 2)),\n    ...(request.mode === 'patch' ? [] : [[removeHistory, remove]]),\n    [advance],\n  ]; #1",
        'db-sqlite/src/repositories/package-admin-read.ts:object rest access: ...version #1',
      ],
    },
    {
      reason:
        'These fixed source-error lookups read JSON counter values, never executor change metadata.',
      sites: [
        'db-sqlite/src/repositories/source.ts:unresolved computed access: errors[code] #1',
        'db-sqlite/src/repositories/source.ts:unresolved computed access: errors[code] #2',
      ],
    },
    {
      reason:
        'Generation tracking inserts one org-pinned package pointer with no executor count read; source JSON updates contain no timestamp or request-derived errors. The pointer write metadata is unused; generation and reaper row counts use RETURNING to exclude trigger writes.',
      sites: [
        "db-sqlite/src/repositories/job.ts:SQL template: sql`INSERT INTO source_sync_package\n            (org_id, source_id, package_key, generation, job_id, state)\n            SELECT j.org_id, s.id, json_extract(j.payload_json, '$.key'), s.sync_generation, j.id, j.state\n            FROM job j JOIN source s ON s.org_id = j.org_id\n              AND s.id = json_extract(j.payload_json, '$.sourceId')\n            WHERE j.org_id = ${ctx.orgId} AND j.id = ${id}\n              AND j.type = 'core:package-sync:v1' AND j.state = 'queued'\n              AND s.sync_generation = json_extract(j.payload_json, '$.syncGeneration')\n              AND json_type(j.payload_json, '$.key') = 'text'\n            ON CONFLICT (org_id, source_id, package_key) DO UPDATE SET\n              job_id = excluded.job_id, state = excluded.state, error = NULL\n            WHERE source_sync_package.org_id = ${ctx.orgId}\n              AND source_sync_package.generation = excluded.generation\n              AND source_sync_package.job_id <> excluded.job_id\n              AND EXISTS (SELECT 1 FROM job parent\n                WHERE parent.org_id = ${ctx.orgId} AND parent.id = source_sync_package.job_id\n                  AND parent.id = json_extract(${payloadJson}, '$.parentJob.id')\n                  AND parent.lease_owner = json_extract(${payloadJson}, '$.parentJob.owner')\n                  AND parent.fence = json_extract(${payloadJson}, '$.parentJob.fence')\n                  AND parent.state = 'running' AND parent.lease_until > ${NOW})` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`json_set(sync_counts, '$.listing', json('true'))` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql`DELETE FROM source_sync_package WHERE org_id = ${ctx.orgId} AND source_id = ${input.id}` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`json_set(sync_counts, '$.listing', json('false'))` #1",
      ],
    },
    {
      reason:
        'The error-code import is a static allowlist with no executor counts. Sync requests update scheduling timestamps under the owner fence and bump the cache epoch only for proxies to invalidate negative entries; source keys are unchanged.',
      sites: [
        "db-sqlite/src/repositories/source.ts:opaque dependency: import { SOURCE_ERROR_CODES } from '@package-broker/core/sources/source-error-codes'; #1",
        "db-sqlite/src/repositories/job.ts:opaque dependency: import { SOURCE_ERROR_CODES } from '@package-broker/core/sources/source-error-codes'; #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from source\n        where org_id = ${ctx.orgId} and id = ${input.id} and status <> 'paused')` #1",
        "db-sqlite/src/repositories/source.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allOf([held, owned]), ctx, sql<SqlBool>`${isProxy(current.type) ? 1 : 0}`),\n        [\n          ...assertCheck(active),\n          compile(\n            db\n              .updateTable('source')\n              .set({ next_poll_at: DB_NOW, updated_at: DB_NOW })\n              .where('org_id', '=', ctx.orgId)\n              .where('id', '=', input.id)\n              .where('status', '!=', 'paused'),\n          ),\n          auditPendingStatement(ctx, input.audit),\n          ...(input.idempotency === undefined\n            ? []\n            : [idempotencyInsertStatement(ctx, input.idempotency)]),\n        ],\n        { authority: probe(held, true), conflict: probe(collision, false) },\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.ok) return 'requested'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'authority' || outcome.reason === 'indeterminate')\n        return failureResult(ctx, input.id, outcome.reason); #1",
      ],
    },
    {
      reason:
        'Read-only grouped attachment count and JSON page-id filter; neither expression writes rows or reads executor changes.',
      sites: [
        'db-sqlite/src/repositories/source-attachment-counts.ts:SQL template: sql<number>`count(*)` #1',
        'db-sqlite/src/repositories/source-attachment-counts.ts:SQL template: sql<boolean>`attachment.source_id in (select value from json_each(${JSON.stringify(input.sourceIds)}))` #1',
      ],
    },
    {
      reason:
        'The prefix helper only validates input and builds comparison predicates with Kysely; it neither mutates rows nor reads executor change counts.',
      sites: [
        "db-sqlite/src/sql/project-prefix.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/sql/project-prefix.ts:opaque dependency: import { isValidProjectListPrefix } from '@package-broker/core/authz/project-list'; #1",
        'db-sqlite/src/sql/project-prefix.ts:SQL template: sql<SqlBool>`${sql.ref(column)} >= ${q}` #1',
        'db-sqlite/src/sql/project-prefix.ts:SQL template: sql<SqlBool>`(${sql.ref(column)} >= ${q} AND ${sql.ref(column)} < ${upper})` #1',
        'db-sqlite/src/sql/project-prefix.ts:SQL template: sql<SqlBool>`(${range(slug)} OR ${range(name)})` #1',
      ],
    },
    {
      reason:
        'Project revision increments change no referenced key; attachment change predicates and their parenthesized true fallback preserve scope filters in the existing fenced batch without consuming executor change counts.',
      sites: [
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<number>`revision + 1` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`not ${isAttached(ctx, input.projectId, input.sourceId)} or exists (\n          select 1 from project_source where org_id = ${ctx.orgId}\n          and project_id = ${input.projectId} and source_id = ${input.sourceId}\n          and ${precedence === undefined ? sql<SqlBool>`0` : sql<SqlBool>`precedence is not ${precedence}`})` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from project_source where org_id = ${ctx.orgId}\n          and project_id = ${input.projectId} and source_id = ${input.sourceId}\n          and precedence is not ${precedence})` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`(${changed ?? sql<SqlBool>`1`})` #1',
      ],
    },
    {
      reason:
        'The live share and accepted-count bound are organization-scoped scalar predicates; neither reads executor changes.',
      sites: [
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`NOT ${withinAbsenceShare(\n              unseenSourcePackages(ctx, scope.sourceId),\n              expectedCount,\n              options.maxAbsenceShare ?? DEFAULT_MAX_ABSENCE_SHARE,\n              minPackages,\n            )}` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`(NOT (${needsAcceptance}) OR ${acceptedBound(scope.sourceId)})` #1',
      ],
    },
    {
      reason:
        'The audit payload receives the organization-scoped live unseen count before removal; the update leaves all referenced audit keys unchanged.',
      sites: [
        "db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<string>`json_set(payload_json, '$.changes.absent.new', ${unseenSourcePackages(ctx, scope.sourceId)})` #1",
      ],
    },
    {
      reason:
        'The fixed result index identifies the conditional audit insert; its changes semantics are reviewed separately.',
      sites: [
        'db-sqlite/src/repositories/ingest-finalize.ts:unresolved computed access: results[acceptanceAuditIndex] #1',
      ],
    },
    {
      reason:
        'Literal true disables the accepted bound probe when the source was not armed; this contains no count access.',
      sites: ['db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`1` #2'],
    },
    {
      reason:
        'The shared selection revision reads only organization-scoped source configuration and sorted registrations; it has no mutations or executor count reads.',
      sites: [
        "db-sqlite/src/repositories/source-selection-revision.ts:SQL template: sql<string>`(SELECT json_array(source.config_json, source.status = 'active',\n      (SELECT json_group_array(registration.pattern) FROM (\n        SELECT registered_name.pattern FROM registered_name\n        WHERE registered_name.org_id = ${ctx.orgId} AND registered_name.source_id = ${sourceId}\n        ORDER BY registered_name.pattern) AS registration))\n    FROM source WHERE source.org_id = ${ctx.orgId} AND source.id = ${sourceId})` #1",
      ],
    },
    {
      reason:
        'Kysely supplies the shared revision SQL tag and exposes no executor count in this module.',
      sites: [
        "db-sqlite/src/repositories/source-selection-revision.ts:opaque dependency: import { sql } from 'kysely'; #1",
      ],
    },
    {
      reason:
        'Fixture-side access in source-selection-races-contract.ts; indexes or assigns test data, never an executor result count.',
      sites: [
        'db-sqlite/src/contract/source-selection-races-contract.ts:opaque object access: Object.assign(session, { stamp, snapshotId: SNAPSHOT, cursor, seenCount: 1 }) #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-reconcile.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<number>`(SELECT count(*) FROM package\n        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${id}\n          ${keyFilter(sql`package.name`)}\n          AND package.listing_seen_stamp = ${stamp}\n          ${keys === undefined ? sql`AND ${selectedPackage(ctx)}` : sql``})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<number>`(SELECT count(*) FROM package\n    WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${sourceId}\n      AND package.name IN (SELECT value FROM json_each(${keys}))\n      ${stamp === undefined ? sql`` : sql`AND package.listing_seen_stamp = ${stamp}`}\n      ${selectedOnly ? sql`AND ${selectedPackage(ctx)}` : sql``})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<string>`package.source_id` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<string>`package.ecosystem` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<string>`package.name` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`package.updated_at < ${boundary}\n      AND (package.status = 'active' OR package.removal_cause IS NOT 'source_listing')\n      AND ${selectedPackage(ctx)}` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<number>`(SELECT count(*) FROM package\n    WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${sourceId}\n      AND package.updated_at < ${boundary} AND package.status = 'active'\n      AND ${selectedPackage(ctx)})` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`(SELECT (${seen} + counted.n) < ${minPackages}\n    OR CAST(counted.n AS REAL) / (${seen} + counted.n) <= ${maxShare}\n    FROM (SELECT ${unseen} AS n) AS counted)` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`version.package_id IN (SELECT package.id FROM package\n          WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${scope.sourceId}\n            AND ${selectedPackage(ctx)})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package WHERE package.org_id = ${ctx.orgId} AND package.id = ${id} AND ${selectedPackage(ctx)})` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`package.updated_at >= ${boundary} AND package.status = 'removed_upstream'\n      AND ${selectedPackage(ctx)}` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET updated_at = max(updated_at, ${boundary}), listing_seen_stamp = ${stamp}\n              WHERE org_id = ${ctx.orgId} AND source_id = ${id} AND listing_seen_stamp IS NOT ${stamp}\n                AND name IN (SELECT value FROM json_each(${json}))\n                AND ${selectedPackage(ctx)}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${sourceKeyRows(ctx, id, json)} = ${keys.length}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${sourceKeyRows(ctx, id, json, stamp)} = ${sourceKeyRows(ctx, id, json, undefined, true)}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET last_op_id = ${decisionId},\n          listing_open_stamp = strftime('%Y-%m-%dT%H:%M:%fZ', listing_open_stamp, '+0.001 seconds')\n          WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId} AND ${selectedPackage(ctx)} AND ${absent}` #1",
      ],
    },
    {
      reason:
        'Import in ingest-finalize.ts; dependency is opaque to the scan and exposes no executor count.',
      sites: [
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { auditEvent } from '@package-broker/core/audit/actions'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { ulid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import {\n  assertFinalizeAllowed,\n  DEFAULT_MAX_ABSENCE_SHARE,\n  DEFAULT_MIN_PACKAGES,\n  FinalizeEvidenceError,\n  recordMassAbsence,\n  recordRemovalAcceptanceCleared,\n  recordRemovalApplied,\n  type FinalizeGuardOptions,\n} from '@package-broker/core/ingest/finalize-guard'; #1",
      ],
    },
    {
      reason:
        'SQL in ingest-finalize.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<number>`(SELECT count(*) FROM package\n        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${scope.sourceId}\n          AND package.listing_seen_stamp = ${stamp}\n          AND ${sourceSelectionCondition(ctx, scope.sourceId, sql<string>`package.ecosystem`, sql<string>`package.name`, true)})` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`UPDATE source SET last_refusal_at = NULL, last_refusal_absent = NULL,\n                last_refusal_listed = NULL, last_refusal_successful = NULL,\n                removal_accepted = 0, updated_at = ${NOW}\n              WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId}\n                AND (last_refusal_at IS NOT NULL OR removal_accepted = 1)` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<string>`package.ecosystem` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<string>`package.name` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`SELECT removal_accepted AS armed, last_refusal_absent AS accepted_absent,\n                      project_id FROM source\n                    WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId}` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM source\n          WHERE org_id = ${ctx.orgId} AND id = ${sourceId} AND removal_accepted = 1\n            AND ${unseenSourcePackages(ctx, sourceId)} <= last_refusal_absent)` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM source\n              WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId} AND listing_open_stamp = ${stamp})` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`UPDATE source SET last_refusal_at = ${NOW}, last_refusal_absent = ${absent},\n                  last_refusal_listed = ${expectedCount},\n                  last_refusal_successful = ${input.successfulCandidates},\n                  removal_accepted = 0, updated_at = ${NOW}\n                WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId}\n                  AND listing_open_stamp = ${stamp}` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`1` #1',
      ],
    },
    {
      reason:
        'SQL in ingest-session.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<boolean>`(EXISTS (SELECT 1 FROM ingest_session WHERE ${holds(ctx, handle)}\n            AND ingest_session.scope = 'source' AND ingest_session.source_id = ${pin.sourceId})\n            ${pin.unseen === undefined ? sql`` : sql`AND ${unseenSourcePackages(ctx, pin.sourceId)} = ${pin.unseen}`}\n            AND ${sourceSelectionRevision(ctx, pin.sourceId)} = ${pin.revision ?? null})` #1",
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM ingest_session WHERE ${holds(ctx, handle)}\n      AND (ingest_session.scope = 'source' OR EXISTS (SELECT 1 FROM source\n        WHERE source.id = ingest_session.source_id AND source.org_id = ${ctx.orgId}\n          AND ${sourceSelectionCondition(ctx, sql<string>`source.id`, sql<string>`source.ecosystem`, sql<string>`ingest_session.package_key`, true)})))` #1",
      ],
    },
    {
      reason:
        'Import in source-removal.ts; dependency is opaque to the scan and exposes no executor count.',
      sites: [
        "db-sqlite/src/repositories/source-removal.ts:opaque dependency: import { sql } from 'kysely'; #1",
      ],
    },
    {
      reason:
        'SQL in source-removal.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/source-removal.ts:SQL template: sql`UPDATE source SET removal_accepted = 1, updated_at = ${NOW}\n      WHERE org_id = ${ctx.orgId} AND id = ${input.sourceId} AND removal_accepted = 0\n        AND last_refusal_at = ${refusal.at} AND last_refusal_absent = ${refusal.absent}\n        AND last_refusal_listed = ${refusal.listed}\n        AND last_refusal_successful = ${refusal.successful} AND last_refusal_successful > 0` #1',
      ],
    },
    {
      reason:
        'Import in source-selection.ts; dependency is opaque to the scan and exposes no executor count.',
      sites: [
        "db-sqlite/src/repositories/source-selection.ts:opaque dependency: import { sql, type Expression, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/source-selection.ts:opaque dependency: import { MAX_PATTERN_BYTES, MAX_PATTERN_WILDCARDS } from '@package-broker/core/catalogue/patterns'; #1",
      ],
    },
    {
      reason:
        'SQL in source-selection.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/source-selection.ts:SQL template: sql`CASE WHEN json_valid(selection_source.config_json)\n    THEN selection_source.config_json ELSE '{}' END` #1",
        "db-sqlite/src/repositories/source-selection.ts:SQL template: sql`OR (selection_source.config_json = '{}' AND selection_source.status = 'active'\n        AND NOT EXISTS (SELECT 1 FROM registered_name AS selection_registration\n          WHERE selection_registration.org_id = ${ctx.orgId}\n            AND selection_registration.source_id = selection_source.id))` #1",
        'db-sqlite/src/repositories/source-selection.ts:SQL template: sql`` #1',
        "db-sqlite/src/repositories/source-selection.ts:SQL template: sql<SqlBool>`EXISTS (SELECT 1 FROM source AS selection_source\n    WHERE selection_source.org_id = ${ctx.orgId} AND selection_source.id = ${sourceId}\n      AND selection_source.ecosystem = ${ecosystem}\n      AND (selection_source.type IN ('packagist_proxy', 'npmjs_proxy')\n        ${unconfigured}\n        OR (${registered} AND (\n          (selection_source.type = 'vcs')\n          OR (selection_source.type = 'npm_registry' AND EXISTS (\n            SELECT 1 FROM json_each(${config}, '$.scopes') AS selected_scope\n            WHERE selected_scope.type = 'text'\n              AND substr(${key}, 1, instr(${key}, '/') - 1) = selected_scope.value))\n          OR (selection_source.type = 'composer_repository' AND (\n            EXISTS (SELECT 1 FROM json_each(${config}, '$.selection.packages') AS selected_name\n              WHERE selected_name.type = 'text' AND selected_name.value = ${key})\n            OR EXISTS (SELECT 1 FROM json_each(${config}, '$.selection.patterns') AS selected_pattern\n              WHERE CASE WHEN selected_pattern.type = 'text'\n                AND selected_pattern.value NOT GLOB '*[^a-z0-9._~@!/*-]*'\n                AND length(selected_pattern.value) BETWEEN 1 AND ${sql.lit(MAX_PATTERN_BYTES)}\n                AND length(selected_pattern.value) - length(replace(selected_pattern.value, '*', '')) <= ${sql.lit(MAX_PATTERN_WILDCARDS)}\n                THEN ${key} GLOB selected_pattern.value ELSE 0 END)))))))` #1",
      ],
    },
    {
      reason:
        'SQL in source.ts; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`EXISTS (SELECT 1 FROM session\n        WHERE org_id = ${ctx.orgId} AND id = ${fence.sessionId} AND identity_id IS NULL)` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`EXISTS (SELECT 1 FROM (${permissions}) AS removal_admin\n        WHERE removal_admin.scope = 'organization' AND removal_admin.protects = 1)` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`EXISTS (SELECT 1 FROM source\n        WHERE org_id = ${ctx.orgId} AND id = ${input.id}\n          AND (project_id IS NULL OR EXISTS (SELECT 1 FROM project\n            WHERE project.org_id = ${ctx.orgId} AND project.id = source.project_id AND project.status = 'active')))` #1",
      ],
    },
    {
      reason:
        'SQL changes() guard after a single direct source UPDATE; SQLite changes() excludes FK-action rows.',
      sites: ['db-sqlite/src/repositories/source.ts:SQL template: sql<boolean>`changes() = 1` #1'],
    },
    {
      reason:
        'Fixture-side access in project-source-read.ts; indexes or assigns test data, never an executor result count.',
      sites: [
        'db-sqlite/src/testing/mutation-table/project-source-read.ts:unresolved computed access: orgs[sourceOrg] #1',
        'db-sqlite/src/testing/mutation-table/project-source-read.ts:unresolved computed access: orgs[attachmentOrg] #1',
      ],
    },
    {
      reason:
        'Remove batch prepends a visibility check; the tail-relative count still selects the source status update, whose referenced keys are unchanged.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allOf([held, owned]), ctx),\n        [\n          ...assertCheck(visible),\n          compile(\n            db\n              .deleteFrom('registered_name')\n              .where('id', '=', input.id)\n              .where('org_id', '=', ctx.orgId),\n          ),\n          pause,\n          auditPendingStatement(ctx, input.pauseAudit, { sql: 'changes() = 1', params: [] }),\n          auditPendingStatement(ctx, input.audit),\n          ...(input.idempotency === undefined\n            ? []\n            : [idempotencyInsertStatement(ctx, input.idempotency)]),\n        ],\n        {\n          authority: probe(held, true),\n          conflict: probe(liveIdempotencyCollision(ctx, input.idempotency), false),\n        },\n      ); #1",
      ],
    },
    {
      reason:
        'Indexes SELECT id rows to choose a version for the idempotency fixture; not an executor count.',
      sites: [
        'db-sqlite/src/contract/catalogue-write-contract.ts:unresolved computed access: versions[index] #1',
      ],
    },
    {
      reason:
        'Fisher-Yates swap of generated import fixture items in the batch contract; indexes fixture data, not an executor count.',
      sites: [
        'db-sqlite/src/contract/writer-batch-contract.ts:unresolved computed access: items[i] #1',
        'db-sqlite/src/contract/writer-batch-contract.ts:unresolved computed access: items[i] #2',
        'db-sqlite/src/contract/writer-batch-contract.ts:unresolved computed access: items[j] #1',
        'db-sqlite/src/contract/writer-batch-contract.ts:unresolved computed access: items[j] #2',
      ],
    },
    {
      reason:
        'Result-length guard comparing results.length with statements.length; reads no changes value and the existing changes reads in the same function stay reviewed.',
      sites: [
        "db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: if (results.length !== statements.length) {\n        throw new TypeError('incomplete status transition results');\n      } #1",
        "db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: if (results.length !== statements.length) {\n        throw new TypeError('incomplete blob replace results');\n      } #1",
        "db-sqlite/src/repositories/catalogue-write-dist.ts:builder variable: if (results.length !== statements.length) {\n        throw new TypeError('incomplete dist attach results');\n      } #1",
      ],
    },
    {
      reason:
        'Org-scoped source/project visibility SELECT used by the batch guard; it performs no mutation or count read.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as visible_source\n    where visible_source.id = ${sourceId} and visible_source.org_id = ${ctx.orgId}\n      and (visible_source.project_id is null or exists (\n        select 1 from project as visible_project\n        where visible_project.id = visible_source.project_id\n          and visible_project.org_id = ${ctx.orgId} and visible_project.status = 'active')))` #1",
      ],
    },
    {
      reason:
        'Indexes domain data in backup-scope; retained because the key cannot be proven to exclude changes.',
      sites: ['db-sqlite/src/backup-scope.ts:unresolved computed access: BACKUP_SCOPE[table] #1'],
    },
    {
      reason:
        'Indexes fixture data in access-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/access-contract.ts:unresolved computed access: letters[Math.floor(n / 8)] #1',
        'db-sqlite/src/contract/access-contract.ts:unresolved computed access: letters[n % 8] #1',
        'db-sqlite/src/contract/access-contract.ts:unresolved computed access: ANCHORS[provider] #1',
        'db-sqlite/src/contract/access-contract.ts:unresolved computed access: allowedProject[level] #1',
      ],
    },
    {
      reason:
        'Object introspection in access-contract; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/contract/access-contract.ts:opaque object access: Object.entries(tokens) #1',
      ],
    },
    {
      reason:
        'Computed fixture dispatch in access-contract; reviewed explicitly because its target is not statically known.',
      sites: [
        'db-sqlite/src/contract/access-contract.ts:computed builder call: accessContractCases[name](open, wrap) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in access-race; retained because the key cannot be proven to exclude changes.',
      sites: [
        "db-sqlite/src/contract/access-race.ts:unresolved computed access: 'abcdefgh'[n % 8] #1",
      ],
    },
    {
      reason:
        'Indexes fixture data in auth-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/auth-contract.ts:unresolved computed access: raw[index % 2] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in blob-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/blob-contract.ts:unresolved computed access: record[hook] #1',
        'db-sqlite/src/contract/blob-contract.ts:unresolved computed access: store[method] #1',
        'db-sqlite/src/contract/blob-contract.ts:unresolved computed access: record[hook] #2',
        'db-sqlite/src/contract/blob-contract.ts:unresolved computed access: lifecycle[method] #1',
      ],
    },
    {
      reason:
        'Computed fixture dispatch in blob-contract; reviewed explicitly because its target is not statically known.',
      sites: [
        'db-sqlite/src/contract/blob-contract.ts:computed builder call: f.lifecycle[method](other, absent, generation) #1',
        'db-sqlite/src/contract/blob-contract.ts:computed builder call: f.lifecycle[method](other, key, generation) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in cache-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/cache-contract.ts:unresolved computed access: (fixture as unknown as Record<string, unknown>)[hook] #1',
        'db-sqlite/src/contract/cache-contract.ts:unresolved computed access: (fixture.cache as unknown as Record<string, unknown>)[method] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in catalogue-race-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/catalogue-race-contract.ts:unresolved computed access: cases[name] #1',
      ],
    },
    {
      reason:
        'Object introspection in catalogue-race-contract; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/contract/catalogue-race-contract.ts:opaque object access: Object.entries(cases) #1',
      ],
    },
    {
      reason:
        'Fixture SQL in catalogue-read-contract; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy)\n     VALUES (?, ?, ?, ?, ?, ?, ?)` #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: 'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)' #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, \'subscription\' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1" #1',
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO package (id, org_id, source_id, ecosystem, name, status, description)\n     VALUES (?, ?, ?, ?, ?, ?, ?)` #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,\n       published_at_basis, metadata_json, status, blob_id, revision, removed_upstream_at, tombstoned_at)\n     VALUES (?, ?, ?, ?, ?, ?, 'import_time', ?, ?, ?, ?, ?, ?)` #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 10, \'k-\' || ?)" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: 'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)' #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO project (id, org_id, slug, name) VALUES ('PA', ?, 'pa', 'PA')\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO project (id, org_id, slug, name) VALUES ('PB', ?, 'pb', 'PB')\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO project (id, org_id, slug, name) VALUES ('PO', ?, 'po', 'PO')\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason)\n       VALUES ('R-m01-100', ?, 'V-m01-100', 1, '{}', 'sync')` #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project_package SET org_id = ? WHERE project_id = 'PA' AND package_id = 'K-m01'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project_source SET org_id = ? WHERE project_id = 'PA' AND source_id = 'S-O'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE version SET blob_id = 'B-org-b-blob' WHERE id = 'V-m01-100'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE version_revision SET blob_id = 'B-org-b-blob' WHERE id = 'R-m01-100'\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM project_package WHERE package_id = \'K-twin\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE package SET status = 'removed_upstream' WHERE id = 'K-twin'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-PB'\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM project_source WHERE source_id = \'S-PB\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project SET status = 'archived' WHERE id = 'PB'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE version SET status = 'quarantined' WHERE package_id = 'K-twin'\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM version WHERE package_id = \'K-twin\'" #1',
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM project_package WHERE package_id = \'K-twin\'" #2',
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM package WHERE id = \'K-twin\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('RN', ?, 'S-O', 'npm', ?)\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM registered_name WHERE id = \'RN\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('RN-B', ?, 'S-B', 'npm', ?)\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM registered_name WHERE id = \'RN-B\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('PP1', ?, 'PA', 'S-XP', 'fresh-*', 'exclude')\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "DELETE FROM project_package_pattern WHERE id = \'PP1\'" #1',
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "UPDATE source SET default_visible_to_new_projects = 0 WHERE id = \'S-XP\'" #1',
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "UPDATE source SET default_visible_to_new_projects = 1 WHERE id = \'S-XP\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project SET status = 'archived' WHERE id = 'PA'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project_source SET precedence = 0 WHERE source_id = 'S-XP' AND project_id = 'PA'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project_source SET precedence = 900 WHERE source_id = 'S-O' AND project_id = 'PA'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO source (id, org_id, project_id, name, ecosystem, type)\n         VALUES ('S-O2', ?, NULL, 'S-O2', 'npm', 'npm_registry')` #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE project SET status = 'archived' WHERE id = 'PA'\" #2",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-O'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE source SET removal_policy = 'flag' WHERE id = 'S-X'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-X'\" #1",
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: \"UPDATE version SET status = 'quarantined' WHERE package_id = 'K-m09'\" #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "UPDATE version SET revision = 2 WHERE id = \'V-m09-100\'" #1',
        "db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: `INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, blob_id, reason)\n         VALUES ('R-m09-100', ?, 'V-m09-100', 1,\n           '{\"dist\":{\"tarball\":\"https://u.test/historical-status.tgz\"}}', 'B-X', 'sync')` #1",
        'db-sqlite/src/contract/catalogue-read-contract.ts:SQL text: "UPDATE version SET status = ?, tombstoned_at = ? WHERE id = \'V-m09-100\'" #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/contract/catalogue-read-contract.ts:unresolved computed access: results[index] #1',
      ],
    },
    {
      reason:
        'Codec contract deliberately imports its runtime adapter; fixture dependency boundary is manually reviewed.',
      sites: [
        'db-sqlite/src/contract/codec-contract.ts:dynamic dependency: import(/* @vite-ignore */ url) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in codec-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/codec-contract.ts:unresolved computed access: r.digests?.[alg] #1',
      ],
    },
    {
      reason:
        'Blob fixture reflects optional lifecycle hooks; retained because reflective access is not a statically proven count read.',
      sites: [
        'db-sqlite/src/contract/count-calls.ts:reflective count access: Reflect.get(target, property, receiver) #1',
      ],
    },
    {
      reason:
        'Fixture SQL in executor-contract; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT 1 AS one, ? AS word' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO value_row (id, txt, num, nul, bin) VALUES (?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT txt, num, nul, bin FROM value_row WHERE id = ?' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id' #2",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'UPDATE item SET label = ?' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT id, label FROM item ORDER BY id' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL text: '4. all() of an UPDATE without RETURNING resolves to [] and changes the row' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, label) VALUES (?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'UPDATE item SET label = ? WHERE id = ?' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT label FROM item WHERE id = ?' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, code) VALUES (?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, code) VALUES (?, ?)' #2",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, code) VALUES (?, ?)' #3",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, code) VALUES (?, ?)' #4",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT id FROM item' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO child (id, parent_id) VALUES (?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO child (id, req) VALUES (?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO child (id, qty) VALUES (?, ?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id, label) VALUES (?, ?)' #2",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT label FROM item WHERE id = ?' #2",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT ? AS n' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT ? AS n' #2",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'INSERT INTO item (id) VALUES (?)' #1",
        "db-sqlite/src/contract/executor-contract.ts:SQL input: sql: 'SELECT COUNT(*) AS n FROM item' #1",
      ],
    },
    {
      reason:
        'Indexes fixture data in job-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/job-contract.ts:unresolved computed access: status.history[status.history.length - 1] #1',
        'db-sqlite/src/contract/job-contract.ts:unresolved computed access: fixture[key] #1',
        'db-sqlite/src/contract/job-contract.ts:unresolved computed access: fixture[key] #2',
      ],
    },
    {
      reason:
        'Object introspection and computed keys in migration contracts contain scalar fixture values, not executor mutation results.',
      sites: [
        'db-sqlite/src/contract/npm-publish-migration-contract.ts:unresolved computed access: before[index] #1',
        'db-sqlite/src/contract/npm-publish-migration-contract.ts:opaque object access: Object.entries(source!) #1',
        'db-sqlite/src/contract/npm-publish-migration-contract.ts:opaque object access: Object.values(values) #1',
        'db-sqlite/src/contract/npm-publish-migration-contract.ts:opaque object access: Object.values(columns) #1',
        "db-sqlite/src/contract/npm-publish-migration-contract.ts:unresolved computed key: await expect(\n              insert(executor, table, { ...base, [column]: `other-${parent}` }),\n            ).rejects.toMatchObject({ kind: 'foreign_key' }); #1",
        'db-sqlite/src/contract/migration-contract.ts:opaque object access: Object.values(values) #1',
        'db-sqlite/src/contract/migration-contract.ts:opaque object access: Object.values(values) #2',
      ],
    },
    {
      reason:
        'Indexes fixture data in migration-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/migration-contract.ts:unresolved computed access: ROLE_IDS[defaults.key] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in migration-lock-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/migration-lock-contract.ts:unresolved computed access: runners[loserIndex] #1',
      ],
    },
    {
      reason:
        'Object introspection in org-key-contract; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/contract/org-key-contract.ts:opaque object access: Object.entries(EXPECTED_FOREIGN_KEYS) #1',
      ],
    },
    {
      reason:
        'Object introspection in registry-contract; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/contract/registry-contract.ts:opaque object access: Object.entries(registryContractCases) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in registry-race-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/registry-race-contract.ts:unresolved computed access: cases[name as keyof typeof cases] #1',
        'db-sqlite/src/contract/registry-race-contract.ts:unresolved computed access: opened[side] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in token-contract; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/contract/token-contract.ts:unresolved computed access: expected[slug] #1',
      ],
    },
    {
      reason:
        'Computed fixture map in token-contract; domain key construction is reviewed explicitly.',
      sites: [
        "db-sqlite/src/contract/token-contract.ts:unresolved computed key: expect(\n        await createProjectGrantRepository(executor).delete(\n          ctx,\n          mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {\n            [projectGrantKey('project-grant')]: 1,\n          }),\n          {\n            audit: mutationAudit('project_grant.revoke', 'project-grant', 'alpha'),\n            id: 'project-grant',\n            projectId: 'alpha',\n            providerAnchors: anchors,\n          },\n        ),\n      ).toEqual({ status: 'deleted', offboardedUserId: null }); #1",
      ],
    },
    {
      reason:
        'Computed fixture dispatch in token-contract; reviewed explicitly because its target is not statically known.',
      sites: [
        'db-sqlite/src/contract/token-contract.ts:computed builder call: tokenContractCases[name](open, (executor) => ({\n            driver: executor.driver,\n            batch: executor.batch.bind(executor),\n            all: (statement) => {\n              if (!statement.sql.includes(\'"t"."id" as "token_id"\')) return executor.all(statement);\n              const sql = statement.sql.replace(before, after);\n              if (sql !== statement.sql) mutations += 1;\n              return executor.all({ ...statement, sql });\n            },\n          })) #1',
      ],
    },
    {
      reason:
        'Object introspection in token-contract; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/contract/token-contract.ts:opaque object access: Object.entries(tokenContractCases) #1',
      ],
    },
    {
      reason:
        'Fixture SQL in two-organizations; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/contract/two-organizations.ts:SQL input: sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)' #1",
        "db-sqlite/src/contract/two-organizations.ts:SQL input: sql: 'INSERT INTO cache_epoch (org_id, version) VALUES (?, hex(randomblob(16))) ON CONFLICT (org_id) DO NOTHING' #1",
        "db-sqlite/src/contract/two-organizations.ts:SQL input: sql: 'DROP INDEX organization_singleton' #1",
      ],
    },
    {
      reason:
        'SQL in catalogue-status-statements; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/internal/catalogue-status-statements.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` #1",
        'db-sqlite/src/internal/catalogue-status-statements.ts:SQL template: sql<string>`hex(randomblob(16))` #1',
        'db-sqlite/src/internal/catalogue-status-statements.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM version\n          WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}\n            AND version.last_op_id = ${opId})` #1',
      ],
    },
    {
      reason:
        'Local builder in catalogue-status-statements; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: const insertRevision = db\n    .insertInto('version_revision')\n    .columns([\n      'id',\n      'org_id',\n      'version_id',\n      'revision',\n      'blob_id',\n      'source_ref',\n      'metadata_json',\n      'reason',\n      'op_id',\n    ])\n    .expression(\n      db\n        .selectFrom('version')\n        .select([\n          sql<string>`${newOpId()}`.as('id'),\n          'version.org_id',\n          'version.id',\n          'version.revision',\n          'version.blob_id',\n          'version.source_ref',\n          'version.metadata_json',\n          sql<string>`'status:' || version.status || ${suffix}`.as('reason'),\n          sql<string>`${opId}`.as('op_id'),\n        ])\n        .where('version.id', '=', versionId)\n        .where('version.org_id', '=', ctx.orgId)\n        .where('version.status', 'in', from),\n    ); #1",
        "db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: const updateVersion = db\n    .updateTable('version')\n    .set({\n      status: to,\n      revision: sql<number>`version.revision + 1`,\n      last_op_id: opId,\n      ...(to === 'active' ? { removed_upstream_at: null } : {}),\n      ...(tombstone ? { tombstoned_at: NOW, tombstone_reason: reason } : {}),\n    })\n    .where('version.id', '=', versionId)\n    .where('version.org_id', '=', ctx.orgId)\n    .where('version.status', 'in', from)\n    .where(\n      sql<boolean>`EXISTS (SELECT 1 FROM version_revision\n        WHERE version_revision.version_id = version.id AND version_revision.op_id = ${opId})`,\n    ); #1",
        "db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: const advancePackage = db\n    .updateTable('package')\n    .set({\n      rev: sql<number>`package.rev + 1`,\n      modified_at: monotonicNow,\n    })\n    .where('package.org_id', '=', ctx.orgId)\n    .where(\n      sql<boolean>`EXISTS (SELECT 1 FROM version\n        WHERE version.package_id = package.id AND version.last_op_id = ${opId})`,\n    ); #1",
        'db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: const statements = [compile(insertRevision), compile(updateVersion), compile(advancePackage)]; #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: if (results.length !== statementCount) throw new TypeError('incomplete dist tag results'); #1",
        'db-sqlite/src/internal/catalogue-status-statements.ts:builder variable: return { changed: (results[1]?.changes ?? 0) > 0, statements: statements.length }; #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-write-guard; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/internal/catalogue-write-guard.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', max(\n  unixepoch('now', 'subsec'),\n  unixepoch(package.modified_at, 'subsec') + 0.001\n), 'unixepoch')` #1",
        'db-sqlite/src/internal/catalogue-write-guard.ts:SQL template: sql<SqlBool>`blob.purge_lease_until IS NULL` #1',
        'db-sqlite/src/internal/catalogue-write-guard.ts:SQL template: sql<SqlBool>`(blob.purge_lease_until IS NULL AND blob.purge_generation = ${expectedGeneration})` #1',
      ],
    },
    {
      reason:
        'SQL boundary in lease-time; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        "db-sqlite/src/internal/lease-time.ts:opaque SQL input: sql.raw(`strftime('${FORMAT}','now')`) #1",
      ],
    },
    {
      reason:
        'SQL in lease-time; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/internal/lease-time.ts:SQL template: sql<string>`strftime('${sql.raw(FORMAT)}','now', ${`+${String(leaseSeconds)} seconds`})` #1",
      ],
    },
    {
      reason:
        'Object introspection in kysely; domain/fixture values are reviewed as possible indirect count access.',
      sites: ['db-sqlite/src/kysely.ts:opaque object access: Object.values<string>(aliases) #1'],
    },
    {
      reason:
        'SQL in kysely; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`exists ${query}` #1',
        "db-sqlite/src/kysely.ts:SQL template: sql<number>`cast(round(unixepoch('now', 'subsec') * 1000) as integer)` #1",
        "db-sqlite/src/kysely.ts:SQL template: sql`(select json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') from json_each(${JSON.stringify(\n          providers.map((entry) => [\n            entry.provider,\n            entry.anchor,\n            entry.emailAuthoritative ? 1 : 0,\n            authoritativeDomainsOf(entry),\n          ]),\n        )}))` #1",
        'db-sqlite/src/kysely.ts:SQL template: sql<\n      string | number\n    >`(select ${sql.ref(`${names.values}.${column}`)} from ${sql.table(names.values)})` #1',
        'db-sqlite/src/kysely.ts:SQL template: sql`select null, null where 0` #1',
        'db-sqlite/src/kysely.ts:SQL template: sql`select provider, anchor from ${sql.table(names.anchors)}${\n            authoritativeOnly ? sql` where email_authoritative = 1` : sql``\n          }` #1',
        'db-sqlite/src/kysely.ts:SQL template: sql`select null, null where 0` #2',
        'db-sqlite/src/kysely.ts:SQL template: sql`select ${sql.ref(`${names.anchors}.provider`)}, json_each.value from ${sql.table(\n            names.anchors,\n          )}, json_each(${sql.ref(`${names.anchors}.domains`)}) where ${sql.ref(\n            `${names.anchors}.email_authoritative`,\n          )} = 1` #1',
        "db-sqlite/src/kysely.ts:SQL template: sql`select json_extract(value, '$[0]'), json_extract(value, '$[1]') from json_each(${JSON.stringify(\n    providers.flatMap((entry) =>\n      authoritativeDomainsOf(entry).map((domain) => [entry.provider, domain]),\n    ),\n  )})` #1",
        "db-sqlite/src/kysely.ts:SQL template: sql`select json_extract(value, '$[0]'), json_extract(value, '$[1]') from json_each(${JSON.stringify(\n    providers.map((entry) => [entry.provider, entry.anchor]),\n  )})` #1",
        'db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`(${sql.ref(`${alias.binding}.provider`)}, ${sql.ref(`${alias.binding}.anchor`)}) in (${anchors})` #1',
        "db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`(${sql.ref(`${alias.identity}.provider`)}, substr(${email}, instr(${email}, '@') + 1)) in (${authoritativeDomains})` #1",
        "db-sqlite/src/kysely.ts:SQL template: sql`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer)` #1",
        'db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`(${ms} >= ${now} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${ms} <= ${now} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)})` #1',
        "db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`(${ms} >= ${bindings.value('lower_ms')} and ${ms} <= ${bindings.value('upper_ms')})` #1",
        'db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`${ms} between ${databaseTimeMs} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${databaseTimeMs} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)}` #1',
        'db-sqlite/src/kysely.ts:SQL template: sql<SqlBool>`(${sql.ref(`${alias.member}.org_id`)} = ${bindings.org} and ${evidenceWithin(`${alias.member}.refreshed_at`, window, options.now)} and exists ${identity})` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in kysely; retained because the key cannot be proven to exclude changes.',
      sites: ['db-sqlite/src/kysely.ts:unresolved computed access: values[column] #1'],
    },
    {
      reason:
        'Local builder in kysely; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/kysely.ts:builder variable: const insert = ctes\n    .with(\n      (cte) => cte('guard_cond(f)').materialized(),\n      (qb) => qb.selectNoFrom(eb(condition, 'is not', sql.lit(1)).as('f')),\n    )\n    .with('guard_rows(n)', (qb) =>\n      qb.selectNoFrom(sql.lit(1).as('n')).unionAll(qb.selectNoFrom(sql.lit(2).as('n'))),\n    )\n    .insertInto('access_mutation_guard')\n    .columns(['key'])\n    .expression(\n      ctes\n        .selectFrom(['guard_cond', 'guard_rows'])\n        .select(sql<string>`${newOpId()}`.as('key'))\n        .where('guard_cond.f', '=', sql.lit(1)),\n    ); #1",
        'db-sqlite/src/kysely.ts:builder variable: return [compile(insert)]; #1',
        "db-sqlite/src/kysely.ts:builder variable: const bump = ctes\n    .updateTable('cache_epoch')\n    .set({\n      version:\n        changed === undefined\n          ? sql<string>`hex(randomblob(16))`\n          : sql<string>`case when ${changed} then hex(randomblob(16)) else version end`,\n    })\n    .where('org_id', '=', ctx.orgId); #1",
        "db-sqlite/src/kysely.ts:builder variable: const bumpedOnce = ctes\n    .with('guard_rows(n)', (qb) =>\n      qb.selectNoFrom(sql.lit(1).as('n')).unionAll(qb.selectNoFrom(sql.lit(2).as('n'))),\n    )\n    .insertInto('access_mutation_guard')\n    .columns(['key'])\n    .expression(\n      ctes\n        .selectFrom(['guard_rows'])\n        .select(sql<string>`${newOpId()}`.as('key'))\n        .where(sql<boolean>`changes() <> 1`),\n    ); #1",
        'db-sqlite/src/kysely.ts:builder variable: return [compile(bump), compile(bumpedOnce)]; #1',
      ],
    },
    {
      reason:
        'SQL in lock; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/migrations/lock.ts:SQL input: sql: `CREATE TABLE IF NOT EXISTS migration_lock (\n  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),\n  holder      TEXT,\n  acquired_at TEXT,\n  expires_at  TEXT\n) STRICT` #1',
        "db-sqlite/src/migrations/lock.ts:SQL input: sql: 'INSERT OR IGNORE INTO migration_lock (id) VALUES (1)' #1",
        'db-sqlite/src/migrations/lock.ts:SQL input: sql: `UPDATE migration_lock SET holder = ?, acquired_at = ${DB_NOW}, expires_at = ${DB_NOW_PLUS} WHERE id = 1 AND (holder IS NULL OR expires_at < ${DB_NOW}) RETURNING holder` #1',
        "db-sqlite/src/migrations/lock.ts:SQL input: sql: 'SELECT holder, expires_at FROM migration_lock WHERE id = 1' #1",
        'db-sqlite/src/migrations/lock.ts:SQL input: sql: `INSERT INTO migration_lock (id) SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) WHERE NOT EXISTS (SELECT 1 FROM migration_lock WHERE id = 1 AND holder = ? AND expires_at >= ${DB_NOW})` #1',
        'db-sqlite/src/migrations/lock.ts:SQL input: sql: `UPDATE migration_lock SET expires_at = ${DB_NOW_PLUS} WHERE id = 1 AND holder = ?` #1',
        "db-sqlite/src/migrations/lock.ts:SQL input: sql: 'UPDATE migration_lock SET holder = NULL, acquired_at = NULL, expires_at = NULL WHERE id = 1 AND holder = ?' #1",
      ],
    },
    {
      reason:
        'SQL in runner; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/migrations/runner.ts:SQL input: sql: \"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migration', 'migration_lock')\" #1",
        "db-sqlite/src/migrations/runner.ts:SQL input: sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)' #1",
        "db-sqlite/src/migrations/runner.ts:SQL input: sql: 'SELECT id, checksum FROM schema_migration' #1",
        "db-sqlite/src/migrations/runner.ts:SQL input: sql: 'SELECT checksum FROM schema_migration WHERE id = ?' #1",
        'db-sqlite/src/migrations/runner.ts:SQL input: sql: `SELECT holder, expires_at, expires_at < ${DB_NOW} AS expired FROM migration_lock WHERE id = 1` #1',
      ],
    },
    {
      reason:
        'SQL boundary in source; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'db-sqlite/src/migrations/source.ts:opaque SQL input: PHASE_DIRECTIVE.exec(firstLine) #1',
        'db-sqlite/src/migrations/source.ts:opaque SQL input: FILE_NAME.exec(fileName) #1',
      ],
    },
    {
      reason:
        'SQL boundary in split; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'db-sqlite/src/migrations/split.ts:opaque SQL input: LEADING_WORD.exec(statement) #1',
      ],
    },
    {
      reason:
        'SQL in access; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`cast(round(unixepoch('now', 'subsec') * 1000) as integer)` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer)` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`${instantMs(column)} between ${nowMs} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${nowMs} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)}` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`${sql.ref(`${alias.grant}.subject_provider`)} is null` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`${sql.ref(`${alias.member}.org_id`)} = ${bindings.org}` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`${sql.lit(localAdmin ? 1 : 0)}` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`0` #1',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${loose\n          .selectFrom(`session as ${localSession}`)\n          .select(sql.lit(1).as('one'))\n          .where(`${localSession}.org_id`, '=', ctx.orgId)\n          .where(`${localSession}.id`, '=', input.session as string)\n          .where(`${localSession}.revoked_at`, 'is', null)\n          .where(`${localSession}.identity_id`, 'is', null)}` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${loose\n    .selectFrom(rows.as(rowsAlias))\n    .select(sql.lit(1).as('one'))\n    .where(`${rowsAlias}.permission`, '=', input.permission)}` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${loose\n    .selectFrom(`project as ${project}`)\n    .select(sql.lit(1).as('one'))\n    .where(`${project}.org_id`, '=', ctx.orgId)\n    .where(`${project}.id`, '=', input.projectId as string)\n    .where(`${project}.status`, '=', sql.lit('active'))}` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`(${active} and ${held})` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`s.identity_id is null` #1',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<string>`json_object(\n      'organization', json_group_array(distinct pr.permission) filter (where pr.scope = 'organization'),\n      'project', json_group_array(distinct pr.permission) filter (where pr.scope = 'project'),\n      'holder', coalesce(max(pr.scope = 'organization' and pr.protects = 1), 0)\n    )` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #2',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #3',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #4',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #5',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #6',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #7',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<number>`0` #1',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case when exists ${verifiedIdentity(\n          ctx,\n          { ...freshAlias, user: 'u' },\n          input.providerAnchors,\n          undefined,\n        )\n          .whereRef(`${freshAlias.identity}.id`, '=', 'i.id')\n          .where(freshEvidence(`${freshAlias.identity}.validated_at`))} then 1 else 0 end` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`(s.identity_id is null or i.id is not null)` #1',
        "db-sqlite/src/repositories/access.ts:SQL template: sql`unixepoch('now', 'subsec')` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`t.validation_kind = 'local'` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<string>`json_object(\n      'organization', json_group_array(distinct pr.permission) filter (where pr.scope = 'organization'),\n      'project', json_group_array(distinct pr.permission) filter (where pr.scope = 'project'),\n      'holder', coalesce(max(pr.scope = 'organization' and pr.protects = 1), 0),\n      'visible', coalesce(max(pr.permission in (${projectNames})), 0)\n    )` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`t.kind = 'pat'` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql<string>`json_group_array(distinct spp.permission)` #1',
        'db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`0` #2',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${verifiedIdentity(ctx, holderAlias, input.providerAnchors, undefined)\n          .whereRef(`${freshAlias.identity}.id`, '=', 't.validation_identity_id')\n          .where(freshEvidence(`${freshAlias.identity}.validated_at`))}` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`exists ${usableLocalLogin(ctx, holderAlias).where(\n    freshEvidence(`${freshAlias.login}.last_login_at`),\n  )} and ${adminEligibility(ctx, looseEb.ref('u.id') as unknown as Expression<string>)}` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case\n    when t.kind = 'pat' and t.validation_kind = 'sso' then ${ssoFresh}\n    when t.kind = 'pat' and t.validation_kind = 'local' and t.validation_identity_id is null then ${localFresh}\n    else 0 end` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<string | null>`case\n    when t.kind = 'pat' and t.validation_kind = 'sso' then (\n      select ev_i.validated_at from identity ev_i\n      where ev_i.org_id = ${ctx.orgId} and ev_i.id = t.validation_identity_id and ev_i.user_id = t.user_id)\n    when t.kind = 'pat' and t.validation_kind = 'local' and t.validation_identity_id is null then (\n      select ev_l.last_login_at from local_login ev_l\n      where ev_l.org_id = ${ctx.orgId} and ev_l.user_id = t.user_id)\n    else null end` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #8',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #9',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #10',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #11',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #12',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #13',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #14',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case when t.kind = 'svc' and vp.id is not null\n          and (sp.project_id is null or sp.project_id = vp.id)\n          and exists (\n            select 1 from service_principal_permission spv\n            where spv.org_id = t.org_id and spv.service_principal_id = t.service_principal_id\n              and spv.permission in (${projectNames})\n          ) then 1 else 0 end` #1",
        'db-sqlite/src/repositories/access.ts:SQL template: sql`null` #15',
        'db-sqlite/src/repositories/access.ts:SQL template: sql`0` #1',
        "db-sqlite/src/repositories/access.ts:SQL template: sql<SqlBool>`(\n            (t.kind = 'pat' and t.project_id is null and t.project_mode = 'all')\n            or (t.kind = 'pat' and t.project_id is null and t.project_mode = 'selected' and exists (\n              select 1 from token_project tp\n              where tp.token_id = t.id and tp.org_id = t.org_id and tp.project_id = p.id\n            ))\n            or (t.kind = 'svc' and t.project_id is sp.project_id and (sp.project_id is null or sp.project_id = p.id))\n          )` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<string>`(select json_group_array(json_object('org', tpb.org_id, 'project', tpb.project_id))\n        from token_project tpb where tpb.token_id = t.id)` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case when unixepoch(t.expires_at, 'subsec') > ${nowSeconds} then 0 else 1 end` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<string | null>`case t.kind when 'pat' then u.status else sp.status end` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case t.kind when 'svc' then (t.project_id is sp.project_id) else (t.project_id is null) end` #1",
        "db-sqlite/src/repositories/access.ts:SQL template: sql<number>`case when t.kind = 'pat' and u.pat_invalid_before is not null\n        and coalesce(unixepoch(t.created_at, 'subsec') >= unixepoch(u.pat_invalid_before, 'subsec'), 0) = 0\n        then 1 else 0 end` #1",
      ],
    },
    {
      reason:
        'Local builder in access; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/access.ts:builder variable: const rows = await executor.all<{ id: string }>(\n        compile(\n          loose\n            .updateTable('session')\n            .set({ last_seen_at: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })\n            .where('org_id', '=', ctx.orgId)\n            .where('id', '=', sessionId)\n            .where(liveSessionCondition('session', idleSeconds))\n            .where(\n              sql<SqlBool>`unixepoch(coalesce(last_seen_at, created_at), 'subsec') < unixepoch('now', 'subsec') - ${TOUCH_INTERVAL_SECONDS}`,\n            )\n            .where(\n              sql<SqlBool>`exists (select 1 from user_account where user_account.id = session.user_id and user_account.org_id = session.org_id and user_account.status = 'active')`,\n            )\n            .returning('id'),\n        ),\n      ); #1",
        'db-sqlite/src/repositories/access.ts:builder variable: return rows.length > 0; #1',
        "db-sqlite/src/repositories/access.ts:builder variable: const rows = await executor.all<{ id: string }>(\n        compile(\n          loose\n            .updateTable('token')\n            .set({ last_used_at: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })\n            .where('org_id', '=', ctx.orgId)\n            .where('id', '=', tokenId)\n            .where('kind', '=', kind)\n            .where('revoked_at', 'is', null)\n            .where(\n              sql<SqlBool>`(expires_at is null or unixepoch(expires_at, 'subsec') > unixepoch('now', 'subsec'))`,\n            )\n            .where(\n              sql<SqlBool>`(last_used_at is null or unixepoch(last_used_at, 'subsec') is null or unixepoch(last_used_at, 'subsec') < unixepoch('now', 'subsec') - ${TOUCH_INTERVAL_SECONDS})`,\n            )\n            .where(\n              sql<SqlBool>`(\n                (token.kind = 'pat' and exists (select 1 from user_account where user_account.id = token.user_id and user_account.org_id = token.org_id and user_account.status = 'active' and (user_account.pat_invalid_before is null or unixepoch(token.created_at, 'subsec') >= unixepoch(user_account.pat_invalid_before, 'subsec'))))\n                or (token.kind = 'svc' and exists (select 1 from service_principal where service_principal.id = token.service_principal_id and service_principal.org_id = token.org_id and service_principal.status = 'active'))\n              )`,\n            )\n            .returning('id'),\n        ),\n      ); #1",
        'db-sqlite/src/repositories/access.ts:builder variable: return rows.length > 0; #2',
      ],
    },
    {
      reason:
        'SQL in actor-authority; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/actor-authority.ts:SQL template: sql<SqlBool>`(s.identity_id is null or i.id is not null)` #1',
        'db-sqlite/src/repositories/actor-authority.ts:SQL template: sql<SqlBool>`1` #1',
        'db-sqlite/src/repositories/actor-authority.ts:SQL template: sql<SqlBool>`(${session} and ${projectExists} and ${held})` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in admin-bootstrap; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: roleIds[key] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: results[topUp.length] #1',
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: results[results.length - 1] #1',
      ],
    },
    {
      reason:
        'SSO bootstrap selects grant insert/promotion and permission top-up results; rowsOf counts RETURNING rows, excluding trigger and FK-action writes.',
      sites: [
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: results[results.length - 1] #2',
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: results[results.length - 2] #1',
        'db-sqlite/src/repositories/admin-bootstrap.ts:unresolved computed access: results[guards.length + topUp.length - 1] #1',
      ],
    },
    {
      reason:
        'SQL in audit-pending; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/audit-pending.ts:SQL text: `INSERT INTO audit_pending\n  (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip,\n   action, target_type, target_id, project_id, payload_json)` #1',
        "db-sqlite/src/repositories/audit-pending.ts:SQL text: 'audit insert must bind at most 100 parameters' #1",
        'db-sqlite/src/repositories/audit-pending.ts:SQL input: sql:\n      when === undefined\n        ? `${INSERT} VALUES (${values})`\n        : `${INSERT} SELECT ${values} WHERE ${when.sql}` #1',
      ],
    },
    {
      reason:
        'SQL in blob-access; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/blob-access.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now')` #1",
        "db-sqlite/src/repositories/blob-access.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now', '-1 day')` #1",
      ],
    },
    {
      reason:
        'Local builder in blob-access; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/blob-access.ts:builder variable: const query = db\n        .updateTable('blob')\n        .set({ last_accessed_at: NOW })\n        .where('org_id', '=', ctx.orgId)\n        .where('deleted_at', 'is', null)\n        .where(sql<SqlBool>`id in (select value from json_each(${JSON.stringify(ids)}))`)\n        .where((eb) =>\n          eb.or([eb('last_accessed_at', 'is', null), eb('last_accessed_at', '<', DAY_AGO)]),\n        ); #1",
        'db-sqlite/src/repositories/blob-access.ts:builder variable: const [result] = await executor.batch([compile(query) as ScalarStatement]); #1',
      ],
    },
    {
      reason:
        'SQL in blob-lease-guard; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/blob-lease-guard.ts:SQL template: sql<SqlBool>`(${sql.ref(column)} is not null and ${sql.ref(column)} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` #1",
        "db-sqlite/src/repositories/blob-lease-guard.ts:SQL input: sql: `(${versionAlias}.blob_id IS NULL OR NOT EXISTS (SELECT 1 FROM blob bls_blob WHERE bls_blob.id = ${versionAlias}.blob_id AND bls_blob.org_id = ? AND bls_blob.purge_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))` #1",
      ],
    },
    {
      reason:
        'SQL in blob-references; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `(${orphanSql(blobRef)}\n    AND (${blobRef}.refetchable = 1 OR (${blobRef}.refetchable = 0 AND ${blobRef}.storage_key LIKE 'npm-publish/%'))\n    AND julianday(COALESCE(${blobRef}.published_at, ${blobRef}.created_at)) <= julianday('now', '-${ORPHAN_GRACE_DAYS} days')\n    AND NOT EXISTS (\n      SELECT 1 FROM ingest_session bref_ing\n      WHERE bref_ing.org_id = ${blobRef}.org_id AND bref_ing.snapshot_blob_sha256 = ${blobRef}.sha256)\n    AND NOT EXISTS (\n      SELECT 1 FROM upstream_state bref_up\n      WHERE bref_up.org_id = ${blobRef}.org_id AND bref_up.content_sha256 = ${blobRef}.sha256))` #1",
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `EXISTS (SELECT 1 FROM (${references(blobRef, columns, () => '')}) bref_rel\n    WHERE bref_rel.rel <> ''\n    AND ${blobRef}.purge_after < COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', bref_rel.rel, '+' || CASE WHEN bref_rel.rejected_hosted THEN ${PUBLISH_PURGE_WINDOW_DAYS} ELSE max((SELECT o.retention_removed_upstream_days FROM organization o WHERE o.id = ${blobRef}.org_id), bref_rel.ov) END || ' days'), '${NEVER}'))` #1",
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `(${blobRef}.org_id = ?\n  AND ((EXISTS (${references(blobRef, '1', (c) => `AND ${c}`)})\n  AND NOT EXISTS (${references(blobRef, '1', (c) => `AND NOT ${released(c)}`)})\n  AND NOT EXISTS (${references(blobRef, '1', (c) => `AND ${c} AND bref_s.type = 'hosted' AND NOT (${REJECTED_HOSTED})`)}))\n  OR ${orphan.sql})\n  AND NOT EXISTS (\n    SELECT 1 FROM import_run bref_ru CROSS JOIN import_ref bref_ir INDEXED BY import_ref_run_external\n      ON bref_ir.import_run_id = bref_ru.id AND bref_ir.org_id = bref_ru.org_id\n    WHERE bref_ru.org_id = ${blobRef}.org_id\n      AND (bref_ru.before_image_expires_at IS NULL OR bref_ru.before_image_expires_at > ${NOW})\n      AND bref_ir.entity_type = 'version'\n      AND json_extract(bref_ir.before_image_json, '$.blob_id') = ${blobRef}.id))` #1",
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: '' #1",
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: 'AND (b.created_at, b.id) > (?, ?)' #1",
        "db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `SELECT b.id, b.sha256, b.created_at, ${overrideSql('b')} AS override_days, ${orphanSql('b')} AS orphan\nFROM blob b\nWHERE ${eligible.sql} AND NOT ${missingReleaseStampSql('b')} AND b.purge_after IS NULL AND b.deleted_at IS NULL ${cursor.sql}\nORDER BY b.created_at, b.id\nLIMIT ?` #1",
        'db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `SELECT b.id, b.sha256, b.created_at FROM blob b\nWHERE b.org_id = ? AND b.purge_after IS NOT NULL AND b.deleted_at IS NULL AND (NOT ${eligible.sql} OR ${premature.sql}) ${cursor.sql}\nORDER BY b.created_at, b.id\nLIMIT ?` #1',
        'db-sqlite/src/repositories/blob-references.ts:SQL input: sql: `SELECT 1 AS one FROM blob b WHERE b.sha256 = ? AND ${eligible.sql}` #1',
      ],
    },
    {
      reason:
        'SQL in blob; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now')` #1",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<string>`lower(hex(randomblob(16)))` #1',
        'db-sqlite/src/repositories/blob.ts:SQL input: sql: `${base.sql} AND ${eligible.sql}${suffix}` #1',
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`purge_after <= ${NOW}` #1',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${leaseLive('purge_lease_until')}` #1",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<{ one: number }>`(select 1 as one)` #1',
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<number>`exists (select 1 from blob where org_id = ${ctx.orgId} and sha256 = ${sha256} and purge_lease_until is not null)` #1',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${leaseLive('purge_lease_until')}` #2",
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${leaseLive('purge_lease_until')}` #3",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<number>`(select retention_removed_upstream_days from organization where id = blob.org_id)` #1',
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<number>`max(${orgDays}, ${override})` #1',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<string>`coalesce(purge_after, strftime(${sql.lit(FORMAT)}, 'now', '+' || ${days} || ' days'))` #1",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`${removedAt} <= ${NOW}` #1',
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`(select retention_removed_upstream_days from organization where id = blob.org_id) is not null` #1',
        "db-sqlite/src/repositories/blob.ts:SQL input: sql: `UPDATE blob SET purge_after = NULL\nWHERE org_id = ? AND sha256 = ? AND deleted_at IS NULL AND purge_after IS NOT NULL\nAND (purge_lease_until IS NULL OR purge_lease_until <= strftime('${FORMAT}', 'now'))\nAND (NOT ${eligible.sql} OR ${premature.sql})` #1",
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${leaseLive('purge_lease_until')}` #4",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`${sql.raw(orphan.sql)}` #1',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now', ${`+${leaseSeconds} seconds`})` #1",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`purge_after <= ${NOW}` #2',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${leaseLive('purge_lease_until')}` #5",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${sql.raw(premature.sql)}` #1',
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<number>`1` #1',
        "db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`purge_lease_until > strftime(${sql.lit(FORMAT)}, 'now', ${modifier})` #1",
        'db-sqlite/src/repositories/blob.ts:SQL template: sql<SqlBool>`not ${sql.raw(premature.sql)}` #2',
      ],
    },
    {
      reason:
        'Local builder in blob; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/blob.ts:builder variable: const bump = db\n        .updateTable('blob')\n        .set({ purge_generation: FRESH, purge_lease_until: null })\n        .where('org_id', '=', ctx.orgId)\n        .where('sha256', '=', sha256)\n        .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)\n        .returning('purge_generation'); #1",
        'db-sqlite/src/repositories/blob.ts:builder variable: const [bumped, fresh] = await executor.batch([statement(bump), statement(probe)]); #1',
        "db-sqlite/src/repositories/blob.ts:builder variable: const upsert = db\n        .insertInto('blob')\n        .values({\n          id: FRESH,\n          org_id: ctx.orgId,\n          sha256,\n          size_bytes: input.size,\n          storage_key:\n            input.npmPublishHandle === undefined\n              ? blobStorageKey(ctx.orgId, sha256)\n              : stagedStorageKey(input.npmPublishHandle, sha256),\n          media_type: input.mediaType,\n          refetchable: input.refetchable ? 1 : 0,\n          purge_generation: input.generation,\n          published_at: NOW,\n        })\n        .onConflict((conflict) =>\n          conflict\n            .columns(['org_id', 'sha256'])\n            .doUpdateSet({\n              published_at: NOW,\n              refetchable: sql<number>`case when blob.deleted_at is not null then excluded.refetchable else min(blob.refetchable, excluded.refetchable) end`,\n              upstream_url: sql<\n                string | null\n              >`case when blob.deleted_at is not null then excluded.upstream_url else blob.upstream_url end`,\n              last_fetched_at: sql<\n                string | null\n              >`case when blob.deleted_at is not null then excluded.last_fetched_at else blob.last_fetched_at end`,\n              last_accessed_at: sql<\n                string | null\n              >`case when blob.deleted_at is not null then excluded.last_accessed_at else blob.last_accessed_at end`,\n              purge_lease_until: null,\n              size_bytes: sql<number>`excluded.size_bytes`,\n              media_type: sql<string>`excluded.media_type`,\n              storage_key: sql<string>`excluded.storage_key`,\n              purge_after: null,\n              deleted_at: null,\n            })\n            .where(\n              sql<SqlBool>`blob.purge_generation = excluded.purge_generation and not ${leaseLive('blob.purge_lease_until')} and (blob.deleted_at is not null or (blob.size_bytes = excluded.size_bytes and blob.media_type = excluded.media_type))`,\n            ),\n        )\n        .returning(['sha256', 'size_bytes', 'media_type', 'purge_after', 'purge_generation']); #1",
        'db-sqlite/src/repositories/blob.ts:builder variable: const [before, written, current] = await executor.batch([\n        statement(previous),\n        statement(upsert),\n        statement(existing),\n      ]); #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-dist; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`case when json_type(${column}, ${path}) = 'text' then json_extract(${column}, ${path}) end` #1",
        "db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`v.org_id = ${ctx.orgId}\n    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))` #1",
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`` #1',
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`v.version_normalized = ${query.versionNormalized}` #1',
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`${selector} and v.id = ${query.expect.versionId} and v.revision = ${query.expect.revision}` #1',
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`v.id = ${query.versionId} and v.revision = ${query.revision}` #1',
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`null` #1',
        "db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`lower(nullif(${jsonText(historyMeta, '$.dist.shasum')}, ''))` #1",
        'db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`null` #2',
        "db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`\n  union all\n  select v.id, r.revision, 0, w.package_id, w.source_id, v.status, r.source_ref, r.blob_id, r.metadata_json,\n    case when json_extract(r.metadata_json, '$.dist.type') in ('zip', 'tar', 'tgz')\n      then json_extract(r.metadata_json, '$.dist.type') else v.dist_type end,\n    ${historyShasum}, ${historyIntegrity}\n  from w\n  join version as v on v.package_id = w.package_id\n  join version_revision as r on r.version_id = v.id and r.revision = ${query.revision}\n  where ${available} and r.org_id = ${ctx.orgId}\n    and v.id = ${query.versionId} and v.revision > ${query.revision}` #1",
        "db-sqlite/src/repositories/catalogue-dist.ts:SQL template: sql`with w as ${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)},\nt (version_id, revision, current, package_id, source_id, status, source_ref, blob_id, metadata_json,\n   dist_type, composer_shasum, npm_integrity) as (\n  select v.id, v.revision, 1, w.package_id, w.source_id, v.status, v.source_ref, v.blob_id, v.metadata_json,\n    v.dist_type, v.composer_shasum, v.npm_integrity\n  from w\n  join version as v on v.package_id = w.package_id\n  where ${available} and ${selector}${history}\n)\nselect t.version_id, t.revision, t.current, t.package_id, t.source_id, t.status, t.source_ref,\n  t.dist_type, t.composer_shasum, t.npm_integrity,\n  ${jsonText(meta, npm ? '$.dist.tarball' : '$.dist.url')} as upstream_dist_url,\n  ${npm ? jsonText(meta, '$.dist.shasum') : sql`null`} as npm_shasum,\n  b.id as blob_id, b.sha256, b.size_bytes, b.media_type, b.refetchable\nfrom t\nleft join blob as b on b.id = t.blob_id and b.org_id = ${ctx.orgId} and b.deleted_at is null\nlimit 1` #1",
      ],
    },
    {
      reason:
        'SQL in catalogue-list; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`select pkg.name as key, pkg.id as package_id, pkg.source_id, pkg.description\n  from project_package as pp\n  join package as pkg on pkg.id = pp.package_id\n  join source as src on src.id = pkg.source_id\n  join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id\n  where pp.project_id = ${projectId} and pkg.ecosystem = ${ecosystem} and ${filter}\n    and ${visibleRowsCondition(ctx, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}\n    and not exists (\n      select 1 from package as bp indexed by package_by_name\n      join project_package as bpp on bpp.project_id = pp.project_id and bpp.package_id = bp.id\n      join source as bs on bs.id = bp.source_id\n      join project_source as bps on bps.project_id = pp.project_id and bps.source_id = bp.source_id\n      where bp.org_id = pkg.org_id and bp.ecosystem = pkg.ecosystem and bp.name = pkg.name\n        and ${visibleRowsCondition(ctx, { pp: 'bpp', pkg: 'bp', src: 'bs', ps: 'bps' })}\n        and (${better}) < (${current})\n    )\n  order by pkg.name\n  limit ${limit}` #1",
        "db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`exists (\n    select 1 from project_source as ops\n    join source as os on os.id = ops.source_id\n    join project as op on op.id = ops.project_id\n    where ops.project_id = ${projectId} and ops.org_id = ${ctx.orgId}\n      and os.org_id = ${ctx.orgId} and op.org_id = ${ctx.orgId} and op.status = 'active'\n      and os.ecosystem = ${ecosystem} and os.type in ('packagist_proxy', 'npmjs_proxy')\n      and (os.project_id is null or os.project_id = ops.project_id)\n  )` #1",
        'db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`with w as (${winners(ctx, projectId, ecosystem, filter, limit)})\nselect ${openNamespace(ctx, projectId, ecosystem)} as open_namespace,\n  w.key, w.package_id, w.source_id, w.description\nfrom (select 1) as one\nleft join w on 1 = 1\norder by w.key` #1',
        "db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`replace(pkg.name, '!', '')` #1",
        "db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`${searchable} like ${pattern} escape '\\\\'` #1",
        'db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`instr(${searchable}, ${needle}) > 0` #1',
        'db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`1 = 1` #1',
        'db-sqlite/src/repositories/catalogue-list.ts:SQL template: sql`pkg.name > ${query.after}` #1',
      ],
    },
    {
      reason:
        'SQL boundary in catalogue-lookup; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        "db-sqlite/src/repositories/catalogue-lookup.ts:opaque SQL input: sql.raw(\n  'w.package_id, w.source_id, w.rev, w.modified_at, w.created_at, w.last_synced_at, e.version as cache_epoch',\n) #1",
        'db-sqlite/src/repositories/catalogue-lookup.ts:opaque SQL input: sql.raw(\n  `v.id, v.revision, v.version, v.version_normalized, v.stability, v.status, v.published_at,\n   v.upstream_released_at, v.license, v.dist_type, v.composer_shasum, v.npm_integrity,\n   v.deprecated_message, v.metadata_json`,\n) #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-lookup; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`v.package_id = w.package_id and v.org_id = ${ctx.orgId}\n    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))` #1",
        "db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`dt.package_id = w.package_id and dt.org_id = ${ctx.orgId} and ${sql.lit(query.ecosystem === 'npm' ? 1 : 0)} = 1` #1",
        'db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)}` #1',
        'db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`with w as ${winner(ctx, query)}\nselect ${HEADER_COLUMNS}, ${VERSION_COLUMNS}\nfrom w\n${match}\nleft join cache_epoch as e on e.org_id = ${ctx.orgId}\nlimit 1` #1',
        'db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`cross join version as v indexed by version_identity\n  on v.version_normalized = ${query.versionNormalized} and ${available(ctx)}` #1',
        'db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`cross join dist_tag as dt on dt.tag = ${query.tag} and ${tagged(ctx, query)}\njoin version as v on v.id = dt.version_id and ${available(ctx)}` #1',
        'db-sqlite/src/repositories/catalogue-lookup.ts:SQL template: sql`with w as ${winner(ctx, query)},\nt as (\n  select dt.tag, v.version\n  from w\n  cross join dist_tag as dt on ${tagged(ctx, query)}\n  join version as v on v.id = dt.version_id and ${available(ctx)}\n)\nselect ${HEADER_COLUMNS}, t.tag, t.version\nfrom w\nleft join t on 1 = 1\nleft join cache_epoch as e on e.org_id = ${ctx.orgId}\norder by t.tag` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in catalogue-lookup; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/catalogue-lookup.ts:unresolved computed access: tags[row.tag] #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-predicates; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`('packagist_proxy', 'npmjs_proxy')` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`(\n    length(cast(${pattern} as blob)) <> length(${pattern})\n    or length(${pattern}) not between 1 and ${sql.lit(MAX_PATTERN_BYTES)}\n    or ${pattern} glob '*[^a-z0-9._~@!/*-]*'\n    or length(${pattern}) - length(replace(${pattern}, '*', '')) > ${sql.lit(MAX_PATTERN_WILDCARDS)}\n  )` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from project_source as ${sql.id(a.ps)}\n    join source as ${sql.id(a.s)} on ${at(a.s, 'id')} = ${at(a.ps, 'source_id')}\n    join project as ${sql.id(a.p)} on ${at(a.p, 'id')} = ${at(a.ps, 'project_id')}\n    where ${at(a.ps, 'project_id')} = ${projectRef}\n      and ${at(a.ps, 'source_id')} = ${sourceRef}\n      and ${at(a.ps, 'org_id')} = ${ctx.orgId}\n      and ${at(a.s, 'org_id')} = ${ctx.orgId}\n      and ${at(a.p, 'org_id')} = ${ctx.orgId}\n      and ${at(a.s, 'ecosystem')} = ${ecosystemRef}\n      and (${at(a.s, 'project_id')} is null or ${at(a.s, 'project_id')} = ${at(a.ps, 'project_id')})\n  )` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`${at(alias, 'org_id')} = ${ctx.orgId} and ${at(alias, 'project_id')} = ${projectRef} and ${at(alias, 'source_id')} = ${sourceRef}` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`${at(alias, 'effect')} = ${sql.lit(value)}` #1",
        'db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`project_package_pattern as ${sql.id(alias)}` #1',
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`(\n    ${flagRef} = 1\n    and not exists (\n      select 1 from ${table(a.bad)}\n      where ${scoped(a.bad)} and ${invalidPattern(at(a.bad, 'pattern'))}\n    )\n    and (\n      select count(*) from ${table(a.ci)}\n      where ${scoped(a.ci)} and ${effect(a.ci, 'include')}\n    ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}\n    and (\n      select count(*) from ${table(a.cx)}\n      where ${scoped(a.cx)} and ${effect(a.cx, 'exclude')}\n    ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}\n    and (\n      not exists (\n        select 1 from ${table(a.i)}\n        where ${scoped(a.i)} and ${effect(a.i, 'include')}\n      )\n      or exists (\n        select 1 from ${table(a.im)}\n        where ${scoped(a.im)} and ${effect(a.im, 'include')}\n          and ${keyRef} glob ${at(a.im, 'pattern')}\n      )\n    )\n    and not exists (\n      select 1 from ${table(a.x)}\n      where ${scoped(a.x)} and ${effect(a.x, 'exclude')}\n        and ${keyRef} glob ${at(a.x, 'pattern')}\n    )\n  )` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`case when ${source('type')} in ${PROXY_TYPES} then 1 else 0 end` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`case when ${source('project_id')} is null then 1 else 0 end` #1",
        'db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql`${sql.ref(`${pp}.org_id`)} = ${ctx.orgId}\n    and ${sql.ref(`${pkg}.org_id`)} = ${ctx.orgId}\n    and ${sql.ref(`${src}.org_id`)} = ${ctx.orgId}\n    and ${sql.ref(`${ps}.org_id`)} = ${ctx.orgId}\n    and ${attachedSourceCondition(ctx, col(`${pp}.project_id`), col(`${pkg}.source_id`), col(`${pkg}.ecosystem`))}\n    and ${readTimeCondition(ctx, col(`${pp}.project_id`), { package: pkg, source: src })}\n    and ${proxyEligibleCondition({ package: pkg, source: src })}` #1',
      ],
    },
    {
      reason:
        'Object introspection in catalogue-predicates; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/repositories/catalogue-predicates.ts:opaque object access: Object.values(node) #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-read; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql<SqlBool>`src.id = +pkg.source_id` #1',
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`(w.package_id = ${binding.packageId} and w.source_id = ${binding.sourceId} and w.rev = ${binding.rev})` #1',
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`1 = 1` #1',
        "db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`v.stability = 'dev'` #1",
        "db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`v.stability <> 'dev'` #1",
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`v.published_at <= ${query.publishedAtMost}` #1',
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`v.published_at >= ${after.publishedAt} and (v.published_at > ${after.publishedAt} or v.id > ${after.id})` #1',
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`` #1',
        'db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql` and ${sql.join(filters, sql` and `)}` #1',
        "db-sqlite/src/repositories/catalogue-read.ts:SQL template: sql`with w as ${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)},\ncand as (\n  select ${VERSION_COLUMNS}\n  from w cross join version as v indexed by version_by_published on v.package_id = w.package_id\n  where v.org_id = ${ctx.orgId} and ${bound}\n    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))${extra}\n  order by v.published_at, v.id\n  limit ${limit + 1}\n),\nsized as (\n  select cand.*,\n    row_number() over page as rn,\n    sum(length(cast(metadata_json as blob))) over (page rows between unbounded preceding and current row) as bytes,\n    count(*) over () as candidates\n  from cand\n  window page as (order by published_at, id)\n)\nselect w.package_id, w.source_id, w.rev, w.modified_at, w.created_at, w.last_synced_at,\n  e.version as cache_epoch,\n  case when ${bound} then 0 else 1 end as changed,\n  s.candidates, s.id, s.revision, s.version, s.version_normalized, s.stability, s.status,\n  s.published_at, s.upstream_released_at, s.license, s.dist_type, s.composer_shasum,\n  s.npm_integrity, s.deprecated_message, s.metadata_json\nfrom (select 1) as one\nleft join w on 1 = 1\nleft join cache_epoch as e on e.org_id = ${ctx.orgId} and w.package_id is not null\nleft join sized as s on s.rn <= ${limit} and (s.rn = 1 or s.bytes <= ${CATALOGUE_PAGE_BYTES})\nwhere w.package_id is not null or ${sql.lit(binding ? 1 : 0)} = 1\norder by s.rn` #1",
      ],
    },
    {
      reason:
        'SQL boundary in catalogue-read; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'db-sqlite/src/repositories/catalogue-read.ts:opaque SQL input: sql.raw(\n  `v.id, v.revision, v.version, v.version_normalized, v.stability, v.status, v.published_at,\n   v.upstream_released_at, v.license, v.dist_type, v.composer_shasum, v.npm_integrity,\n   v.deprecated_message, v.metadata_json`,\n) #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-reblob; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/catalogue-reblob.ts:SQL template: sql<string>`(SELECT blob.id FROM blob\n    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${newSha256} AND blob.deleted_at IS NULL)` #1',
        'db-sqlite/src/repositories/catalogue-reblob.ts:SQL template: sql<string>`(SELECT blob.id FROM blob\n    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${newSha256} AND blob.deleted_at IS NULL\n      AND blob.id <> ${oldBlobId}\n      AND ${fence})` #1',
        "db-sqlite/src/repositories/catalogue-reblob.ts:SQL template: sql<SqlBool>`version.id = ${versionId} AND version.org_id = ${ctx.orgId}\n    AND version.blob_id = ${oldBlobId} AND version.revision = ${expectedRevision}\n    AND version.status <> 'tombstoned'\n    AND EXISTS (SELECT 1 FROM package\n      WHERE package.id = version.package_id AND package.org_id = ${ctx.orgId}\n        AND ((package.ecosystem = 'composer' AND COALESCE(version.composer_shasum, '') = '')\n          OR (package.ecosystem = 'npm' AND version.npm_integrity IS NULL\n            AND COALESCE(json_extract(version.metadata_json, '$.dist.shasum'), '') = '')))\n    AND ${eligibleBlob} IS NOT NULL` #1",
        'db-sqlite/src/repositories/catalogue-reblob.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM version WHERE ${eligible})` #1',
        'db-sqlite/src/repositories/catalogue-reblob.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM version\n      WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}\n        AND version.revision = ${expectedRevision} + 1 AND version.last_op_id = ${opId}\n        AND version.blob_id = ${liveBlob}\n        AND EXISTS (SELECT 1 FROM version_revision AS before\n          WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}\n            AND before.revision = ${expectedRevision} AND before.blob_id = ${oldBlobId}\n            AND before.op_id = ${opId}))` #1',
      ],
    },
    {
      reason:
        'Local builder in catalogue-reblob; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: const beforeImage = db\n    .insertInto('version_revision')\n    .columns([\n      'id',\n      'org_id',\n      'version_id',\n      'revision',\n      'blob_id',\n      'source_ref',\n      'metadata_json',\n      'reason',\n      'op_id',\n    ])\n    .expression(\n      db\n        .selectFrom('version')\n        .select([\n          sql<string>`${newOpId()}`.as('id'),\n          'version.org_id',\n          'version.id',\n          'version.revision',\n          'version.blob_id',\n          'version.source_ref',\n          'version.metadata_json',\n          sql<string>`${reason}`.as('reason'),\n          sql<string>`${opId}`.as('op_id'),\n        ])\n        .where(eligible),\n    ); #1",
        "db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: const replace = db\n    .updateTable('version')\n    .set({\n      blob_id: liveBlob,\n      revision: sql<number>`version.revision + 1`,\n      last_op_id: opId,\n    })\n    .where('version.id', '=', versionId)\n    .where('version.org_id', '=', ctx.orgId)\n    .where('version.revision', '=', expectedRevision)\n    .where(\n      sql<SqlBool>`EXISTS (SELECT 1 FROM version_revision AS before\n        WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}\n          AND before.revision = version.revision AND before.op_id = ${opId})`,\n    ); #1",
        "db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: const advance = db\n    .updateTable('package')\n    .set({\n      rev: sql<number>`package.rev + 1`,\n      modified_at: monotonicNow,\n    })\n    .where('package.org_id', '=', ctx.orgId)\n    .where(\n      sql<SqlBool>`EXISTS (SELECT 1 FROM version\n        WHERE version.package_id = package.id AND version.id = ${versionId}\n          AND version.org_id = ${ctx.orgId} AND version.last_op_id = ${opId})`,\n    ); #1",
        'db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: const statements = [\n    ...guard,\n    ...precheck,\n    compile(beforeImage),\n    compile(replace),\n    ...replaced,\n    compile(advance),\n  ]; #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: if (results.length !== statementCount) throw new TypeError('incomplete dist tag results'); #1",
        'db-sqlite/src/repositories/catalogue-reblob.ts:builder variable: return { changed: true, statements: statements.length }; #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-reconcile; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`strftime('%Y-%m-%dT%H:%M:%fZ', max(\n  unixepoch('now', 'subsec'),\n  unixepoch(package.modified_at, 'subsec') + 0.001\n), 'unixepoch')` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${sql.join(\n    parts.flatMap((part, i) =>\n      i < params.length ? [sql.raw(part), sql.val(params[i])] : [sql.raw(part)],\n    ),\n    sql``,\n  )}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM source WHERE source.id = ${id} AND source.org_id = ${ctx.orgId})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package WHERE package.id = ${id} AND package.org_id = ${ctx.orgId})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`source` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`package` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM ${table}\n    WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId} AND listing_open_stamp = ${stamp})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`source` #2',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`package` #2',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<string>`(SELECT listing_opened_at FROM ${table}\n    WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql` AND ${column} IN (SELECT value FROM json_each(${keys}))` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<number>`(SELECT count(*) FROM version\n        WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${id}\n          ${keyFilter(sql`version.version_normalized`)}\n          AND version.listing_seen_stamp = ${stamp})` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<number>`(SELECT count(*) FROM version\n    WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${packageId}\n      AND version.status = 'active' AND version.updated_at < ${boundary})` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE cache_epoch SET version = hex(randomblob(16))\n        WHERE org_id = ${ctx.orgId} AND ${condition}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`NOT (changes() <> 1 AND ${condition})` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`version.last_op_id = ${scope.opId}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`version.package_id = ${scope.packageId}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE blob SET refetchable = 0\n        WHERE blob.org_id = ${ctx.orgId} AND blob.refetchable = 1\n          AND blob.deleted_at IS NULL AND blob.purge_after IS NULL\n          AND NOT ${leaseLive('blob.purge_lease_until')}\n          AND blob.id IN (SELECT version.blob_id FROM version\n            WHERE version.org_id = ${ctx.orgId} AND version.status = 'removed_upstream'\n              AND version.blob_id IS NOT NULL AND ${inScope})` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`1 = 1` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`version.package_id = ${packageId}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`${packageFilter} AND version.org_id = ${ctx.orgId}\n    AND version.status = ${from} AND ${predicate}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`${packageFilter} AND version.org_id = ${ctx.orgId}\n          AND version.last_op_id = ${opId} AND version.status = 'active'` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`INSERT INTO version_revision\n          (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason, op_id)\n        SELECT lower(hex(randomblob(16))), version.org_id, version.id,\n          ${to === 'active' ? sql`version.revision - 1` : sql`version.revision`},\n          version.blob_id, version.source_ref, version.metadata_json, ${revisionReason}, ${opId}\n        FROM version WHERE ${revisionRows}` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE version SET status = 'active', removed_upstream_at = NULL,\n            revision = revision + 1, last_op_id = ${opId} WHERE ${rows}` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE version SET status = 'removed_upstream', removed_upstream_at = ${NOW},\n            revision = revision + 1, last_op_id = ${opId} WHERE ${rows}` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${seenRows(ctx, scope, stamp)} = ${count}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`package.org_id = ${ctx.orgId} AND package.source_id = ${id} AND ${predicate}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET status = 'removed_upstream', removed_upstream_at = coalesce(removed_upstream_at, ${NOW}),\n          removal_cause = 'source_listing',\n          last_op_id = CASE WHEN status = 'active' THEN ${opId} ELSE last_op_id END,\n          rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(unseen)}\n          RETURNING package.last_op_id = ${opId} AS newly_removed` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET status = 'active', removed_upstream_at = NULL,\n          removal_cause = NULL, last_op_id = ${opId},\n          rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(returned)}` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n        WHERE package.id = version.package_id AND package.org_id = ${ctx.orgId}\n          AND package.source_id = ${id} AND package.last_op_id = ${opId}\n          AND package.status = 'removed_upstream')` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n        JOIN source ON source.id = package.source_id AND source.org_id = package.org_id\n        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${id}\n          AND package.last_op_id = ${opId} AND source.removal_policy = 'exclude')` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`version.updated_at < ${boundary}` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`version.updated_at >= ${boundary}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${returned} AND ${leaseNotLive(ctx, 'version')}` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`package.status = 'removed_upstream'\n    AND package.removal_cause = 'document_absent'` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n        JOIN source ON source.id = package.source_id AND source.org_id = package.org_id\n        WHERE package.id = ${id} AND package.org_id = ${ctx.orgId}\n          AND source.removal_policy = 'exclude'\n          AND ((${packageRevival}) OR EXISTS (SELECT 1 FROM version\n            WHERE version.package_id = package.id AND version.org_id = package.org_id\n              AND version.last_op_id = ${opId})))` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET status = 'active', removed_upstream_at = NULL,\n      removal_cause = NULL, last_op_id = ${opId}\n      WHERE package.id = ${id} AND package.org_id = ${ctx.orgId} AND ${packageRevival}` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET rev = rev + 1, modified_at = ${CLOCK}\n      WHERE package.id = ${id} AND package.org_id = ${ctx.orgId}\n        AND (package.last_op_id = ${opId} OR EXISTS (SELECT 1 FROM version\n          WHERE version.package_id = package.id AND version.org_id = ${ctx.orgId}\n            AND version.last_op_id = ${opId}))` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET last_synced_at = ${NOW}\n        WHERE id = ${id} AND org_id = ${ctx.orgId}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`SELECT count(*) AS held FROM version\n      WHERE version.package_id = ${id} AND version.org_id = ${ctx.orgId}\n        AND version.status = 'removed_upstream' AND ${returned}` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`source` #3',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`package` #3',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE ${table} SET listing_opened_at = ${NOW}, listing_open_stamp =\n          strftime('%Y-%m-%dT%H:%M:%fZ', max(unixepoch('now', 'subsec'),\n            coalesce(unixepoch(listing_open_stamp, 'subsec') + 0.001, 0)), 'unixepoch')\n          WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId}\n          RETURNING listing_open_stamp AS stamp` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE version SET updated_at = max(updated_at, ${boundary}), listing_seen_stamp = ${stamp}\n              WHERE org_id = ${ctx.orgId} AND package_id = ${id} AND listing_seen_stamp IS NOT ${stamp}\n                AND version_normalized IN (SELECT value FROM json_each(${json}))` #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`${seenRows(ctx, scope, stamp, json)} = ${keys.length}` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`(EXISTS (SELECT 1 FROM upstream_state\n          WHERE upstream_state.package_id = ${packageId} AND upstream_state.org_id = ${ctx.orgId})\n        AND NOT EXISTS (SELECT 1 FROM upstream_state\n          WHERE upstream_state.package_id = ${packageId} AND upstream_state.org_id = ${ctx.orgId}\n            AND (upstream_state.not_found_count < ${ABSENCE_MIN_NOT_FOUND}\n              OR upstream_state.first_not_found_at IS NULL\n              OR upstream_state.first_not_found_at >\n                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${String(sinceSeconds)} seconds`}))))` #1",
        'db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package WHERE package.id = ${packageId}\n          AND package.org_id = ${ctx.orgId} AND package.last_op_id = ${opId})` #1',
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql`UPDATE package SET status = 'removed_upstream',\n            removed_upstream_at = coalesce(removed_upstream_at, ${NOW}),\n            removal_cause = CASE WHEN status = 'active' THEN 'document_absent' ELSE removal_cause END,\n            last_op_id = ${opId},\n            rev = rev + 1, modified_at = ${CLOCK}\n            WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}\n              AND package.last_op_id = ${decisionId}\n              AND (package.status = 'active' OR EXISTS (SELECT 1 FROM version\n                WHERE version.package_id = package.id AND version.org_id = ${ctx.orgId}\n                  AND version.status = 'active'))` #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n          JOIN source ON source.id = package.source_id AND source.org_id = package.org_id\n          WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}\n            AND package.last_op_id = ${opId} AND source.removal_policy = 'exclude')` #1",
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[results.length - 1] #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[updateIndex] #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[leaseHeldBackIndex] #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[removalIndex] #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[restorationIndex] #1',
        'db-sqlite/src/repositories/catalogue-reconcile.ts:unresolved computed access: results[flip] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in catalogue-status; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/catalogue-status.ts:unresolved computed access: lease.params[index] #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-write-dist; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/catalogue-write-dist.ts:SQL template: sql<string>`(SELECT blob.id FROM blob\n    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${sha256} AND blob.deleted_at IS NULL\n      AND ${fence})` #1',
        "db-sqlite/src/repositories/catalogue-write-dist.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM version\n      WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}\n        AND version.revision = ${revision} AND version.status <> 'tombstoned'\n        AND version.blob_id = ${liveBlob})` #1",
      ],
    },
    {
      reason:
        'Local builder in catalogue-write-dist; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-dist.ts:builder variable: const attach = db\n    .updateTable('version')\n    .set({ blob_id: liveBlob, last_op_id: opId })\n    .where('version.id', '=', versionId)\n    .where('version.org_id', '=', ctx.orgId)\n    .where('version.revision', '=', revision)\n    .where('version.status', '<>', 'tombstoned')\n    .where(sql<SqlBool>`${liveBlob} IS NOT NULL`)\n    .where('version.blob_id', 'is', null); #1",
        "db-sqlite/src/repositories/catalogue-write-dist.ts:builder variable: const advance = db\n    .updateTable('package')\n    .set({\n      rev: sql<number>`package.rev + 1`,\n      modified_at: monotonicNow,\n    })\n    .where('package.org_id', '=', ctx.orgId)\n    .where(\n      sql<SqlBool>`EXISTS (SELECT 1 FROM version\n        WHERE version.package_id = package.id AND version.id = ${versionId}\n          AND version.last_op_id = ${opId})`,\n    ); #1",
        'db-sqlite/src/repositories/catalogue-write-dist.ts:builder variable: const statements = [...guard, compile(attach), ...attached, compile(advance)]; #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: if (results.length !== statementCount) throw new TypeError('incomplete dist tag results'); #1",
        'db-sqlite/src/repositories/catalogue-write-dist.ts:builder variable: return {\n        changed: (results[attachIndex]?.changes ?? 0) > 0,\n        statements: statements.length,\n      }; #1',
      ],
    },
    {
      reason:
        'Local builder in catalogue-write-package; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-package.ts:builder variable: const create = db\n    .insertInto('package')\n    .columns([\n      'id',\n      'org_id',\n      'source_id',\n      'ecosystem',\n      'name',\n      'description',\n      'visible_to_new_projects',\n    ])\n    .expression(\n      db\n        .selectFrom('source')\n        .select([\n          sql<string>`${candidateId}`.as('id'),\n          'source.org_id',\n          'source.id',\n          'source.ecosystem',\n          sql<string>`${key}`.as('name'),\n          sql<string | null>`${description}`.as('description'),\n          'source.default_visible_to_new_projects',\n        ])\n        .where('source.id', '=', sourceId)\n        .where('source.org_id', '=', ctx.orgId)\n        .where('source.ecosystem', '=', ecosystem),\n    )\n    .onConflict((oc) => oc.columns(['org_id', 'ecosystem', 'source_id', 'name']).doNothing()); #1",
        "db-sqlite/src/repositories/catalogue-write-package.ts:builder variable: const describe = db\n    .updateTable('package')\n    .set({\n      description,\n      rev: sql<number>`package.rev + 1`,\n      modified_at: monotonicNow,\n    })\n    .where('package.org_id', '=', ctx.orgId)\n    .where('package.ecosystem', '=', ecosystem)\n    .where('package.source_id', '=', sourceId)\n    .where('package.name', '=', key)\n    .where(sql<SqlBool>`package.description is not ${description}`); #1",
        "db-sqlite/src/repositories/catalogue-write-package.ts:builder variable: return {\n    candidateId,\n    statements: [\n      ...guard,\n      ...sourceMatches,\n      compile(create),\n      compile(describe),\n      ...rederiveStatements(ctx, { kind: 'package', packageId: candidateId }),\n    ],\n  }; #1",
      ],
    },
    {
      reason:
        'SQL in catalogue-write-package; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/catalogue-write-package.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM source\n      WHERE source.id = ${sourceId} AND source.org_id = ${ctx.orgId}\n        AND source.ecosystem = ${ecosystem})` #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-write-tags; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n      WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}\n        AND package.ecosystem = 'npm')` #1",
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`${targetOf(target)} IS NOT NULL` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`${tag}` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`${targetOf(target)} IS NULL` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`${newOpId()}` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`${tag}` #2',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string | null>`(SELECT dist_tag.version_id FROM dist_tag\n                  WHERE dist_tag.package_id = version.package_id AND dist_tag.org_id = ${ctx.orgId}\n                    AND dist_tag.tag = ${tag})` #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`'set'` #1",
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`${actorType}` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string | null>`${actorId}` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<string>`${opId}` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`NOT EXISTS (SELECT 1 FROM dist_tag AS collision\n                  WHERE collision.package_id = version.package_id AND collision.tag = ${tag}\n                    AND collision.org_id <> ${ctx.orgId})` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`NOT EXISTS (SELECT 1 FROM dist_tag\n                  WHERE dist_tag.package_id = version.package_id AND dist_tag.org_id = ${ctx.orgId}\n                    AND dist_tag.tag = ${tag} AND dist_tag.version_id = version.id)` #1',
        'db-sqlite/src/repositories/catalogue-write-tags.ts:SQL template: sql<boolean>`dist_tag.package_id = ${packageId} AND dist_tag.org_id = ${ctx.orgId}\n    AND dist_tag.tag NOT IN (SELECT value FROM json_each(${keep}))` #1',
      ],
    },
    {
      reason:
        'Object introspection in catalogue-write-tags; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/repositories/catalogue-write-tags.ts:opaque object access: Object.entries(request.tags) #1',
      ],
    },
    {
      reason:
        'Conflict action in catalogue-write-tags; retained verbatim so a later action or callback change requires review.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-tags.ts:conflict action: db\n          .insertInto('dist_tag')\n          .columns(['org_id', 'package_id', 'tag', 'version_id'])\n          .expression(\n            db\n              .selectFrom('version')\n              .select([\n                'version.org_id',\n                'version.package_id',\n                sql<string>`${tag}`.as('tag'),\n                'version.id',\n              ])\n              .where('version.id', '=', targetOf(target)),\n          )\n          .onConflict((oc) =>\n            oc\n              .columns(['package_id', 'tag'])\n              .doUpdateSet({ version_id: sql<string>`excluded.version_id`, updated_at: NOW })\n              .where(\n                sql<boolean>`dist_tag.org_id = ${ctx.orgId} AND dist_tag.version_id IS NOT excluded.version_id`,\n              ),\n          ) #1",
      ],
    },
    {
      reason:
        'Local builder in catalogue-write-tags; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: const removeHistory = compile(\n    db\n      .insertInto('dist_tag_history')\n      .columns([\n        'id',\n        'org_id',\n        'package_id',\n        'tag',\n        'version_id',\n        'previous_version_id',\n        'action',\n        'actor_type',\n        'actor_id',\n        'op_id',\n      ])\n      .expression(\n        db\n          .selectFrom('dist_tag')\n          .select([\n            // One statement removes many rows: share the ULID time prefix, generate 64 random bits per row.\n            sql<string>`${newOpId().slice(0, 10)} || upper(hex(randomblob(8)))`.as('id'),\n            'dist_tag.org_id',\n            'dist_tag.package_id',\n            'dist_tag.tag',\n            sql<string | null>`NULL`.as('version_id'),\n            'dist_tag.version_id',\n            sql<string>`'remove'`.as('action'),\n            sql<string>`${actorType}`.as('actor_type'),\n            sql<string | null>`${actorId}`.as('actor_id'),\n            sql<string>`${opId}`.as('op_id'),\n          ])\n          .where(absent),\n      ),\n  ); #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: const remove = compile(db.deleteFrom('dist_tag').where(absent)); #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: const advance = compile(\n    db\n      .updateTable('package')\n      .set({\n        rev: sql<number>`package.rev + 1`,\n        modified_at: monotonicNow,\n      })\n      .where('package.id', '=', packageId)\n      .where('package.org_id', '=', ctx.orgId)\n      .where(\n        sql<boolean>`EXISTS (SELECT 1 FROM dist_tag_history\n          WHERE dist_tag_history.package_id = package.id AND dist_tag_history.op_id = ${opId})`,\n      ),\n  ); #1",
        'db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: const statementCount = groups.reduce((sum, group) => sum + group.length, 0); #1',
        "db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: if (results.length !== statementCount) throw new TypeError('incomplete dist tag results'); #1",
        'db-sqlite/src/repositories/catalogue-write-tags.ts:builder variable: return {\n        packageId,\n        inserted: 0,\n        updated: setChanges + removed,\n        unchanged: valid.length - (skipped.length - badGrammar.length) - setChanges,\n        conflicts: [],\n        refused: [],\n        skippedTags: skipped,\n        statements: statementCount,\n      }; #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/catalogue-write-tags.ts:unresolved computed access: results[setOffset + sets.length] #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-write-version-insert; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:SQL text: 'incomplete version insert results' #1",
        'db-sqlite/src/repositories/catalogue-write-version-insert.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n      WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}\n        AND package.ecosystem = ${ecosystem})` #1',
        'db-sqlite/src/repositories/catalogue-write-version-insert.ts:SQL template: sql<boolean>`NOT EXISTS (SELECT 1 FROM package\n      WHERE package.id = ${packageId} AND package.last_synced_at IS NULL\n        AND ${latestHistory} > ${NOW})` #1',
      ],
    },
    {
      reason:
        'Local builder in catalogue-write-version-insert; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: const inserts = accepted.map(({ input, stability }) =>\n    compile(\n      db\n        .insertInto('version')\n        .columns([\n          'id',\n          'org_id',\n          'package_id',\n          'version',\n          'version_normalized',\n          'stability',\n          'published_at',\n          'published_at_basis',\n          'upstream_released_at',\n          'license',\n          'dist_type',\n          'composer_shasum',\n          'npm_integrity',\n          'source_ref',\n          'metadata_json',\n          'deprecated_message',\n          'last_op_id',\n        ])\n        .expression(\n          db\n            .selectFrom('package')\n            .select([\n              sql<string>`${newOpId()}`.as('id'),\n              'package.org_id',\n              'package.id',\n              sql<string>`${input.version}`.as('version'),\n              sql<string>`${input.versionNormalized}`.as('version_normalized'),\n              sql<string>`${stability}`.as('stability'),\n              sql<string>`CASE WHEN package.last_synced_at IS NULL THEN ${input.history.at} ELSE ${NOW} END`.as(\n                'published_at',\n              ),\n              sql<string>`CASE WHEN package.last_synced_at IS NULL THEN ${input.history.basis} ELSE 'broker' END`.as(\n                'published_at_basis',\n              ),\n              sql<string | null>`${input.upstreamReleasedAt}`.as('upstream_released_at'),\n              sql<string | null>`${input.license}`.as('license'),\n              sql<string | null>`${input.distType}`.as('dist_type'),\n              sql<string | null>`${input.metadata.composerShasum}`.as('composer_shasum'),\n              sql<string | null>`${input.metadata.npmIntegrity}`.as('npm_integrity'),\n              sql<string | null>`${input.sourceRef}`.as('source_ref'),\n              sql<string>`${input.metadata.json}`.as('metadata_json'),\n              sql<string | null>`${input.metadata.deprecatedMessage}`.as('deprecated_message'),\n              sql<string>`${opId}`.as('last_op_id'),\n            ])\n            .where('package.id', '=', packageId)\n            .where('package.org_id', '=', ctx.orgId),\n        )\n        .onConflict((oc) => oc.columns(['package_id', 'version_normalized']).doNothing()),\n    ),\n  ); #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: const advance = db\n    .updateTable('package')\n    .set({\n      rev: sql<number>`package.rev + 1`,\n      modified_at: monotonicNow,\n    })\n    .where('package.id', '=', packageId)\n    .where('package.org_id', '=', ctx.orgId)\n    .where(\n      sql<boolean>`EXISTS (SELECT 1 FROM version\n        WHERE +version.package_id = package.id AND version.last_op_id = ${opId})`,\n    ); #1",
        'db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: const statements = [\n    ...guard,\n    ...packageMatches,\n    ...historyNotFuture,\n    ...inserts,\n    compile(advance),\n  ]; #1',
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: const bytes = statements\n    .flatMap((statement) => statement.params)\n    .reduce<number>(\n      (total, value) =>\n        total +\n        (typeof value === 'string'\n          ? ENCODER.encode(value).length\n          : value instanceof Uint8Array\n            ? value.byteLength\n            : value === null\n              ? 0\n              : 8),\n      0,\n    ); #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: if (bytes > MAX_BATCH_PARAMETER_BYTES) {\n    throw Object.assign(new RangeError('batch parameter payload exceeds 4 MiB'), {\n      code: 'batch_too_large' as const,\n    });\n  } #1",
        'db-sqlite/src/repositories/catalogue-write-version-insert.ts:builder variable: return plan(statements, guard.length + packageMatches.length + historyNotFuture.length); #1',
      ],
    },
    {
      reason:
        'SQL in catalogue-write-version-update; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL text: 'incomplete version update results' #1",
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package\n        WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}\n          AND package.ecosystem = ${ecosystem})` #1',
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<number>`package.rev + 1` #1',
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(\n            accepted.map((input) => ({\n              version: input.versionNormalized,\n              metadata: input.metadata.json,\n              sourceRef: input.sourceRef,\n              distType: input.distType,\n              license: input.license,\n              deprecated: input.metadata.deprecatedMessage,\n              upstream: input.upstreamReleasedAt,\n            })),\n          )}) AS incoming CROSS JOIN version\n            WHERE version.version_normalized = json_extract(incoming.value, '$.version')\n              AND version.package_id = package.id AND version.org_id = ${ctx.orgId}\n              AND version.status <> 'tombstoned'\n              AND (version.deprecated_message IS NOT json_extract(incoming.value, '$.deprecated')\n                OR version.upstream_released_at IS NOT json_extract(incoming.value, '$.upstream')\n                OR (${ecosystem} = 'composer' AND (\n                  version.metadata_json IS NOT json_extract(incoming.value, '$.metadata')\n                  OR version.source_ref IS NOT json_extract(incoming.value, '$.sourceRef')\n                  OR version.dist_type IS NOT json_extract(incoming.value, '$.distType')\n                  OR version.license IS NOT json_extract(incoming.value, '$.license')))))` #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`version.package_id = ${packageId} AND version.org_id = ${ctx.orgId}\n      AND version.version_normalized = ${input.versionNormalized}\n      AND version.status <> 'tombstoned'` #1",
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`(version.deprecated_message IS NOT ${metadata.deprecatedMessage}\n      OR version.upstream_released_at IS NOT ${input.upstreamReleasedAt})` #1',
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<string>`${newOpId()}` #1',
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<string>`'upstream_change'` #1",
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<string>`${opId}` #1',
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`(version.metadata_json IS NOT ${metadata.json}\n                    OR version.source_ref IS NOT ${input.sourceRef}\n                    OR version.dist_type IS NOT ${input.distType}\n                    OR version.license IS NOT ${input.license})` #1',
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<string | null>`CASE\n                WHEN version.dist_type IS NOT ${input.distType}\n                  OR version.composer_shasum IS NOT ${metadata.composerShasum}\n                  OR json_extract(version.metadata_json, '$.dist') IS NOT json_extract(${metadata.json}, '$.dist')\n                  OR (${metadata.composerShasum} IS NULL AND version.source_ref IS NOT ${input.sourceRef})\n                THEN NULL ELSE version.blob_id END` #1",
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<number>`version.revision + 1` #1',
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM version_revision AS before\n                WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}\n                  AND before.revision = version.revision\n                  AND before.op_id = ${opId})` #1',
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:SQL template: sql<boolean>`(version.metadata_json IS NOT ${metadata.json}\n                OR version.npm_integrity IS NOT ${metadata.npmIntegrity})` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in catalogue-write-version-update; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/catalogue-write-version-update.ts:unresolved computed access: roles[index] #1',
      ],
    },
    {
      reason:
        'Local builder in catalogue-write-version-update; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:builder variable: const inPlace = db\n      .updateTable('version')\n      .set({\n        deprecated_message: metadata.deprecatedMessage,\n        upstream_released_at: input.upstreamReleasedAt,\n        last_op_id: opId,\n      })\n      .where(slot)\n      .where(deprecationDiffers); #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:builder variable: push('inplace', compile(inPlace)); #1",
      ],
    },
    {
      reason:
        'Object introspection in catalogue-write-version-update; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque object access: Object.assign(new RangeError('batch parameter payload exceeds 4 MiB'), {\n      code: 'batch_too_large' as const,\n    }) #1",
      ],
    },
    {
      reason:
        'Indexes domain data in catalogue-writer; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/catalogue-writer.ts:unresolved computed access: statement.params[index++] #1',
        'db-sqlite/src/repositories/catalogue-writer.ts:unresolved computed access: planned[i] #1',
        'db-sqlite/src/repositories/catalogue-writer.ts:unresolved computed access: lease.params[index] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/catalogue-writer.ts:unresolved computed access: results[offset++] #1',
      ],
    },
    {
      reason:
        'SQL in closure-edges; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`pp.org_id = ${ctx.orgId} and pkg.org_id = ${ctx.orgId}\n    and src.org_id = ${ctx.orgId} and ps.org_id = ${ctx.orgId}\n    and ${attachedSourceCondition(ctx, col('pp.project_id'), col('pkg.source_id'), col('pkg.ecosystem'))}` #1",
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`from project_package as pp\n    join package as pkg on pkg.id = pp.package_id\n    join source as src on src.id = pkg.source_id\n    join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`from project_package as pp indexed by project_package_name\n    cross join package as pkg on pkg.id = pp.package_id\n    cross join source as src on src.id = pkg.source_id\n    cross join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`1 = 1` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`pp.ecosystem = ${ecosystem} and pp.name = ${pageKey}` #1',
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`select pkg.name as key, pkg.id as package_id, pkg.source_id, src.type as source_type,\n    src.removal_policy,\n    row_number() over (partition by pkg.name order by ${sql.join(winnerOrder({ source: 'src', attachment: 'ps' }))}) as rn\n  ${from}\n  where ${nameScope} and pp.project_id = ${projectId} and pkg.ecosystem = ${ecosystem} and ${filter}\n    and ${visibleRowsCondition(ctx, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}` #1",
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`case when json_type(v.metadata_json, '$.require') in ('object', 'array')\n      then json_extract(v.metadata_json, '$.require') else null end` #1",
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`json_extract(v.metadata_json, ${`$.${field}`})` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`${extract(field)} is null` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql` and ` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`${field}, ${extract(field)}` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`case when ${absent} then null else json_object(${members}) end` #1',
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`input as (select ${list.json} as keys), k as (\n  select cast(j.key as integer) as idx, j.value as name,\n    ${ctx.orgId} as org_id, ${ecosystem} as ecosystem\n  from input, json_each(input.keys) as j\n  where (select count(*) from input, json_each(input.keys)) = ${list.count}\n)` #1',
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`exists (\n  select 1 from project as pj\n  where pj.id = pp.project_id and pj.org_id = ${ctx.orgId} and pj.status = 'active'\n)` #1",
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`kp.used + (json_extract(kp.batch, '$.id') is not null)` #1",
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`null` #1',
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`case when json_extract(kp.batch, '$.key') = ${after.requirerKey} then ${after.versionId} else null end` #1",
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`coalesce(json_extract(kp.batch, '$.id'), ${firstVersion})` #1",
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`with recursive key_page as materialized (\n  select json_object('mode', 'edge') as batch, 0 as used\n  union all\n  select case\n    when json_extract(kp.batch, '$.mode') = 'edge' and json_extract(kp.batch, '$.id') is null then (\n      select json_object('key', nk.name, 'mode', 'versions', 'winner', json((\n        select json_object('package_id', w.package_id, 'removal_policy', w.removal_policy)\n        from (${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name = nk.name`, sql`nk.name`)}) as w\n        where w.rn = 1\n      )))\n      from (\n        select pp.name from project_package as pp indexed by project_package_name\n        where pp.org_id = ${ctx.orgId} and pp.project_id = ${query.projectId}\n          and pp.ecosystem = ${query.ecosystem}\n          and pp.name >= coalesce(json_extract(kp.batch, '$.key'), ${after?.requirerKey ?? ''})\n          and (json_extract(kp.batch, '$.key') is null or pp.name > json_extract(kp.batch, '$.key'))\n        group by pp.name\n        order by pp.name\n        limit 1\n      ) as nk\n    )\n    else json_set(kp.batch, '$.mode', 'edge', '$.id', (\n      select ev.id from version as ev indexed by version_package_id\n      where ev.package_id = json_extract(kp.batch, '$.winner.package_id') and ev.org_id = ${ctx.orgId}\n        and ev.id >= coalesce(${versionAfter}, '')\n        and (${versionAfter} is null or ev.id > ${versionAfter})\n        and (ev.status = 'active' or (ev.status = 'removed_upstream' and json_extract(kp.batch, '$.winner.removal_policy') = 'flag'))\n      order by ev.id\n      limit 1\n    ))\n  end, ${consumed}\n  from key_page as kp\n  where kp.batch is not null and ${consumed} < ${limit + 1}\n), edge_page as materialized (\n  select json_extract(kp.batch, '$.key') as requirer_key, json_extract(kp.batch, '$.id') as version_id\n  from key_page as kp\n  where json_extract(kp.batch, '$.id') is not null\n)\nselect edge_page.requirer_key, edge_page.version_id, v.version,\n  ${depsExpression(query.ecosystem)} as deps\nfrom edge_page\njoin version as v on v.id = edge_page.version_id and v.org_id = ${ctx.orgId}\norder by edge_page.requirer_key, edge_page.version_id` #1",
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`with ${keyTable(ctx, query.ecosystem, list)}\nselect k.idx,\n  exists ${admittedProxySources(ctx, query.projectId, query.ecosystem, 'k')} as admissible,\n  exists (\n    select 1 from package as hp indexed by package_by_name\n    join source as hs on hs.id = hp.source_id\n    where hp.org_id = ${ctx.orgId} and hp.ecosystem = ${query.ecosystem} and hp.name = k.name\n      and hs.org_id = ${ctx.orgId} and hs.ecosystem = ${query.ecosystem}\n      and hs.project_id is null and hs.type not in ('packagist_proxy', 'npmjs_proxy')\n      and ${admissionCondition(ctx, sql`${query.projectId}`, col('hp.source_id'), col('hp.name'), col('hp.visible_to_new_projects'))}\n      and (hp.status = 'active' or (hp.status = 'removed_upstream' and hs.removal_policy = 'flag'))\n      and exists (select 1 from project as pj\n        where pj.id = ${query.projectId} and pj.org_id = ${ctx.orgId} and pj.status = 'active')\n  ) as attachable\nfrom k\norder by k.idx` #1",
        'db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`with ${keyTable(ctx, query.ecosystem, list)},\nc as (${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name in (select name from k)`)})\nselect k.idx, c.source_id, c.source_type\nfrom k\nleft join c on c.key = k.name and c.rn = 1\norder by k.idx` #1',
        "db-sqlite/src/repositories/closure-edges.ts:SQL template: sql`select pkg.id as package_id, src.id as source_id, src.type as source_type,\n  src.project_id is not null as project_level, ps.precedence,\n  (${readTimeCondition(ctx, col('pp.project_id'), { package: 'pkg', source: 'src' })}\n    and ${proxyEligibleCondition({ package: 'pkg', source: 'src' })}) as eligible\n${visibleFrom()}\nwhere pp.project_id = ${query.projectId} and pkg.ecosystem = ${query.ecosystem}\n  and pkg.name = ${query.key} and ${orgScope(ctx)} and ${projectActiveCondition(ctx)}\norder by ${sql.join(winnerOrder({ source: 'src', attachment: 'ps' }))}` #1",
      ],
    },
    {
      reason:
        'Indexes domain data in closure-edges; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/closure-edges.ts:unresolved computed access: query.keys[row.idx] #1',
        'db-sqlite/src/repositories/closure-edges.ts:unresolved computed access: query.keys[row.idx] #2',
      ],
    },
    {
      reason:
        'Local builder in credential; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/credential.ts:builder variable: const rows = await run<{ readonly id: string }>(\n        executor,\n        db\n          .updateTable('credential')\n          .set({\n            ciphertext: sealed.ciphertext,\n            nonce: sealed.nonce,\n            key_version: nextVersion,\n            rotated_at: now,\n            updated_at: now,\n          })\n          .where('org_id', '=', ctx.orgId)\n          .where('id', '=', id)\n          .where('key_version', '=', expectedVersion)\n          .returning('id'),\n      ); #1",
        'db-sqlite/src/repositories/credential.ts:builder variable: return rows.length > 0; #1',
        "db-sqlite/src/repositories/credential.ts:builder variable: const rows = await run<{ readonly id: string }>(\n        executor,\n        db\n          .deleteFrom('credential')\n          .where('org_id', '=', ctx.orgId)\n          .where('id', '=', id)\n          .returning('id'),\n      ); #1",
        'db-sqlite/src/repositories/credential.ts:builder variable: return rows.length > 0; #2',
      ],
    },
    {
      reason:
        'SQL in fetch-lease; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/fetch-lease.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM fetch_lease\n      WHERE fetch_lease.lease_key = ${leaseKeyValue} AND fetch_lease.org_id = ${ctx.orgId}\n        AND fetch_lease.owner = ${holder} AND fetch_lease.fence = ${generation}\n        AND fetch_lease.lease_until > ${NOW})` #1',
      ],
    },
    {
      reason:
        'Local builder in fetch-lease; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/fetch-lease.ts:builder variable: const collect = compile(\n        db.deleteFrom('fetch_lease').where(\n          'lease_key',\n          'in',\n          db\n            .selectFrom('fetch_lease')\n            .select('lease_key')\n            .where('org_id', '=', ctx.orgId)\n            .where('lease_key', '<>', k)\n            .where('lease_until', '<', sql<string>`strftime('${sql.raw(FORMAT)}','now','-1 hour')`)\n            .orderBy('lease_until')\n            .limit(FETCH_LEASE_GC_LIMIT),\n        ),\n      ); #1",
        "db-sqlite/src/repositories/fetch-lease.ts:builder variable: const acquire = compile(\n        db\n          .insertInto('fetch_lease')\n          .values({\n            org_id: ctx.orgId,\n            lease_key: k,\n            owner: o,\n            fence: 1,\n            lease_until: until(duration),\n            acquired_at: NOW as never,\n          })\n          .onConflict((conflict) =>\n            conflict\n              .column('lease_key')\n              .doUpdateSet({\n                owner: o,\n                fence: sql<number>`fetch_lease.fence + 1`,\n                lease_until: until(duration),\n                acquired_at: NOW as never,\n              })\n              .where(\n                sql<boolean>`fetch_lease.lease_until <= ${NOW} AND fetch_lease.org_id = excluded.org_id`,\n              ),\n          )\n          .returning(['owner', 'fence']),\n      ); #1",
        'db-sqlite/src/repositories/fetch-lease.ts:builder variable: const [, result] = await executor.batch([collect, acquire]); #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/grant.ts:unresolved computed access: outcome.results[updateAt] #1',
        'db-sqlite/src/repositories/grant.ts:unresolved computed access: outcome.results[updateAt] #2',
      ],
    },
    {
      reason:
        'SQL in idempotency; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/idempotency.ts:SQL template: sql<SqlBool>`0` #1',
        'db-sqlite/src/repositories/idempotency.ts:SQL template: sql<SqlBool>`exists (select 1 from api_idempotency where org_id = ${ctx.orgId}\n        and principal_key = ${record.principalKey} and key = ${record.key}\n        and expires_at > ${record.createdAt})` #1',
        "db-sqlite/src/repositories/idempotency.ts:SQL input: sql: `INSERT INTO api_idempotency\n      (rowid, org_id, principal_key, key, route, request_hash, status, response_json, created_at, expires_at)\n      SELECT live.id, ?,\n        CASE WHEN live.id IS NULL THEN ? WHEN ? = '_' THEN '__' ELSE '_' END,\n        ?, ?, ?, ?, ?, ?, ?\n      FROM (SELECT (SELECT rowid FROM api_idempotency\n        WHERE org_id = ? AND principal_key = ? AND key = ? AND expires_at > ?) AS id) AS live\n      WHERE ${conditions.join(' AND ')}\n      ON CONFLICT (org_id, principal_key, key) DO UPDATE SET\n        route = excluded.route,\n        request_hash = excluded.request_hash,\n        status = excluded.status,\n        response_json = excluded.response_json,\n        created_at = excluded.created_at,\n        expires_at = excluded.expires_at\n      WHERE api_idempotency.expires_at <= excluded.created_at` #1",
        'db-sqlite/src/repositories/idempotency.ts:SQL input: sql: `SELECT principal_key AS principalKey, key, route, request_hash AS requestHash,\n          status, response_json AS responseJson, created_at AS createdAt, expires_at AS expiresAt\n          FROM api_idempotency\n          WHERE org_id = ? AND principal_key = ? AND key = ? AND expires_at > ?` #1',
        'db-sqlite/src/repositories/idempotency.ts:SQL input: sql: `DELETE FROM api_idempotency WHERE org_id = ? AND (principal_key, key) IN (\n          SELECT principal_key, key FROM api_idempotency\n          WHERE org_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?\n        )` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in import-journal; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: query.params[index] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: domain[key] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: ENTITY[item.type] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: row[column] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: fence.expected[String(entityId)] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: row[column] #2',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: ENTITY[item.type] #2',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: ENTITY[item.type] #3',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: input.auditProjects[index] #1',
        'db-sqlite/src/repositories/import-journal.ts:unresolved computed access: input.audits[index] #1',
      ],
    },
    {
      reason:
        'Object introspection in import-journal; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/repositories/import-journal.ts:opaque object access: Object.values(values) #1',
        'db-sqlite/src/repositories/import-journal.ts:opaque object access: Object.entries(ENTITY) #1',
      ],
    },
    {
      reason:
        'Indexes domain data in import-rollback; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: ROLLBACK_ENTITIES[type] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: guard.values[column] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: action.domain[column] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: values[blobIndex] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: targets[index] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: row[column] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: domain[column] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: row[column] #2',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: values[column] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: row[column] #3',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: states[index] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: fence.expected[action.entityId] #1',
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: input.actions[index] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/import-rollback.ts:unresolved computed access: outcome.results[cursor + entry.decided] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in import-verification; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/import-verification.ts:unresolved computed access: ROLLBACK_ENTITIES[type] #1',
        'db-sqlite/src/repositories/import-verification.ts:unresolved computed access: row[key] #1',
        'db-sqlite/src/repositories/import-verification.ts:unresolved computed access: ENTITY[item.type] #1',
        'db-sqlite/src/repositories/import-verification.ts:unresolved computed access: ROLLBACK_ENTITIES[type] #2',
        'db-sqlite/src/repositories/import-verification.ts:unresolved computed access: row[key] #2',
      ],
    },
    {
      reason:
        'SQL in ingest-finalize; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<number>`(SELECT count(*) FROM version\n        WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${scope.packageId}\n          AND version.listing_seen_stamp = ${stamp})` #1',
        "db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`UPDATE ingest_session SET state = 'complete', updated_at = ${NOW}\n        WHERE id = ${session.id} AND org_id = ${ctx.orgId} AND owner = ${session.owner}\n          AND fence = ${session.fence} AND state = 'running'` #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM ingest_session\n        WHERE id = ${session.id} AND org_id = ${ctx.orgId} AND state = 'complete')` #1",
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`lease_until > ${NOW}` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM source WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId} AND listing_open_stamp = ${stamp})` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM package WHERE org_id = ${ctx.orgId} AND id = ${scope.packageId} AND listing_open_stamp = ${stamp})` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<boolean>`${markedRows(ctx, scope, stamp)} = 0` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`source` #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql`package` #1',
        "db-sqlite/src/repositories/ingest-finalize.ts:SQL template: sql<number>`(EXISTS (SELECT 1 FROM ingest_session\n                    WHERE id = ${session.id} AND org_id = ${ctx.orgId} AND owner = ${session.owner}\n                      AND fence = ${session.fence} AND state = 'running' AND lease_until > ${NOW})\n                    AND EXISTS (SELECT 1 FROM ${table}\n                      WHERE id = ${scopeId} AND org_id = ${ctx.orgId}\n                        AND listing_open_stamp = ${stamp}))` #1",
      ],
    },
    {
      reason:
        'Object introspection in ingest-finalize; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque object access: Object.entries(parsePendingValidators(JSON.parse(row.pending_validators ?? '{}'))) #1",
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/ingest-finalize.ts:unresolved computed access: results[leaseHeldBackIndex] #1',
        'db-sqlite/src/repositories/ingest-finalize.ts:unresolved computed access: results[index] #1',
      ],
    },
    {
      reason:
        'SQL in ingest-session; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<boolean>`ingest_session.id = ${id} AND ingest_session.org_id = ${ctx.orgId}\n    AND ingest_session.owner = ${owner} AND ingest_session.fence = ${fence}\n    AND ingest_session.state = 'running' AND ingest_session.lease_until > ${NOW}` #1",
        'db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM ingest_session WHERE ${holds(ctx, handle)})` #1',
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<boolean>`(EXISTS (SELECT 1 FROM ingest_session AS newer\n              WHERE newer.org_id = old.org_id AND newer.scope_key = old.scope_key\n                AND newer.generation > old.generation)\n              OR (old.state = 'abandoned' AND old.stamp IS NULL))` #1",
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<string>`strftime('${sql.raw(FORMAT)}','now')` #1",
        "db-sqlite/src/repositories/ingest-session.ts:SQL template: sql<string>`strftime('${sql.raw(FORMAT)}','now', ${`-${String(INGEST_SESSION_DEAD_DAYS)} days`})` #1",
      ],
    },
    {
      reason:
        'Local builder in ingest-session; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/ingest-session.ts:builder variable: const acquire = compile(\n        db\n          .insertInto('ingest_session')\n          .columns([\n            'id',\n            'org_id',\n            'scope',\n            'scope_key',\n            'source_id',\n            'package_key',\n            'generation',\n            'owner',\n            'fence',\n            'lease_until',\n            'state',\n            'started_at',\n            'updated_at',\n          ])\n          .expression(\n            db\n              .selectFrom('source')\n              .select([\n                sql<string>`${ulid()}`.as('id'),\n                'source.org_id',\n                sql<string>`${scope.scope}`.as('scope'),\n                sql<string>`${scopeKey}`.as('scope_key'),\n                sql<string>`${sourceId}`.as('source_id'),\n                sql<string | null>`${packageKey}`.as('package_key'),\n                sql<number>`(SELECT COALESCE(MAX(prior.generation), 0) + 1 FROM ingest_session AS prior\n                  WHERE prior.org_id = ${ctx.orgId} AND prior.scope_key = ${scopeKey})`.as(\n                  'generation',\n                ),\n                sql<string>`${o}`.as('owner'),\n                sql<number>`1`.as('fence'),\n                until(duration).as('lease_until'),\n                sql<'running'>`'running'`.as('state'),\n                sql<string>`${NOW}`.as('started_at'),\n                sql<string>`${NOW}`.as('updated_at'),\n              ])\n              .where('source.id', '=', sourceId)\n              .where('source.org_id', '=', ctx.orgId),\n          )\n          .onConflict((conflict) =>\n            conflict\n              .columns(['org_id', 'scope_key'])\n              .where(sql<boolean>`state = 'running'`)\n              .doUpdateSet({\n                owner: o,\n                fence: sql<number>`ingest_session.fence + 1`,\n                lease_until: until(duration),\n                updated_at: NOW as never,\n              })\n              .where(sql<boolean>`ingest_session.lease_until <= ${NOW}`),\n          )\n          .returning([\n            'id',\n            'scope_key',\n            'owner',\n            'fence',\n            'generation',\n            'stamp',\n            'snapshot_id',\n            'snapshot_blob_sha256',\n            'cursor',\n            'seen_count',\n            'pages_so_far',\n            'pending_validators',\n          ]),\n      ); #1",
        "db-sqlite/src/repositories/ingest-session.ts:builder variable: const collect = compile(\n        db.deleteFrom('ingest_session').where(\n          'id',\n          'in',\n          db\n            .selectFrom('ingest_session as old')\n            .select('old.id')\n            .where('old.org_id', '=', ctx.orgId)\n            .where('old.scope_key', '=', scopeKey)\n            .where('old.state', '<>', 'running')\n            .where(\n              'old.generation',\n              '<',\n              sql<number>`(SELECT MAX(latest.generation) FROM ingest_session AS latest\n                WHERE latest.org_id = ${ctx.orgId} AND latest.scope_key = ${scopeKey})`,\n            )\n            .orderBy('old.generation')\n            .limit(INGEST_SESSION_GC_LIMIT),\n        ),\n      ); #1",
        'db-sqlite/src/repositories/ingest-session.ts:builder variable: const [result] = await executor.batch([acquire, collect]); #1',
        "db-sqlite/src/repositories/ingest-session.ts:builder variable: const update = compile(\n        db\n          .updateTable('ingest_session')\n          .set({\n            cursor,\n            seen_count: sql<number>`ingest_session.seen_count + ${input.addSeen}`,\n            pages_so_far: sql<number>`ingest_session.pages_so_far + 1`,\n            lease_until: until(seconds(guard.leaseSeconds)),\n            updated_at: NOW as never,\n          })\n          .where(holds(ctx, guard))\n          .returning(['seen_count', 'pages_so_far']),\n      ); #1",
        'db-sqlite/src/repositories/ingest-session.ts:builder variable: results = await executor.batch([...(writeGuard ?? []), update]); #1',
      ],
    },
    {
      reason:
        'SQL in job-lease-guard; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/job-lease-guard.ts:SQL template: sql<boolean>`EXISTS (SELECT 1 FROM job\n      WHERE job.id = ${id} AND job.org_id = ${ctx.orgId}\n        AND job.lease_owner = ${owner} AND job.fence = ${fence}\n        AND job.state = 'running'\n        AND job.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))` #1",
      ],
    },
    {
      reason:
        'SQL boundary in job-schedule; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        "db-sqlite/src/repositories/job-schedule.ts:opaque SQL input: sql.raw(`strftime('${FORMAT}','now')`) #1",
      ],
    },
    {
      reason:
        'SQL in job-schedule; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/job-schedule.ts:SQL input: sql: compiled.sql #1',
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:00.000Z','now','+1 minute')` #1",
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql<string>`${item.nextRunAt}` #1',
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled)\n    VALUES (${ctx.orgId}, ${item.name}, ${item.everySeconds}, ${firstRun(item)}, 1)\n    ON CONFLICT (org_id, name) DO UPDATE SET enabled = 1\n    WHERE job_schedule.every_seconds = excluded.every_seconds` #1',
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`SELECT s.name FROM job_schedule s\n        JOIN json_each(${intervals}) j ON s.name = json_extract(j.value, '$.name')\n        WHERE s.org_id = ${ctx.orgId} AND s.every_seconds <> json_extract(j.value, '$.every')\n        LIMIT 1` #1",
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`SELECT name FROM job_schedule\n          WHERE org_id = ${ctx.orgId} AND enabled = 1 AND every_seconds IS NOT NULL\n            AND next_run_at <= ${NOW} AND name > ${after}\n          ORDER BY name LIMIT ${DUE_PAGE_LIMIT}` #1',
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`SELECT value FROM json_each(${names})\n        WHERE value NOT IN (SELECT name FROM job_schedule WHERE org_id = ${ctx.orgId})` #1',
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`SELECT every_seconds FROM job_schedule\n          WHERE org_id = ${ctx.orgId} AND name = ${item.name}` #1',
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`SELECT json_extract(\n              CASE WHEN s.every_seconds <> json_extract(j.value, '$.every') THEN '{' ELSE '{}' END,\n              '$')\n            FROM job_schedule s JOIN json_each(${intervals}) j\n              ON s.name = json_extract(j.value, '$.name')\n            WHERE s.org_id = ${ctx.orgId}` #1",
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`UPDATE job_schedule SET enabled = 0\n            WHERE org_id = ${ctx.orgId} AND enabled = 1\n              AND name NOT IN (SELECT value FROM json_each(${names}))` #1',
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`strftime('${sql.raw(FORMAT)}',\n          unixepoch(s.next_run_at)\n            + ((unixepoch(${NOW}) - unixepoch(s.next_run_at)) / s.every_seconds) * s.every_seconds,\n          'unixepoch')` #1",
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`INSERT INTO job_schedule\n                (org_id, name, every_seconds, next_run_at, enabled)\n              VALUES (${ctx.orgId}, ${name}, ${definition.everySeconds},\n                ${firstRun({ ...definition, nextRunAt: null })}, 1)\n              ON CONFLICT (org_id, name) DO NOTHING` #1',
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`INSERT INTO job (id, org_id, type, payload_json, idempotency_key, max_attempts)\n            SELECT ${jobId}, s.org_id, s.name, '{}', ${prefix} || ${slot}, ${maxAttempts}\n            FROM job_schedule s\n            WHERE s.org_id = ${ctx.orgId} AND s.name = ${name} AND s.enabled = 1\n              AND s.every_seconds IS NOT NULL AND s.next_run_at <= ${NOW}\n            ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` #1",
        "db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`UPDATE job_schedule SET\n              last_slot = newest.slot,\n              next_run_at = strftime('${sql.raw(FORMAT)}', newest.slot,\n                printf('+%d seconds', job_schedule.every_seconds))\n            FROM (SELECT substr(max(idempotency_key), ${prefix.length + 1}) AS slot FROM job\n              WHERE org_id = ${ctx.orgId} AND type = ${name} AND idempotency_key >= ${prefix}\n                AND idempotency_key < ${`${KEY_PREFIX}${name};`}\n                AND length(idempotency_key) = ${prefix.length + SLOT_LENGTH}\n                AND substr(idempotency_key, ${prefix.length + 1}, ${SLOT_DATE_LENGTH}) GLOB ${SLOT_DATE_GLOB}\n                AND substr(idempotency_key, ${prefix.length + 1 + SLOT_DATE_LENGTH}) GLOB ${SLOT_TIME_GLOB}) AS newest\n            WHERE job_schedule.org_id = ${ctx.orgId} AND job_schedule.name = ${name}\n              AND job_schedule.enabled = 1 AND job_schedule.every_seconds IS NOT NULL\n              AND newest.slot >= job_schedule.next_run_at AND newest.slot <= ${NOW}` #1",
        'db-sqlite/src/repositories/job-schedule.ts:SQL template: sql`UPDATE job_schedule SET enabled = 0\n          WHERE org_id = ${ctx.orgId} AND name = ${scheduleName(name)}` #1',
      ],
    },
    {
      reason:
        'Indexes domain data in job-schedule; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/job-schedule.ts:unresolved computed access: page[page.length - 1] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/job-schedule.ts:unresolved computed access: results[insertAt] #1',
      ],
    },
    {
      reason:
        'SQL boundary in job; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        "db-sqlite/src/repositories/job.ts:opaque SQL input: sql.raw(`strftime('${FORMAT}','now')`) #1",
        "db-sqlite/src/repositories/job.ts:opaque SQL input: sql.raw('attempts') #1",
        "db-sqlite/src/repositories/job.ts:opaque SQL input: sql.raw('max_attempts') #1",
      ],
    },
    {
      reason:
        'SQL in job; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/job.ts:SQL input: sql: compiled.sql #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql<string>`strftime('${sql.raw(FORMAT)}', ${base}, printf('+%.3f seconds', ${seconds}))` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`job.id = ${text('id', guard.id)} AND job.org_id = ${ctx.orgId}\n    AND job.lease_owner = ${text('owner', guard.owner)}\n    AND job.fence = ${integer('fence', guard.fence, 1, Number.MAX_SAFE_INTEGER)}\n    AND job.state = 'running'` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`(SELECT a.${sql.raw(column)} FROM job_attempt a\n    WHERE a.job_id = job.id AND a.fence = job.fence AND a.outcome = ${outcome})` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql<number>`(0.8 + 0.2 * (abs(random() % 1000001)) / 1000000.0)` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql<number>`${0.8 + 0.2 * draw}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`WHEN ${index + 1} THEN ${retryDelaySeconds(index + 1, () => 1)}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`CASE min(${attempts}, ${BACKOFF_STEPS}) ${sql.join(steps, sql` `)} END * ${jitter()}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql<\n      string | null\n    >`CASE WHEN ${attempts} >= ${max} THEN NULL ELSE ${plus(NOW, delay)} END` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql<string | null>`(SELECT ${backoffAt(sql.raw('j.attempts'), sql.raw('j.max_attempts'))}\n      FROM job j WHERE j.id = job_attempt.job_id)` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job_attempt SET outcome = 'lease_expired', error = 'lease_lost',\n      finished_at = ${NOW}, next_run_at = ${nextRunOf()}\n      WHERE job_attempt.org_id = ${ctx.orgId} AND job_attempt.outcome = 'running'\n      AND job_attempt.job_id IN (${ids})\n      AND EXISTS (SELECT 1 FROM job x WHERE x.id = job_attempt.job_id\n        AND x.fence = job_attempt.fence AND x.state = 'running' AND x.lease_until <= ${NOW})` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET\n      state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,\n      run_at = COALESCE(${backoffAt(attempts, max)}, run_at),\n      last_error = 'lease_lost', sync_error = NULL,\n      finished_at = CASE WHEN attempts >= max_attempts THEN ${NOW} ELSE NULL END,\n      lease_owner = NULL, lease_until = NULL, updated_at = ${NOW}\n      WHERE job.org_id = ${ctx.orgId} AND job.state = 'running' AND job.lease_until <= ${NOW}\n      AND job.id IN (${ids})\n      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id AND a.fence = job.fence\n        AND a.outcome = 'running') RETURNING id` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`job.org_id = ${ctx.orgId} AND job.state = 'running' AND job.lease_until <= ${NOW}` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT json_valid(${value}) AS ok` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`0` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`${next} IS NULL` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET\n      state = CASE WHEN ${dead} THEN 'dead' ELSE 'queued' END,\n      attempts = ${outcome === 'released' ? sql`max(attempts - 1, 0)` : sql`attempts`},\n      run_at = COALESCE(${next}, run_at),\n      sync_error = CASE WHEN job.type = 'core:package-sync:v1' AND job.lease_until > ${finished}\n        THEN ${syncError} ELSE NULL END,\n      last_error = ${lastError === null ? sql`last_error` : sql`${lastError}`},\n      finished_at = CASE WHEN ${dead} THEN ${finished} ELSE NULL END,\n      lease_owner = NULL,\n      lease_until = NULL,\n      updated_at = ${finished}\n      WHERE ${where}\n      AND EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id AND a.fence = job.fence\n        AND a.worker = job.lease_owner AND a.outcome = ${outcome} AND a.finished_at IS NOT NULL) RETURNING id` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`INSERT INTO job\n          (id, org_id, type, payload_json, resource_key, idempotency_key, max_attempts, run_at,\n           project_id, initiator_token_id)\n          SELECT ${id}, ${ctx.orgId}, ${type}, ${payloadJson}, ${resourceKey}, ${key},\n            ${row.maxAttempts}, COALESCE(${runAt}, ${NOW}), ${projectId}, ${tokenId}\n          WHERE ${projectId} IS NULL\n            OR EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND org_id = ${ctx.orgId})\n          ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT id, type, payload_json, project_id, resource_key FROM job\n          WHERE org_id = ${ctx.orgId} AND idempotency_key = ${key}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT id FROM project WHERE org_id = ${ctx.orgId} AND id = ${projectId}` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT id, type, state, attempts, max_attempts, run_at, last_error\n          FROM job WHERE org_id = ${ctx.orgId} AND id = ${text('id', id)}` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT attempt, outcome, error, started_at, finished_at FROM job_attempt\n          WHERE org_id = ${ctx.orgId} AND job_id = ${id}\n          ORDER BY fence DESC LIMIT ${JOB_STATUS_HISTORY_LIMIT}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`AND c.id = ${text('id', input.id)}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`c.org_id = ${ctx.orgId} AND c.state = 'queued' AND c.run_at <= ${NOW}\n        AND c.type IN (SELECT value FROM json_each(${types})) ${target}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT h.id FROM job h WHERE h.org_id = ${ctx.orgId}\n        AND h.state = 'running' AND h.lease_until <= ${NOW}\n        AND h.resource_key IN (SELECT c.resource_key FROM job c WHERE ${eligible}\n          AND c.resource_key IS NOT NULL)` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`NOT EXISTS (SELECT 1 FROM job_attempt WHERE id = ${who})` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`json_valid(c.payload_json) AND instr(c.payload_json, char(0)) = 0` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT c.id FROM job c WHERE ${eligible} AND NOT (${validPayload})\n        ORDER BY c.run_at, c.id LIMIT ${CORRUPT_SCAN_LIMIT}` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT count(*) AS n FROM job_attempt WHERE id = ${who}` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET state = 'dead', sync_error = NULL, last_error = 'invalid_payload',\n          finished_at = ${NOW}, updated_at = ${NOW}\n          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND ${unused}\n          AND run_at <= ${NOW}\n          AND id IN (${corrupt})` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET\n          state = 'running', sync_error = NULL,\n          attempts = attempts + 1,\n          fence = fence + 1,\n          lease_owner = ${who},\n          lease_until = ${plus(NOW, sql`${lease}`)},\n          updated_at = ${NOW}\n          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND ${unused} AND id = (\n            SELECT c.id FROM job c\n            WHERE ${eligible} AND (${validPayload})\n              AND (c.resource_key IS NULL OR NOT EXISTS (\n                SELECT 1 FROM job r WHERE r.org_id = c.org_id AND r.resource_key = c.resource_key\n                  AND r.state = 'running'))\n              AND (SELECT count(*) FROM job r WHERE r.org_id = ${ctx.orgId}\n                AND r.state = 'running' AND r.lease_until > ${NOW}) < ${cap}\n            ORDER BY c.run_at, c.id LIMIT 1)` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`INSERT INTO job_attempt (id, org_id, job_id, attempt, fence, worker, outcome)\n          SELECT ${who}, org_id, id, attempts, fence, lease_owner, 'running' FROM job\n          WHERE org_id = ${ctx.orgId} AND lease_owner = ${who} AND state = 'running'\n          AND ${unused}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT id, type, payload_json, idempotency_key, resource_key, project_id,\n            initiator_token_id, attempts, max_attempts, fence, lease_owner, lease_until\n          FROM job WHERE org_id = ${ctx.orgId} AND lease_owner = ${who} AND state = 'running'` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET\n          lease_until = max(lease_until, ${plus(NOW, sql`${JOB_LEASE_SECONDS}`)}), updated_at = ${NOW}\n          WHERE job.org_id = ${ctx.orgId} AND ${guardOf(ctx, guard)} AND job.lease_until > ${NOW}` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`EXISTS (SELECT 1 FROM job WHERE job.id = job_attempt.job_id\n        AND job.org_id = job_attempt.org_id AND job.lease_owner = job_attempt.worker\n        AND job.fence = job_attempt.fence AND job.state = 'running')` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`job_attempt.org_id = ${ctx.orgId} AND job_attempt.job_id = ${guard.id}\n        AND job_attempt.fence = ${guard.fence} AND job_attempt.worker = ${guard.owner}\n        AND job_attempt.outcome = 'running' AND ${live}` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`job.org_id = ${ctx.orgId} AND ${guardOf(ctx, guard)}` #1',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job_attempt SET outcome = 'succeeded', finished_at = ${NOW}\n            WHERE ${attemptWhere}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,\n            last_error = NULL, sync_error = NULL, finished_at = ${marker('succeeded', 'finished_at')},\n            updated_at = ${marker('succeeded', 'finished_at')}\n            WHERE ${jobWhere} AND EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id\n              AND a.fence = job.fence AND a.worker = job.lease_owner AND a.outcome = 'succeeded')` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job_attempt SET outcome = 'released', finished_at = ${NOW},\n            next_run_at = ${plus(NOW, sql`${delay}`)} WHERE ${attemptWhere}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job_attempt SET outcome = 'failed', error = ${code}, finished_at = ${NOW},\n          next_run_at = CASE WHEN ${outcome.permanent === true ? 1 : 0} = 1 THEN NULL\n            ELSE ${nextRunOf()} END\n          WHERE ${attemptWhere}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT p.id FROM job p\n        WHERE p.org_id = ${ctx.orgId} AND p.state = 'running' AND p.lease_until <= ${NOW}\n        AND ${live} (SELECT 1 FROM job_attempt q WHERE q.job_id = p.id AND q.fence = p.fence\n          AND q.outcome = 'running')\n        ORDER BY p.lease_until, p.id LIMIT ${page}` #1",
        'db-sqlite/src/repositories/job.ts:SQL template: sql`EXISTS` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`NOT EXISTS` #1',
        'db-sqlite/src/repositories/job.ts:SQL template: sql`` #2',
        "db-sqlite/src/repositories/job.ts:SQL template: sql`AND (j.run_at, j.id) > (SELECT c.run_at, c.id FROM job c\n              WHERE c.org_id = ${ctx.orgId} AND c.id = ${text('afterId', input.afterId)}\n              AND c.state = 'queued')` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`SELECT j.id FROM job j\n          WHERE j.state = 'queued' AND j.run_at <= ${NOW} AND j.org_id = ${ctx.orgId}\n          AND j.type IN (SELECT value FROM json_each(${types}))\n          AND (j.resource_key IS NULL OR (\n            NOT EXISTS (SELECT 1 FROM job r WHERE r.org_id = j.org_id\n              AND r.resource_key = j.resource_key AND r.state = 'running')\n            AND NOT EXISTS (SELECT 1 FROM job e WHERE e.org_id = j.org_id\n              AND e.resource_key = j.resource_key AND e.state = 'queued' AND e.run_at <= ${NOW}\n              AND e.type IN (SELECT value FROM json_each(${types}))\n              AND (e.run_at, e.id) < (j.run_at, j.id))))\n          ${after}\n          ORDER BY j.run_at, j.id LIMIT ${page}` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`strftime(${sql.raw(`'${FORMAT}'`)}, 'now', printf('-%d seconds', ${grace}))` #1",
        "db-sqlite/src/repositories/job.ts:SQL template: sql`UPDATE job SET state = 'dead', sync_error = NULL, last_error = 'unknown_job_type',\n          finished_at = ${NOW}, updated_at = ${NOW}\n          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND id IN (\n            SELECT u.id FROM job u\n            WHERE u.state = 'queued' AND u.org_id = ${ctx.orgId}\n              AND u.run_at <= ${cutoff}\n              AND u.type NOT IN (SELECT value FROM json_each(${types}))\n              AND NOT EXISTS (SELECT 1 FROM job_attempt a JOIN job t ON t.id = a.job_id\n                WHERE a.org_id = ${ctx.orgId} AND t.type = u.type\n                AND (a.started_at > ${cutoff} OR a.finished_at > ${cutoff}))\n            ORDER BY u.run_at, u.id LIMIT ${page}) RETURNING id` #1",
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/job.ts:unresolved computed access: results[results.length - 1] #1',
        'db-sqlite/src/repositories/job.ts:unresolved computed access: results[results.length - 1] #2',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/keyring-verifier.ts:unresolved computed access: out[index] #1',
      ],
    },
    {
      reason:
        'SQL in keyring-verifier; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL template: sql<string>`hex(mac)` #1',
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: query #1',
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: `SELECT 1 FROM ${table} WHERE ${scope} LIMIT 1` #1',
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: `SELECT password_hash FROM local_login WHERE password_hash IS NOT NULL AND ${scope}` #1',
        "db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: 'SELECT id, org_id, kind, aad, hex(ciphertext) AS ciphertext_hex, hex(nonce) AS nonce_hex FROM credential WHERE key_version = ? AND org_id = (SELECT id FROM organization) LIMIT 1' #1",
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: `INSERT INTO keyring_verifier (key_version, mac) SELECT ?, ${blobLiteral(row.mac)} WHERE NOT EXISTS (SELECT 1 FROM keyring_verifier)` #1',
        'db-sqlite/src/repositories/keyring-verifier.ts:SQL input: sql: `INSERT INTO keyring_verifier (key_version, mac) VALUES (?, ${blobLiteral(row.mac)}) ON CONFLICT (key_version) DO NOTHING` #1',
      ],
    },
    {
      reason:
        'SQL boundary in keyring-verifier; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'db-sqlite/src/repositories/keyring-verifier.ts:opaque SQL input: PASSWORD_HASH_PATTERN.exec(row.password_hash) #1',
      ],
    },
    {
      reason:
        'Local builder in local-login-setup; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/local-login-setup.ts:builder variable: const statements: Statement[] = [\n        compile(\n          db\n            .updateTable('local_login')\n            .set({\n              password_hash: input.passwordHash,\n              totp_enabled_at: now,\n              totp_last_step: step,\n              credential_rev: sql<number>`credential_rev + 1`,\n              setup_hash: null,\n              setup_expires_at: null,\n              failed_count: 0,\n              locked_until: null,\n              last_op_id: opId,\n              last_login_at: now,\n              updated_at: now,\n            })\n            .where('org_id', '=', ctx.orgId)\n            .where('user_id', '=', input.userId)\n            .where('setup_hash', '=', setupHash)\n            .where('setup_expires_at', '>', now)\n            .where('totp_credential_id', '=', input.expectedCredentialId)\n            .where('credential_rev', '=', credentialRev)\n            .where('last_op_id', 'is not', opId)\n            .where((eb) => adminEligibility(ctx, eb.ref('local_login.user_id'))),\n        ),\n        sessionInsertStatement(ctx, input.session, [guard]),\n        auditPendingStatement(ctx, input.audit, {\n          sql: `(${when.sql}) = 1`,\n          params: when.params,\n        }),\n      ]; #1",
        'db-sqlite/src/repositories/local-login-setup.ts:builder variable: statements.push(\n          revokePreviousStatement(ctx, input.previousSecretHash, input.session.id, now),\n        ); #1',
        'db-sqlite/src/repositories/local-login-setup.ts:builder variable: const results = await executor.batch(statements); #1',
        'db-sqlite/src/repositories/local-login-setup.ts:builder variable: return results[1]?.changes === 1; #1',
      ],
    },
    {
      reason:
        'Local builder in local-login-success; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/local-login-success.ts:builder variable: let update = db\n    .updateTable('local_login')\n    .set((eb) => ({\n      totp_last_step: step,\n      failed_count: 0,\n      locked_until: null,\n      last_op_id: opId,\n      last_login_at: now,\n      password_hash: eb.fn.coalesce(eb.val(rehash), 'local_login.password_hash'),\n      updated_at: now,\n    }))\n    .where('local_login.org_id', '=', ctx.orgId)\n    .where('local_login.user_id', '=', snapshot.userId)\n    .where('local_login.credential_rev', '=', snapshot.credentialRev)\n    .where('local_login.password_hash', '=', passwordHash)\n    .where('local_login.totp_credential_id', '=', totpCredentialId)\n    .where('local_login.totp_enabled_at', 'is not', null)\n    .where((eb) =>\n      eb.or([\n        eb('local_login.totp_last_step', 'is', null),\n        eb('local_login.totp_last_step', '<', step),\n      ]),\n    )\n    .where((eb) =>\n      eb.or([\n        eb('local_login.locked_until', 'is', null),\n        eb('local_login.locked_until', '<=', now),\n        ...(reservedLock\n          ? [\n              eb.and([\n                eb('local_login.locked_until', '=', snapshot.lockedUntil),\n                eb('local_login.failed_count', '=', snapshot.failedCount),\n              ]),\n            ]\n          : []),\n      ]),\n    )\n    .where(adminEligibility(ctx, loginEb.ref('local_login.user_id'))); #1",
        'db-sqlite/src/repositories/local-login-success.ts:builder variable: update = update.where(reauthSessionExists(ctx, snapshot.userId, reauthSessionId, now)); #1',
        'db-sqlite/src/repositories/local-login-success.ts:builder variable: return compile(update); #1',
        "db-sqlite/src/repositories/local-login-success.ts:builder variable: const results = await executor.batch([\n        compile(\n          db\n            .updateTable('local_login')\n            .set({\n              password_hash: input.newHash,\n              credential_rev: sql<number>`credential_rev + 1`,\n              updated_at: input.now,\n            })\n            .where('local_login.org_id', '=', ctx.orgId)\n            .where('local_login.user_id', '=', input.userId)\n            .where('local_login.password_hash', '=', input.expectedHash)\n            .where((eb) =>\n              eb.exists(\n                db\n                  .selectFrom('user_account')\n                  .select(sql.lit(1).as('one'))\n                  .where('user_account.org_id', '=', ctx.orgId)\n                  .where('user_account.id', '=', input.userId)\n                  .where('user_account.status', '=', 'active'),\n              ),\n            ),\n        ),\n      ]); #1",
        'db-sqlite/src/repositories/local-login-success.ts:builder variable: return results[0]?.changes === 1; #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/login.ts:unresolved computed access: results[sessionIndex] #1',
        'db-sqlite/src/repositories/login.ts:unresolved computed access: results[groupsIndex] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in package-admin-read; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/package-admin-read.ts:unresolved computed access: rows[examined - 1] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in pat-offboarding; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/pat-offboarding.ts:unresolved computed access: ids[index] #1',
        'db-sqlite/src/repositories/pat-offboarding.ts:unresolved computed access: ids[index] #2',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/pat-offboarding.ts:unresolved computed access: results[updateAt] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in project-grant; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/project-grant.ts:unresolved computed access: fence.expected?.[key] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/project-grant.ts:unresolved computed access: outcome.results[changedAt] #1',
        'db-sqlite/src/repositories/project-grant.ts:unresolved computed access: outcome.results[changedAt] #2',
        'db-sqlite/src/repositories/project-grant.ts:unresolved computed access: outcome.results[membersAt] #1',
        'db-sqlite/src/repositories/project-grant.ts:unresolved computed access: outcome.results[offboardedAt] #1',
      ],
    },
    {
      reason:
        'SQL in project; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/project.ts:SQL text: 'update' #1",
        'db-sqlite/src/repositories/project.ts:SQL template: sql<SqlBool>`(s.identity_id is null or i.id is not null)` #1',
        "db-sqlite/src/repositories/project.ts:SQL template: sql<SqlBool>`unixepoch(rs.reauth_at, 'subsec') > unixepoch('now', 'subsec') - ${REAUTH_SECONDS}` #1",
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`${condition} is not 1` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`${authority} is 1` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`case when ${reauth.base} is 1 then (case when ${reauth.fresh} is 1 then 1 else 2 end) else 0 end` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`${sql.ref(column)} ${sql.raw(comparison)} ${value}` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`(${liveIdempotencyCollision(ctx, idempotency)} or exists (select 1 from project where org_id = ${ctx.orgId} and id = ${id} and revision <> ${expected}))` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<number>`${authority} is 1` #2',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<SqlBool>`exists (select 1 from session hp_s where hp_s.org_id = ${ctx.orgId} and hp_s.id = ${fence.sessionId} and hp_s.revoked_at is null and hp_s.identity_id is null)` #1',
        "db-sqlite/src/repositories/project.ts:SQL template: sql<SqlBool>`not exists (select 1 from role_permission rp where rp.org_id = r.org_id and rp.role_id = r.id and rp.permission not in (select held.permission from ${held.as('held')}))` #1",
        'db-sqlite/src/repositories/project.ts:SQL template: sql<boolean>`name <> ${changes.name}` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<boolean>`token_max_scope <> ${changes.tokenMaxScope}` #1',
        'db-sqlite/src/repositories/project.ts:SQL template: sql<boolean>`require_publish_approval <> ${changes.requirePublishApproval ? 1 : 0}` #1',
      ],
    },
    {
      reason:
        'Local builder in project; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/project.ts:builder variable: const outcome = await runOrgFenced(\n      executor,\n      ctx,\n      fence,\n      guard,\n      [\n        ...checks,\n        scalar(\n          db\n            .updateTable('project')\n            .set({\n              status: to,\n              revision: sql`revision + 1`,\n              updated_at: stamp,\n              last_op_id: newOpId(),\n            })\n            .where('org_id', '=', ctx.orgId)\n            .where('id', '=', id)\n            .where('revision', '=', expected)\n            .where('status', '=', from)\n            .returning('id'),\n        ),\n        auditPendingStatement(ctx, audit),\n        ...(idempotency === undefined ? [] : [idempotencyInsertStatement(ctx, idempotency)]),\n      ],\n      targetProbes(ctx, id, expected, from, authority, idempotency),\n    ); #1",
        "db-sqlite/src/repositories/project.ts:builder variable: if (!outcome.ok) {\n      const reason = failure(outcome.reason);\n      if (reason === 'authority' && reauth) {\n        const [probe] = await executor.all<{ refused: number }>(\n          authorityProbe(projectAuthority(ctx, fence, 'org:projects:archive')),\n        );\n        return probe?.refused === 0 ? 'reauth_required' : 'authority';\n      }\n      return reason === 'collision' ? noop : reason;\n    } #1",
        'db-sqlite/src/repositories/project.ts:builder variable: const changed = outcome.results[changedAt]; #1',
        "db-sqlite/src/repositories/project.ts:builder variable: if (changed === undefined || changed.rows.length === 0) {\n      throw new Error('project transition committed without a changed row');\n    } #1",
        "db-sqlite/src/repositories/project.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(authority, ctx),\n        [\n          ...assertCheck(roleAllowed),\n          scalar(\n            db.insertInto('project').values({\n              id: input.id,\n              org_id: ctx.orgId,\n              slug: input.slug,\n              name: input.name,\n              token_max_scope: scope,\n              require_publish_approval: input.requirePublishApproval === true ? 1 : 0,\n              created_at: now,\n              updated_at: now,\n              last_op_id: opId,\n            }),\n          ),\n          scalar(\n            db\n              .insertInto('access_grant')\n              .columns([\n                'id',\n                'org_id',\n                'subject_type',\n                'subject_value',\n                'scope',\n                'project_id',\n                'role_id',\n                'created_by',\n                'created_at',\n                'updated_at',\n              ])\n              .expression(\n                initialRole(db)\n                  .innerJoin('project as created', (join) =>\n                    join\n                      .onRef('created.org_id', '=', 'r.org_id')\n                      .on('created.id', '=', input.id)\n                      .on('created.last_op_id', '=', opId),\n                  )\n                  .select([\n                    eb.val(ulid()).as('id'),\n                    eb.val(ctx.orgId).as('org_id'),\n                    eb.val('email').as('subject_type'),\n                    'creator.email as subject_value',\n                    eb.val('project').as('scope'),\n                    'created.id as project_id',\n                    'r.id as role_id',\n                    'creator.id as created_by',\n                    eb.val(now).as('created_at'),\n                    eb.val(now).as('updated_at'),\n                  ]),\n              ),\n          ),\n          ...attachSourceStatements(ctx, input.id),\n          auditPendingStatement(ctx, input.audit),\n          ...(input.idempotency === undefined\n            ? []\n            : [idempotencyInsertStatement(ctx, input.idempotency)]),\n        ],\n        {\n          authority: authorityProbe(authority),\n          conflict: scalar(\n            db.selectNoFrom(\n              sql<number>`${liveIdempotencyCollision(ctx, input.idempotency)}`.as('holds'),\n            ),\n          ),\n          collision: scalar(\n            db.selectNoFrom(\n              sql<number>`(${roleAllowed} is not 1 or exists (\n            select 1 from project where org_id = ${ctx.orgId} and (slug = ${input.slug} or id = ${input.id})\n          ))`.as('holds'),\n            ),\n          ),\n        },\n      ); #1",
        "db-sqlite/src/repositories/project.ts:builder variable: if (outcome.ok) return 'created'; #1",
        'db-sqlite/src/repositories/project.ts:builder variable: const reason = failure(outcome.reason); #1',
        "db-sqlite/src/repositories/project.ts:builder variable: if (reason !== 'collision') return reason; #1",
        "db-sqlite/src/repositories/project.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        guard,\n        [\n          ...checks,\n          scalar(\n            db\n              .updateTable('project')\n              .set({\n                ...(changes.name !== undefined ? { name: changes.name } : {}),\n                ...(changes.tokenMaxScope !== undefined\n                  ? { token_max_scope: changes.tokenMaxScope }\n                  : {}),\n                ...(changes.requirePublishApproval !== undefined\n                  ? { require_publish_approval: changes.requirePublishApproval ? 1 : 0 }\n                  : {}),\n                revision: sql`revision + 1`,\n                updated_at: stamp,\n                last_op_id: newOpId(),\n              })\n              .where('org_id', '=', ctx.orgId)\n              .where('id', '=', id)\n              .where('revision', '=', expected)\n              .where('status', '=', 'active')\n              .where((w) => w.or(differences.map((difference) => w.parens(difference))))\n              .returning('id'),\n          ),\n          auditPendingStatement(ctx, audit),\n          ...(idempotency === undefined ? [] : [idempotencyInsertStatement(ctx, idempotency)]),\n        ],\n        targetProbes(ctx, id, expected, 'active', authority, idempotency),\n      ); #1",
        "db-sqlite/src/repositories/project.ts:builder variable: if (!outcome.ok) {\n        const reason = failure(outcome.reason);\n        return reason === 'collision' ? 'archived' : reason;\n      } #1",
        'db-sqlite/src/repositories/project.ts:builder variable: const changed = outcome.results[changedAt]; #2',
        "db-sqlite/src/repositories/project.ts:builder variable: return changed !== undefined && changed.rows.length > 0 ? 'updated' : 'unchanged'; #1",
      ],
    },
    {
      reason:
        'Local builder in provider-binding; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/provider-binding.ts:builder variable: const statements = [\n    db\n      .insertInto('identity_block')\n      .columns(['org_id', 'provider', 'issuer', 'subject', 'blocked_at'])\n      .expression(\n        db\n          .selectFrom('identity')\n          .select([\n            'identity.org_id',\n            'identity.provider',\n            sql<string>`${expectedAnchor}`.as('issuer'),\n            'identity.subject',\n            sql<string>`${now}`.as('blocked_at'),\n          ])\n          .where('identity.org_id', '=', ctx.orgId)\n          .where('identity.provider', '=', provider)\n          .where(bound),\n      )\n      .onConflict((conflict) => conflict.doNothing()),\n    db\n      .updateTable('token')\n      .set({ revoked_at: now })\n      .where('token.org_id', '=', ctx.orgId)\n      .where('token.revoked_at', 'is', null)\n      .where('token.validation_identity_id', 'in', (values) =>\n        values\n          .selectFrom('identity')\n          .select('identity.id')\n          .where('identity.org_id', '=', ctx.orgId)\n          .where('identity.provider', '=', provider),\n      )\n      .where(bound),\n    db\n      .deleteFrom('session')\n      .where('session.org_id', '=', ctx.orgId)\n      .where('session.identity_id', 'in', (values) =>\n        values\n          .selectFrom('identity')\n          .select('identity.id')\n          .where('identity.org_id', '=', ctx.orgId)\n          .where('identity.provider', '=', provider),\n      )\n      .where(bound),\n    db\n      .deleteFrom('user_group')\n      .where('user_group.org_id', '=', ctx.orgId)\n      .where('user_group.provider', '=', provider)\n      .where(bound),\n    db\n      .deleteFrom('identity')\n      .where('identity.org_id', '=', ctx.orgId)\n      .where('identity.provider', '=', provider)\n      .where(bound)\n      .returning('identity.id'),\n    db\n      .updateTable('identity_provider_binding')\n      .set({ anchor: newAnchor, created_at: now })\n      .where('identity_provider_binding.org_id', '=', ctx.orgId)\n      .where('identity_provider_binding.provider', '=', provider)\n      .where('identity_provider_binding.anchor', '=', expectedAnchor),\n  ].map((query) => compile(query) as ScalarStatement); #1",
        'db-sqlite/src/repositories/provider-binding.ts:builder variable: const results = await executor.batch(statements); #1',
        'db-sqlite/src/repositories/provider-binding.ts:builder variable: return {\n    swapped: (results[BINDING]?.changes ?? 0) > 0,\n    identities: results[IDENTITIES]?.rows.length ?? 0,\n    sessions: results[SESSIONS]?.changes ?? 0,\n  }; #1',
      ],
    },
    {
      reason:
        'SQL in proxy-admission; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/proxy-admission.ts:SQL template: sql<string>`${sql.ref(`${ps}.source_id`)}` #1',
        'db-sqlite/src/repositories/proxy-admission.ts:SQL template: sql`(select ${ctx.orgId} as org_id, ${query.ecosystem} as ecosystem, ${query.key} as name)` #1',
      ],
    },
    {
      reason:
        'SQL in registered-name; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as rn_act_s\n    where rn_act_s.id = ${sourceId} and rn_act_s.org_id = ${ctx.orgId}\n      and (rn_act_s.type in (${sql.join(PROXY_TYPES)})\n        or (exists (select 1 from registered_name as rn_act_r\n              where rn_act_r.source_id = rn_act_s.id and rn_act_r.org_id = rn_act_s.org_id)\n          and (rn_act_s.type <> 'npm_registry' or not exists (\n            select 1 from json_each(rn_act_s.config_json, '$.scopes') as rn_act_j\n            where not exists (select 1 from registered_name as rn_act_c\n              where rn_act_c.source_id = rn_act_s.id and rn_act_c.org_id = rn_act_s.org_id\n                and rn_act_c.pattern = rn_act_j.value || '/*'))))))` #1",

        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<number>`(${condition}) is not 1` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<number>`(${condition})` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`(${sql.join(conditions, sql` and `)})` #1',

        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from registered_name as target\n        where target.id = ${input.id} and target.org_id = ${ctx.orgId}\n          and target.source_id = ${sourceId})` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as target\n        where target.id = ${input.id} and target.org_id = ${ctx.orgId}\n          and target.project_id is ${source.project_id})` #1',
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as target\n        where target.id = ${input.id} and target.org_id = ${ctx.orgId} and target.status = 'paused')` #1",
      ],
    },
    {
      reason:
        'Local builder in registered-name; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.ok) return 'added'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'authority') return 'forbidden'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (\n        outcome.reason === 'conflict' &&\n        input.idempotency !== undefined &&\n        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))\n      )\n        return 'conflict'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'conflict') return 'pattern_taken'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'collision') return 'duplicate'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'indeterminate') return 'indeterminate'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: const pause = compile(\n        db\n          .updateTable('source')\n          .set({ status: 'paused', updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })\n          .where('id', '=', sourceId)\n          .where('org_id', '=', ctx.orgId)\n          .where('status', '<>', 'paused')\n          .where(sql<SqlBool>`not ${sourceActivatable(ctx, sourceId)}`),\n      ); #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.ok) {\n        return outcome.results[outcome.results.length - (input.idempotency === undefined ? 3 : 4)]\n          ?.changes === 1\n          ? 'removed_and_paused'\n          : 'removed';\n      } #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'authority') return 'forbidden'; #2",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'conflict') return 'conflict'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'indeterminate') return 'indeterminate'; #2",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allOf([held, owned]), ctx),\n        [\n          ...assertCheck(paused),\n          ...assertCheck(activatable),\n          compile(\n            db\n              .updateTable('source')\n              .set({\n                status: 'active',\n                next_poll_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,\n                updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,\n              })\n              .where('id', '=', input.id)\n              .where('org_id', '=', ctx.orgId)\n              .where('status', '=', 'paused'),\n          ),\n          auditPendingStatement(ctx, input.audit),\n          ...(input.idempotency === undefined\n            ? []\n            : [idempotencyInsertStatement(ctx, input.idempotency)]),\n        ],\n        {\n          authority: probe(held, true),\n          conflict: probe(\n            sql<SqlBool>`(${liveIdempotencyCollision(ctx, input.idempotency)} or ${allOf([owned, paused, sql<SqlBool>`not ${activatable}`])})`,\n            false,\n          ),\n          collision: probe(allOf([owned, sql<SqlBool>`not ${paused}`]), false),\n        },\n      ); #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.ok) return 'enabled'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'authority') return 'forbidden'; #3",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (\n        outcome.reason === 'conflict' &&\n        input.idempotency !== undefined &&\n        (await holds(liveIdempotencyCollision(ctx, input.idempotency)))\n      )\n        return 'conflict'; #2",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'conflict') return 'activation_requires_registered_names'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'collision') return 'already_enabled'; #1",
        "db-sqlite/src/repositories/registered-name.ts:builder variable: if (outcome.reason === 'indeterminate') return 'indeterminate'; #3",
      ],
    },
    {
      reason:
        'Indexes domain data in role; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/role.ts:unresolved computed access: input.ids[role.key] #1',
      ],
    },
    {
      reason:
        'Object introspection in service-principal; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/repositories/service-principal.ts:opaque object access: Object.values(probes) #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/service-principal.ts:unresolved computed access: outcome.results[guard.length] #1',
      ],
    },
    {
      reason:
        'SQL in session-liveness; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/session-liveness.ts:SQL template: sql<SqlBool>`(${column('revoked_at')} is null\n    and unixepoch(${column('expires_at')}, 'subsec') > unixepoch('now', 'subsec')\n    and unixepoch(${column('created_at')}, 'subsec') > unixepoch('now', 'subsec') - ${absolute}\n    and unixepoch(coalesce(${column('last_seen_at')}, ${column('created_at')}), 'subsec') > unixepoch('now', 'subsec') - ${idle})` #1",
      ],
    },
    {
      reason:
        'Local builder in session; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/session.ts:builder variable: let update = db\n    .updateTable('session')\n    .set({ revoked_at: now })\n    .where('session.org_id', '=', ctx.orgId)\n    .where('session.secret_hash', '=', previousSecretHash)\n    .where('session.revoked_at', 'is', null)\n    .where('session.id', '<>', newSessionId)\n    .where((eb) =>\n      eb.exists(\n        eb\n          .selectFrom('session as created')\n          .select('created.id')\n          .where('created.id', '=', newSessionId)\n          .where('created.org_id', '=', ctx.orgId),\n      ),\n    ); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: update = update.where(guard); #1',
        'db-sqlite/src/repositories/session.ts:builder variable: return compile(update) as ScalarStatement; #1',
        "db-sqlite/src/repositories/session.ts:builder variable: let update = db\n    .updateTable('session')\n    .set({ revoked_at: now })\n    .where('session.org_id', '=', ctx.orgId)\n    .where('session.user_id', '=', userId)\n    .where('session.revoked_at', 'is', null); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: update = update.where(guard); #2',
        'db-sqlite/src/repositories/session.ts:builder variable: return compile(update); #1',
        'db-sqlite/src/repositories/session.ts:builder variable: return rows.length > 0; #1',
        "db-sqlite/src/repositories/session.ts:builder variable: const rows = await run<IdRow>(\n        executor,\n        db\n          .updateTable('session')\n          .set({ revoked_at: now })\n          .where('org_id', '=', ctx.orgId)\n          .where('id', '=', id)\n          .where('revoked_at', 'is', null)\n          .returning('id'),\n      ); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: return rows.length > 0; #2',
        "db-sqlite/src/repositories/session.ts:builder variable: const update = db.updateTable('session').set({ revoked_at: now }).where(when).returning('id'); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: const results = await executor.batch([\n          auditPendingStatement(ctx, audit, {\n            sql: `EXISTS (${eligible.sql})`,\n            params: eligible.params,\n          }),\n          compile(update),\n        ]); #1',
        'db-sqlite/src/repositories/session.ts:builder variable: return (results[1]?.rows.length ?? 0) > 0; #2',
        'db-sqlite/src/repositories/session.ts:builder variable: const rows = await run<IdRow>(executor, update); #1',
        "db-sqlite/src/repositories/session.ts:builder variable: const rows = await run<IdRow>(\n        executor,\n        db\n          .deleteFrom('session')\n          .where('org_id', '=', ctx.orgId)\n          .where('id', 'in', (eb) =>\n            eb\n              .selectFrom('session as expired')\n              .select('expired.id')\n              .where('expired.org_id', '=', ctx.orgId)\n              .where('expired.expires_at', '<', before)\n              .orderBy('expired.expires_at')\n              .limit(limit),\n          )\n          .returning('id'),\n      ); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: return rows.length; #1',
      ],
    },
    {
      reason:
        'SQL in session; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`session.org_id = ${ctx.orgId}\n        AND session.id = ${input.sessionId}\n        AND session.revoked_at IS NULL\n        AND unixepoch(session.expires_at, 'subsec') > unixepoch(${input.now}, 'subsec')\n        AND session.identity_id IS ${input.identityId}\n        AND (session.reauth_at IS NULL\n          OR unixepoch(session.reauth_at, 'subsec') < unixepoch(${input.authTime}, 'subsec'))` #1",
        "db-sqlite/src/repositories/session.ts:builder variable: const results = await executor.batch([\n        auditPendingStatement(ctx, input.audit, {\n          sql: `EXISTS (${eligible.sql})`,\n          params: eligible.params,\n        }),\n        compile(\n          db.updateTable('session').set({ reauth_at: input.authTime }).where(when).returning('id'),\n        ),\n      ]); #1",
        'db-sqlite/src/repositories/session.ts:builder variable: return (results[1]?.rows.length ?? 0) > 0; #1',
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`unixepoch(session.expires_at, 'subsec') > unixepoch(${cutoffs.now}, 'subsec')` #1",
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`unixepoch(coalesce(session.last_seen_at, session.created_at), 'subsec') > unixepoch(${cutoffs.idleSince}, 'subsec')` #1",
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`unixepoch(session.created_at, 'subsec') > unixepoch(${cutoffs.now}, 'subsec') - 43200` #1",
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`unixepoch(expires_at, 'subsec') > unixepoch(${now}, 'subsec')` #1",
        "db-sqlite/src/repositories/session.ts:SQL template: sql<boolean>`unixepoch(coalesce(last_seen_at, created_at), 'subsec') < unixepoch(${staleBefore}, 'subsec')` #1",
      ],
    },
    {
      reason:
        'Indexes domain data in source-sync-reads; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/source-sync-reads.ts:unresolved computed access: keys[keys.length - 1] #1',
      ],
    },
    {
      reason:
        'SQL in source; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<number>`(${condition}) is not 1` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<number>`(${condition})` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`(${sql.join(conditions, sql` and `)})` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from source as target\n    where target.id = ${id} and target.org_id = ${ctx.orgId} and target.project_id is ${ownerProjectId})` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from credential as owned\n    where owned.id = ${id} and owned.org_id = ${ctx.orgId} and owned.project_id is ${ownerProjectId})` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql`case when json_valid(config_json) then\n    case when json_type(config_json) = 'object' then config_json end end` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql`json_extract(${config}, '$.provider')` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql`lower(json_extract(${config}, '$.repository'))` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from project as visible_project\n      where visible_project.id = ${input.projectId} and visible_project.org_id = ${ctx.orgId}\n        and visible_project.status = 'active')` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`(source.project_id = ${input.projectId} or\n        (source.project_id is null and exists (select 1 from project_source as attachment\n          where attachment.org_id = ${ctx.orgId} and attachment.project_id = ${input.projectId}\n            and attachment.source_id = source.id)))` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from project as visible_project\n        where visible_project.id = ${input.projectId} and visible_project.org_id = ${ctx.orgId}\n          and visible_project.status = 'active')` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`(source.project_id = ${input.projectId} or\n        (source.project_id is null and exists (select 1 from project_source as attachment\n          where attachment.org_id = ${ctx.orgId} and attachment.project_id = ${input.projectId}\n            and attachment.source_id = source.id)))` #2',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || poll_interval_seconds || ' seconds')` #1",
        "db-sqlite/src/repositories/source.ts:SQL input: sql: 'changes() > 0' #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from source as existing\n        where existing.org_id = ${ctx.orgId}\n          and (existing.id = ${input.id}\n            or (existing.project_id is ${input.projectId} and existing.name = ${input.name})))` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`not ${duplicate}` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`not ${credentialOk}` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from source as proxy\n          where proxy.id = ${input.id} and proxy.type in (${sql.join(PROXY_TYPES)}))` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from package as referencing\n        where referencing.source_id = ${input.id})` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from webhook_delivery as delivered\n        where delivered.org_id = ${ctx.orgId} and delivered.source_id = ${input.id})` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<string | null>`${sql.ref(column)}` #1',
        'db-sqlite/src/repositories/source.ts:SQL template: sql<string | null>`${value}` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<'active'>`case when status = 'paused' then 'paused' else 'active' end` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`strftime(${format}, 'now', '+' || poll_interval_seconds || ' seconds')` #1",
        "db-sqlite/src/repositories/source.ts:SQL template: sql<'degraded'>`case when status = 'paused' then 'paused'\n              when consecutive_failures + 1 >= ${FAILING_AFTER} then 'failing' else 'degraded' end` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<number>`consecutive_failures + 1` #1',
        "db-sqlite/src/repositories/source.ts:SQL template: sql<string>`strftime(${format}, 'now', '+' ||\n              min(poll_interval_seconds, 300 * (1 << min(consecutive_failures, ${MAX_BACKOFF_EXPONENT}))) ||\n              ' seconds')` #1",
        'db-sqlite/src/repositories/source.ts:SQL template: sql<SqlBool>`exists (select 1 from job as polling\n              where polling.id = ${guard.id} and polling.org_id = ${ctx.orgId}\n                and polling.resource_key = ${`source:${input.id}`})` #1',
      ],
    },
    {
      reason:
        'Local builder in source; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/source.ts:builder variable: const insert = compile(\n        db.insertInto('source').values({\n          id: input.id,\n          org_id: ctx.orgId,\n          project_id: input.projectId,\n          name: input.name,\n          ecosystem: input.ecosystem,\n          type: input.type,\n          url: input.url,\n          credential_id: input.credential?.id ?? null,\n          config_json: jsonConfig,\n          user_agent: input.userAgent ?? null,\n          status: isProxy(input.type) ? 'active' : 'paused',\n          ...(interval === undefined ? {} : { poll_interval_seconds: interval }),\n          ...(policy === undefined ? {} : { removal_policy: policy }),\n          ...(retention === undefined ? {} : { retention_days_override: retention }),\n          ...(input.defaultVisibleToNewProjects === undefined\n            ? {}\n            : { default_visible_to_new_projects: input.defaultVisibleToNewProjects ? 1 : 0 }),\n          next_poll_at: DB_NOW,\n        }),\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allowed, ctx),\n        [\n          ...(input.credential !== null && 'statement' in input.credential\n            ? [input.credential.statement]\n            : []),\n          ...(credentialOk === null ? [] : assertCheck(credentialOk)),\n          insert,\n          auditPendingStatement(ctx, input.audit, { sql: 'changes() > 0', params: [] }),\n        ],\n        probes,\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.ok) return 'created'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'authority') return 'forbidden'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'conflict') return 'credential_scope_mismatch'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'collision') return 'duplicate'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: return outcome.reason === 'indeterminate' ? 'indeterminate' : 'conflict'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: const update = compile(\n        db\n          .updateTable('source')\n          .set({\n            ...set,\n            ...(touchesCoverage\n              ? {\n                  status: sql<SourceStatus>`case when status <> 'paused' then 'paused' else status end`,\n                }\n              : {}),\n            updated_at: DB_NOW,\n          })\n          .where('id', '=', input.id)\n          .where('org_id', '=', ctx.orgId),\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allowed, ctx),\n        [\n          ...(input.preparedCredential === undefined ? [] : [input.preparedCredential.statement]),\n          ...(credentialOk === null ? [] : assertCheck(credentialOk)),\n          statusBefore,\n          update,\n          ...input.audit.map((event) =>\n            auditPendingStatement(ctx, event, { sql: 'changes() > 0', params: [] }),\n          ),\n        ],\n        {\n          authority: probe(authority(ctx, fence, current.projectId, input.providerAnchors), true),\n          ...(credentialOk === null || input.preparedCredential !== undefined\n            ? {}\n            : { conflict: probe(credentialOk, true) }),\n        },\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.ok) {\n        const before = outcome.results[outcome.results.length - 2 - input.audit.length]?.rows[0];\n        return touchesCoverage && before?.status !== 'paused'\n          ? 'paused_for_reactivation'\n          : 'updated';\n      } #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'conflict' && credentialOk !== null) {\n        return (await read(ctx, input.id)) === null ? 'not_found' : 'credential_scope_mismatch';\n      } #1",
        'db-sqlite/src/repositories/source.ts:builder variable: return failureResult(ctx, input.id, outcome.reason); #1',
        "db-sqlite/src/repositories/source.ts:builder variable: const update = compile(\n        db\n          .updateTable('source')\n          .set({ status: 'active', updated_at: DB_NOW })\n          .where('id', '=', input.id)\n          .where('org_id', '=', ctx.orgId)\n          .where('type', 'in', [...PROXY_TYPES]),\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allowed, ctx),\n        [\n          auditPendingStatement(ctx, input.audit, {\n            sql: `EXISTS (SELECT 1 FROM source WHERE org_id = ? AND id = ? AND status <> 'active'\n              AND type IN (${PROXY_TYPES.map(() => '?').join(', ')}))`,\n            params: [ctx.orgId, input.id, ...PROXY_TYPES],\n          }),\n          update,\n        ],\n        {\n          authority: probe(held, true),\n        },\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.ok) return 'resumed'; #1",
        'db-sqlite/src/repositories/source.ts:builder variable: return failureResult(ctx, input.id, outcome.reason); #2',
        "db-sqlite/src/repositories/source.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allowed, ctx),\n        [\n          ...assertCheck(sql<SqlBool>`not ${packages}`),\n          ...assertCheck(sql<SqlBool>`not ${history}`),\n          compile(db.deleteFrom('project_package_pattern').where('source_id', '=', input.id)),\n          compile(db.deleteFrom('project_source').where('source_id', '=', input.id)),\n          compile(\n            db.deleteFrom('source').where('id', '=', input.id).where('org_id', '=', ctx.orgId),\n          ),\n        ],\n        {\n          authority: probe(held, true),\n          conflict: probe(packages, false),\n          collision: probe(history, false),\n        },\n      ); #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.ok) return 'deleted'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'conflict') return 'has_packages'; #1",
        "db-sqlite/src/repositories/source.ts:builder variable: if (outcome.reason === 'collision') return 'has_history'; #1",
        'db-sqlite/src/repositories/source.ts:builder variable: return failureResult(ctx, input.id, outcome.reason); #3',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/source.ts:unresolved computed access: results[results.length - 1] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in token-read; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/token-read.ts:unresolved computed access: items[items.length - 1] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in token; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/repositories/token.ts:unresolved computed access: SCOPE_CEILINGS[input.scope] #1',
        'db-sqlite/src/repositories/token.ts:unresolved computed access: SCOPE_CEILINGS[input.scope] #2',
      ],
    },
    {
      reason:
        'Object introspection in token; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/repositories/token.ts:opaque object access: Object.values(rows[0] ?? {}) #1',
      ],
    },
    {
      reason:
        'SQL in upstream-state; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/upstream-state.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now')` #1",
        "db-sqlite/src/repositories/upstream-state.ts:SQL template: sql<string>`strftime(${sql.lit(FORMAT)}, 'now', ${sql.lit(`+${ttlSeconds} seconds`)})` #1",
      ],
    },
    {
      reason:
        'Conflict action in upstream-state; retained verbatim so a later action or callback change requires review.',
      sites: [
        "db-sqlite/src/repositories/upstream-state.ts:conflict action: db\n      .insertInto('upstream_state')\n      .columns([\n        'org_id',\n        'package_id',\n        'form',\n        'etag',\n        'last_modified',\n        'content_sha256',\n        'checked_at',\n        'fresh_until',\n        'not_found_count',\n        'first_not_found_at',\n      ])\n      .expression((eb) =>\n        eb\n          .selectFrom('package')\n          .select([\n            'package.org_id',\n            'package.id',\n            eb.val(form).as('form'),\n            eb.val(values.etag).as('etag'),\n            eb.val(values.lastModified).as('last_modified'),\n            eb.val(values.contentSha256).as('content_sha256'),\n            now().as('checked_at'),\n            freshUntil.as('fresh_until'),\n            eb.val(values.notFound ? 1 : 0).as('not_found_count'),\n            (values.notFound ? now() : sql<string | null>`null`).as('first_not_found_at'),\n          ])\n          .where('package.id', '=', packageId)\n          .where('package.org_id', '=', ctx.orgId),\n      )\n      .onConflict((conflict) =>\n        conflict\n          .columns(['package_id', 'form'])\n          .doUpdateSet((eb) =>\n            values.notFound\n              ? {\n                  checked_at: eb.ref('excluded.checked_at'),\n                  fresh_until: eb.ref('excluded.fresh_until'),\n                  not_found_count: sql<number>`upstream_state.not_found_count + 1`,\n                  first_not_found_at: sql<string>`coalesce(upstream_state.first_not_found_at, excluded.first_not_found_at)`,\n                }\n              : {\n                  etag: eb.ref('excluded.etag'),\n                  last_modified: eb.ref('excluded.last_modified'),\n                  content_sha256: eb.ref('excluded.content_sha256'),\n                  checked_at: eb.ref('excluded.checked_at'),\n                  fresh_until: eb.ref('excluded.fresh_until'),\n                  not_found_count: 0,\n                  first_not_found_at: null,\n                },\n          )\n          .where('upstream_state.org_id', '=', ctx.orgId),\n      ) #1",
      ],
    },
    {
      reason:
        'SQL in visibility-attach; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql`('packagist_proxy', 'npmjs_proxy')` #1",
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<number>`case when type in ${PROXY_TYPES} then 1000 else 100 end` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`(${sql.join(conditions, sql` and `)})` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<number>`(${condition}) is not 1` #1',
        "db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from project as target_project\n    where target_project.id = ${projectId} and target_project.org_id = ${ctx.orgId}\n      and target_project.status = 'active')` #1",
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from source as target_source\n    where target_source.id = ${sourceId} and target_source.org_id = ${ctx.orgId}\n      and target_source.project_id is ${owner}\n      and (target_source.project_id is null or target_source.project_id = ${projectId}))` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from project_source as target_attachment\n    where target_attachment.org_id = ${ctx.orgId} and target_attachment.project_id = ${projectId}\n      and target_attachment.source_id = ${sourceId})` #1',
        "db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from project where org_id = ${ctx.orgId}\n          and id = ${projectId} and status = 'active' and revision = ${expected})` #1",
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`(select count(*) from project_source where org_id = ${ctx.orgId}\n          and project_id = ${projectId}) = ${sourceIds.length}` #1',
        "db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`(select count(*) from project_source as ps\n          join source as s on s.id = ps.source_id\n          join json_each(${snapshot}) as wanted on json_extract(wanted.value, '$.id') = ps.source_id\n          where ps.org_id = ${ctx.orgId} and s.org_id = ${ctx.orgId}\n            and ps.project_id = ${projectId}\n            and s.project_id is json_extract(wanted.value, '$.owner')\n            and (s.project_id is null or s.project_id = ${projectId})) = ${sourceIds.length}` #1",
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`1` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`not exists (\n          select 1 from api_idempotency where org_id = ${ctx.orgId}\n          and principal_key = ${input.idempotency.principalKey} and key = ${input.idempotency.key}\n          and expires_at > ${input.idempotency.createdAt})` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from project_source as ps\n        join json_each(${order}) as wanted on wanted.value = ps.source_id\n        where ps.org_id = ${ctx.orgId} and ps.project_id = ${projectId}\n          and ps.precedence is not cast(wanted.key as integer))` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<number>`(select cast(wanted.key as integer)\n        from json_each(${order}) as wanted where wanted.value = project_source.source_id)` #1',
        'db-sqlite/src/repositories/visibility-attach.ts:SQL template: sql<SqlBool>`exists (select 1 from package as target_package\n        join source as owner_source on owner_source.id = target_package.source_id\n        where target_package.id = ${input.packageId} and target_package.org_id = ${ctx.orgId}\n          and owner_source.org_id = ${ctx.orgId} and owner_source.project_id is ${owner})` #1',
      ],
    },
    {
      reason:
        'Local builder in visibility-attach; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const insert = db\n    .insertInto('project_source')\n    .columns(['org_id', 'project_id', 'source_id', 'precedence'])\n    .expression(\n      db\n        .selectFrom('source')\n        .select([\n          'org_id',\n          sql<string>`${projectId}`.as('project_id'),\n          'id',\n          DEFAULT_PRECEDENCE.as('precedence'),\n        ])\n        .where('org_id', '=', ctx.orgId)\n        .where('project_id', 'is', null)\n        .where(\n          sql<SqlBool>`exists (select 1 from project as new_project\n            where new_project.id = ${projectId} and new_project.org_id = ${ctx.orgId})`,\n        ),\n    )\n    .onConflict((conflict) => conflict.columns(['project_id', 'source_id']).doNothing()); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: return [compile(insert), ...rederiveStatements(ctx, { kind: 'project', projectId })]; #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const insert = db\n        .insertInto('project_source')\n        .columns(['org_id', 'project_id', 'source_id', 'precedence'])\n        .expression(\n          db\n            .selectFrom('source')\n            .select([\n              'org_id',\n              sql<string>`${input.projectId}`.as('project_id'),\n              'id',\n              (precedence === undefined ? DEFAULT_PRECEDENCE : sql<number>`${precedence}`).as(\n                'precedence',\n              ),\n            ])\n            .where('org_id', '=', ctx.orgId)\n            .where('id', '=', input.sourceId),\n        )\n        .onConflict((conflict) =>\n          precedence === undefined\n            ? conflict.columns(['project_id', 'source_id']).doNothing()\n            : conflict\n                .columns(['project_id', 'source_id'])\n                .doUpdateSet({ precedence: (eb) => eb.ref('excluded.precedence') })\n                .where(sql<SqlBool>`project_source.precedence is not excluded.precedence`),\n        ); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const result = await run(\n        ctx,\n        fence,\n        authority,\n        sourceServes(ctx, input.sourceId, found.owner, input.projectId),\n        [\n          projectRevision(ctx, input.projectId, changed),\n          compile(insert),\n          ...visibilityAuditStatements(ctx, input),\n          ...rederiveStatements(ctx, {\n            kind: 'projectSource',\n            projectId: input.projectId,\n            sourceId: input.sourceId,\n          }),\n        ],\n        changed,\n      ); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: return found.owner === null && !result.ok && result.reason === 'authority'\n        ? notFound\n        : result; #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const rows = db\n        .deleteFrom('project_package')\n        .where('org_id', '=', ctx.orgId)\n        .where('project_id', '=', projectId)\n        .where('package_id', 'in', (qb) =>\n          qb\n            .selectFrom('package')\n            .select('id')\n            .where('org_id', '=', ctx.orgId)\n            .where('source_id', '=', sourceId),\n        ); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const patterns = db\n        .deleteFrom('project_package_pattern')\n        .where('org_id', '=', ctx.orgId)\n        .where('project_id', '=', projectId)\n        .where('source_id', '=', sourceId); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const attachment = db\n        .deleteFrom('project_source')\n        .where('org_id', '=', ctx.orgId)\n        .where('project_id', '=', projectId)\n        .where('source_id', '=', sourceId); #1",
        'db-sqlite/src/repositories/visibility-attach.ts:builder variable: return run(\n        ctx,\n        fence,\n        holds(ctx, fence, found.owner, projectId, true),\n        allOf(\n          sourceServes(ctx, sourceId, found.owner, projectId),\n          isAttached(ctx, projectId, sourceId),\n        ),\n        [\n          projectRevision(ctx, projectId),\n          compile(rows),\n          compile(patterns),\n          compile(attachment),\n          ...visibilityAuditStatements(ctx, input),\n        ],\n      ); #1',
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const update = db\n        .updateTable('project_source')\n        .set({ precedence })\n        .where('org_id', '=', ctx.orgId)\n        .where('project_id', '=', input.projectId)\n        .where('source_id', '=', input.sourceId)\n        .where('precedence', 'is not', precedence); #1",
        'db-sqlite/src/repositories/visibility-attach.ts:builder variable: return run(\n        ctx,\n        fence,\n        holds(ctx, fence, found.owner, input.projectId),\n        allOf(\n          sourceServes(ctx, input.sourceId, found.owner, input.projectId),\n          isAttached(ctx, input.projectId, input.sourceId),\n        ),\n        [\n          projectRevision(ctx, input.projectId, changed),\n          compile(update),\n          ...visibilityAuditStatements(ctx, input),\n        ],\n        changed,\n      ); #1',
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const update = compile(\n        db\n          .updateTable('project_source')\n          .set({ precedence })\n          .where('org_id', '=', ctx.orgId)\n          .where('project_id', '=', projectId)\n          .where('precedence', 'is not', precedence),\n      ); #1",
        'db-sqlite/src/repositories/visibility-attach.ts:builder variable: return run(\n        ctx,\n        fence,\n        authority,\n        state,\n        [revision, update, ...visibilityAuditStatements(ctx, input)],\n        changed,\n      ); #1',
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: const update = db\n        .updateTable('package')\n        .set({ visible_to_new_projects: flag })\n        .where('org_id', '=', ctx.orgId)\n        .where('id', '=', input.packageId)\n        .where('visible_to_new_projects', 'is not', flag); #1",
        "db-sqlite/src/repositories/visibility-attach.ts:builder variable: return run(ctx, fence, holds(ctx, fence, owner, null), state, [\n        compile(update),\n        ...rederiveStatements(ctx, { kind: 'package', packageId: input.packageId }),\n      ]); #1",
      ],
    },
    {
      reason:
        'SQL in visibility-audit; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: ["db-sqlite/src/repositories/visibility-audit.ts:SQL input: sql: 'changes() > 0' #1"],
    },
    {
      reason:
        'SQL in visibility-derive; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<ProjectPackageOrigin>`case when exists (\n    select 1 from project_package_pattern as derive_include\n    where derive_include.org_id = ${ctx.orgId}\n      and derive_include.project_id = ${projectRef}\n      and derive_include.source_id = ${sourceRef}\n      and derive_include.effect = 'include'\n  ) then 'pattern' else 'subscription' end` #1",
        "db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`(\n    ${k('org_id')} = ${ctx.orgId}\n    and ${attachedSourceCondition(ctx, projectRef, k('source_id'), k('ecosystem'))}\n    and ${admissionCondition(ctx, projectRef, k('source_id'), k('name'), k('visible_to_new_projects'))}\n  )` #1",
        'db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${project} = ${scope.projectId}` #1',
        'db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${pkg} = ${scope.packageId}` #1',
        'db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${project} = ${scope.projectId} and exists (\n        select 1 from package as scope_package\n        where scope_package.id = ${pkg} and scope_package.source_id = ${scope.sourceId}\n      )` #1',
        "db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${col('derive_attachment.project_id')} = ${scope.projectId}` #1",
        "db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${col('derive_package.id')} = ${scope.packageId}` #1",
        "db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql<SqlBool>`${col('derive_attachment.project_id')} = ${scope.projectId}\n        and ${col('derive_package.source_id')} = ${scope.sourceId}` #1",
        'db-sqlite/src/repositories/visibility-derive.ts:SQL template: sql`(select source_id from package as row_package where row_package.id = ${col(`${ROW}.package_id`)})` #1',
      ],
    },
    {
      reason:
        'Local builder in visibility-derive; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/visibility-derive.ts:builder variable: const remove = db\n    .deleteFrom(ROW)\n    .where(`${ROW}.org_id`, '=', ctx.orgId)\n    .where(`${ROW}.origin`, '<>', 'explicit')\n    .where(rowInScope(scope))\n    .where(\n      sql<SqlBool>`not exists (\n        select 1 from package as stay_package\n        where stay_package.id = ${col(`${ROW}.package_id`)}\n          and ${derivedFor(ctx, rowProject, 'stay_package')}\n      )`,\n    ); #1",
        "db-sqlite/src/repositories/visibility-derive.ts:builder variable: const retag = db\n    .updateTable(ROW)\n    .set({ origin })\n    .where(`${ROW}.org_id`, '=', ctx.orgId)\n    .where(`${ROW}.origin`, '<>', 'explicit')\n    .where(rowInScope(scope))\n    .where(sql<SqlBool>`${col(`${ROW}.origin`)} <> ${origin}`); #1",
        "db-sqlite/src/repositories/visibility-derive.ts:builder variable: const insert = db\n    .insertInto(ROW)\n    .orIgnore()\n    .columns(['org_id', 'project_id', 'package_id', 'origin', 'ecosystem', 'name'])\n    .expression(\n      db\n        .selectFrom('package as derive_package')\n        .innerJoin(\n          'project_source as derive_attachment',\n          'derive_attachment.source_id',\n          'derive_package.source_id',\n        )\n        .select([\n          'derive_package.org_id',\n          'derive_attachment.project_id',\n          'derive_package.id',\n          derivedOrigin(ctx, attachmentProject, col('derive_package.source_id')).as('origin'),\n          'derive_package.ecosystem',\n          'derive_package.name',\n        ])\n        .where('derive_attachment.org_id', '=', ctx.orgId)\n        .where(candidateInScope(scope))\n        .where(derivedFor(ctx, attachmentProject, 'derive_package')),\n    ); #1",
        'db-sqlite/src/repositories/visibility-derive.ts:builder variable: return [compile(remove), compile(retag), compile(insert)]; #1',
      ],
    },
    {
      reason:
        'SQL in visibility-subset; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<number>`(${condition}) is not 1` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from project_source as vs_attachment\n    join source as vs_source on vs_source.id = vs_attachment.source_id\n    join project as vs_project on vs_project.id = vs_attachment.project_id\n    where vs_attachment.project_id = ${projectId}\n      and vs_attachment.source_id = ${sourceId}\n      and vs_attachment.org_id = ${ctx.orgId}\n      and vs_source.org_id = ${ctx.orgId}\n      and vs_project.org_id = ${ctx.orgId}\n      and (vs_source.project_id is null or vs_source.project_id = vs_attachment.project_id)\n  )` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from package as vs_package\n    join project_source as vs_attachment on vs_attachment.source_id = vs_package.source_id\n    join source as vs_source on vs_source.id = vs_package.source_id\n    join project as vs_project on vs_project.id = vs_attachment.project_id\n    where vs_package.id = ${packageId}\n      and vs_package.org_id = ${ctx.orgId}\n      and vs_attachment.project_id = ${projectId}\n      and vs_attachment.org_id = ${ctx.orgId}\n      and vs_source.org_id = ${ctx.orgId}\n      and vs_project.org_id = ${ctx.orgId}\n      and vs_source.ecosystem = vs_package.ecosystem\n      and (vs_source.project_id is null or vs_source.project_id = vs_attachment.project_id)\n  )` #1',
        "db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from project as vs_active\n    where vs_active.id = ${projectId} and vs_active.org_id = ${ctx.orgId} and vs_active.status = 'active'\n  )` #1",
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql`vs_owner.project_id is null` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql`vs_owner.project_id = ${owner.projectId}` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from package as vs_hidden\n    join source as vs_owner on vs_owner.id = vs_hidden.source_id\n    where vs_hidden.id = ${packageId}\n      and vs_hidden.org_id = ${ctx.orgId}\n      and vs_owner.org_id = ${ctx.orgId}\n      and vs_hidden.visible_to_new_projects = 0\n      and ${ownedBy}\n  )` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n    select 1 from project_package_pattern as vs_pattern\n    where vs_pattern.org_id = ${ctx.orgId}\n      and vs_pattern.project_id = ${target.projectId}\n      and vs_pattern.source_id = ${target.sourceId}\n      and ${extra}\n  )` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<number>`count(case when effect = ${input.effect} then 1 end)` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<number>`count(case when pattern = ${input.pattern} then 1 end)` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql`vs_pattern.pattern = ${input.pattern} and vs_pattern.effect <> ${input.effect}` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(\n        select count(*) from project_package_pattern as vs_limit\n        where vs_limit.org_id = ${ctx.orgId}\n          and vs_limit.project_id = ${input.projectId}\n          and vs_limit.source_id = ${input.sourceId}\n          and vs_limit.effect = ${input.effect}\n      ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`not ${clash}` #1',
        "db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(\n        ${projectActive(ctx, input.projectId)}\n        or (\n          not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern} and vs_pattern.effect = 'exclude'`)}\n          and (\n            not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)}\n            or ${patternRow(ctx, input, sql`vs_pattern.pattern <> ${input.pattern} and vs_pattern.effect = 'include'`)}\n          )\n        )\n      )` #1",
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(${active} and (${manageHeld} or ${orgHeld} or ${ownHeld}))` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`exists (\n        select 1 from package as vs_flag\n        where vs_flag.id = ${input.packageId} and vs_flag.org_id = ${ctx.orgId}\n          and vs_flag.visible_to_new_projects = 1\n      )` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(not ${flagOne} or ${manageHeld})` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(not ${orgHidden} or ${orgHeld})` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(not ${ownHidden} or ${ownHeld})` #1',
        'db-sqlite/src/repositories/visibility-subset.ts:SQL template: sql<SqlBool>`(${active} and (\n        (${flagOne} and ${manageHeld})\n        or (${orgHidden} and ${orgHeld})\n        or (${ownHidden} and ${ownHeld})\n      ))` #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/repositories/visibility-subset.ts:unresolved computed access: results[GUARD_STATEMENTS + index] #1',
      ],
    },
    {
      reason:
        'Local builder in visibility-subset; aliases, conflict behavior and escapes are reviewed with the module mutation targets.',
      sites: [
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const insert = compile(\n        db\n          .insertInto('project_package_pattern')\n          .values({\n            id: newOpId(),\n            org_id: ctx.orgId,\n            project_id: input.projectId,\n            source_id: input.sourceId,\n            pattern: input.pattern,\n            effect: input.effect,\n          })\n          .onConflict((conflict) =>\n            conflict.columns(['project_id', 'source_id', 'pattern']).doNothing(),\n          ),\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(\n          held,\n          ctx,\n          sql<SqlBool>`not ${patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)}`,\n        ),\n        [\n          ...assertCheck(attached),\n          ...assertCheck(sql<SqlBool>`not ${clash}`),\n          insert,\n          ...visibilityAuditStatements(ctx, input),\n          ...assertCheck(withinLimit),\n          ...rederiveStatements(ctx, {\n            kind: 'projectSource',\n            projectId: input.projectId,\n            sourceId: input.sourceId,\n          }),\n        ],\n        probes,\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.ok) return changesAt(outcome.results, 2) > 0 ? 'added' : 'unchanged'; #1",
        'db-sqlite/src/repositories/visibility-subset.ts:builder variable: const refused = failure(outcome.reason); #1',
        'db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (refused !== null) return refused; #1',
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.reason === 'conflict') return 'not_attached'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.reason === 'collision') return 'conflict'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const remove = compile(\n        db\n          .deleteFrom('project_package_pattern')\n          .where('org_id', '=', ctx.orgId)\n          .where('project_id', '=', input.projectId)\n          .where('source_id', '=', input.sourceId)\n          .where('pattern', '=', input.pattern),\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(held, ctx, patternRow(ctx, input, sql`vs_pattern.pattern = ${input.pattern}`)),\n        [\n          ...assertCheck(narrowing),\n          remove,\n          ...visibilityAuditStatements(ctx, input, true),\n          ...rederiveStatements(ctx, {\n            kind: 'projectSource',\n            projectId: input.projectId,\n            sourceId: input.sourceId,\n          }),\n        ],\n        { authority: probe(sql<SqlBool>`(${held} and ${narrowing})`) },\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.ok) return changesAt(outcome.results, 1) > 0 ? 'removed' : 'not_found'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: return failure(outcome.reason) ?? 'failed'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const upsert = compile(\n        db\n          .insertInto('project_package')\n          .columns(['org_id', 'project_id', 'package_id', 'origin', 'ecosystem', 'name'])\n          .expression(\n            db\n              .selectFrom('package')\n              .select([\n                'org_id',\n                sql<string>`${input.projectId}`.as('project_id'),\n                'id',\n                sql<'explicit'>`'explicit'`.as('origin'),\n                'ecosystem',\n                'name',\n              ])\n              .where('id', '=', input.packageId)\n              .where('org_id', '=', ctx.orgId),\n          )\n          .onConflict((conflict) =>\n            conflict\n              .columns(['project_id', 'package_id'])\n              .doUpdateSet({ origin: 'explicit' })\n              .where('project_package.origin', '<>', 'explicit'),\n          ),\n      ); #1",
        'db-sqlite/src/repositories/visibility-subset.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allowed, ctx),\n        [...assertCheck(eligible), ...checks.flatMap((check) => assertCheck(check)), upsert],\n        {\n          authority: probe(authorized),\n          conflict: probe(eligible),\n        },\n      ); #1',
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.ok) return changesAt(outcome.results, 4) > 0 ? 'added' : 'unchanged'; #1",
        'db-sqlite/src/repositories/visibility-subset.ts:builder variable: const refused = failure(outcome.reason); #2',
        'db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (refused !== null) return refused; #2',
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: return outcome.reason === 'conflict' ? 'not_eligible' : 'failed'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const remove = compile(\n        db\n          .deleteFrom('project_package')\n          .where('org_id', '=', ctx.orgId)\n          .where('project_id', '=', input.projectId)\n          .where('package_id', '=', input.packageId)\n          .where('origin', '=', 'explicit'),\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(held, ctx),\n        [\n          remove,\n          ...rederiveStatements(ctx, {\n            kind: 'projectSource',\n            projectId: input.projectId,\n            sourceId,\n          }),\n        ],\n        { authority: probe(held) },\n      ); #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: if (outcome.ok) return changesAt(outcome.results, 0) > 0 ? 'removed' : 'not_found'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:builder variable: return failure(outcome.reason) ?? 'failed'; #2",
      ],
    },
    {
      reason:
        'SQL boundary in vulnerability; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'db-sqlite/src/repositories/vulnerability.ts:opaque SQL input: /^(?:ssh:\\/\\/)?[^@]+@(\\[[^\\]]+\\]|[^/:]+)(?::(\\d+)\\/|:|\\/)/.exec(\n            config.repository,\n          ) #1',
      ],
    },
    {
      reason:
        'SQL in vulnerability; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/vulnerability.ts:SQL text: `INSERT INTO vulnerability_result (org_id,version_id,source,package_id,ecosystem,package_key,version,query_version,mapping_version,assessment,fetched_at,attempted_at,next_attempt_at,failure_count,last_error_code,generation,refresh_id)\n        SELECT ?,json_extract(i.value,'$.versionId'),'osv',json_extract(i.value,'$.packageId'),json_extract(i.value,'$.ecosystem'),json_extract(i.value,'$.packageKey'),json_extract(i.value,'$.version'),json_extract(i.value,'$.queryVersion'),json_extract(i.value,'$.mappingVersion'),NULL,NULL,?,json_extract(i.value,'$.due'),json_extract(i.value,'$.code') IS NOT NULL,json_extract(i.value,'$.code'),json_extract(i.value,'$.expectedGeneration')+1,?\n        FROM json_each(?) i WHERE EXISTS (SELECT 1 FROM vulnerability_sync_state WHERE org_id = ? AND source='osv' AND write_token = ?)\n        AND (json_extract(i.value,'$.expectedGeneration')=0 OR EXISTS (SELECT 1 FROM vulnerability_result r WHERE r.org_id = ? AND r.version_id=json_extract(i.value,'$.versionId') AND r.source='osv' AND r.generation=json_extract(i.value,'$.expectedGeneration')))\n        ON CONFLICT (org_id,version_id,source) DO UPDATE SET package_id=excluded.package_id,ecosystem=excluded.ecosystem,package_key=excluded.package_key,version=excluded.version,query_version=excluded.query_version,mapping_version=excluded.mapping_version,\n          assessment=CASE WHEN vulnerability_result.package_id=excluded.package_id AND vulnerability_result.ecosystem=excluded.ecosystem AND vulnerability_result.package_key=excluded.package_key AND vulnerability_result.version=excluded.version AND vulnerability_result.query_version=excluded.query_version AND vulnerability_result.mapping_version=excluded.mapping_version THEN vulnerability_result.assessment ELSE NULL END,\n          fetched_at=CASE WHEN vulnerability_result.package_id=excluded.package_id AND vulnerability_result.ecosystem=excluded.ecosystem AND vulnerability_result.package_key=excluded.package_key AND vulnerability_result.version=excluded.version AND vulnerability_result.query_version=excluded.query_version AND vulnerability_result.mapping_version=excluded.mapping_version THEN vulnerability_result.fetched_at ELSE NULL END,\n          attempted_at=excluded.attempted_at,next_attempt_at=excluded.next_attempt_at,last_error_code=excluded.last_error_code,\n          failure_count=CASE WHEN excluded.last_error_code IS NOT NULL THEN min(vulnerability_result.failure_count+1,1000) ELSE 0 END,generation=excluded.generation,refresh_id=excluded.refresh_id\n        WHERE vulnerability_result.org_id = ? AND vulnerability_result.generation=excluded.generation-1 RETURNING version_id` #1",
        "db-sqlite/src/repositories/vulnerability.ts:SQL text: `UPDATE vulnerability_result SET refresh_id=NULL,\n        assessment=CASE WHEN last_error_code IS NULL THEN CASE WHEN EXISTS (SELECT 1 FROM vulnerability_match m WHERE m.org_id=vulnerability_result.org_id AND m.version_id=vulnerability_result.version_id AND m.source=vulnerability_result.source) THEN 'affected' ELSE 'not_affected' END ELSE assessment END,\n        fetched_at=CASE WHEN last_error_code IS NULL THEN ? ELSE fetched_at END\n        WHERE org_id = ? AND source='osv' AND refresh_id = ?` #1",
        "db-sqlite/src/repositories/vulnerability.ts:SQL text: `UPDATE vulnerability_sync_state SET write_token=NULL WHERE org_id = ? AND source='osv' AND write_token = ?` #1",
        "db-sqlite/src/repositories/vulnerability.ts:SQL text: `INSERT INTO vulnerability_result (org_id,version_id,source,package_id,ecosystem,package_key,version,query_version,mapping_version,attempted_at,next_attempt_at,generation,refresh_id)\n          SELECT ?,?,'osv',?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM vulnerability_sync_state WHERE org_id = ? AND source='osv' AND write_token = ?)\n          AND (? = 0 OR EXISTS (SELECT 1 FROM vulnerability_result WHERE org_id = ? AND version_id = ? AND source='osv' AND generation = ?))\n          ON CONFLICT (org_id,version_id,source) DO UPDATE SET package_id=excluded.package_id,ecosystem=excluded.ecosystem,package_key=excluded.package_key,version=excluded.version,query_version=excluded.query_version,mapping_version=excluded.mapping_version,\n            assessment=CASE WHEN vulnerability_result.package_id=excluded.package_id AND vulnerability_result.ecosystem=excluded.ecosystem AND vulnerability_result.package_key=excluded.package_key AND vulnerability_result.version=excluded.version AND vulnerability_result.query_version=excluded.query_version AND vulnerability_result.mapping_version=excluded.mapping_version THEN vulnerability_result.assessment ELSE NULL END,\n            fetched_at=CASE WHEN vulnerability_result.package_id=excluded.package_id AND vulnerability_result.ecosystem=excluded.ecosystem AND vulnerability_result.package_key=excluded.package_key AND vulnerability_result.version=excluded.version AND vulnerability_result.query_version=excluded.query_version AND vulnerability_result.mapping_version=excluded.mapping_version THEN vulnerability_result.fetched_at ELSE NULL END,\n            attempted_at=excluded.attempted_at,next_attempt_at=excluded.next_attempt_at,refresh_id=excluded.refresh_id\n          WHERE vulnerability_result.org_id = ? AND vulnerability_result.generation = ?` #1",
        "db-sqlite/src/repositories/vulnerability.ts:SQL text: `UPDATE vulnerability_sync_state SET write_token=NULL WHERE org_id = ? AND source='osv' AND write_token = ?` #2",
      ],
    },
    {
      reason:
        'SQL in webhook-delivery; exact text and interpolations are reviewed with the count-reader mutation targets and FK assumptions.',
      sites: [
        "db-sqlite/src/repositories/webhook-delivery.ts:SQL input: sql: `INSERT INTO webhook_delivery (org_id, provider, delivery_id, event, outcome)\n      VALUES (?, ?, ?, ?, 'received')\n      ON CONFLICT (provider, delivery_id) DO NOTHING` #1",
        'db-sqlite/src/repositories/webhook-delivery.ts:SQL input: sql: `SELECT outcome FROM webhook_delivery\n      WHERE org_id = ? AND provider = ? AND delivery_id = ?` #1',
        "db-sqlite/src/repositories/webhook-delivery.ts:SQL input: sql: `UPDATE webhook_delivery\n      SET outcome = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\n      WHERE org_id = ? AND provider = ? AND delivery_id = ? AND outcome = 'received'` #1",
        "db-sqlite/src/repositories/webhook-delivery.ts:SQL input: sql: `SELECT id FROM source\n      WHERE org_id = ? AND type = 'vcs' AND credential_id = ? AND status <> 'paused'\n        AND json_extract(config_json, '$.provider') = 'github'\n        AND json_extract(config_json, '$.installationId') = ?\n        AND lower(json_extract(config_json, '$.repository')) = ?\n      ORDER BY id LIMIT 100` #1",
      ],
    },
    {
      reason:
        'Indexes fixture data in catalogue-fixture; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: items[int(items.length)] #1',
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: NON_PROXY_TYPES[ecosystem] #1',
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: NON_PROXY_TYPES[ecosystem] #2',
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: pools[source.ecosystem] #1',
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: pools[source.ecosystem] #2',
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: pools[owner.ecosystem] #1',
      ],
    },
    {
      reason:
        'Fixture SQL in catalogue-fixture; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL input: sql: 'DROP INDEX IF EXISTS organization_singleton' #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING' #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO cache_epoch (org_id, version) VALUES (?, hex(randomblob(16))) ON CONFLICT (org_id) DO NOTHING' #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)' #1",
        'db-sqlite/src/testing/catalogue-fixture.ts:SQL text: `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, default_visible_to_new_projects, removal_policy)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` #1',
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, ?)' #1",
        'db-sqlite/src/testing/catalogue-fixture.ts:SQL text: `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status, removed_upstream_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` #1',
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: 'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL text: `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at,\n                            published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, 'import_time', '{}', ?, ?, ?)` #1",
        'db-sqlite/src/testing/catalogue-fixture.ts:SQL text: "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, \'explicit\' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1" #1',
        "db-sqlite/src/testing/catalogue-fixture.ts:SQL input: sql: 'INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, ? AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1' #1",
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/testing/catalogue-fixture.ts:unresolved computed access: results[index] #1',
      ],
    },
    {
      reason:
        'Fixture SQL in foreign-keys-off; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/foreign-keys-off.ts:SQL input: sql: 'PRAGMA foreign_keys' #1",
        "db-sqlite/src/testing/foreign-keys-off.ts:SQL input: sql: 'PRAGMA foreign_keys = OFF' #1",
        "db-sqlite/src/testing/foreign-keys-off.ts:SQL input: sql: 'PRAGMA foreign_keys = ON' #1",
      ],
    },
    {
      reason:
        'Fixture SQL in migrated-database; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: ["db-sqlite/src/testing/migrated-database.ts:SQL input: sql: 'ANALYZE' #1"],
    },
    {
      reason:
        'Indexes fixture data in actor-authority; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/actor-authority.ts:unresolved computed access: [\n        /"actor"\\."org_id" = "s"\\."org_id"/,\n        /"i"\\."org_id" = "s"\\."org_id"/,\n        /"s"\\."org_id" = \\?/,\n      ][index] #1',
      ],
    },
    {
      reason:
        'Fixture SQL in blob-references; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable, published_at) VALUES (?, ?, ?, 1, ?, 1, ?)' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at)\n      VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'upstream', '{}', ?, 'tombstoned', ?)` #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: \"INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES (?, ?, ?, 1, ?, '{}', 'test')\" #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL input: sql: 'SELECT sha256 FROM blob WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)\n        VALUES ('ING1', ?, 'source', ?, 'S-ING', 1, 'o', 1, ?, 'running', ?, ?, ?)` #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)\n        VALUES (?, 'K-UP', 'composer-p2', ?, ?, ?)` #1",
        'db-sqlite/src/testing/mutation-table/blob-references.ts:SQL input: sql: `SELECT b.id AS id FROM blob b WHERE ${condition.sql}` #1',
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)\n        VALUES ('ING1', ?, 'source', ?, 'S-F', 1, 'o', 1, ?, 'running', ?, ?, ?)` #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)\n        VALUES (?, 'K-F', 'composer-p2', ?, ?, ?)` #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL input: sql: 'SELECT id, purge_after FROM blob ORDER BY id' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: 'UPDATE blob SET purge_after = ?' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: 'UPDATE organization SET retention_removed_upstream_days = 1 WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: 'UPDATE source SET retention_days_override = ?' #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at, removed_upstream_at)\n            VALUES (?, ?, 'K', ?, ?, ?, 'upstream', '{}', ?, ?, ?, ?)` #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: \"INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES ('REV', ?, 'VR', 1, 'BR', '{}', 'test')\" #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:SQL text: \"UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'K'\" #1",
        'db-sqlite/src/testing/mutation-table/blob-references.ts:SQL input: sql: `SELECT b.id FROM blob b WHERE ${condition.sql} ORDER BY b.id` #1',
      ],
    },
    {
      reason:
        'Object introspection in blob-references; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/testing/mutation-table/blob-references.ts:opaque object access: Object.entries(refs) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in catalogue-predicates; retained because the key cannot be proven to exclude changes.',
      sites: [
        "db-sqlite/src/testing/mutation-table/catalogue-predicates.ts:unresolved computed access: ['guard_ps', 'guard_s', 'guard_p'][index] #1",
      ],
    },
    {
      reason:
        'Computed fixture dispatch in catalogue-reader; reviewed explicitly because its target is not statically known.',
      sites: [
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:computed builder call: calls[method](reader, own) #1',
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:computed builder call: calls[method](reader, foreign) #1',
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:computed builder call: calls[method](readerOf(context), own) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in catalogue-reader; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:unresolved computed access: empty[method] #1',
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:unresolved computed access: empty[method] #2',
        'db-sqlite/src/testing/mutation-table/catalogue-reader.ts:unresolved computed access: empty[method] #3',
      ],
    },
    {
      reason:
        'Fixture SQL in catalogue-reblob; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)\n      VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)` #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable, published_at) VALUES (?, ?, ?, 1, ?, 1, ?)' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #2",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: \"UPDATE version SET blob_id = 'B-OLD' WHERE id = 'V1'\" #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #3",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: `INSERT INTO version_revision\n            (id, org_id, version_id, revision, blob_id, metadata_json, reason, op_id)\n            VALUES ('VR-REBLOB', ?, 'V1', 1, 'B-OLD', '{}', 'refetch_changed', ?)` #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: \"UPDATE version SET revision = 2, blob_id = 'B-NEW', last_op_id = ? WHERE id = 'V1'\" #1",
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: "UPDATE version SET org_id = ? WHERE id = \'V1\'" #1',
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: "UPDATE package SET org_id = ? WHERE id = \'K-NPM\'" #1',
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'UPDATE job SET org_id = ? WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: 'SELECT * FROM version ORDER BY id' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: 'SELECT * FROM package ORDER BY id' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: 'SELECT * FROM version_revision ORDER BY id' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #4",
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: "SELECT blob_id, revision FROM version WHERE id = \'V1\'" #1',
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #5",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #6",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)' #2",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: \"UPDATE version SET blob_id = 'OLD' WHERE id = 'V'\" #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #7",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: `INSERT INTO version_revision (id, org_id, version_id, revision, blob_id,\n            metadata_json, reason, op_id) VALUES ('R', ?, 'V', 1, 'OLD', '{}', 'refetch_changed', ?)` #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: \"UPDATE version SET blob_id = 'NEW', revision = 2, last_op_id = ? WHERE id = 'V'\" #1",
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: "UPDATE version SET last_op_id = ? WHERE id = \'V\'" #1',
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'replace' #8",
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: "SELECT blob_id FROM version WHERE id = \'V\'" #1',
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: \"UPDATE version SET blob_id = 'B-OLD' WHERE id IN ('V1', 'V2')\" #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL text: 'UPDATE job SET org_id = ? WHERE id = ?' #2",
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: `SELECT * FROM ${table} ORDER BY rowid` #1',
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:SQL input: sql: 'SELECT id, blob_id, revision FROM version ORDER BY id' #1",
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:unresolved computed access: plan.statements[index] #1',
        'db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:unresolved computed access: statements[index] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in catalogue-time-cases; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/catalogue-time-cases.ts:unresolved computed access: versions[index] #1',
      ],
    },
    {
      reason:
        'Fixture SQL in catalogue-write-dist; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'version update' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)' #2",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'UPDATE version SET blob_id = ? WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'UPDATE version SET last_op_id = ? WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL input: sql: 'SELECT * FROM package' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL input: sql: 'SELECT * FROM package' #2",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL input: sql: 'SELECT blob_id FROM version WHERE id = ?' #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'version update' #2",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:SQL text: 'version update' #3",
      ],
    },
    {
      reason:
        'Computed fixture dispatch in catalogue-writer; reviewed explicitly because its target is not statically known.',
      sites: [
        "db-sqlite/src/testing/mutation-table/catalogue-writer.ts:computed builder call: storeCalls[method](\n        store,\n        orgOf(context).own,\n        fence,\n        foreignTarget ? 'F' : 'O',\n      ) #1",
        "db-sqlite/src/testing/mutation-table/catalogue-writer.ts:computed builder call: storeCalls[method](store, own, fence, 'O') #1",
      ],
    },
    {
      reason:
        'Fixture SQL in fixtures; exact mutation/conflict text is reviewed alongside the isolated contract setup.',
      sites: [
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)\n      VALUES (?, ?, ?, ?, ?, ?, 'upstream', '{}')` #1",
        'db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)` #1',
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)' #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:SQL text: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)' #2",
        'db-sqlite/src/testing/mutation-table/fixtures.ts:SQL template: sql<number>`(${guard})` #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in harness; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/harness.ts:unresolved computed access: predicate.waivedCopies?.[copy] #1',
      ],
    },
    {
      reason:
        'Object introspection in harness; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/testing/mutation-table/harness.ts:opaque object access: Object.assign(insert, { forged }) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in identity-block; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/identity-block.ts:unresolved computed access: [\n          /"actor"\\."org_id" = "s"\\."org_id"/,\n          /"i"\\."org_id" = "s"\\."org_id"/,\n          /"s"\\."org_id" = \\?/,\n        ][index] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in import-rollback; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/import-rollback.ts:unresolved computed access: expected[entityId] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in import-verification; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/import-verification.ts:unresolved computed access: ROLLBACK_ENTITIES[type] #1',
        'db-sqlite/src/testing/mutation-table/import-verification.ts:unresolved computed access: row[c] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in ingest-finalize; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/ingest-finalize.ts:unresolved computed access: blobCases[index] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in inventory; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/inventory.ts:unresolved computed access: source[index] #1',
        'db-sqlite/src/testing/mutation-table/inventory.ts:unresolved computed access: sources[file] #1',
        'db-sqlite/src/testing/mutation-table/inventory.ts:unresolved computed access: allowlist[key] #1',
        'db-sqlite/src/testing/mutation-table/inventory.ts:unresolved computed access: statuses[owner] #1',
        'db-sqlite/src/testing/mutation-table/inventory.ts:unresolved computed access: statuses[owner] #2',
      ],
    },
    {
      reason:
        'Indexes fixture data in kysely; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/kysely.ts:unresolved computed access: adminCases[index] #1',
        'db-sqlite/src/testing/mutation-table/kysely.ts:unresolved computed access: aliases[layer] #1',
        'db-sqlite/src/testing/mutation-table/kysely.ts:unresolved computed access: cases[index] #1',
        "db-sqlite/src/testing/mutation-table/kysely.ts:unresolved computed access: (['identity', 'binding'].includes(layer) ? ['email', 'group'] : ['local', 'email', 'group'])[index] #1",
      ],
    },
    {
      reason:
        'Indexes fixture data in package-id; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/package-id.ts:unresolved computed access: orgs[rows.source] #1',
        'db-sqlite/src/testing/mutation-table/package-id.ts:unresolved computed access: orgs[rows.pkg] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in project-readable; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/project-readable.ts:unresolved computed access: alias[layer] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in registry-reads; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/registry-reads.ts:unresolved computed access: orgs[sourceOrg] #1',
        'db-sqlite/src/testing/mutation-table/registry-reads.ts:unresolved computed access: orgs[nameOrg] #1',
        'db-sqlite/src/testing/mutation-table/registry-reads.ts:unresolved computed access: orgs[rows.source] #1',
        'db-sqlite/src/testing/mutation-table/registry-reads.ts:unresolved computed access: orgs[rows.pkg] #1',
        'db-sqlite/src/testing/mutation-table/registry-reads.ts:unresolved computed access: orgs[rows.version] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in role; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/role.ts:unresolved computed access: ids[role.key] #1',
        'db-sqlite/src/testing/mutation-table/role.ts:unresolved computed access: ids[role.key] #2',
        'db-sqlite/src/testing/mutation-table/role.ts:unresolved computed access: ids[key] #1',
        'db-sqlite/src/testing/mutation-table/role.ts:unresolved computed access: ids[DEFAULT_ROLES[index]!.key] #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in session; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/session.ts:unresolved computed access: rotationCases[index] #1',
      ],
    },
    {
      reason:
        'Computed fixture map in visibility-derive; domain key construction is reviewed explicitly.',
      sites: [
        "db-sqlite/src/testing/mutation-table/visibility-derive.ts:unresolved computed key: export const entries: readonly MutationEntry[] = [\n  {\n    file: 'repositories/visibility-derive.ts',\n    builder: 'rederiveStatements',\n    cases: [\n      ...(['remove', 'retag', 'stay', 'insert'] as const).map(deriveCase),\n      foreignOriginCase(true),\n      foreignOriginCase(false),\n    ],\n    predicates: [\n      {\n        name: 'retagged origins ignore foreign include patterns',\n        locate: /derive_include\\.org_id = \\?/,\n        neutral: NOT_NULL,\n        copies: 3,\n        waivedCopies: { 2: 'the insert occurrence is killed by the inserted-origin case' },\n        caseName: foreignOriginCase(true).name,\n      },\n      {\n        name: 'inserted origins ignore foreign include patterns',\n        locate: /derive_include\\.org_id = \\?/,\n        neutral: NOT_NULL,\n        copies: 3,\n        waivedCopies: {\n          0: 'the retag assignment occurrence is killed by the retagged-origin case',\n          1: 'the retag comparison occurrence is killed by the retagged-origin case',\n        },\n        caseName: foreignOriginCase(false).name,\n      },\n      ...(['remove', 'retag'] as const).map((kind, index) => ({\n        name: `${kind} row belongs to the organization`,\n        locate: ref('project_package', 'org_id', '\\\\?'),\n        neutral: NOT_NULL,\n        copies: 2,\n        waivedCopies: {\n          [1 - index]:\n            `the other occurrence is stripped and killed by \"${deriveCase(kind === 'remove' ? 'retag' : 'remove').name}\"`,\n        },\n        caseName: deriveCase(kind).name,\n      })),\n      ...(['stay', 'insert'] as const).map((kind) => ({\n        name: `${kind} package belongs to the organization`,\n        locate: ref(kind === 'stay' ? 'stay_package' : 'derive_package', 'org_id', '\\\\?'),\n        neutral: NOT_NULL,\n        copies: 1,\n        caseName: deriveCase(kind).name,\n      })),\n    ],\n    waivers: [\n      {\n        locate: /\"guard_(?:bad|ci|cx|i|im|x)\"\\.\"org_id\" = \\?/,\n        reason:\n          'delegated admissionCondition predicates; all six pattern aliases have independent foreign-pattern mutants in catalogue-predicates.ts',\n      },\n      {\n        locate: /\"derive_attachment\"\\.\"org_id\" = \\?/,\n        reason:\n          'same unique (project_id, source_id) row as guard_ps in attachedSourceCondition; both organization comparisons are redundant with each other',\n      },\n      {\n        locate: /\"guard_(?:ps|s|p)\"\\.\"org_id\" = \\?/,\n        reason:\n          'delegated attachedSourceCondition, registered with foreign attachment/source/project mutants in catalogue-predicates.ts; insert guard_ps also duplicates derive_attachment',\n      },\n    ],\n  },\n]; #1",
      ],
    },
    {
      reason:
        'Indexes fixture data in vulnerability; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/vulnerability.ts:unresolved computed access: evidence[part] #1',
        'db-sqlite/src/testing/mutation-table/vulnerability.ts:unresolved computed access: [/v\\.org_id = \\?/, /p\\.org_id = \\?/, /r\\.org_id = \\?/, /s\\.org_id = \\?/][i] #1',
      ],
    },
    {
      reason:
        'Computed fixture dispatch in vulnerability; reviewed explicitly because its target is not statically known.',
      sites: [
        'db-sqlite/src/testing/mutation-table/vulnerability.ts:computed builder call: repo[op](own, lease) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in webhook-delivery; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/mutation-table/webhook-delivery.ts:unresolved computed access: orgOf(context)[org] #1',
      ],
    },
    {
      reason:
        'Test-runner metadata assignment in statement-budget-setup; it carries trip records and reads no statement result.',
      sites: [
        'db-sqlite/src/testing/statement-budget-setup.ts:opaque object access: Object.assign(task.meta, { statementBudgetTrips: [...trips] }) #1',
      ],
    },
    {
      reason:
        'Indexes fixture data in node-sqlite-executor; retained because the key cannot be proven to exclude changes.',
      sites: [
        'db-sqlite/src/testing/node-sqlite-executor.ts:unresolved computed access: params[index] #1',
      ],
    },
    {
      reason:
        'Object introspection in node-sqlite-executor; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'db-sqlite/src/testing/node-sqlite-executor.ts:opaque object access: Object.entries(row) #1',
      ],
    },
    {
      reason:
        'SQL boundary in node-sqlite-executor; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.exec('PRAGMA foreign_keys = ON') #1",
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.exec('PRAGMA journal_mode = WAL') #1",
        'db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.prepare(sql) #1',
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.exec('BEGIN IMMEDIATE') #1",
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.exec('COMMIT') #1",
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque SQL input: database.exec('ROLLBACK') #1",
      ],
    },
    {
      reason:
        'Object introspection in assets; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'runtime-cloudflare/src/assets.ts:opaque object access: Object.values(manifest.files) #1',
      ],
    },
    {
      reason:
        'Indexes domain data in assets; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/assets.ts:unresolved computed access: manifest.files[name] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in workers-codec; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/codec/workers-codec.ts:unresolved computed access: DIGEST_NAME[alg] #1',
        'runtime-cloudflare/src/codec/workers-codec.ts:unresolved computed access: values[i] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in d1-executor; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/db/d1-executor.ts:unresolved computed access: params[index] #1',
      ],
    },
    {
      reason:
        'Object introspection in d1-executor; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'runtime-cloudflare/src/db/d1-executor.ts:opaque object access: Object.entries(row) #1',
      ],
    },
    {
      reason:
        'SQL boundary in d1-executor; callers supply compiled or parameterized statements and retain responsibility for count semantics.',
      sites: [
        'runtime-cloudflare/src/db/d1-executor.ts:opaque SQL input: db.prepare(statement.sql) #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: [
        'runtime-cloudflare/src/db/d1-executor.ts:unresolved computed access: statements[index] #1',
      ],
    },
    {
      reason:
        'Object introspection in index; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'runtime-cloudflare/src/index.ts:opaque object access: Object.getOwnPropertyDescriptor(env, name) #1',
        'runtime-cloudflare/src/index.ts:opaque object access: Object.entries(parsed) #1',
        "runtime-cloudflare/src/index.ts:opaque object access: Object.getOwnPropertyDescriptor(body, 'org') #1",
      ],
    },
    {
      reason:
        'Indexes domain data in index; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/index.ts:unresolved computed access: record[method] #1',
        'runtime-cloudflare/src/index.ts:unresolved computed access: bucketCounts[index === -1 ? HISTOGRAM_BOUNDS.length : index] #1',
      ],
    },
    {
      reason:
        'Selects a statement/result slot; count semantics are reviewed separately at each changes read.',
      sites: ['runtime-cloudflare/src/index.ts:unresolved computed access: out[key] #1'],
    },
    {
      reason:
        'Indexes domain data in workers; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/observability/workers.ts:unresolved computed access: labels[key] #1',
      ],
    },
    {
      reason:
        'Indexes domain data in rehearsal.test.support; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/restore-rehearsal/rehearsal.test.support.ts:unresolved computed access: keys[name] #1',
      ],
    },
    {
      reason:
        'Object introspection in rehearsal.test.support; domain/fixture values are reviewed as possible indirect count access.',
      sites: [
        'runtime-cloudflare/src/restore-rehearsal/rehearsal.test.support.ts:opaque object access: Object.entries(manifest.keys) #1',
        "runtime-cloudflare/src/restore-rehearsal/rehearsal.test.support.ts:opaque object access: Object.getOwnPropertyDescriptor(crypto, 'DigestStream') #1",
        "runtime-cloudflare/src/restore-rehearsal/rehearsal.test.support.ts:opaque object access: Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream') #1",
      ],
    },
    {
      reason:
        'Indexes domain data in sql-snapshot.test.support; retained because the key cannot be proven to exclude changes.',
      sites: [
        'runtime-cloudflare/src/restore-rehearsal/sql-snapshot.test.support.ts:unresolved computed access: row[`type${i}`] #1',
        'runtime-cloudflare/src/restore-rehearsal/sql-snapshot.test.support.ts:unresolved computed access: row[String(i)] #1',
      ],
    },
    {
      reason: 'Shared fixture assertion runner; does not supply production mutation statements.',
      sites: [
        "db-sqlite/src/contract/catalogue-read-contract.ts:opaque dependency: import { describe, expect, it } from 'vitest'; #1",
        "db-sqlite/src/contract/executor-contract.ts:opaque dependency: import { describe, expect, it } from 'vitest'; #1",
        "db-sqlite/src/testing/foreign-keys-off.ts:opaque dependency: import { it } from 'vitest'; #1",
        "db-sqlite/src/testing/mutation-table/blob-references.ts:opaque dependency: import { expect } from 'vitest'; #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:opaque dependency: import { expect } from 'vitest'; #1",
        "db-sqlite/src/testing/mutation-table/catalogue-write-dist.ts:opaque dependency: import { expect } from 'vitest'; #1",
      ],
    },
    {
      reason:
        'Shared core domain/auth API boundary; local SQL composition and count-reader FK assumptions remain explicitly reviewed.',
      sites: [
        "db-sqlite/src/contract/executor-contract.ts:opaque dependency: import { DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/contract/two-organizations.ts:opaque dependency: import { orgContext } from '@package-broker/core/db/port'; #1",
        "db-sqlite/src/internal/catalogue-status-statements.ts:opaque dependency: import {\n  statusRevisionReason,\n  versionTransition,\n  type StatusReason,\n  type VersionStatus,\n} from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/internal/catalogue-write-guard.ts:opaque dependency: import { catalogueWriteGuard, type CatalogueWriteGuard } from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: import {\n  fenceGuard,\n  runFenced,\n  type FailureProbes,\n  type FencedOutcome,\n  type FenceGuard,\n  type MutationFence,\n  type TokenMutationFence,\n} from '@package-broker/core/authz/fence'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: import { ulid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: import { isValidDomain } from '@package-broker/core/identity/policy'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: import { isValidProviderId } from '@package-broker/core/identity/port'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: export { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/access.ts:opaque dependency: import { PERMISSIONS } from '@package-broker/core/authz/permissions'; #1",
        "db-sqlite/src/repositories/access.ts:opaque dependency: import {\n  parseScopeLevel,\n  parseScopesJson,\n  tokenEffectivePermissions,\n  type ScopeLevel,\n  type TokenProjectMode,\n} from '@package-broker/core/authz/scope'; #1",
        "db-sqlite/src/repositories/actor-authority.ts:opaque dependency: import { SESSION_IDLE_MS } from '@package-broker/core/auth/session'; #1",
        "db-sqlite/src/repositories/audit-pending.ts:opaque dependency: import { isUlid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/blob.ts:opaque dependency: import {\n  BLOB_MEDIA_TYPES,\n  BlobBusyError,\n  BlobConflictError,\n  BlobValidationError,\n  blobStorageKey,\n  stagedStorageKey,\n  parseSha256,\n  type BlobInfo,\n  type BlobMetadataPort,\n  type PurgeGeneration,\n  type Sha256,\n} from '@package-broker/core/platform/blob'; #1",
        "db-sqlite/src/repositories/catalogue-list.ts:opaque dependency: import {\n  CATALOGUE_PAGE_MAX,\n  CATALOGUE_SEARCH_MAX,\n  validateLimit,\n  type CatalogueReader,\n  type ListedPackage,\n  type VisibleListing,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:opaque dependency: import {\n  MAX_PATTERN_BYTES,\n  MAX_PATTERN_WILDCARDS,\n  MAX_PATTERNS_PER_RULE,\n} from '@package-broker/core/catalogue/patterns'; #1",
        "db-sqlite/src/repositories/catalogue-read.ts:opaque dependency: import {\n  CATALOGUE_PAGE_MAX,\n  validateLimit,\n  type CatalogueReader,\n  type CatalogueVersion,\n  type DistType,\n  type PackageResolution,\n  type PageChanged,\n  type ResolveVersionsQuery,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:opaque dependency: import {\n  ABSENCE_MIN_NOT_FOUND,\n  ABSENCE_MIN_SPAN_MS,\n  CATALOGUE_KEY_LIST_MAX,\n  type CatalogueWriteGuard,\n  type FinalizeResult,\n  type FinalizeEvidence,\n  type ListingScope,\n  type MarkListingEffect,\n  type WriteEffect,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:opaque dependency: import {\n  isCompleteListing,\n  statusRevisionReason,\n  type CompleteSourceListing,\n  type CompleteVersionListing,\n} from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:opaque dependency: import {\n  assertFinalizeAllowed,\n  DEFAULT_MAX_ABSENCE_SHARE,\n  type FinalizeGuardOptions,\n} from '@package-broker/core/ingest/finalize-guard'; #1",
        "db-sqlite/src/repositories/catalogue-write-package.ts:opaque dependency: import { MAX_KEY_LENGTH, type NameEcosystem } from '@package-broker/core/catalogue/names'; #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:opaque dependency: import { validateVersion } from '@package-broker/core/catalogue/versions'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:opaque dependency: import {\n  CATALOGUE_SYNC_VERSIONS_PER_CALL,\n  type CatalogueWriteGuard,\n  type VersionInput,\n  type SyncRefusal,\n  type SyncResult,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:opaque dependency: import { MAX_METADATA_BYTES } from '@package-broker/core/catalogue/metadata'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:opaque dependency: import { validateVersion, type VersionEcosystem } from '@package-broker/core/catalogue/versions'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:opaque dependency: import { parseHistoryDate } from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque dependency: import {\n  CATALOGUE_SYNC_VERSIONS_PER_CALL,\n  type CatalogueWriteGuard,\n  type SyncRefusal,\n  type SyncResult,\n  type VersionInput,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque dependency: import { MAX_METADATA_BYTES } from '@package-broker/core/catalogue/metadata'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque dependency: import { validateVersion, type VersionEcosystem } from '@package-broker/core/catalogue/versions'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque dependency: import { parseHistoryDate } from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/repositories/closure-edges.ts:opaque dependency: import {\n  CATALOGUE_KEY_LIST_MAX,\n  CATALOGUE_PAGE_MAX,\n  CATALOGUE_WINNER_KEYS_MAX,\n  validateLimit,\n  type CatalogueReader,\n  type CatalogueSourceType,\n  type EdgePage,\n  type EdgeRow,\n  type KeyClass,\n  type KeyClassification,\n  type WinnerCandidate,\n  type WinnerClassification,\n} from '@package-broker/core/db/catalogue'; #1",
        "db-sqlite/src/repositories/credential.ts:opaque dependency: import { DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/credential.ts:opaque dependency: import { credentialAad, type Sealed } from '@package-broker/core/secrets/cipher'; #1",
        "db-sqlite/src/repositories/fetch-lease.ts:opaque dependency: import { sha256Hex } from '@package-broker/core/auth/primitives'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import {\n  completeSourceListing,\n  completeVersionListing,\n} from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { MassAbsenceError } from '@package-broker/core/ingest/absence-guard'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { parsePendingValidators, type UpstreamForm } from '@package-broker/core/ingest/validators'; #1",
        "db-sqlite/src/repositories/ingest-session.ts:opaque dependency: import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/ingest-session.ts:opaque dependency: import { parsePendingValidators } from '@package-broker/core/ingest/validators'; #1",
        "db-sqlite/src/repositories/ingest-session.ts:opaque dependency: import { ulid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/job-schedule.ts:opaque dependency: import { ulid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/job-schedule.ts:opaque dependency: import {\n  DEFAULT_MAX_ATTEMPTS,\n  MAX_IDEMPOTENCY_KEY_LENGTH,\n  MAX_JOB_ATTEMPTS,\n  assertQualifiedJobName,\n  normalizeRunAt,\n  validateSchedule,\n} from '@package-broker/core/platform/jobs'; #1",
        "db-sqlite/src/repositories/job.ts:opaque dependency: import { DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/job.ts:opaque dependency: import {\n  IdempotencyConflictError,\n  JOB_LEASE_SECONDS,\n  JOB_REAP_PAGE_LIMIT,\n  JOB_STATUS_HISTORY_LIMIT,\n  StaleFenceError,\n  type JobClaim,\n  type JobEnqueue,\n  type JobGuard,\n  type JobRepository,\n  type JobSettle,\n} from '@package-broker/core/platform/job-repository'; #1",
        "db-sqlite/src/repositories/job.ts:opaque dependency: import {\n  JobError,\n  MAX_JOB_ATTEMPTS,\n  normalizeRunAt,\n  retryDelaySeconds,\n  type JobAttemptOutcome,\n  type JobAttemptSummary,\n  type JobErrorCode,\n  type JobState,\n  type JobStatus,\n} from '@package-broker/core/platform/jobs'; #1",
        "db-sqlite/src/repositories/keyring-verifier.ts:opaque dependency: import { PASSWORD_HASH_PATTERN, PASSWORD_ITERATIONS } from '@package-broker/core/auth/password'; #1",
        "db-sqlite/src/repositories/keyring-verifier.ts:opaque dependency: import { base64urlDecode } from '@package-broker/core/auth/primitives'; #1",
        "db-sqlite/src/repositories/keyring-verifier.ts:opaque dependency: import { credentialAad } from '@package-broker/core/secrets/cipher'; #1",
        "db-sqlite/src/repositories/keyring-verifier.ts:opaque dependency: import {\n  KeyringMismatchError,\n  KeyringVersionInUseError,\n  KeyringPasswordHashUnreadableError,\n  KeyringStoreUnavailableError,\n  type KeyringVerifierStore,\n  type StoredVerifier,\n} from '@package-broker/core/secrets/keyring-verifier'; #1",
        "db-sqlite/src/repositories/project.ts:opaque dependency: import {\n  isValidProjectSlug,\n  projectSlugProblem,\n  reservedFirstSegments,\n} from '@package-broker/core/authz/project-path'; #1",
        "db-sqlite/src/repositories/project.ts:opaque dependency: import { PROJECT_LIST_MAX_LIMIT } from '@package-broker/core/authz/project-list'; #1",
        "db-sqlite/src/repositories/project.ts:opaque dependency: import {\n  PROJECT_NAME_MAX_LENGTH,\n  TOKEN_MAX_SCOPES,\n  type ProjectStatus,\n  type ProjectStore,\n  type TokenMaxScope,\n} from '@package-broker/core/authz/project-service'; #1",
        "db-sqlite/src/repositories/project.ts:opaque dependency: import { isUlid, ulid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/provider-binding.ts:opaque dependency: import {\n  isReservedProviderId,\n  isValidProviderId,\n  isValidTrustAnchor,\n} from '@package-broker/core/identity/port'; #1",
        "db-sqlite/src/repositories/registered-name.ts:opaque dependency: import {\n  MAX_PATTERN_BYTES,\n  MAX_PATTERN_WILDCARDS,\n  isValidPattern,\n} from '@package-broker/core/catalogue/patterns'; #1",
        "db-sqlite/src/repositories/session-liveness.ts:opaque dependency: import { SESSION_ABSOLUTE_MS } from '@package-broker/core/auth/session'; #1",
        "db-sqlite/src/repositories/source-attachment-counts.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/source.ts:opaque dependency: import { DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/repositories/upstream-state.ts:opaque dependency: import { assertHeaderValue } from '@package-broker/core/ingest/validators'; #1",
        "db-sqlite/src/repositories/visibility-attach.ts:opaque dependency: import { isUlid } from '@package-broker/core/ids'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:opaque dependency: import { isValidPattern, MAX_PATTERNS_PER_RULE } from '@package-broker/core/catalogue/patterns'; #1",
        "db-sqlite/src/repositories/vulnerability.ts:opaque dependency: import { displayName, packageKey } from '@package-broker/core/catalogue/names'; #1",
        "db-sqlite/src/repositories/vulnerability.ts:opaque dependency: import { matchesPattern } from '@package-broker/core/catalogue/patterns'; #1",
        "db-sqlite/src/repositories/vulnerability.ts:opaque dependency: import { parseSourceConfig, type SourceType } from '@package-broker/core/sources/config'; #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:opaque dependency: import { isValidPattern } from '@package-broker/core/catalogue/patterns'; #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:opaque dependency: import { deriveVisibility, type VisibilityConfig } from '@package-broker/core/catalogue/visibility'; #1",
        "db-sqlite/src/testing/foreign-keys-off.ts:opaque dependency: import { DbError } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/testing/migrated-database.ts:opaque dependency: import {\n  completeVersionListing,\n  type CompleteVersionListing,\n} from '@package-broker/core/catalogue/version-rules'; #1",
        "db-sqlite/src/testing/mutation-table/catalogue-reblob.ts:opaque dependency: import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:opaque dependency: import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:opaque dependency: import { mutationFence } from '@package-broker/core/authz/fence'; #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:opaque dependency: import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata'; #1",
        "db-sqlite/src/testing/sql-snapshot.ts:opaque dependency: import {\n  D1_STATEMENTS_PER_BATCH,\n  type ScalarSqlValue,\n  type SqlExecutor,\n  type Statement,\n} from '@package-broker/core/db/port'; #1",
        "db-sqlite/src/testing/sql-snapshot.ts:opaque dependency: import { assertBatchStatementCount } from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque dependency: import {\n  DbError,\n  assertBatchStatementCount,\n  classifySqliteError,\n} from '@package-broker/core/db/errors'; #1",
        "runtime-cloudflare/src/db/d1-executor.ts:opaque dependency: import {\n  DbError,\n  assertBatchStatementCount,\n  classifySqliteError,\n} from '@package-broker/core/db/errors'; #1",
        "db-sqlite/src/testing/catalogue-fixture.ts:opaque dependency: import {\n  D1_STATEMENTS_PER_BATCH,\n  D1_STATEMENTS_PER_INVOCATION,\n  type ScalarSqlExecutor,\n  type ScalarStatement,\n} from '@package-broker/core/db/port'; #1",
      ],
    },
    {
      reason:
        'Port types, the NPM_AUDIT_REFS_MAX numeric constant and the VulnerabilitySnapshotError class from the core vulnerability port; no executor, SQL or D1 call crosses this import.',
      sites: [
        "db-sqlite/src/repositories/vulnerability.ts:opaque dependency: import {\n  NPM_AUDIT_REFS_MAX,\n  VulnerabilitySnapshotError,\n  type AuthorizedNpmAudit,\n  type NpmAuditAuthorizer,\n  type NpmAuditRef,\n  type NpmAuditTuple,\n} from '@package-broker/core/db/vulnerability'; #1",
      ],
    },
    {
      reason:
        'Installed Kysely API is an opaque boundary; local builders, SQL inputs and count consumers are reviewed separately.',
      sites: [
        "db-sqlite/src/internal/catalogue-status-statements.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/internal/catalogue-write-guard.ts:opaque dependency: import { sql, type RawBuilder, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/internal/lease-time.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/kysely.ts:opaque dependency: import {\n  DummyDriver,\n  Kysely,\n  SqliteAdapter,\n  SqliteIntrospector,\n  SqliteQueryCompiler,\n  expressionBuilder,\n  sql,\n  type Compilable,\n  type Expression,\n  type OperationNode,\n  type QueryCreator,\n  type SelectQueryBuilder,\n  type SqlBool,\n} from 'kysely'; #1",
        "db-sqlite/src/repositories/access.ts:opaque dependency: import {\n  expressionBuilder,\n  sql,\n  type Expression,\n  type Kysely,\n  type QueryCreator,\n  type SelectQueryBuilder,\n  type SqlBool,\n} from 'kysely'; #1",
        "db-sqlite/src/repositories/actor-authority.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/blob-access.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/blob-lease-guard.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/blob.ts:opaque dependency: import { sql, type Compilable, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-dist.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-list.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-lookup.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:opaque dependency: import { sql, type Expression, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-read.ts:opaque dependency: import { sql, type RawBuilder, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-reblob.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-reconcile.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-write-dist.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-write-package.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-write-tags.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-insert.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/catalogue-write-version-update.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/closure-edges.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/credential.ts:opaque dependency: import { sql, type Compilable } from 'kysely'; #1",
        "db-sqlite/src/repositories/fetch-lease.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/idempotency.ts:opaque dependency: import { sql, type RawBuilder, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/ingest-finalize.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/ingest-session.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/job-lease-guard.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/job-schedule.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/job.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/keyring-verifier.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/local-login-setup.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/local-login-success.ts:opaque dependency: import { expressionBuilder, sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/project.ts:opaque dependency: import { expressionBuilder, sql, type Compilable, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/provider-binding.ts:opaque dependency: import { sql } from 'kysely'; #1",
        "db-sqlite/src/repositories/proxy-admission.ts:opaque dependency: import { sql, type Kysely } from 'kysely'; #1",
        "db-sqlite/src/repositories/registered-name.ts:opaque dependency: import { sql, type Expression, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/session-liveness.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/session.ts:opaque dependency: import { expressionBuilder, sql, type Compilable } from 'kysely'; #1",
        "db-sqlite/src/repositories/source.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/upstream-state.ts:opaque dependency: import { sql, type RawBuilder } from 'kysely'; #1",
        "db-sqlite/src/repositories/visibility-attach.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/visibility-derive.ts:opaque dependency: import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/repositories/visibility-subset.ts:opaque dependency: import { sql, type SqlBool } from 'kysely'; #1",
        "db-sqlite/src/testing/mutation-table/fixtures.ts:opaque dependency: import { sql } from 'kysely'; #1",
      ],
    },
    {
      reason:
        'Fixture migration reader; filesystem access supplies schema setup, not executor counts.',
      sites: [
        "db-sqlite/src/testing/migrated-database.ts:opaque dependency: import { readdirSync, readFileSync } from 'node:fs'; #1",
      ],
    },
    {
      reason:
        'Native SQLite executor boundary; raw changes adaptation and callers have separate count reviews.',
      sites: [
        "db-sqlite/src/testing/node-sqlite-executor.ts:opaque dependency: import { DatabaseSync, type StatementSync } from 'node:sqlite'; #1",
      ],
    },
    {
      reason:
        'Audit condition embeds only the compiled organization-scoped operation marker and session effect guards with bound parameters; no D1 changes() read.',
      sites: [
        'db-sqlite/src/repositories/local-login-success.ts:SQL input: sql: `(${when.sql}) = 1` #1',
      ],
    },

    {
      reason:
        'Claim builders import the npm name limit and Kysely expression types; these dependencies add no result-count reads or writes.',
      sites: [
        "db-sqlite/src/repositories/catalogue-predicates.ts:opaque dependency: import { MAX_NPM_NAME_LENGTH } from '@package-broker/core/catalogue/names'; #1",
      ],
    },
    {
      reason:
        'Claim coverage uses bounded ASCII equality and scope prefixes; legacy GLOB stays behind its pattern validator, with no writes or count reads.',
      sites: [
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`(${ecosystem} = 'npm'\n    and length(${pattern}) between 1 and ${sql.lit(MAX_NPM_NAME_LENGTH)}\n    and length(cast(${pattern} as blob)) = length(${pattern})\n    and ${pattern} not glob '*[^a-z0-9._~@!/*-]*'\n    and (instr(${pattern}, '*') = 0 or\n      (substr(${pattern}, 1, 1) = '@' and substr(${pattern}, -2) = '/*' and instr(${pattern}, '*') = length(${pattern})))\n    and (${key} = ${pattern} or (substr(${pattern}, -2) = '/*'\n      and substr(${key}, 1, length(${pattern}) - 1) = substr(${pattern}, 1, length(${pattern}) - 1))))` #1",
        "db-sqlite/src/repositories/catalogue-predicates.ts:SQL template: sql<SqlBool>`(\n    ${at(pkg.source, 'type')} not in ${PROXY_TYPES}\n    or (\n      not exists (\n        select 1 from package as ${sql.id(a.q)} indexed by package_by_name\n        join source as ${sql.id(a.qs)} on ${at(a.qs, 'id')} = ${at(a.q, 'source_id')}\n          and ${at(a.qs, 'org_id')} = ${p('org_id')}\n        where ${at(a.q, 'org_id')} = ${p('org_id')}\n          and ${at(a.q, 'ecosystem')} = ${p('ecosystem')}\n          and ${at(a.q, 'name')} = ${p('name')}\n          and ${at(a.qs, 'type')} not in ${PROXY_TYPES}\n      )\n      and not exists (\n        select 1 from registered_name as ${sql.id(a.r)}\n        where ${at(a.r, 'org_id')} = ${p('org_id')}\n          and ${at(a.r, 'ecosystem')} = ${p('ecosystem')}\n          and (case when ${at(a.r, 'ecosystem')} = 'npm' and length(${at(a.r, 'pattern')}) > ${sql.lit(MAX_PATTERN_BYTES)} and ${npmClaimCover(at(a.r, 'ecosystem'), at(a.r, 'pattern'), at(a.r, 'pattern'))}\n            then ${npmClaimCover(at(a.r, 'ecosystem'), at(a.r, 'pattern'), p('name'))}\n            when ${invalidPattern(at(a.r, 'pattern'))} then 1 else ${p('name')} glob ${at(a.r, 'pattern')} end)\n      )\n    )\n  )` #1",
      ],
    },
    {
      reason:
        'Registered-name coverage delegates npm exact/scope claims to the shared helper and keeps legacy glob validation bounded before matching.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from registered_name as rn_cov\n    where rn_cov.org_id = ${ctx.orgId} and rn_cov.source_id = ${sourceId}\n      and rn_cov.ecosystem = ${ecosystem}\n      and (${npmClaimCover(sql.ref('rn_cov.ecosystem'), sql.ref('rn_cov.pattern'), sql`${key}`)}\n      or (case when rn_cov.pattern not glob '*[^a-z0-9._~@!/*-]*'\n      and length(cast(rn_cov.pattern as blob)) = length(rn_cov.pattern)\n      and length(rn_cov.pattern) between 1 and ${sql.lit(MAX_PATTERN_BYTES)}\n      and length(rn_cov.pattern) - length(replace(rn_cov.pattern, '*', ''))\n        <= ${sql.lit(MAX_PATTERN_WILDCARDS)}\n        then ${key} glob rn_cov.pattern else 0 end)))` #1",
      ],
    },
    {
      reason:
        'Upstream verification reads any organization npmjs_proxy, independently of attachments; the source organization fence remains required.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as claim_proxy\n      where claim_proxy.org_id = ${ctx.orgId} and claim_proxy.type = 'npmjs_proxy'\n        ${id === undefined ? sql`` : sql`and claim_proxy.id = ${id}`})` #1",
      ],
    },
    {
      reason:
        'Hosted admission checks cached public packages only on other sources in the same organization; this read neither mutates rows nor reads counts.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (\n        select 1 from package as claim_package join source as claim_source\n          on claim_source.id = claim_package.source_id and claim_source.org_id = ${ctx.orgId}\n        where claim_package.org_id = ${ctx.orgId} and claim_package.ecosystem = 'npm'\n          and claim_package.source_id <> ${input.sourceId}\n          and claim_source.type in ('npmjs_proxy', 'npm_registry')\n          and (claim_package.name = ${input.pattern}\n            ${input.pattern.endsWith('/*') ? sql`or substr(claim_package.name, 1, ${input.pattern.length - 1}) = ${input.pattern.slice(0, -1)}` : sql``}))` #1",
      ],
    },
    {
      reason:
        'Claim verification composes organization-scoped read predicates only; no mutation, D1 changes read or FK effect is introduced.',
      sites: [
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`not ${organizationProxy(ctx)}` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`1` #2',
      ],
    },
    {
      reason:
        'Replacement refuses to uncover any destination package covered by the old claim; both package and claim are scoped by organization and source inside the write batch.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`not exists (\n        select 1 from package as owned_package join registered_name as old_claim\n          on old_claim.org_id = ${ctx.orgId} and old_claim.id = ${input.id} and old_claim.source_id = ${input.sourceId}\n        where owned_package.org_id = ${ctx.orgId} and owned_package.source_id = ${input.sourceId}\n          and ${npmClaimCover(sql.lit('npm'), sql.ref('old_claim.pattern'), sql.ref('owned_package.name'))}\n          and not ${npmClaimCover(sql.lit('npm'), sql`${input.pattern}`, sql.ref('owned_package.name'))}\n      )` #1",
      ],
    },
    {
      reason:
        'Registered-name batch rechecks organization, authority, stored-package overlap, public-name verification, replacement coverage and audit snapshot before one fenced insert/update; it never reads a D1 result count.',
      sites: [
        'db-sqlite/src/repositories/registered-name.ts:builder variable: const outcome = await runOrgFenced(\n        executor,\n        ctx,\n        fence,\n        assertGuard(allOf([held, sourceUnchanged]), ctx),\n        [\n          ...assertCheck(visible),\n          ...assertCheck(sql<SqlBool>`not ${otherSource}`),\n          ...assertCheck(sql<SqlBool>`not ${storedOverlap}`),\n          ...assertCheck(sql<SqlBool>`not ${cachedPublic}`),\n          ...assertCheck(verified),\n          ...assertCheck(retainsPackages),\n          ...(input.previousPattern === undefined\n            ? []\n            : assertCheck(\n                sql<SqlBool>`exists (select 1 from registered_name where org_id = ${ctx.orgId} and id = ${input.id} and source_id = ${input.sourceId} and pattern = ${input.previousPattern})`,\n              )),\n          ...(input.replace\n            ? assertCheck(\n                sql<SqlBool>`exists (select 1 from registered_name where org_id = ${ctx.orgId} and id = ${input.id} and source_id = ${input.sourceId})`,\n              )\n            : []),\n          insert,\n          auditPendingStatement(ctx, input.audit),\n          ...(input.idempotency === undefined\n            ? []\n            : [idempotencyInsertStatement(ctx, input.idempotency)]),\n        ],\n        {\n          authority: probe(held, true),\n          conflict: probe(\n            sql<SqlBool>`(${liveIdempotencyCollision(ctx, input.idempotency)} or ${otherSource})`,\n            false,\n          ),\n          collision: probe(sameSource, false),\n        },\n      ); #1',
      ],
    },
    {
      reason:
        'Claim validation imports a pure npm grammar helper without SQL mutations or result-count reads.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:opaque dependency: import { isNpmClaim } from '@package-broker/core/sources/claim-admission'; #1",
      ],
    },
    {
      reason:
        'Claim admission composes organization-scoped read predicates; source identity and ownership are rechecked without reading mutation counts.',
      sites: [
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from registered_name as existing\n        where existing.org_id = ${ctx.orgId}\n          and ${input.replace ? sql`existing.id <> ${input.id} and` : sql``} (existing.id = ${input.id}\n            or (existing.source_id = ${input.sourceId} and existing.ecosystem = ${source.ecosystem}\n              and existing.pattern = ${input.pattern})))` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from registered_name\n        where org_id = ${ctx.orgId} and ecosystem = ${source.ecosystem}\n          and source_id <> ${input.sourceId} and pattern = ${input.pattern})` #1',
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from package as stored_package\n          join source as stored_source on stored_source.id = stored_package.source_id\n            and stored_source.org_id = ${ctx.orgId}\n          where stored_package.org_id = ${ctx.orgId} and stored_package.ecosystem = 'npm'\n            and stored_package.source_id <> ${input.sourceId}\n            and stored_source.type not in (${sql.join(PROXY_TYPES)})\n            and ${npmClaimCover(sql.lit('npm'), sql`${input.pattern}`, sql.ref('stored_package.name'))})` #1",
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`0` #2',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`0` #1',
        'db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`1` #1',
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from source as owner\n        where owner.id = ${input.sourceId} and owner.org_id = ${ctx.orgId}\n          and owner.ecosystem = ${source.ecosystem}\n          and owner.type = ${source.type}\n          and (owner.type <> 'hosted' or owner.project_id is null))` #1",
      ],
    },
    {
      reason:
        'Registered-name insertion or replacement changes only the claim row under organization and source fences; no referenced key or D1 result-count dependency changes.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:builder variable: const insert = input.replace\n        ? compile(\n            db\n              .updateTable('registered_name')\n              .set({ pattern: input.pattern })\n              .where('org_id', '=', ctx.orgId)\n              .where('id', '=', input.id)\n              .where('source_id', '=', input.sourceId),\n          )\n        : compile(\n            db.insertInto('registered_name').values({\n              id: input.id,\n              org_id: ctx.orgId,\n              source_id: input.sourceId,\n              ecosystem: source.ecosystem,\n              pattern: input.pattern,\n            }),\n          ); #1",
      ],
    },
    {
      reason:
        'Overlap checks organization-scoped registrations, comparing bounded legacy globs and compatible literal prefixes conservatively; destination registrations are excluded.',
      sites: [
        "db-sqlite/src/repositories/registered-name.ts:SQL template: sql<SqlBool>`exists (select 1 from registered_name as existing\n        where existing.org_id = ${ctx.orgId} and existing.ecosystem = ${source.ecosystem}\n          and existing.source_id <> ${input.sourceId}\n          and (existing.pattern = ${input.pattern}\n            ${\n              source.ecosystem !== 'npm'\n                ? sql``\n                : sql`or\n              ((${source.type} = 'hosted' or exists (select 1 from source as overlap_participant where overlap_participant.org_id = ${ctx.orgId} and overlap_participant.id = existing.source_id and overlap_participant.type = 'hosted')) and (\n              (${input.pattern.includes('*') ? 1 : 0} = 1\n                and substr(existing.pattern, 1, min(case when instr(existing.pattern, '*') > 0 then instr(existing.pattern, '*') - 1 else length(existing.pattern) end, ${input.pattern.split('*')[0]!.length})) = substr(${input.pattern}, 1, min(case when instr(existing.pattern, '*') > 0 then instr(existing.pattern, '*') - 1 else length(existing.pattern) end, ${input.pattern.split('*')[0]!.length})))\n              or\n              (case when length(existing.pattern) <= ${sql.lit(MAX_PATTERN_BYTES)} then ${input.pattern} glob existing.pattern else 0 end)\n              or (substr(existing.pattern, -2) = '/*' and instr(existing.pattern, '*') = length(existing.pattern)\n                and substr(${input.pattern}, 1, length(existing.pattern) - 1) = substr(existing.pattern, 1, length(existing.pattern) - 1))\n              ${input.pattern.endsWith('/*') ? sql`or substr(existing.pattern, 1, ${input.pattern.length - 1}) = ${input.pattern.slice(0, -1)}` : sql``}))`\n            }))` #1",
      ],
    },
  ].flatMap(({ reason, sites }) => sites.map((site) => [site, reason])),
);

const UNCERTAIN_CACHE = new Map<string, ReadSite[]>();
const MUTATOR = /^(insertInto|updateTable|deleteFrom)$/;
const COUNT_KEY =
  /^(changes|changesCount|affectedRows|rowCount|numUpdatedRows|numDeletedRows|numInsertedOrUpdatedRows)$/;

function uncertain(source: string, mutations = true): ReadSite[] {
  const cacheKey = `${mutations}:${source}`;
  const cached = UNCERTAIN_CACHE.get(cacheKey);
  if (cached) return cached;
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const staticString = staticStrings(file);
  const found = new Map<ts.Node, ReadSite>();
  function add(kind: string, node: ts.Node): void {
    const expression = `${kind}: ${node.getText(file)}`;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    if (!found.has(node)) found.set(node, { expression, line });
  }
  function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
    visitor(node);
    ts.forEachChild(node, (child) => walk(child, visitor));
  }
  function method(node: ts.Node): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
      const keys = staticString(node.argumentExpression);
      return keys?.length === 1 ? keys[0] : undefined;
    }
    return undefined;
  }
  function statement(node: ts.Node): ts.Node {
    while (node.parent && !ts.isStatement(node)) node = node.parent;
    return node;
  }
  // Track local builder aliases by symbol. Every use is reviewed, rather than assuming
  // a builder cannot gain conflict actions after its initial fluent expression.
  const options = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
  const builders = new Set<ts.Symbol>();
  let changed = mutations;
  while (changed) {
    changed = false;
    walk(file, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name))
        return;
      let builder = false;
      walk(node.initializer, (child) => {
        const key = method(child);
        if (key && MUTATOR.test(key)) builder = true;
        if (ts.isIdentifier(child)) {
          const symbol = checker.getSymbolAtLocation(child);
          if (symbol && builders.has(symbol)) builder = true;
        }
      });
      const symbol = checker.getSymbolAtLocation(node.name);
      if (builder && symbol && !builders.has(symbol)) {
        builders.add(symbol);
        changed = true;
      }
    });
  }
  walk(file, (node) => {
    const dependency = mutations && runtimeDependency(node);
    if (dependency && !dependency.startsWith('.')) add('opaque dependency', node);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && builders.has(symbol)) add('builder variable', statement(node));
    }
    if (ts.isElementAccessExpression(node)) {
      const keys = staticString(node.argumentExpression);
      if (keys === undefined && !ts.isNumericLiteral(node.argumentExpression))
        add('unresolved computed access', node);
      else if (keys?.some((key) => COUNT_KEY.test(key) && key !== 'changes'))
        add('executor count', node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      COUNT_KEY.test(node.name.text) &&
      node.name.text !== 'changes'
    )
      add('executor count', node);
    if (ts.isComputedPropertyName(node) && staticString(node.expression) === undefined)
      add('unresolved computed key', statement(node));
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      if (node.dotDotDotToken) add('object rest access', node);
      const key = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
        COUNT_KEY.test(key.text) &&
        key.text !== 'changes'
      )
        add('executor count', node);
    }
    // No SQL grammar is assumed here. Even malformed statements and raw UPSERT
    // actions retain their complete text for review instead of disappearing from a regex.
    if (mutations && ts.isTaggedTemplateExpression(node)) add('SQL template', node);
    if (
      mutations &&
      ts.isStringLiteralLike(node) &&
      !ts.isTaggedTemplateExpression(node.parent) &&
      /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT)\b/i.test(node.text)
    )
      add('SQL text', node);
    if (mutations && ts.isPropertyAssignment(node) && methodName(node.name) === 'sql')
      add('SQL input', node);

    if (ts.isCallExpression(node)) {
      const key = method(node.expression);
      if (
        key === 'get' &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'Reflect'
      ) {
        const keys = node.arguments[1] && staticString(node.arguments[1]);
        if (!keys || keys.some((name) => COUNT_KEY.test(name)))
          add('reflective count access', node);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'Object' &&
        key &&
        /^(values|entries|assign|getOwnPropertyDescriptor|getOwnPropertyDescriptors)$/.test(key)
      )
        add('opaque object access', node);
      if (ts.isElementAccessExpression(node.expression) && (!key || MUTATOR.test(key)))
        add('computed builder call', node);
      if (
        mutations &&
        key &&
        /^(onConflict|orReplace|orIgnore|orAbort|orFail|orRollback|ignore|doNothing|doUpdateSet)$/.test(
          key,
        )
      )
        add('conflict action', node);
      if (mutations && key && /^(raw|prepare|exec|executeQuery)$/.test(key))
        add('opaque SQL input', node);
      if (
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        add('dynamic dependency', node);
    }
  });
  if (mutations) mutationTargets(source, 'module.ts', (node) => add('unresolved mutation', node));
  // Keep the outermost uncertain expression: its exact text covers every nested site.
  const sites = [...found]
    .filter(([node]) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (found.has(parent)) return false;
      }
      return true;
    })
    .map(([, site]) => site);
  // TypeScript recovers an AST after syntax errors; recovery must not erase a site.
  for (const diagnostic of ts
    .createProgram([file.fileName], options, host)
    .getSyntacticDiagnostics(file)) {
    sites.push({
      expression: `unparseable TypeScript: ${source}`,
      line: file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
    });
  }
  UNCERTAIN_CACHE.set(cacheKey, sites);
  return sites;
}

function methodName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}

function uncertainInventory(sources: Readonly<Record<string, string>>) {
  const mutationFiles = new Set([
    ...Object.entries(sources)
      .filter(([, source]) => reads(source).length)
      .map(([file]) => file),
    ...importedBuilders(sources),
  ]);
  return Object.fromEntries(
    Object.entries(sources).flatMap(([file, source]) => {
      const occurrences = new Map<string, number>();
      const sites = [...uncertain(source, mutationFiles.has(file))];
      if (mutationFiles.has(file)) {
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        for (const node of parsed.statements) {
          const specifier = runtimeDependency(node);
          if (
            specifier?.startsWith('.') &&
            sources[join(dirname(file), specifier).replace(/\.js$/, '.ts')] === undefined
          ) {
            sites.push({
              expression: `unresolved dependency: ${node.getText(parsed)}`,
              line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
            });
          }
        }
      }
      return sites.map(({ expression, line }) => {
        const occurrence = (occurrences.get(expression) ?? 0) + 1;
        occurrences.set(expression, occurrence);
        return [`${file}:${expression} #${occurrence}`, { file, line }];
      });
    }),
  );
}

function assertUncertain(
  sources: Readonly<Record<string, string>>,
  reviewed: Readonly<Record<string, string>> = REVIEWED_UNCERTAIN,
): void {
  const sites = uncertainInventory(sources);
  const errors = Object.entries(sites)
    .filter(([key]) => !reviewed[key]?.trim() || /[\r\n]/.test(reviewed[key]!))
    .map(
      ([key, { file, line }]) =>
        `${file}:${line}: Unreviewed site (add an exact entry with a one-line reason): ${key}`,
    );
  for (const key of Object.keys(reviewed)) {
    if (!sites[key]) errors.push(`Stale reviewed site: ${key}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

function sourcesUnder(root: string): Record<string, string> {
  return Object.fromEntries(
    ['db-sqlite', 'runtime-cloudflare'].flatMap((name) =>
      modules(join(root, name, 'src')).map((path) => [
        relative(root, path),
        readFileSync(path, 'utf8'),
      ]),
    ),
  );
}

function inventory(sources: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(sources).flatMap(([file, source]) => {
      const occurrences = new Map<string, number>();
      return reads(source).map(({ expression, line }) => {
        const occurrence = (occurrences.get(expression) ?? 0) + 1;
        occurrences.set(expression, occurrence);
        return [`${file}:${expression} #${occurrence}`, { file, line }];
      });
    }),
  );
}

function assertReviewed(
  sources: Readonly<Record<string, string>>,
  reviewed: Readonly<Record<string, Review>> = REVIEWED,
): void {
  const sites = inventory(sources);
  const unreviewed = Object.entries(sites)
    .filter(([key]) => reviewed[key] === undefined)
    .map(([key, { file, line }]) => `${file}:${line}: Unreviewed changes read: ${key}`);
  const stale = Object.keys(reviewed)
    .filter((key) => sites[key] === undefined)
    .map((key) => `Stale reviewed changes read: ${key}`);
  if (unreviewed.length || stale.length) throw new Error([...unreviewed, ...stale].join('\n'));
}

function runtimeDependency(node: ts.Node): string | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return undefined;
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return undefined;
  if (ts.isImportDeclaration(node)) {
    if (node.importClause?.isTypeOnly) return undefined;
    const bindings = node.importClause?.namedBindings;
    if (
      bindings &&
      ts.isNamedImports(bindings) &&
      !node.importClause?.name &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    )
      return undefined;
  } else {
    if (node.isTypeOnly) return undefined;
    if (
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly)
    )
      return undefined;
  }
  return node.moduleSpecifier.text;
}

function importedBuilders(sources: Readonly<Record<string, string>>): string[] {
  const dependencies = new Set<string>();
  const visited = new Set<string>();
  function visit(reader: string): void {
    if (visited.has(reader)) return;
    visited.add(reader);
    const file = ts.createSourceFile(reader, sources[reader]!, ts.ScriptTarget.Latest, true);
    for (const node of file.statements) {
      const specifier = runtimeDependency(node);
      if (!specifier?.startsWith('.')) continue;
      const dependency = join(dirname(reader), specifier).replace(/\.js$/, '.ts');
      // Missing/opaque boundaries are separately recorded as uncertain sites with reasons.
      if (sources[dependency] === undefined) continue;
      dependencies.add(dependency);
      visit(dependency);
    }
  }
  for (const [reader, source] of Object.entries(sources)) {
    if (reads(source).length) visit(reader);
  }
  return [...dependencies].sort();
}

function mutationTargets(
  source: string,
  name = 'module.ts',
  onUnresolved?: (node: ts.Node) => void,
): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const staticString = staticStrings(file);
  const targets: string[] = [];
  function unresolved(node: ts.Node): void {
    if (onUnresolved) {
      targets.push(`UNRESOLVED mutation: ${node.getText(file)}`);
      onUnresolved(node);
      return;
    }
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    throw new Error(
      `${name}:${line}: Unreviewed site: Unresolved mutation target or conflict action: ${node.getText(file)}`,
    );
  }
  function conflicts(call: ts.CallExpression): string {
    const actions: string[] = [];
    let node: ts.Node = call;
    while (
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      ts.isCallExpression(node.parent.parent) &&
      node.parent.parent.expression === node.parent
    ) {
      const next = node.parent.parent;
      const method = node.parent.name.text;
      if (/^(orIgnore|orAbort|orFail|orReplace|orRollback|ignore)$/.test(method)) {
        actions.push(method);
      } else if (method === 'onConflict') {
        const conflictActions: string[] = [];
        function visitAction(action: ts.Node): void {
          if (
            ts.isCallExpression(action) &&
            ts.isPropertyAccessExpression(action.expression) &&
            /^(doNothing|doUpdateSet)$/.test(action.expression.name.text)
          ) {
            conflictActions.push(action.expression.name.text);
          }
          ts.forEachChild(action, visitAction);
        }
        for (const arg of next.arguments) visitAction(arg);
        if (!conflictActions.length) unresolved(next);
        actions.push(`onConflict:${conflictActions.sort().join('/')}`);
      }
      node = next;
    }
    return actions.length ? ` [${actions.join(', ')}]` : '';
  }
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(insertInto|updateTable|deleteFrom)$/.test(node.expression.name.text)
    ) {
      const tables = node.arguments.length === 1 ? staticString(node.arguments[0]!) : undefined;
      if (tables === undefined) {
        unresolved(node);
        return;
      }
      for (const table of tables) {
        targets.push(
          `${node.expression.name.text}('${table.replace(/'/g, "''")}')${conflicts(node)}`,
        );
      }
    }
    const sql = ts.isTemplateExpression(node)
      ? node.head.text +
        node.templateSpans.map((span, index) => ` ?${index}? ${span.literal.text}`).join('')
      : ts.isStringLiteralLike(node)
        ? node.text
        : undefined;
    if (sql !== undefined && /^\s*(WITH|INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      for (const match of sql.matchAll(
        /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z_0-9]*|\?\d+\?)/gi,
      )) {
        const table = match[2]!;
        const tables =
          table.startsWith('?') && ts.isTemplateExpression(node)
            ? staticString(node.templateSpans[Number(table.slice(1, -1))]!.expression, true)
            : [table];
        if (tables === undefined) {
          unresolved(node);
          return;
        }
        for (const table of tables) {
          if (table.toUpperCase() !== 'SET') {
            targets.push(`${match[1]!.toUpperCase().replace(/\s+/g, ' ')} ${table}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return targets.sort();
}

function builderTargets(sources: Readonly<Record<string, string>>) {
  const files = new Set([
    ...Object.entries(sources)
      .filter(([, source]) => reads(source).length)
      .map(([file]) => file),
    ...importedBuilders(sources),
  ]);
  return Object.fromEntries(
    [...files].sort().map((file) => {
      const counts = new Map<string, number>();
      for (const target of mutationTargets(sources[file]!, file, () => {})) {
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
      return [
        file,
        [...counts]
          .map(([target, count]) => (count === 1 ? target : `${target} x${count}`))
          .join('; '),
      ];
    }),
  );
}

function migrationSql(): string[] {
  const directory = new URL('../../db-sqlite/migrations/', import.meta.url);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), 'utf8'));
}

function inboundForeignKeys(sql: readonly string[], parents: readonly string[]) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of sql) db.exec(migration);
    const edges = db
      .prepare(
        `
      SELECT schema.name AS child, fk.*
      FROM sqlite_schema AS schema, pragma_foreign_key_list(schema.name) AS fk
      WHERE schema.type = 'table'
    `,
      )
      .all();
    return Object.fromEntries(
      parents.map((parent) => {
        if (
          db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(parent) === undefined
        ) {
          throw new Error(`Reviewed parent table is missing: ${parent}`);
        }
        return [
          parent,
          edges
            .filter((edge) => edge.table === parent)
            .map(
              (edge) =>
                `${edge.child}(${edge.from}) -> (${edge.to}): ON DELETE ${edge.on_delete}; ON UPDATE ${edge.on_update}`,
            )
            .sort(),
        ];
      }),
    );
  } finally {
    db.close();
  }
}

describe('D1 changes read-site scan', () => {
  const sources = sourcesUnder(ROOT);

  it('lists every changes read across both source trees with no stale reviewed sites', () => {
    assertReviewed(sources);
  });

  it('requires a reason for every uncertain site, with no stale entries', () => {
    assertUncertain(sources);
  });

  it('keeps transitive runtime imports of readers in the reviewed builder set', () => {
    expect(importedBuilders(sources)).toEqual(REVIEWED_IMPORTS);
    expect(builderTargets(sources)).toEqual(REVIEWED_TARGETS);
  });

  it('keeps the inbound FK actions relied on by every reviewed site', () => {
    const parents = [
      ...new Set(Object.values(REVIEWED).flatMap((review) => review.parents)),
    ].sort();
    expect(parents).toEqual(Object.keys(REVIEWED_PARENTS).sort());
    expect(inboundForeignKeys(migrationSql(), parents)).toEqual(REVIEWED_PARENTS);
  });

  it('records a one-line reason for every reviewed site', () => {
    expect(Object.keys(REVIEWED).length).toBeGreaterThan(0);
    for (const review of Object.values(REVIEWED)) {
      expect(review.reason.trim()).not.toBe('');
      expect(review.reason).not.toMatch(/[\r\n]/);
    }
  });

  it.each(['db-sqlite', 'runtime-cloudflare'])(
    'discovers a new fixture in %s and rejects its added or removed read',
    (name) => {
      const root = mkdtempSync(join(ROOT, '../.t939-scan-'));
      try {
        for (const pkg of ['db-sqlite', 'runtime-cloudflare']) {
          mkdirSync(join(root, pkg, 'src/nested'), { recursive: true });
        }
        const file = `${name}/src/nested/fixture.ts`;
        const path = join(root, file);
        writeFileSync(path, '\nresult.meta.changes;');
        expect(() => assertReviewed(sourcesUnder(root), {})).toThrow(`${file}:2`);
        const reviewed = {
          [`${file}:result.meta.changes #1`]: { reason: 'Fixture adapter.', parents: [] },
        };
        expect(() => assertReviewed(sourcesUnder(root), reviewed)).not.toThrow();
        writeFileSync(path, '\nresult.rows.length;');
        expect(() => assertReviewed(sourcesUnder(root), reviewed)).toThrow(
          `Stale reviewed changes read: ${file}:result.meta.changes #1`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('accepts unrelated edits and line shifts without changing review keys', () => {
    const reviewed = {
      'fixture.ts:result.changes #1': { reason: 'Fixture adapter.', parents: [] },
    };
    expect(() =>
      assertReviewed({ 'fixture.ts': '// unrelated edit\n\nresult.changes;' }, reviewed),
    ).not.toThrow();
  });

  it('allows unrelated edits in the four formerly stale source modules', () => {
    const edited = { ...sources };
    for (const file of [
      'repositories/catalogue-reconcile.ts',
      'repositories/ingest-finalize.ts',
      'repositories/registered-name.ts',
      'kysely.ts',
    ]) {
      const path = `db-sqlite/src/${file}`;
      edited[path] = `// Unrelated documentation edit.\n${sources[path]}`;
    }
    assertReviewed(edited);
    expect(importedBuilders(edited)).toEqual(REVIEWED_IMPORTS);
    expect(builderTargets(edited)).toEqual(REVIEWED_TARGETS);
  });

  it('rejects replacing a reviewed expression even if the read count stays unchanged', () => {
    const reviewed = {
      'fixture.ts:results[0].changes #1': { reason: 'Insert slot.', parents: [] },
    };
    expect(() => assertReviewed({ 'fixture.ts': 'results[1].changes;' }, reviewed)).toThrow(
      'fixture.ts:1',
    );
  });

  it('rejects copying a reviewed expression', () => {
    const reviewed = {
      'fixture.ts:result.changes #1': { reason: 'Fixture adapter.', parents: [] },
    };
    expect(() =>
      assertReviewed({ 'fixture.ts': 'result.changes;\nresult.changes;' }, reviewed),
    ).toThrow('fixture.ts:2');
  });

  it('detects a new aliased or namespace statement-builder import and skips type-only imports', () => {
    const source = `import type { Statement } from './port.js';
      import { type Result } from './types.js';
      import { insert as renamed } from './insert.js';
      import * as builders from './builders.js';
      result.changes;`;
    expect(importedBuilders({ 'reader.ts': source, 'insert.ts': '', 'builders.ts': '' })).toEqual([
      'builders.ts',
      'insert.ts',
    ]);
    expect(() => assertUncertain({ 'reader.ts': source }, {})).toThrow('unresolved dependency');
  });

  it('rejects an added read in a fixture with its file and line', () => {
    expect(() => assertReviewed({ 'db-sqlite/src/fixture.ts': '\nresult.meta.changes;' })).toThrow(
      'db-sqlite/src/fixture.ts:2',
    );
  });

  it('rejects an added executor-count read through a constant computed key', () => {
    const source = "const key = 'changes' as const;\nresult[key];";
    expect(reads(source)).toEqual([{ expression: 'result[key]', line: 2 }]);
    expect(() => assertReviewed({ 'fixture.ts': source }, {})).toThrow(
      'fixture.ts:2: Unreviewed changes read',
    );
  });

  it.each([
    "const key = 'changes' as const; const alias = key; result[alias];",
    "const key = ('changes' satisfies string); result[(key)];",
    "const key = 'changes'; const { [key]: count } = result;",
    "const key = 'changes'; ({ [key]: count } = result);",
  ])('resolves constant computed read keys: %s', (source) => {
    expect(reads(source)).toHaveLength(1);
    expect(() => assertReviewed({ 'fixture.ts': source }, {})).toThrow('fixture.ts:1');
  });

  it('resolves computed keys in their lexical scope', () => {
    const source = `const key = 'rows';
      function count() {
        const key = 'changes' as const;
        result[key];
      }
      result[key];`;
    expect(reads(source)).toEqual([{ expression: 'result[key]', line: 4 }]);
    expect(() =>
      assertUncertain(
        { 'fixture.ts': "const key = 'changes'; function rows(key: string) { result[key]; }" },
        {},
      ),
    ).toThrow('Unreviewed site');
  });

  it('rejects removing a reviewed site as stale', () => {
    expect(() =>
      assertReviewed(
        {},
        { 'fixture.ts:result.changes #1': { reason: 'Isolated table.', parents: [] } },
      ),
    ).toThrow('Stale reviewed changes read');
  });

  it.each([
    'result.changes',
    'result?.changes',
    'result.meta.changes',
    'result?.meta?.changes',
    'result[`changes`]',
    'const { meta: { changes: count } } = result;',
    'const copy = { ...changes };',
    'result["changes"]',
    "result['changes']",
    '({ changes } = result);',
    '({ changes: count } = result);',
    '({ nested: { changes } } = result);',
    '({ nested: { changes: count } } = result);',
    '(({ changes: count } = result));',
    '({ changes: (count) } = result);',
    '({ "changes": count } = result);',
    '({ ["changes"]: count } = result);',
    '({ changes: count = 0 } = result);',
    '([{ changes: count }] = results);',
    'const { changes } = result;',
    'const { changes: count } = result;',
    'const { changes }: StatementResult = result;',
    'const { changes: count }: StatementResult = result;',
    'function count({ changes }) {}',
    'function count({ changes: count }) {}',
    'function count({ changes }: StatementResult) {}',
    'function count({ changes: count }: StatementResult) {}',
    'const count = ({ changes }: StatementResult) => changes;',
    'const { "changes": count }: StatementResult = result;',
    'const { ["changes"]: count }: StatementResult = result;',
  ])('detects a new read via %s', (read) => {
    const source = `const statement = db.deleteFrom('identity');\n${read}`;
    expect(reads(source)).toHaveLength(1);
    expect(() => assertReviewed({ 'unreviewed.ts': source }, {})).toThrow('unreviewed.ts:2');
    expect(inventory({ 'unreviewed.ts': source })).not.toEqual(inventory({}));
  });

  it.each(['DELETE', 'UPDATE'])(
    'rejects an ON %s CASCADE FK added to a reviewed parent table',
    (action) => {
      const migration = `CREATE TABLE new_child (session_id TEXT REFERENCES session(id) ON ${action} CASCADE);`;
      expect(
        inboundForeignKeys([...migrationSql(), migration], Object.keys(REVIEWED_PARENTS)),
      ).not.toEqual(REVIEWED_PARENTS);
    },
  );

  it('derives inline, table-level, composite and ALTER TABLE FK actions from SQL syntax', () => {
    const sql = [
      'CREATE TABLE parent (org TEXT, id TEXT, PRIMARY KEY (org, id));',
      `CREATE TABLE child (
        parent_id TEXT REFERENCES "parent"(id) ON UPDATE CASCADE ON DELETE SET NULL,
        org TEXT,
        other_id TEXT,
        FOREIGN KEY (org, other_id) REFERENCES parent(org, id) ON DELETE RESTRICT ON UPDATE SET DEFAULT
      );`,
      'ALTER TABLE child ADD COLUMN added TEXT REFERENCES parent(id);',
      '-- REFERENCES parent(id) ON DELETE CASCADE',
    ];
    expect(inboundForeignKeys(sql, ['parent'])).toEqual({
      parent: [
        'child(added) -> (id): ON DELETE NO ACTION; ON UPDATE NO ACTION',
        'child(org) -> (org): ON DELETE RESTRICT; ON UPDATE SET DEFAULT',
        'child(other_id) -> (id): ON DELETE RESTRICT; ON UPDATE SET DEFAULT',
        'child(parent_id) -> (id): ON DELETE SET NULL; ON UPDATE CASCADE',
      ],
    });
  });

  it('ignores comments, strings, property declarations and aliases of other properties', () => {
    expect(
      reads(`// result.changes
      const text = 'result.changes';
      const { count: changes } = result;
      const object = { changes: 1 };
      ({ count: changes } = result);
      ({ nested: { count: changes } } = result);
      type Result = { changes: number };`),
    ).toEqual([]);
  });

  it('detects retargeting an approved statement without changing its read', () => {
    const source = "db.deleteFrom('session'); result.changes";
    expect(builderTargets({ 'module.ts': source.replace('session', 'identity') })).not.toEqual(
      builderTargets({ 'module.ts': source }),
    );
  });

  it('rejects REPLACE conflict handling in the existing version insertion builder', () => {
    const file = 'db-sqlite/src/repositories/catalogue-write-version-insert.ts';
    const original = sources[file]!;
    const replacement = original.replace(
      ".onConflict((oc) => oc.columns(['package_id', 'version_normalized']).doNothing())",
      '.orReplace()',
    );
    expect(replacement).not.toBe(original);
    assertReviewed({ ...sources, [file]: replacement });
    expect(builderTargets(sources)).toEqual(REVIEWED_TARGETS);
    expect(() =>
      expect(builderTargets({ ...sources, [file]: replacement })).toEqual(REVIEWED_TARGETS),
    ).toThrow();
  });

  it('rejects retargeting a DELETE after an interpolated CTE in an imported builder', () => {
    const sources = {
      'reader.ts': "import { remove } from './builder.js'; result.changes;",
      'builder.ts': 'export const remove = sql`WITH target AS (SELECT ${id}) DELETE FROM session`;',
    };
    const reviewed = { 'builder.ts': 'DELETE FROM session', 'reader.ts': '' };
    expect(builderTargets(sources)).toEqual(reviewed);
    expect(() =>
      expect(
        builderTargets({
          ...sources,
          'builder.ts': sources['builder.ts'].replace(
            'DELETE FROM session',
            'DELETE FROM identity',
          ),
        }),
      ).toEqual(reviewed),
    ).toThrow();
  });

  it('rejects changing the constant table in the existing imported visibility builder', () => {
    const file = 'db-sqlite/src/repositories/visibility-derive.ts';
    const original = sources[file]!;
    const replacement = original.replace("const ROW = 'project_package'", "const ROW = 'identity'");
    expect(replacement).not.toBe(original);
    assertReviewed({ ...sources, [file]: replacement });
    expect(importedBuilders(sources)).toContain(file);
    expect(mutationTargets(original)).toEqual([
      "deleteFrom('project_package')",
      "insertInto('project_package') [orIgnore]",
      "updateTable('project_package')",
    ]);
    expect(builderTargets(sources)).toEqual(REVIEWED_TARGETS);
    expect(() =>
      expect(builderTargets({ ...sources, [file]: replacement })).toEqual(REVIEWED_TARGETS),
    ).toThrow();
  });

  it.each([
    'db.deleteFrom(table)',
    "let table = 'session'; db.updateTable(table)",
    'const table = other; const other = table; db.insertInto(table)',
    "const table = 'session'; function remove(table: string) { db.deleteFrom(table); }",
    'sql`WITH target AS (SELECT ${id}) DELETE FROM ${table}`',
    "db.insertInto('version').onConflict(handler)",
  ])('fails closed on an unresolved mutation target or conflict action: %s', (source) => {
    expect(() => assertUncertain({ 'fixture.ts': `${source}; result.changes;` }, {})).toThrow(
      'fixture.ts:1: Unreviewed site',
    );
  });

  it('resolves table aliases and respects lexical shadowing', () => {
    expect(
      mutationTargets(`const table = 'session'; const alias = table as string;
        db.deleteFrom(alias);
        function remove() { const table = 'identity'; db.deleteFrom(table); }`),
    ).toEqual(["deleteFrom('identity')", "deleteFrom('session')"]);
  });

  it('records every constant SQL table fragment in a conditional', () => {
    const source =
      "const table = scope.kind === 'source' ? sql`source` : sql`package`;\n" +
      'sql`UPDATE ${table} SET listing_opened_at = ${now}`';
    expect(mutationTargets(source)).toEqual(['UPDATE package', 'UPDATE source']);
    expect(mutationTargets(source.replace('sql`source`', 'sql`identity`'))).not.toEqual(
      mutationTargets(source),
    );
  });

  it.each(['orReplace', 'orIgnore', 'orAbort', 'orFail', 'orRollback', 'ignore'])(
    'records the %s conflict action on its mutation target',
    (action) => {
      expect(mutationTargets(`db.insertInto('version').${action}()`)).toEqual([
        `insertInto('version') [${action}]`,
      ]);
    },
  );

  it('distinguishes conflict updates from doing nothing', () => {
    const original = "db.insertInto('version').onConflict(oc => oc.doNothing())";
    expect(mutationTargets(original)).toEqual(["insertInto('version') [onConflict:doNothing]"]);
    expect(
      mutationTargets(original.replace('doNothing()', "doUpdateSet({ id: 'other' })")),
    ).not.toEqual(mutationTargets(original));
  });

  it('extracts mutations from middle and tail template spans', () => {
    expect(
      mutationTargets(
        'sql`WITH target AS (SELECT ${id}) UPDATE session SET id = ${nextId}; DELETE FROM token`',
      ),
    ).toEqual(['DELETE FROM token', 'UPDATE session']);
  });

  it.each([
    "export const insert = () => db.insertInto('session');",
    "export const insert = () => ({ sql: 'INSERT INTO session (id) VALUES (?)' });",
    "export const insert = () => ({ sql: 'WITH target AS (SELECT 1) UPDATE session SET revoked = 1' });",
  ])('rejects retargeting an imported builder with its reader unchanged: %s', (builder) => {
    const reader = `import { sessionInsertStatement as insert } from './session.js';
      const results = await executor.batch([insert(ctx, input, [])]);
      results[0]?.changes;`;
    const sources = { 'reader.ts': reader, 'session.ts': builder };
    expect(
      builderTargets({ ...sources, 'session.ts': builder.replace('session', 'identity') }),
    ).not.toEqual(builderTargets(sources));
  });

  it('counts duplicate reads so copying an approved expression cannot bypass review', () => {
    expect(reads('result.changes + result.changes')).toHaveLength(2);
  });

  it.each([
    ['computed parameter', 'function count(key: string) { return result[key]; }'],
    ['mutable computed key', "let key = 'changes'; result[key];"],
    ['constructed computed key', "const key = 'chan' + 'ges'; result[key];"],
    ['partially resolved key', "const key = flag ? 'rows' : other; result[key];"],
    ['computed destructuring', 'const { [key]: count } = result;'],
    ['computed assignment', '({ [key]: count } = result);'],
    ['computed builder method', "db['deleteFrom']('identity');"],
    ['unresolved builder method', "db[method]('identity');"],
    ['reflective executor count', 'Reflect.get(result, key);'],
    ['executor result rest', 'const { ...counts } = result;'],
    ['executor count alias', 'const { numUpdatedRows: count } = result;'],
    ['executor count property', 'result.numDeletedRows;'],
    ['builder variable action', "const b = db.insertInto('version'); b.orReplace();"],
    [
      'builder alias escape',
      "const b = db.insertInto('version'); const alias = b; consume(alias);",
    ],
    [
      'raw UPSERT',
      "const q = 'INSERT INTO version(id) VALUES (?) ON CONFLICT(id) DO UPDATE SET id = excluded.id';",
    ],
    ['raw REPLACE', "const q = 'REPLACE INTO version(id) VALUES (?)';"],
    ['comment before SQL', "const q = '/* mutation */ DELETE FROM identity';"],
    ['quoted SQL target', 'const q = `DELETE FROM "identity"`;'],
    ['malformed SQL', 'const q = sql`DELETE !!!`;'],
    ['unknown SQL template', 'const q = sql`${action} ${table}`;'],
    ['opaque SQL argument', 'database.prepare(query);'],
    ['dynamic dependency', "const b = import('./builder.js');"],
  ])('requires explicit review for the %s evasion', (_kind, source) => {
    expect(() => assertUncertain({ 'evasion.ts': `\n${source}\nresult.changes;` }, {})).toThrow(
      'evasion.ts:2: Unreviewed site',
    );
  });

  it('rejects TypeScript parse recovery with the compiler diagnostic location', () => {
    expect(() =>
      assertUncertain(
        { 'evasion.ts': '\nconst q = sql`DELETE FROM identity;\nresult.changes;' },
        {},
      ),
    ).toThrow('evasion.ts:3: Unreviewed site');
  });

  it('requires a new review when a builder variable gains a conflict action', () => {
    const original = {
      'fixture.ts': "const b = db.insertInto('version'); b.doNothing(); result.changes;",
    };
    const reviewed = Object.fromEntries(
      Object.keys(uncertainInventory(original)).map((key) => [
        key,
        'Fixture insert builder; conflict action reviewed.',
      ]),
    );
    expect(() => assertUncertain(original, reviewed)).not.toThrow();
    expect(() =>
      assertUncertain(
        { 'fixture.ts': original['fixture.ts'].replace('doNothing', 'orReplace') },
        reviewed,
      ),
    ).toThrow('Unreviewed site');
  });

  it('requires a new review when raw SQL gains an UPSERT action without changing its target', () => {
    const sql = 'INSERT INTO version(id) VALUES (?) ON CONFLICT(id) DO NOTHING';
    const original = { 'fixture.ts': `const query = ${JSON.stringify(sql)}; result.changes;` };
    const updated = {
      'fixture.ts': original['fixture.ts'].replace('DO NOTHING', 'DO UPDATE SET id = excluded.id'),
    };
    expect(mutationTargets(original['fixture.ts'])).toEqual(mutationTargets(updated['fixture.ts']));
    const reviewed = Object.fromEntries(
      Object.keys(uncertainInventory(original)).map((key) => [
        key,
        'Fixture insert does nothing on conflict.',
      ]),
    );
    expect(() => assertUncertain(original, reviewed)).not.toThrow();
    expect(() => assertUncertain(updated, reviewed)).toThrow('Unreviewed site');
  });

  it('accepts a reasoned unresolved site and rejects empty reasons and stale exceptions', () => {
    const sources = { 'fixture.ts': 'result[key];' };
    const key = Object.keys(uncertainInventory(sources))[0]!;
    const reviewed = { [key]: 'Domain lookup; not a count read.' };
    expect(() => assertUncertain(sources, reviewed)).not.toThrow();
    expect(() => assertUncertain(sources, { [key]: '' })).toThrow('Unreviewed site');
    expect(() => assertUncertain(sources, { [key]: 'two\nlines' })).toThrow('Unreviewed site');
    expect(() => assertUncertain({}, reviewed)).toThrow('Stale reviewed site');
    expect(() => assertUncertain({ 'fixture.ts': 'result[key];\nresult[key];' }, reviewed)).toThrow(
      'fixture.ts:2',
    );
  });

  it('requires a reason for unresolved transitive and external dependency boundaries', () => {
    const sources = {
      'reader.ts': "import './bridge.js'; result.changes;",
      'bridge.ts': "export * from './missing.js'; export * from 'external-builder';",
    };
    expect(() => assertUncertain(sources, {})).toThrow('bridge.ts:1: Unreviewed site');
    const sites = uncertainInventory(sources);
    expect(Object.keys(sites).some((key) => key.includes('unresolved dependency'))).toBe(true);
    expect(Object.keys(sites).some((key) => key.includes('opaque dependency'))).toBe(true);
    const reviewed = Object.fromEntries(
      Object.keys(sites).map((key) => [key, 'Fixture opaque dependency explicitly accepted.']),
    );
    expect(() => assertUncertain(sources, reviewed)).not.toThrow();
  });

  it('traverses transitive builders, re-exports and cycles and detects a retargeted leaf', () => {
    const sources = {
      'reader.ts': "import { remove } from './bridge.js'; result.changes;",
      'bridge.ts': "export { remove } from './leaf.js';",
      'leaf.ts': "import './bridge.js'; export const remove = () => db.deleteFrom('session');",
    };
    expect(importedBuilders(sources)).toEqual(['bridge.ts', 'leaf.ts']);
    const targets = builderTargets(sources);
    expect(targets['leaf.ts']).toBe("deleteFrom('session')");
    expect(
      builderTargets({ ...sources, 'leaf.ts': sources['leaf.ts'].replace('session', 'identity') }),
    ).not.toEqual(targets);
    expect(() =>
      assertUncertain({ ...sources, 'bridge.ts': "export * from './missing.js';" }, {}),
    ).toThrow('bridge.ts:1: Unreviewed site');
  });

  it('accepts RETURNING row counts without a changes read', () => {
    expect(reads("db.deleteFrom('identity').returning('id');\nresult.rows.length")).toEqual([]);
  });
});
