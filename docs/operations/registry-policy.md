---
title: Registry policy
sidebar_position: 3
description: Enable deny-only read policy, manage rules, and roll it out or back safely.
---

Registry policy lets an organization or a project hide package versions from installs: a minimum release age, blocked versions, a restrictive allowlist, a malware quarantine and an optional client version floor. Every rule can only take access away. Rules never grant access, and existing project access, publish approval holds, integrity quarantine and tombstones keep applying on their own. <!-- source: packages/core/src/registry/policy/session.ts --> <!-- source: packages/core/src/registry/policy/members.ts -->

## Turn it on

1. Run `pb migrate` so the registry policy tables exist. The management routes appear as soon as they do, so rules can be created and reviewed before anything is enforced. With `registry.policy.enabled: true` a broker refuses to start without them; Node fails startup and Workers log `startup.misconfigured`. <!-- source: packages/runtime-node/src/policy/http-matrix.test.ts --> <!-- source: packages/runtime-cloudflare/src/policy/http-matrix.test.ts -->
2. Set `registry.policy.enabled: true` in `broker.config.ts` and, if you compile `registry.read` hooks, choose `registry.policy.hookBudgetMs` (default 1000 ms). See [Configuration](../reference/configuration.md).
3. Build and deploy both runtime bundles as usual.

With the flag off, no policy is read, the expiry job is not registered and every serving path behaves as before. The management routes stay mounted whenever the policy tables exist, so rules can be staged and inspected while nothing is enforced; without the tables they answer 404. <!-- source: packages/core/src/registry/module-policy.test.ts --> <!-- source: packages/core/src/test-support/policy-rollout.ts -->

## Manage rules

Organization rules live under `/_pb/policies` and apply to every project. Project rules live under `/_pb/projects/:project/policies` and apply to that project only, on top of the organization rules. Rules always intersect: a project rule can tighten an organization rule, never lift it. <!-- source: packages/core/src/api/routes/policies-schemas.ts -->

| Rule           | What it does                                                                                                                            | Permission                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `min_age`      | Hides versions younger than `minAgeDays` (0 to 3650).                                                                                   | `org:settings:write` / `project:settings:write`   |
| `block`        | Hides the listed exact versions; with no members it hides every version of the package, including versions ingested later.              | `org:packages:manage` / `project:packages:manage` |
| `allowlist`    | Hides every version that is not listed; an empty allowlist hides all.                                                                   | `org:packages:manage` / `project:packages:manage` |
| `quarantine`   | Organization-wide malware quarantine of exact versions; reason `malware`, no expiry.                                                    | `org:packages:manage`                             |
| `client_floor` | Refuses package reads from a known client older than `clientMinVersion`; `denyUnknown` also refuses clients the broker cannot identify. | `org:settings:write` / `project:settings:write`   |

Members are exact normalized versions as the catalogue stores them (`1.2.3` for npm, `1.2.3.0` or `dev-main` for Composer). Tags, ranges and globs are refused. Every rule carries a fixed `reasonCode` (`malware`, `security_review`, `compatibility`, `organization_policy`) and may carry an `incidentId`; free text is not accepted. A rule's kind, ecosystem, scope and package never change; to retarget a rule, disable it and create a new one. <!-- source: packages/core/src/db/registry-policy.ts --> <!-- source: packages/core/src/registry/policy/manage-members.test.ts -->

Management needs a human session; tokens and service principals are refused. The routes admit any session of the organization (on project routes, any session holding a permission in that project); the permission in the table above then decides, per rule kind, what the caller can read and change. A caller with only `org:settings:write` therefore sees and manages minimum-age and client-floor rules and is refused on blocks, allowlists and quarantines. <!-- source: packages/core/src/api/routes/policies-gate.test.ts --> Every write needs an `Idempotency-Key` header, and every `PATCH` needs `If-Match: "r<revision>"`; a replayed key returns the stored response with `Idempotent-Replayed: true`, also for a `PATCH` whose `If-Match` revision the lost first attempt already advanced. Keys belong to the caller that sent them. One `PATCH` makes one change: field edits, a new member set, or `{"state": "disabled", "reason": ...}`. Disabling a quarantine is its release. <!-- source: packages/core/src/api/routes/policies-write.ts --> <!-- source: packages/core/src/api/routes/policies-write.test.ts -->

Weakening a rule is the audited override: disabling or releasing it, removing versions from a block or quarantine, giving an empty block its first member, adding to an allowlist, lowering an age or floor, clearing `denyUnknown`, or setting or shortening an expiry. A weakening write needs a session reauthenticated within the last 10 minutes; otherwise it answers `403 reauth_required`. Disabling, releasing and removing blocked or quarantined versions also need one fixed `reason`/`overrideReason`: `false_positive`, `emergency_compatibility`, `superseded` or `other`. Releasing a quarantine does not change any version status and does not release a publish or integrity hold. <!-- source: packages/db-sqlite/src/repositories/registry-policy-update.ts --> <!-- source: packages/db-sqlite/src/repositories/registry-policy-members.ts --> <!-- source: packages/core/src/test-support/policy-admin.ts -->

Package managers can inspect one package with `GET /_pb/policies/packages/:package` (or the project form): version ids, status, date basis, effective date and the rule ids and fixed reasons that hide each version. On a project route a caller without `org:packages:manage` sees organization rules only as the fixed reason `organization_rule`, without their ids or revisions. Pages hold at most 100 versions. Reading packages is not enough for this view, and it returns no manifest, readme or download URL. Each inspection is audited as `policy.inspect`. <!-- source: packages/core/src/registry/policy/inspect.ts -->

## What clients see

| Request                                  | Answer                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packument, dist-tags, P2, search, lists  | Hidden versions, their times and the tags that point at them are left out; `latest` is never moved to another version. A package with no visible version answers 404. |
| A hidden version, tag target or tarball  | The usual 404, with `Cache-Control: private, no-store` like every 404 of a governed read.                                                                             |
| A client floor or hook refusing the read | `403 policy_denied`, `Package access denied by policy`.                                                                                                               |
| Policy cannot be evaluated               | `503 policy_unavailable`, `Retry-After: 5`, `Cache-Control: private, no-store`.                                                                                       |

Governed metadata and archives are sent with `Cache-Control: private, no-cache`; archives no longer carry `immutable`. Metadata keeps `304 Not Modified`: the broker evaluates policy first and then compares an ETag that covers the visible version set, the next time a version ages in or a rule expires, and the client family. A date-only `If-Modified-Since` on governed metadata is answered with the evaluated body. <!-- source: packages/core/src/registry/npm/routes-policy.test.ts --> <!-- source: packages/core/src/registry/composer/routes-policy.test.ts --> <!-- source: packages/core/src/registry/policy/validator.ts -->

## Dates and expiry

Age counts from the stored release date. An imported version without a release date counts from its import date, and a row with neither counts from when the broker first saw it; a version without any usable date makes the request fail with 503 rather than pass. Dates in the future wait until they are reached. Upstream timestamps are what the upstream says, not proof of when a version appeared, so a minimum age is a delay, not evidence that a version is safe. <!-- source: packages/core/src/registry/policy/age.ts --> <!-- source: packages/core/src/registry/policy/age.test.ts -->

Rule expiry and ageing are checked on every request, so a rule stops applying at `expiresAt` with no write and no job. An hourly job per organization only records each expiry once as `registry_policy.expire`; a late or repeated run changes nothing about what the rule did. If a full page was recorded but no follow-up run could be queued, the job logs `registry_policy.expiry_deferred` and the next hourly run continues. <!-- source: packages/core/src/registry/policy/expiry.ts --> <!-- source: packages/db-sqlite/src/contract/registry-policy-expiry.ts -->

## Audit and metrics

Rule creation, edits, member changes, disables, releases and expiries are audited in the same database write as the change. A request for a hidden version, tag target or tarball writes a `policy.read_denied` event with the rule ids and fixed reasons before the 404 is sent; if that event cannot be written, the request fails with 503 and no bytes. Hiding versions from lists and documents is only counted, in `pb.registry_policy.collection_filtered`, so those reads keep working when audit storage is down. Policy events hold identifiers and fixed reasons only, never the `User-Agent`, tokens or e-mail addresses. <!-- source: packages/core/src/registry/policy/read-audit.ts --> <!-- source: packages/core/src/registry/policy/metrics.ts --> <!-- source: packages/core/src/test-support/policy-metadata.ts -->

## Limits

Up to 256 enabled rules apply to one package and 1,000 members to one rule. One request evaluates at most 10,000 versions and 1,000 packages; beyond that it fails with 503 instead of answering with a partial document. Hooks receive at most 64 candidates per call. Load-test these limits before enabling policy on a large catalogue. <!-- source: packages/core/src/db/registry-policy.ts --> <!-- source: packages/core/src/registry/policy/session.ts -->

## Roll out and roll back

Before enabling policy on an existing deployment, remove any edge or CDN rule that caches everything, purge broker responses that an edge cache already holds, and deploy both runtime bundles. Tarballs that clients downloaded before, and package-manager caches and lockfiles, cannot be revoked; policy applies to requests that reach the broker after rollout.

Turning `registry.policy.enabled` off stops enforcement and keeps the stored rules; turning it on again enforces them as they are. A broker binary older than the registry policy migration ignores the policy tables entirely, so rolling back to such a binary also stops enforcement without deleting rules. <!-- source: packages/core/src/test-support/policy-rollout.ts -->
