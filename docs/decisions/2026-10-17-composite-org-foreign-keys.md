# Composite org foreign keys for catalogue child tables

Status: recommendation, decision needed from the orchestrator before rc.1. No migration is added by T716.

## Problem

Child tables carry `org_id` plus single-column foreign keys to their parents (`dist_tag`, `project_package_pattern`, `project_source`, `project_package`, `version`, `registered_name`, `dist_tag_history`). Ids are global ULIDs, so nothing in the schema stops a row whose `org_id` disagrees with its parent's. No writer produces such rows; T716 makes every read and write predicate org-consistent so such a row has no effect, but the schema still permits it.

## Recommendation

Add composite foreign keys `(org_id, parent_id) REFERENCES parent (org_id, id)` for the tables where a mismatched row changes a decision, in one migration `0011_org_consistent_keys.sql` (next free number on main at the time of writing; recheck at merge).

Tier 1 (decision-bearing, do before rc.1):

- `dist_tag (org_id, package_id)` -> `package (org_id, id)`; `(org_id, version_id)` -> `version (org_id, id)`.
- `project_package_pattern (org_id, project_id)` -> `project (org_id, id)`; `(org_id, source_id)` -> `source (org_id, id)`.
- `project_source (org_id, project_id)` and `(org_id, source_id)`.
- `project_package (org_id, project_id)` and `(org_id, package_id)`.
- `package (org_id, source_id)` -> `source (org_id, id)` (the competing-source join in `proxyEligibleCondition`).

Tier 2 (history and audit, can follow): `dist_tag_history`, `version (org_id, package_id)`, `registered_name (org_id, source_id)`.

Parents need `UNIQUE (org_id, id)` first (a unique index on `package`, `source`, `project`, `version`); SQLite requires the referenced columns to be a PRIMARY KEY or UNIQUE set exactly. `id` stays the primary key, so the extra index is redundant for lookups and costs one more index write per parent insert.

## SQLite and D1 behaviour

- SQLite cannot add a constraint to an existing table. Each child table is rebuilt: create new table, copy rows, drop old, rename, recreate indexes. `dist_tag` is `WITHOUT ROWID`, keep that.
- Foreign keys are off by default in SQLite connections and must be switched on with `PRAGMA foreign_keys = ON` per connection; `migration-contract.ts` already asserts this for the test executor. D1 enforces foreign keys on every connection and exposes `PRAGMA defer_foreign_keys` for the duration of a migration batch, so the rebuild order in the migration must either follow parent-first order or defer checks. Verify both on a D1 preview database before merge; this note has not been run against D1.
- Existing data must be checked first: a pre-flight `SELECT` per child table joined to its parent on `id` where `org_id` differs must return zero rows, otherwise the migration aborts. The worker for this migration should emit that query as a migration-contract test.
- Failure mode after the change: a mismatched insert fails with a foreign key error (`DbError` kind `foreign_key`) instead of being silently ignored by predicates. The T716 predicates stay as defence in depth.

## Cost

- One migration, around 8 table rebuilds, roughly 150 lines of SQL plus a contract test seeding mismatched rows on node:sqlite and D1.
- Write overhead: one extra index per parent, an extra key check per child insert; negligible at the expected catalogue sizes.
- Migration time on D1 scales with row count of `version`, `dist_tag_history` and `project_package`; keep tier 2 in a separate migration if row counts make a single batch exceed D1 limits.
- Risk: table rebuilds are the usual place for lost indexes and CHECK clauses; the schema snapshot tests must be updated and reviewed against `0001_init.sql`.

## Decision requested

1. Tier 1 now (before rc.1), tier 2 after: yes or no.
2. If yes, assign migration `0011` and a worker with D1 preview access.

## T741b follow-ups

Tier 1 also covers these two remaining paths:

- `visibility-subset.ts`, `addPattern`: the `project_package_pattern` conflict target is `(project_id, source_id, pattern)`, without `org_id`. A mismatched-org row can occupy that key and make an otherwise valid insert report unchanged. Composite foreign keys to both `project` and `source` prevent that inconsistent row. Until tier 1 lands, fail closed on a foreign-org collision if a writer must distinguish it from an existing own pattern. Adding `org_id` to the conflict target alone requires a matching unique constraint and does not enforce parent ownership.
- `source.ts`, `delete`: cleanup of `project_package_pattern` and `project_source` uses `source_id` alone. It can delete inconsistent child rows bearing another organization's id. Add `org_id = ctx.orgId` to both cleanup deletes as the interim scoped-write fix; tier 1 composite foreign keys prevent those rows from existing. Retain scoped deletes as defence in depth after migration. The package-reference check also uses `source_id` alone: it conservatively blocks deletion while any referencing package exists.

These are decision-bearing attachment and pattern tables, so they belong in tier 1 rather than the tier 2 history/audit migration. Tier 2 should enforce the analogous parent ownership for `dist_tag_history`, `version`, and `registered_name` without widening any runtime predicate.

For D1 rebuilds, use `PRAGMA defer_foreign_keys = ON` at the start of the migration batch when intermediate states temporarily violate references, and verify `PRAGMA foreign_key_check` before completion. D1 keeps `foreign_keys` enabled; attempting to disable it inside a transaction is not a rebuild strategy. Deferral does not disable `ON DELETE` actions, so inventory cascades before dropping a referenced table. An alternative is a dependency-aware drop/rename order that avoids dangling references and cascading data loss throughout the rebuild.

`ALTER TABLE ... RENAME TO ...` rewrites foreign-key references to the renamed table. Renaming the old parent to a temporary name can therefore redirect child references to that temporary name; dropping it later does not automatically retarget them to the replacement parent. Prefer create replacement, copy, drop old, rename replacement, with deferral and explicit handling of referencing children/cascades; otherwise rebuild the affected children in a verified dependency order. Recreate every index, trigger and constraint and test populated parent/child rows on both node:sqlite and Miniflare D1. No migration or D1 rebuild experiment is included in T741b.
