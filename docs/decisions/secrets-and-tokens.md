# Secrets and tokens

Decisions on token kinds, secret storage and key rotation.

## ADR-010: Token kinds pat, svc and cst; PATs span projects, service tokens are CI-only and bound to one project

Status: Accepted, 2026-10-15

### Context

One opaque token must work for Composer HTTP Basic and npm Bearer across npm, pnpm and yarn Berry; a token prototype ran 64 client cases per runtime with identical results on Node and workerd. Composer stores credentials per host, so a developer needs one credential for all projects on the broker host. A PAT therefore spans many projects and a service token is CI-only. Expiry defaults and the validity of each token kind are set below.

### Decision

- Token format is `pb_(pat|svc|cst)_<selector>_<secret>`. The prefix encodes the principal kind only. Capability lives in scopes. The stored form is a selector plus HMAC-SHA-256 with a versioned pepper ([ADR-012](#adr-012-secrets-and-cryptography-with-a-deployment-master-key-hkdf-record-bound-aad-and-a-versioned-pepper)).
- Scopes are `read` (install), `write` (publish, deprecate, dist-tag; P1) and `full` (API operations the user may do). Effective access is requested scopes intersected with the principal's grants, the creator's role and the project token policy. A request for a scope that is not allowed is refused, not narrowed.
- `pat`: created by a user; limited to selected projects or all of the user's projects; accepted on every project URL within its scope, so one Composer `http-basic` entry per host covers all projects.
- `svc`: service principal owned by a user, CI only, bound to one project (organization-wide only for organization admins). It stays valid until it expires or is revoked, regardless of the creator's later membership. The audit log records the creator.
- `cst`: its own principal type because a customer has no owning user; `read` only; expiry per the licence-freeze rules ([ADR-018](registry-and-sources.md#adr-018-catalogue-dates-and-licence-freeze-foundations-in-the-first-schema)).
- Default maximum expiry is 90 days; CI read-only service tokens may last one year.
- PATs and user sessions are re-validated against the identity provider daily and at every login.
- Every request checks the grant, so a token never outlives a revoked grant; `last_used_at` is written lazily; revocation is immediate.
- The vendor API key is a `svc` token with `customers:*` scopes.

### Consequences

- Positive: one credential per laptop; CI uses `COMPOSER_AUTH` with a project token; the format works unchanged on both runtimes and all supported clients (yarn needs `npmAlwaysAuth`).
- Negative: a service token outlives its creator's membership, which is a deliberate choice made visible through the audit record; token lookup and per-request grant checks add one indexed query.
- Follow-ups: GitHub OIDC exchange for short-lived publish tokens; the Tokens screen shows kind and scopes in separate columns.

## ADR-012: Secrets and cryptography with a deployment master key, HKDF, record-bound AAD and a versioned pepper

Status: Accepted, 2026-10-15

### Context

Source credentials, GitHub App keys and webhook secrets are stored by the broker and must survive key rotation without downtime. With one organization per deployment ([ADR-002](identity-and-sessions.md#adr-002-one-organization-per-deployment-with-org_id-kept-as-a-constant-column)), keys are scoped per deployment, not per organization.

### Decision

- The deployment holds one 32-byte random master key in the environment or a binding (named "master key", not "salt").
- Credential ciphertexts use AES-256-GCM with a random 96-bit nonce. Keys are derived with HKDF with a `key_version`, and the additional authenticated data is bound to the record, so a ciphertext cannot be moved to another record.
- Token secrets are stored as selector plus HMAC-SHA-256 under a versioned pepper ([ADR-010](#adr-010-token-kinds-pat-svc-and-cst-pats-span-projects-service-tokens-are-ci-only-and-bound-to-one-project)).
- Rotation loads two key versions at once. A command and job re-encrypt every ciphertext under a new `key_version` with progress and resume, rotate the pepper version, and report what remains on the old version, without downtime.
- Per-deployment keys and blob prefixes apply; deduplication happens within one deployment.

### Consequences

- Positive: rotation without downtime; a stolen database dump without the master key does not reveal credentials; a ciphertext cannot be replayed onto another record.
- Negative: losing the master key makes credentials unrecoverable, so the key belongs in the backup process of the operator ([ADR-019](deployment-and-runtimes.md#adr-019-backup-and-recovery-of-application-state-and-catalogue-metadata)); two keys loaded during rotation widen the exposure window briefly.
- Follow-ups: backups include ciphertexts and keys together with the stated handling; rotation runbook in the deployment documentation.
