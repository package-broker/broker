# Identity and sessions

Decisions on tenancy, sign-in, roles, sessions, URL layout and the audit log.

## ADR-002: One organization per deployment, with `org_id` kept as a constant column

Status: Accepted, 2026-10-15

### Context

The single-tenant build is deployed once per customer on Cloudflare, so the application does not need several organizations in one deployment. Keeping `org_id` as a constant column leaves a later move to multi-tenancy open.

### Decision

- A deployment holds exactly one Organization (created at bootstrap) and many Projects under it. Customers (licence-freeze grants) hang under the Organization.
- Customer isolation is a deployment boundary: one Worker and one database per customer on Cloudflare, one instance per customer on Docker.
- There is no organization switcher, organization CRUD, tenant resolver or per-request database routing. The database handle comes from a deployment binding.
- Every tenant-owned table carries `org_id NOT NULL` with a foreign key, and every unique constraint starts with it.
- Every query goes through the repository layer, and repository methods take an organization context argument. Raw SQL outside repositories fails a lint rule.
- Blob keys and cache keys carry an organization segment (`o/<org_id>/...`).
- No global singletons: deployment settings (bindings, master key) stay apart from organization settings (domain policy, defaults).
- One CI fixture seeds a second organization and runs the authorization and repository contract tests against both to prove that no read crosses the boundary.
- The project switcher in the top bar stays, and its scope selector offers the organization-wide scope plus each project.

### Consequences

- Positive: a later reversal to multi-tenancy needs code but no data migration; one mode means nothing to compile out and no bundle-inspection proof; cross-customer data exposure is excluded by the deployment boundary.
- Negative: the column is decoration unless the discipline above holds (one to two days in the database port and migration runner, then minutes per table); one deployment per customer multiplies operations when one operator serves many customers ([ADR-003](platform-ports-and-adapters.md#adr-003-two-runtimes-cloudflare-workers-and-docker-on-node-behind-ports-and-adapters)).
- Follow-ups: the two-organization fixture is part of the database port contract tests; isolation tests between projects replace cross-organization tests.

## ADR-009: Identity and access through OIDC single sign-on, grants to SSO groups or emails, configurable roles

Status: Accepted, 2026-10-15

### Context

Operators already run an identity provider. Cloudflare Access evaluates group membership from the token issued at sign-in, and generic OIDC has no directory API.

### Decision

- Single sign-on for the UI uses Cloudflare Access on Workers and Dex on Docker, both through OIDC (`plugin-sso-oidc`). Package hostnames use token authentication. `DomainPolicy` holds the verified domain, trusted issuer and auto-join.
- The `Identity` port carries provider, subject, `email_verified` and group claims; hooks `auth.resolveIdentity` and `auth.mapGroups` may deny only ([ADR-004](plugin-api-and-composition.md#adr-004-modular-build-composition-at-build-time-with-deny-only-hooks)).
- There are no local groups. A grant (`ProjectGrant` or an organization grant) goes either to an SSO/SAML group or to an individual email address, at organization or project level.
- Roles are data, not an enum: a role table and permission sets, configurable per instance. Shipped defaults are `Organization Admin`, `Organization Auditor`, `Project Owner`, `Project Developer` and `Project Auditor`. Last-owner protection applies to `Organization Admin`.
- Organization admins see all projects. A user without any grant gets an HTTP 403 page stating that they must be assigned to a project.
- Local admin login (credentials plus TOTP) exists for bootstrap and admins only.
- The authorization engine is a route table of `{permission, boundary}` that also feeds OpenAPI, with one indexed lookup or a maintained effective-access projection.
- SCIM 2.0 provisioning for identity providers federated through Dex is P1.

### Consequences

- Positive: access follows the operator's directory; permission checks live in one place; roles can be adapted without a schema change.
- Negative: a user removed in the identity provider keeps access until the session or token re-validation window ends ([ADR-010](secrets-and-tokens.md#adr-010-token-kinds-pat-svc-and-cst-pats-span-projects-service-tokens-are-ci-only-and-bound-to-one-project), [ADR-011](#adr-011-database-sessions-bounded-revocation-re-authentication-before-token-creation)); Dex does not serve SCIM itself, so the provider pushes to the broker endpoint and users are matched by verified email or external id.
- Follow-ups: the matching rule between SCIM `externalId` and Dex `sub`; the identity-provider test matrix.

## ADR-011: Database sessions, bounded revocation, re-authentication before token creation

Status: Accepted, 2026-10-15

### Context

Group removal in the identity provider does not reach the broker unless the broker polls or receives a push: Cloudflare Access evaluates groups at sign-in and generic OIDC has no directory API. A five-minute removal-to-denial target was set while a mock identity provider showed a 15-minute poll.

### Decision

- Sessions are stored in the application database on both runtimes. Durable Object and Redis session stores are plugins.
- Cookies are host-only with CSRF protection.
- Session lifetime is 12 hours with a one-hour idle timeout.
- Broker-side changes (grant removed, user disabled, token revoked) apply on the next request.
- Group changes in the identity provider apply within five minutes where the provider offers a directory API or push. Where it does not, the window is the next sign-in or session expiry. The window per provider is shown per user with a "membership checked at" indicator.
- Re-authentication is required before a token is created.

### Consequences

- Positive: the promise made to operators is truthful per provider; no extra infrastructure for sessions.
- Negative: providers without a directory API have a window of up to 12 hours; a five-minute poll is bounded by identity-provider API limits.
- Follow-ups: the UI copy states the configured window instead of a fixed number; SCIM in P1 ([ADR-009](#adr-009-identity-and-access-through-oidc-single-sign-on-grants-to-sso-groups-or-emails-configurable-roles)) shortens the window for pushed deprovisioning.

## ADR-014: Audit log in the application database with hash chaining; export in P1

Status: Accepted, 2026-10-15

### Context

The audit log could live inside the application or in an external system; it stays in the application for the MVP. Audit events are low volume and must be complete; operational logs are high volume and short-lived. Sentry is an error tracker and Analytics Engine keeps data for three months, so neither is an audit store. Delivery to an external sink is asynchronous and can lose events on Workers.

### Decision

- An append-only `audit_event` table in the application database is the system of record. Each row stores `sha256(previous_hash, canonical row)`.
- The audit row is written in the same database batch as the change it records, so it cannot be lost.
- Events carry actor (user, service principal or token selector), project, package, version, source IP and the upstream operation. Retention is configurable and defaults to keeping everything; pruning only by explicit policy.
- The UI offers an Audit page for organization admins with filters, per-entity History tabs and a chain status badge. Project owners see their projects' events only.
- Export (P1): JSON Lines and CSV through the API, and an optional sink through the observability port (OTLP logs or HTTP) that receives each event and the daily head hash.
- Operational and access logs go through the observability port ([ADR-024](platform-ports-and-adapters.md#adr-024-observability-through-an-otlp-first-port-vendors-are-plugins-only-where-otlp-is-not-enough)), not the audit table.

### Consequences

- Positive: complete events with tamper evidence; plain indexed queries by project, package, token and actor; the external head hash lets an auditor detect a rewritten chain.
- Negative: an administrator with database access can rewrite the chain unless head hashes are stored outside; about 500 bytes per event, so one million events take about 0.5 GB of D1's 10 GB.
- Follow-ups: export and sink in P1; audit events for source credential and subscription changes ([ADR-007](registry-and-sources.md#adr-007-sources-at-organization-and-project-level-with-project-precedence-digest-dedup-and-live-subscription)).

## ADR-016: Project in the URL path, one Composer `http-basic` entry per host

Status: Accepted, 2026-10-15

### Context

Composer stores `http-basic` credentials by host, and the host includes the port; the project path is not part of the key. Every project is served from one host, so a workstation can hold only one Composer credential for the broker. npm can key `.npmrc` auth by registry URL path. Path routing and the token model of [ADR-010](secrets-and-tokens.md#adr-010-token-kinds-pat-svc-and-cst-pats-span-projects-service-tokens-are-ci-only-and-bound-to-one-project) are chosen for this reason.

### Decision

- The project is part of the URL path on every endpoint: `/<project>/...` for Composer and `/<project>/npm/` for npm. Per-project hostnames are not built.
- A developer's laptop uses one PAT, which the broker accepts on every project URL within its scope ([ADR-010](secrets-and-tokens.md#adr-010-token-kinds-pat-svc-and-cst-pats-span-projects-service-tokens-are-ci-only-and-bound-to-one-project)). The Composer client holds one `http-basic` entry for the broker host.
- CI uses `COMPOSER_AUTH` with a project service token. A project token is never written to the global Composer configuration.
- The Setup screen asks "laptop or CI" and emits the matching snippet.
- Per-project hostnames stay available as a later option.

### Consequences

- Positive: no wildcard DNS or certificates; one host for cookies and CSRF; the credential collision is solved without per-project hosts.
- Negative: a leaked PAT exposes every project in its scope; this is limited by scopes, expiry and daily re-validation ([ADR-010](secrets-and-tokens.md#adr-010-token-kinds-pat-svc-and-cst-pats-span-projects-service-tokens-are-ci-only-and-bound-to-one-project)).
- Follow-ups: the setup snippets are covered by client matrix tests with Composer, npm, pnpm and yarn.
