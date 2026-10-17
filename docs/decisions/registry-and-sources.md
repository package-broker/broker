# Registry and sources

Decisions on supported ecosystems, source ownership and precedence, proxies and retention, migration, GitHub integration and catalogue dates.

## ADR-005: Ecosystems are Composer and npm; Composer v2+ for clients and served endpoints, v1 provider protocol ingested from sources

Status: Accepted, 2026-10-14

### Context

Composer support is scoped to v2+. The registry repo.magento.com serves only v1 metadata (`providers-url`, `provider-includes`) and `/p2/` redirects to HTML, so the rule is refined: clients stay v2+, ingestion must read v1. A conformance run tested the whole v1 protocol with 34 synthetic fixtures (513 assertions pass). A second run ingested the full live Marketplace index, 636 packages and 20,399 versions with 0 errors and 0 rows failing against Composer itself.

### Decision

- Supported ecosystems are Composer and npm.
- Served endpoints speak Composer v2+ only: `packages.json`, `metadata-url` (`p2`), `~dev` metadata. Composer 1 clients get HTTP 406.
- Sources may speak the v1 provider protocol. The ingest adapter reads `providers-url`, `provider-includes`, `providers-lazy-url`, legacy `includes` and inline `packages`, and re-serves the data as v2.
- Ingest rules from the conformance run:
  - Verify the sha1 or sha256 of every include body; on mismatch refetch `packages.json` once, then keep the last known good catalogue and alert.
  - Never expose `mirrors` to clients; retry mirror URLs only when `dist.url` fails with 4xx or 5xx, then fail the version and not the sync.
  - Send `Composer/<version>` as the User-Agent on dist downloads for credentialed v1 sources (configurable), never the broker identifier.
  - A package absent from the index is a tombstone; keep serving the last known metadata and stored dists until an operator or retention policy removes them.
  - Never require or emit `uid`.
  - Never forward or call `notify`, `search`, `providers-api` or `list` URLs; strip `notification-url`.
  - Log `warning` and `info` entries with their constraints and show them in the admin UI; do not relay them.
  - A lazy v1 source costs one request per tracked package per poll; use `If-Modified-Since` and budget polls by package count.
  - Per-package and per-version errors never abort a sync; a sync with errors reports a non-zero error count to the scheduler.
- The Composer metadata edge-case corpus is a contract test suite for the served endpoints and the mirrors.

### Consequences

- Positive: Magento Marketplace stays in scope for 2.0; clients get one protocol; the adapter is verified against Composer as oracle.
- Negative: the v1 reader is extra code to maintain; lazy v1 sources scale with the tracked package count.
- Follow-ups: one credentialed v1 vendor host was not tested (no credential available).

## ADR-006: Private Packagist is not a backend; migration is a one-shot import CLI on the public API

Status: Accepted, 2026-10-15

### Context

Using Private Packagist as a headless backend rests on licence and cost questions that Packagist has not answered in writing, and the cost model is dominated by seat count beyond four projects. A one-shot import replaces the headless idea. An API key takes no seat. The `plan` step ran read-only against a real organization with 56 GET calls, all 200.

### Decision

- No headless use of Private Packagist. The broker does not synchronise configuration with it after migration.
- The import is a CLI on the public API with `plan`, `apply`, `verify` and `rollback`. The UI shows import runs read-only and a "run this in the CLI" panel. Credentials are references resolved on the operator's machine, never entered in the browser or stored by the server.
- Import runs are durable: run id, states (planned, applying, failed, applied, verifying, verified, rolled back), resume, cancel, stale-plan refresh, per-project cutover checklist, journal kept until the operator accepts completion.
- Rollback keeps before-images, has a stated lifetime, detects post-import changes and asks the operator per conflict.
- Member emails come from an operator CSV; the permission table for roles is reviewed before apply and any mapping that widens access is listed for approval; mirrors are processed in operator order with packagist.org last; artifact packages are re-uploaded by the operator; re-runs only inside the migration window and never delete; Packagist stays a fallback for four weeks after the last cut-over, checked against renewal.
- `published_at` of every imported version is the package build or release date at the source; the fallback is the date the version was added to Packagist; import time is used only when nothing else exists. The basis is recorded per version and shown in the plan, with the number of customers whose cut-off it affects.
- Customers and bundles are imported into `Customer` and `CustomerGrant` (P1).
- A secrets-manager SDK on workerd is not needed while the import stays CLI-only.

### Consequences

- Positive: no dependency on a third-party service at runtime; the freeze dates survive the migration; secrets never reach the server.
- Negative: the migration needs an operator machine with the CLI, Composer and the lockfiles; Packagist security monitoring, Update Review and usage tracking are not replaced by the import.
- Follow-ups: written answers from Packagist on rate limits and a read-only key are optional; lockfile-based back-fill of dists kept only by Packagist is opt-in.

## ADR-007: Sources at organization and project level with project precedence, digest dedup and live subscription

Status: Accepted, 2026-10-15

### Context

An agency holds private packages that several projects share, while a client may own extensions that only its project may use. The same package name can therefore come from different sources. A GitHub prototype showed per-source resolution is needed for VCS, vendor and proxy sources alike.

### Decision

- A source and its credentials can be owned by the organization (for example the agency's private packages) or by a project (for example extensions bought by the client).
- The same package name may come from different sources. A project-level source takes precedence and is served to that project. When the project's version digest equals the organization-wide package's digest, the global copy is served (dedup by hash).
- Resolution is the same for Composer and npm; keys are source-aware (`ProjectSource` precedence). Registered private names and npm scopes are required before a private source is enabled.
- Package subsets per project (`ProjectPackage`, patterns allowed) are enforced on metadata, dist, search, version endpoints and cache. The dependency check is bounded: it lists required names that a project or grant cannot see, with no constraint solving.
- A project that subscribes to a source follows that source's current package list, and new packages appear automatically (live). Snapshot mode is not built. The per-package `visible_to_new_projects` flag is live.
- The admin UI offers a project Sources tab with an ordered list, attach and detach, registered names and a "who wins for name X" preview.

### Consequences

- Positive: private and purchased packages coexist without name collisions; storage is deduplicated; new packages reach subscribed projects without admin work.
- Negative: live subscription means a source change is visible to every subscribed project at once, so source credential and package-list changes need audit events ([ADR-014](identity-and-sessions.md#adr-014-audit-log-in-the-application-database-with-hash-chaining-export-in-p1)); resolution logic and cache keys carry source and grant version.
- Follow-ups: precedence preview and the dedup rule need contract tests on both runtimes.

## ADR-008: Restricted public proxies, artifacts persisted by digest, upstream removals kept for one year

Status: Accepted, 2026-10-15

### Context

The broker proxies packagist.org and registry.npmjs.org. An open proxy is an abuse and cost risk. Re-fetched upstream bytes are not guaranteed to be identical: GitHub changed archive checksums in 2023, and some versions cannot be re-fetched at all. An npm proxy prototype measured pull-through, persisted metadata and tarballs, coalesced misses and stale-if-error on both runtimes.

### Decision

- No anonymous access to the public API or to any proxy. Every request carries a token. The anonymous opt-in is not built.
- Proxied and mirrored artifacts are persisted by digest and immutable (SHA-256 key, Composer `shasum`, npm `integrity` recorded).
- Artifacts removed upstream are kept for one year by default. Retention is configurable per deployment.
- Each sync compares upstream and stored versions per source. A missing version is flagged `removed_upstream` with a timestamp and is still served by default. It is excluded from new resolution only by an admin action or a per-source policy. Blobs are hard-deleted only after retention expires.
- Optional lifecycle expiry applies only to proxied public packages, driven by the broker's own `last_accessed_at`. It never applies to VCS-mirrored, vendor-repository or pushed artifacts.
- When a blob is missing, the broker fetches it again from its recorded source under a fetch lease and verifies it against the recorded digests. On mismatch the version is quarantined and reported.
- Metadata uses a TTL, a negative cache, stale serving on upstream errors and one coalesced fetch per key.

### Consequences

- Positive: installs survive upstream deletions for a year; re-fetch cannot silently change bytes; the proxy cannot be used anonymously.
- Negative: storage grows with retention; plain R2 or S3 lifecycle rules cannot express "unused for a year", so the broker tracks `last_accessed_at` and deletes through a job.
- Follow-ups: pushed artifacts and removed-upstream versions cannot be re-fetched and need their own protection ([ADR-019](deployment-and-runtimes.md#adr-019-backup-and-recovery-of-application-state-and-catalogue-metadata)).

## ADR-017: GitHub integration through a GitHub App on selected repositories, webhooks, and Git smart HTTP

Status: Accepted, 2026-10-15

### Context

VCS fetch must work through HTTPS APIs and the Git protocol, and GitHub repositories are authorised through a GitHub App that the instance owner creates. A Git protocol prototype built a Git protocol v2 smart HTTP client of about 500 lines that works on Node and workerd, while SSH needs a process and a key and works only on Node. A live run against a real GitHub App showed that Git over HTTPS accepts only Basic with user `x-access-token` (not Bearer) and that an installation with `repository_selection: all` reads every private repository of the account. The installation is therefore narrowed to selected repositories.

### Decision

- GitHub repositories are authorised through a GitHub App registered and installed by the instance owner on selected repositories only. The install guide requires "Only select repositories".
- The broker mints a JWT (RS256) and exchanges it for installation tokens, which last one hour. Each token request names the repositories it needs, so the token is narrower than the installation.
- Git smart HTTP (protocol v2) is supported on both runtimes with Basic `x-access-token:<token>` as the only accepted form. SSH with system `git` is supported on Docker only, with a broker-owned key and `known_hosts`.
- Dist archives come from the REST zipball, which redirects to codeload. Webhooks (`push`, `release`) drive resync and are verified with `X-Hub-Signature-256` and a constant-time compare. Delivery ids are read as strings.
- A repository answering 451 or 404 on a ref listing is skipped for that sync.
- Bulk source discovery lists the repositories the installation reaches, detects Composer and npm packages, shows a dry-run plan and creates sources idempotently in one job.
- A `GITHUB_TOKEN` push and PAT-based pull are P1.

### Consequences

- Positive: least-privilege access to private repositories; a lighter sync (5 requests and about 30 KB per repository for smart HTTP against 85 REST calls in the reference run); no secrets in the UI beyond the App key, which is stored under [ADR-012](secrets-and-tokens.md#adr-012-secrets-and-cryptography-with-a-deployment-master-key-hkdf-record-bound-aad-and-a-versioned-pepper).
- Negative: the App private key is a high-value secret; a repository that is not npm-publishable from git (build output not committed) cannot be mirrored as an npm package; SSH sources do not run on Workers.
- Follow-ups: webhook endpoint reachability is a deployment prerequisite; pack-size limits on Workers.

## ADR-018: Catalogue dates and licence-freeze foundations in the first schema

Status: Accepted, 2026-10-15

### Context

The product must let a customer whose subscription ended on a date see only versions published up to that date; access is frozen and not revoked, and the vendor can extend access through the API. `published_at` is written once and is the only date the freeze uses, so it cannot be added or corrected after the schema freeze. Prior art is Private Packagist vendor customers and Packeton per-version ACL with expiry. The token-and-grant race was tested on a real D1 database.

### Decision

- `Version` carries a broker-written `published_at` and an informational `upstream_released_at`. `VersionRevision` and `DistTagHistory` exist from the first release.
- For imported or mirrored history, `published_at` is the package build or release date at the source; the fallback is the date the version was added to Packagist or the source registry; the import time is used only when nothing else exists. The basis is recorded per version and audited.
- `Customer` and `CustomerGrant` (`valid_until`, version constraint, minimum stability) are in the P1 schema from the first migration, with a versioned `Bundle` and the `cst` token kind.
- The cut-off is `min(now, valid_until)`. A version is visible when `published_at <= cut-off`. An invisible dist answers HTTP 403 with a reason (`licence_frozen`) and the 403 body explains whom to contact.
- Customer tokens have no expiry by default. The vendor can set one. The UI separates subscription cut-off, token expiry and disabled state.
- The vendor access API provides `PUT /customers/{external_ref}`, grants, tokens, usage and a `grant.freezing` webhook with scopes `customers:write`, `customers:tokens` and `customers:usage` and an `Idempotency-Key`.
- Issuing a token is one conditional statement against the grant, and revocation of a grant revokes its tokens in one batch, so a token never outlives a revoked grant.

### Consequences

- Positive: the freeze survives migration and restore ([ADR-019](deployment-and-runtimes.md#adr-019-backup-and-recovery-of-application-state-and-catalogue-metadata)); the schema does not need a back-filling migration when the customer features ship.
- Negative: backdated `published_at` for imported history contradicts "never backdated" for that history only and is audited; a lockfile pinning a version published after the cut-off fails with 403, and retention, yanks or quarantine can also break an old lockfile.
- Follow-ups: a lockfile check helper on the customer page and the entitlement view (P1); import of Private Packagist customers.
