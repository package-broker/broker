# Deployment and runtimes

Decisions on backup and recovery, data jurisdiction and rate limiting.

## ADR-019: Backup and recovery of application state and catalogue metadata

Status: Accepted, 2026-10-15

### Context

The backup scope is what is needed to recreate the application, because package data can be re-fetched. Three kinds of data cannot be re-fetched: broker-written catalogue metadata the freeze depends on, pushed artifacts, and versions removed upstream. After a restore without catalogue metadata a re-sync would assign new `published_at` dates and change every frozen customer's visible set, so catalogue metadata is part of the backup.

### Decision

- The backup covers configuration, projects, groups, memberships, grants, token metadata, credential ciphertexts and keys, the audit log, and the catalogue metadata rows (`published_at`, `VersionRevision`, `DistTagHistory`).
- Package blobs are not backed up. They are re-fetched from their recorded sources and verified against recorded digests ([ADR-008](registry-and-sources.md#adr-008-restricted-public-proxies-artifacts-persisted-by-digest-upstream-removals-kept-for-one-year)).
- Objectives are an RPO of 24 hours and an RTO of 4 hours.
- On Cloudflare the backup is a daily D1 export to R2 plus D1 Time Travel with 30 days of retention.
- One full restore rehearsal is completed before cut-over.
- Pushed artifacts and versions removed upstream need their own protection (bucket versioning or replication) when pushed publishing ships. The settings screen lists the blobs that cannot be re-fetched.

### Consequences

- Positive: a restore keeps the licence freeze intact; backups stay small because they contain rows, not archives.
- Negative: after a restore the first requests for blobs may be slow because they are fetched again; a version whose source is gone and whose blob is lost cannot be restored.
- Follow-ups: restore runbook and the rehearsal checklist in the deployment documentation; master key custody ([ADR-012](secrets-and-tokens.md#adr-012-secrets-and-cryptography-with-a-deployment-master-key-hkdf-record-bound-aad-and-a-versioned-pepper)).

### Amendment, 2026-10-27: the providers file is outside the database backup

Single sign-on provider definitions set through `PB_IDP_PROVIDERS` live in the deployment's environment, not in the database, so the database backup does not contain them. The operator keeps the providers file under version control or in their own backup and restores it with the deployment. A restored database whose recorded provider trust anchors do not match the restored definitions refuses sign-ins through those providers until the definitions match or the provider is rebound. See [Runtime SSO providers](../reference/runtime-sso-providers.md).

<!-- source: packages/plugin-sso-oidc/src/index.ts:117 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1721 -->
<!-- source: packages/core/src/auth/routes-sso.ts:294 -->

## ADR-020: EU jurisdiction from the first deployment; residency controls in P1

Status: Accepted, 2026-10-14

### Context

Cloudflare jurisdiction on D1, R2 and Durable Objects is fixed when the resource is created and cannot be changed later. A deployment that needs EU residency uses jurisdiction `eu` from its first deploy, and EU residency controls on Cloudflare are important and P1.

### Decision

- The Workers deployment accepts a jurisdiction input when it creates D1, R2 and Durable Object resources, and a deployment that needs EU residency uses `eu` from its first deploy.
- P1 adds verification that a deployment was created with `eu`, a check in `pb cloudflare provision` that refuses a mismatching jurisdiction, and documentation of what stays outside the jurisdiction.
- Provisioning is idempotent by name and never deletes resources.

### Consequences

- Positive: no migration across jurisdictions is ever needed for such a deployment.
- Negative: a deployment created without `eu` cannot be converted and must be recreated.
- Follow-ups: the residency documentation states which data the jurisdiction covers.

## ADR-022: Rate limiting and abuse protection deferred to P1 with recorded starting values

Status: Accepted, 2026-10-15

### Context

Rate limiting may be key for DDoS protection, so the layers are mapped: Cloudflare mitigates volumetric attacks on every plan, WAF rate limiting rules apply per zone and plan, and the Workers Rate Limiting binding is permissive and eventually consistent per location. Rate limiting moves to P1 because the per-token and per-route values are tuned later.

### Decision

- Rate limiting is P1. It is not an MVP concern.
- A `RateLimiter` port is keyed by token selector, by client IP for unauthenticated and failed-auth requests, and by route class (metadata, dist, login, token creation, API writes). Responses are HTTP 429 with `Retry-After`.
- Workers use the Rate Limiting binding as abuse protection only, not accounting. Docker documents a reverse-proxy configuration (nginx `limit_req`, Traefik `RateLimit`) and an in-process limiter per replica.
- Starting values, to be tuned from MVP logs: 600 metadata and dist requests per minute per token (6,000 for project install tokens used by CI fleets); 10 failed authentications per minute per IP; 10 token creations per hour per user; 60 API writes per minute per token.
- Brute-force protection on login, TOTP and token checks (lockout plus an audit event) belongs to the same item.
- Strict per-deployment quotas are a separate item.

### Consequences

- Positive: no MVP effort spent on values that are not yet known; Cloudflare covers volumetric attacks meanwhile.
- Negative: until P1 ships, application-level abuse with valid tokens or expensive unauthenticated requests is limited only by the restricted-access rule ([ADR-008](registry-and-sources.md#adr-008-restricted-public-proxies-artifacts-persisted-by-digest-upstream-removals-kept-for-one-year)) and Cloudflare zone rules; a Docker deployment exposed directly has none of the Cloudflare layers.
- Follow-ups: whether Composer and npm retry on 429 is unverified and can be confirmed with client tests.
