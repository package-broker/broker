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

Status: Accepted, 2026-10-15; amended 2026-10-28 by [ADR-027](#adr-027-github-organization-import-through-a-private-app-and-materialised-sources) for installation selection and Composer-only import.

### Context

VCS fetch must work through HTTPS APIs and the Git protocol, and GitHub repositories are authorised through a GitHub App that the instance owner creates. A Git protocol prototype built a Git protocol v2 smart HTTP client of about 500 lines that works on Node and workerd, while SSH needs a process and a key and works only on Node. A live run against a real GitHub App showed that Git over HTTPS accepts only Basic with user `x-access-token` (not Bearer) and that an installation with `repository_selection: all` reads every private repository of the account. The original decision therefore narrowed the installation to selected repositories; the ADR-027 amendment permits both installation selections while narrowing repository tokens per call.

### Decision

- GitHub repositories are authorised through a GitHub App. Both "All repositories" and "Only select repositories" installations are allowed, with no warning step. Organization import evaluates every repository the confirmed installation can access and admits Composer packages only, as specified in ADR-027.
- The broker mints a JWT (RS256) and exchanges it for installation tokens, which last one hour. Each token request names the repositories it needs, so the token is narrower than the installation.
- Git smart HTTP (protocol v2) is supported on both runtimes with Basic `x-access-token:<token>` as the only accepted form. SSH with system `git` is supported on Docker only, with a broker-owned key and `known_hosts`.
- Dist archives come from the REST zipball, which redirects to codeload. Webhooks (`push`, `release`) drive resync and are verified with `X-Hub-Signature-256` and a constant-time compare. Delivery ids are read as strings.
- A repository answering 451 or 404 on a ref listing is skipped for that sync.
- Organization import lists every repository the confirmed installation reaches, requires a valid root `composer.json`, shows a preview and materialises one source per Composer package through checkpointed reconciliation (ADR-027). npm import and monorepo splitting are out of scope for 2.0; monorepos are a 2.1 roadmap candidate.
- The shipped bulk discovery remains until organization import replaces it.
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

## ADR-027: GitHub organization import through a private App and materialised sources

Status: Accepted, 2026-10-28. Amends ADR-017's selected-repositories-only requirement and Composer/npm discovery scope.

### Context

Administrators need to import an organization's Composer repositories and keep new repositories, access changes and project subscriptions in sync. A repository name can be reused after a rename, a partial listing cannot establish removal, and a background worker must not retain authority after its approving administrator loses it. Imported repositories therefore need stable identity, independent pause inputs and fenced, resumable reconciliation.

The App is private and owned by the GitHub organization, so it can only be installed on that organization. A public App was rejected because it would allow installation on other accounts. Version 2.0 supports one connection to one organization per deployment; multiple connections and cross-organization moves are deferred to 2.1.

### Decision

#### Configuration and defaults

| Decision                 | Resolution                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App ownership            | Create a private, organization-owned GitHub App through the manifest flow under that organization. Ask for the GitHub organization once at App creation. Store keys encrypted in the broker under ADR-012, never in environment variables or Worker secrets. Keep manual credentials as an advanced fallback. |
| Import scope             | Evaluate every repository accessible to the usable installation, whether it selects all or some repositories, without a warning step. Rules have no organization or account picker. Import Composer only; no npm import or monorepo splitting in 2.0.                                                         |
| Connection scope         | One GitHub connection for one organization per deployment, with at most one live installation of its private App. Multiple organizations and cross-organization moves are deferred to 2.1.                                                                                                                    |
| Administrator authority  | Connecting GitHub and managing import rules require a human organization administrator, CSRF protection and fresh re-authentication, rechecked in the commit batch. Read access follows organization source-read authority. Preview requires admin and CSRF but no fresh re-authentication.                   |
| Name matching            | Case-insensitive name globs with `*`, `?` and `!` exclusions.                                                                                                                                                                                                                                                 |
| Package visibility       | New packages are visible at once, with a per-rule package visibility default for new projects.                                                                                                                                                                                                                |
| Source adoption          | Report a matching hand-made source and offer explicit Adopt; never take it over automatically.                                                                                                                                                                                                                |
| Lost matches or access   | Pause and keep serving stored versions when matching or access is lost. Nothing is deleted automatically, and reconciliation never detaches project sources. Existing manual deletion restrictions still apply.                                                                                               |
| GitHub Enterprise Server | GitHub Enterprise Server is deferred to 2.1, on Node/Docker only, subject to the deployment allowlist, with separate API origin and base path. Workers rejects a GHES host.                                                                                                                                   |
| Reconciliation schedule  | Reconcile every 6 hours with healthy webhooks, every hour otherwise.                                                                                                                                                                                                                                          |
| Project subscriptions    | Projects subscribe to rules; attachments retain provenance and per-project exclusions.                                                                                                                                                                                                                        |
| Broker address changes   | A broker address change shows instructions for updating the App now; automatic repair is later work.                                                                                                                                                                                                          |
| Mass-pause review        | Hold staged negatives per rule when more than 5 and more than 20% of its baseline children would pause, or every baseline child would pause. Also hold an empty listing when a rule has baseline children.                                                                                                    |
| Delegated authority      | Apply writes use the authority of the administrator who last saved the rule, rechecked on every write through a delegated fence. Connection jobs have a separate delegated connection fence.                                                                                                                  |
| New-project opt-out      | With “Add to new projects” off, new projects skip the rule's managed sources.                                                                                                                                                                                                                                 |
| Rule deletion            | Deleting a rule releases children as hand-made sources with their current status and attachments.                                                                                                                                                                                                             |
| Workers plan             | Workers Free is unsupported for import rules until measured; Paid is required.                                                                                                                                                                                                                                |
| Publication timing       | Publish new packages live now; an approval queue is later work.                                                                                                                                                                                                                                               |
| Repository transfers     | A repository leaving the organization loses access and its children pause; no cross-organization rebind.                                                                                                                                                                                                      |
| Interrupted connection   | Only the administrator who started an interrupted Connect may resume it, with CSRF protection and fresh re-authentication.                                                                                                                                                                                    |

#### Admission, filters and names

An installation is usable exactly when it is confirmed and its health is `ok`. Confirmation and health are separate: only an admin confirms or withdraws confirmation; JWT verification updates health (`ok`, `suspended`, `removed`, `permission_missing`). Every change to either increments `lifecycle_rev`. Recovery of health never confirms an installation. A reinstall has a new installation id and requires confirmation again. Unknown or unusable installations only queue verification, never bind rules or sync.

Admission requires matching filters, the visibility setting, the default exclusions for archived repositories and forks, and a valid root `composer.json` blob on the default branch. Each repository produces an ordinary organization-level `vcs` source per Composer package name, sharing its connection credential. Subdirectory packages and splitting monorepos are unsupported. `package.json` without `composer.json` is not a Composer package.

Filters contain at most 10 entries, OR-ed together; conditions within an entry are AND-ed. An empty filter list matches all candidates. A name condition contains at most 20 globs using `[A-Za-z0-9._*?!-]{1,100}`, with `!` marking exclusions. Topics support exact lowercase “all of” and “any of”; missing listing topics can be fetched. Required and excluded marker files are root-only names using `[A-Za-z0-9._-]{1,100}`, without `/`. Rules also hold excluded repository ids and refs (tags and literal branch names) to copy to children. “Skip archived” applies only at admission: an already imported repository that becomes archived stays active, gains an archived label and polls weekly.

The Composer name must pass the existing Composer grammar and be registrable: at most 50 bytes in the registered-pattern alphabet. Refuse only an exact registered-name collision with a source outside this repository's children. Wildcard registrations and other providers do not block admission: ADR-007 precedence still chooses the winner per project. Preview reports exact collisions, names too long, other providers and each subscribed project's winner. No new global package-name uniqueness rule is introduced.

#### Identity and lifecycle

Repository identity is `(org_id, api_origin, repository_id)`, independent of the connection; the API origin in 2.0 is `https://api.github.com`. Package identity is the Composer name. Store current repository names and alias history separately. Managed GitHub source configs require `repositoryId`; it remains optional for hand-made sources.

Repository reads use tokens narrowed by `repository_ids`. Verify metadata identity before reading manifests: a different id is a hard `repository_identity_mismatch` refusal; the same id with a changed name stops the sync with `repository_renamed` and requests reconciliation. Never read a new repository that reused the old name. Token grants must contain every requested read permission and reject broader grants. The existing name-based path remains available to hand-made sources.

Historical dist URLs may name the current repository or a recorded alias of the same id. Fetch the canonical current URL with an id-narrowed token and retain digest verification. Managed webhook matching uses repository id, falling back to names for sources without an id. Rename child-update jobs and sync jobs share `source:<id>` as resource key. Rename updates every child, current and paused, comparing the expected config and repository id, changing only the repository name and recording the alias. On a compare-and-set failure, reread and retry once, then settle as superseded. It avoids the generic config-update reactivation pause. A repository transferred out of the organization gets `access_lost`; its children stay paused and served.

Each child has `is_current`, `user_paused` and independent pause reasons: `unmatched`, `access_lost`, `no_composer_json`, `package_renamed`, `rule_paused`, `installation_unavailable`, `disconnected`, `repair_required`, `excluded`. Source status is paused exactly when the user pause is set or any reason remains; every writer derives status in the same batch. Only the owning rule's delegated fence or an admin may remove reasons, except that the delegated connection fence removes `disconnected` during an approved reconnect. Reconciliation never lifts a user pause. Manual resume refuses to activate while another reason remains. Unknown probes make no positive or negative decision.

A package-name change is one staged negative `switch_package` decision. In one batch, first mark the old child non-current and add `package_renamed`, then admit the new child or reuse the paused child of the same repository and returning name. Reuse makes it current and removes only `package_renamed`, preserving other reasons and user pause. At most one current child exists per repository and one child per repository/package name. Renamed-away children retain stored versions and attachments, so pinned lockfiles keep installing. An inadmissible new name cannot create a new source. Definitive root manifest absence, filter mismatch and access loss stage pauses. Verified installation unavailability supplies a separate reversible reason. None deletes sources, packages, versions or blobs.

Rules are evaluated oldest first. The first owning rule retains ownership even while paused. Admission atomically claims ownership only when unowned, already owned by that rule or owned by a deleted rule. Other matching rules report the owner rather than attaching their projects to its children. Rule deletion releases ownership and child relationships without changing source status or attachments; another rule must explicitly adopt a released matching source.

#### Connection and credential safety

Onboarding durably records `setup_pending`, `awaiting_resume`, `conversion_in_progress`, `conversion_uncertain`, `install_pending`, `repair_required`, `failed`, `expired` and `completed`. A valid callback in another or expired session seals the conversion code for the starting admin's resume. Setup codes use their own HKDF label and record-bound AAD, and are deleted on terminal states. Conversion with no progress for 2 minutes becomes uncertain; one retry is allowed while the code is valid. Resume issues new state and invalidates the old state atomically. Pending installation approval is verified every 15 minutes for 7 days, then hourly.

The manifest requests only contents-read and metadata-read, with push, release and repository events, installation setup updates and no OAuth-on-install request. A stable 128-bit random base64url hook key identifies the connection independently of its credential. It is not authentication: webhooks require HMAC verification. Keep the existing hook path shape and credential-id fallback for hand-made App credentials.

Callback state is purpose-bound, single-use and tied to organization, session, user, connection and expected GitHub owner/account. Store an HMAC of state under a derived key. Manifest state expires after 55 minutes; install state after 24 hours. At commit, consume state by compare-and-set and recheck organization administrator authority and fresh re-authentication. Verify installation ownership through this App's JWT, expected account id, required read permissions and absence of suspension. Missing or invalid state permits only a review page, followed by authenticated, CSRF-protected verification and explicit confirmation. Callback responses use `no-store`, `no-referrer` and a 303 redirect that removes code and state.

Validate conversion and the expected organization owner before one atomic batch inserts the encrypted credential and connection, transitions setup and stages audit. Discard the client secret immediately. Retry a failed persistence batch once; repeated failure records a minimal repair-required connection with no credential and safe App identity fields. Repair accepts a supplied key only for `GET /app` and `GET /app/hook/config` until owner and this deployment's exact hook URL/key both match. Then seal the credential and require webhook-secret rotation before confirmation. Both setup and connection repair paths exist.

Key replacement verifies the App first and reseals the same credential id with unchanged record-bound AAD and compare-and-set on its previous update timestamp. JWT and installation-token caches invalidate on key material change. Webhook rotation stores a pending secret and rotation id before PATCH, accepts current and pending while uncertain, and always retries the same pending value. Only a 2xx PATCH or a pending-secret delivery received after rotation began with the matching rotation id finalises it. Promotion retains the old current secret for one hour. Errors never drop the pending secret; backoff runs from 1 minute to 1 hour. After 24 hours without confirmation, mark repair required while continuing to accept both secrets. A new rotation cannot start while one is pending.

Disconnect immediately refuses token minting and uses the requesting admin's delegated connection fence to add `disconnected`, clear child and adopted-source credential references in chunks and record reconnect references. Delete the credential only after a final no-reference guard, then forget cached keys. Reconnect creates a new connection for the same `owner_id`, requires installation confirmation and explicit “Resume” approval, then enqueues child updates under the requesting admin's delegated connection fence to replace credential/installation ids, remove `disconnected` and derive status. It cannot move sources to another organization.

All queries and cache keys are scoped by organization. New GitHub API calls use PolicyFetch, locally constructed paths, the API origin destination, redirects refused, 15-second timeouts and bounded bodies (64 KiB for App calls, 8 MiB for listings/root trees, 1 MiB for blobs). App operations include hook-config read/PATCH, delivery listing and supplied-key verification. Error names stay stable and messages contain no request data. Never log or echo private keys, tokens, webhook secrets, conversion codes, state, credential-bearing URLs or held account/identity e-mail addresses. Hook keys are excluded from audit and logs. Audit records typed safe fields and counts rather than repository lists or secrets.

#### Fenced reconciliation

One non-terminal generation per installation shares a listing across active rules. Capture rule revisions, installation lifecycle revision and per-rule baselines. Persist phase, checkpoint sequence, recovery epoch, staged decisions, counters and the negative-set digest. Triggers coalesce into one rerun flag; the completing batch inserts the next generation and job. Rule revision changes supersede the generation. Listing-only generations run on confirmation even without rules.

Every write batch checks expected phase and checkpoint sequence, job lease, usable installation at the captured lifecycle revision, connected state and writer authority; apply phases also check captured active rule revisions. The batch advances the checkpoint and inserts the continuation job atomically. Jobs carry generation id and sequence; idempotency keys include recovery epoch. Replays are no-ops and stale workers write nothing. A 10-minute recovery sweep re-enqueues runnable stalled work with a guarded epoch increment, never held work; after 5 recoveries without progress it fails as stuck.

The `github-import` system writer may list, probe, decide, recover and verify; it may add pause reasons but cannot remove reasons, resume, create or attach sources, or change credentials or registered names. Admission, reactivation, rename child updates, reason removal and resume, positive/negative application jobs and attachment jobs all use the owning rule's delegated fence. Disconnect, reconnect and rotation use a delegated connection fence approved by the requesting admin. Authority loss fails apply with `approver_lost` and requires an admin to save the rule again; listing may continue.

The phases are listing, probing, deciding, positive application, held review if required, negative application and completion. Listing uses pages of 100 and compares totals with observed rows. Repeat a mismatching listing once; missing ids after a second mismatch remain unknown this generation. A complete matching listing can stage access loss. Probe errors, timeouts, missing refs and malformed responses are unknown, never negative evidence.

Probe one non-recursive root tree with an id-narrowed token. Only a 200 response with `truncated = false` proves root markers present or absent. Fetch a new Composer blob sha to parse the package name. Cache immutable root facts by organization, API origin, repository id, tree sha and semantics version; cache names by blob sha. An unchanged `(pushed_at, default_branch)` reuses the last tree only after the current listing proves access. Never cache unknown results.

Admission is one fenced atomic batch: claim ownership, insert source and exact registered name, enable under the activation guard, insert child, update decision, stage audit and enqueue sync. Positives apply before negative review, with attachments added independently. For each rule, capture baseline `B_r` as current children with no pause reasons, and staged negative count `N_r`. Hold when `N_r > 5` and `N_r > 0.2 × B_r`, or `B_r > 0` and `N_r = B_r`, or the listing is empty while any baseline is nonzero. Thus even a 3-child rule losing all 3 is held. Confirmation requires admin, CSRF, fresh re-authentication, the still-held generation and exact negative digest; the batch records confirmation before negative application. Verified installation unavailability bypasses the match-decision hold and adds a reversible reason.

Each invocation meters subrequests, D1 calls and elapsed time, checkpointing at the first exhausted dimension. Paid budgets are 2,000 subrequests, 600 D1 calls (a batch counts once) and 20 seconds wall time. Count token mints and binding calls, reserve checkpoint room, and derive SQL chunks from the 100-bound-parameter limit including guards. There are no shared quota counters. GitHub headers give a per-run budget of remaining requests minus 20% of the limit, capped by the invocation meter and refreshed on each response. Missing headers allow 100 requests, refreshed through `GET /rate_limit`. Checkpoint until reset on GitHub exhaustion, continue in a new invocation on meter exhaustion, and obey `retry-after` on secondary limits. Previews use a 30% floor. The reserve for child syncs is best effort; their existing 403/429 handling remains.

Preview uses the stored listing snapshot and probe cache, never a fresh listing. Uncached probes show “Not checked yet”; “Check files now” probes at most 50 repositories. A snapshot older than 6 hours shows its age and a refresh action. Webhooks are hints, except installation unavailability verified against GitHub. Health comes from App delivery results, not silence: recent successful deliveries are healthy, repeated failures unhealthy, and no evidence unknown. Consumers register job types before webhook producers enqueue them; otherwise deliveries settle as ignored.

#### Project subscriptions and visibility

The desired-attachment predicate includes every child of a subscribed rule, current or paused, for active projects without a project or rule-wide repository exclusion. The delegated attach job only adds missing project-source rows or provenance on an existing manual row. It never detaches, and runs independently of generation completion with durable paged progress. Admission, subscriptions, restores, project unarchive, rule resume and stale-marker recovery trigger it. Renamed-away and paused children stay attached and served.

Detachment is an explicit admin action with CSRF and fresh re-authentication: unsubscribe, per-project exclusion or manual detach. Reuse the existing detach builder, including removal of project-package visibility, revision bumps, re-derivation and audit. Manual detach records an exclusion atomically. Unsubscribe removes rule-provenance rows; reconciliation never removes manual attachments.

“Add to new projects” defaults on and uses the same desired predicate: insert the rule subscription and attachments/provenance for all children, current and paused, in the creation batch. When off, new-project attachment skips that rule's managed sources. Archived projects are skipped; unarchiving triggers attachment. Precedence is set on insert only, using the rule block's minimum or the default; the existing reorder route is the only writer afterward. The package visibility default is copied to each child's `default_visible_to_new_projects` at creation, after which ADR-007 applies.

### Consequences

- Positive: organization imports grow with GitHub access while host-scoped repository identity prevents old-name reuse; manual pauses, stored history, attachments and project ordering survive reconciliation.
- Negative: any accessible repository gaining an admissible `composer.json` can publish immediately to subscribed projects. Admin-only rules, read-only id-narrowed tokens, exact-name collision checks, visibility settings and admission audit bound that exposure; an approval queue is deferred.
- Negative: durable checkpoints, ownership, staged pauses and credential repair require additional state and fenced writes. Workers Free remains unsupported until measured; the quota reserve is best effort.
- Validation must cover rename/old-name reuse, historical dist aliases, transfer-out pauses, permission presence, stale workers, callback forgery, rotation uncertainty, per-rule holds, retained attachments and unknown probes on Node and Workers. Several organizations, cross-organization moves, GHES, monorepos and automatic removal are deferred to 2.1.
