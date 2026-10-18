# Platform, ports and adapters

Decisions on the supported runtimes, the outbound network policy and observability.

## ADR-003: Two runtimes, Cloudflare Workers and Docker on Node, behind ports and adapters

Status: Accepted, 2026-10-15

### Context

The product must run on Cloudflare Workers and as a Docker image for operators outside Cloudflare. Prototypes ran the same Hono code on Node 24 and on workerd with identical client-visible behaviour for npm publish, Composer push, the database port over D1, `better-sqlite3` and `node:sqlite`, the job port, scoped tokens, the npm proxy and observability. The Workers Paid plan is a prerequisite.

### Decision

- Ship two runtimes, `runtime-cloudflare` and `runtime-node`, over one core.
- Core code depends only on ports: database, migration runner, blob store, cache, job, observability, identity and source provider.
- Cloudflare bindings: D1 (SQLite dialect), R2 (`BlobStore`), Queues plus Cron Triggers (jobs), Durable Objects (fetch coalescing), Workers Logs and Analytics Engine.
- Docker bindings: `better-sqlite3` on SQLite, filesystem or S3-compatible storage, a database queue with leases, heartbeats, fencing and dead letters, single replica.
- The Workers Paid plan ($5/month) is a documented prerequisite for a working service. No Free-plan mode is built. The requirement is recorded in the deployment documentation and the README requirement list.
- PostgreSQL, Redis, multi-replica Docker and Hyperdrive are plugins or Nice to have items.

### Consequences

- Positive: one codebase, contract tests per backend, and the same client behaviour on both runtimes; an operator without Cloudflare can still self-host.
- Negative: every port needs two adapters and a parity test; Workers limits (CPU, memory, subrequests, no process spawning) shape the core; the Workers Paid cost is a fixed floor.
- Follow-ups: deployment documentation for both runtimes; D1 numbers from a remote test feed the sizing notes; adapter parity tests are part of CI ([ADR-023](release-and-versioning.md#adr-023-repository-strategy-versioning-and-release-process)).

## ADR-013: Outbound fetch policy with denied private ranges and a Docker-only host allowlist

Status: Accepted, 2026-10-15

### Context

Sources make the broker fetch URLs configured by admins, which creates server-side request forgery and credential-leak risks across redirects and archives. An internal GitLab on a private network is a legitimate Docker use case. A GitHub App prototype showed installation tokens are broad unless narrowed.

### Decision

- The source provider port applies one outbound fetch policy: private, loopback and link-local ranges are denied; credentials are bound to their origin and are not sent across redirects to another origin; archive size and path count are bounded and paths are validated.
- On Docker, an operator may set a deployment-owned allowlist of private hosts in deployment configuration only. The UI shows the list read-only and shows a "denied by policy" state for blocked hosts.
- Workers keeps the deny: it has no private network to reach.
- The Composer-style User-Agent for credentialed v1 sources is configurable ([ADR-005](registry-and-sources.md#adr-005-ecosystems-are-composer-and-npm-composer-v2-for-clients-and-served-endpoints-v1-provider-protocol-ingested-from-sources)).

### Consequences

- Positive: a compromised admin account cannot turn the broker into a proxy for internal services; an internal GitLab works on Docker without opening the policy in the UI.
- Negative: allowlist changes need deployment access, not UI access; archive limits can reject very large legitimate packages.
- Follow-ups: contract tests cover redirects across origins and oversized archives; limits on Workers follow the memory and subrequest limits of the platform.

## ADR-024: Observability through an OTLP-first port; vendors are plugins only where OTLP is not enough

Status: Accepted, 2026-10-15

### Context

New Relic ingests OTLP natively, so its integration is an OTLP exporter with an endpoint and an API key header. Sentry accepts OTLP traces and logs in open beta but needs its SDK for error grouping, releases and source maps. A prototype produced one port (logger, metrics, tracer, errors) with five adapters and 35 assertions passing on Node and workerd.

### Decision

- One observability port with JSON logs to stdout and stderr on Docker, Workers Logs plus Analytics Engine on Cloudflare, and OTLP export of logs, metrics and traces on both runtimes.
- Every request log carries `DEPLOYMENT_ID` and the token identifier, and every request produces a root span with an `upstream.fetch` child span and a propagated `traceparent`.
- New Relic is an OTLP configuration (HTTP/protobuf recommended), not a plugin; `plugin-newrelic` is P2.
- `plugin-sentry`, needed only for SDK features, is Nice to have.
- An authenticated Prometheus scrape endpoint on Docker is P1. Workers metrics stay in Analytics Engine.
- Audit events do not use this port as their system of record ([ADR-014](identity-and-sessions.md#adr-014-audit-log-in-the-application-database-with-hash-chaining-export-in-p1)).

### Consequences

- Positive: any OTLP backend works on both runtimes without a vendor SDK; one place to add instrumentation.
- Negative: Sentry grouping, releases and source maps are unavailable without the SDK plugin; Analytics Engine keeps data for three months; OTLP delivery validation is asynchronous, so a 200 does not prove ingestion.
- Follow-ups: usage analytics dashboards read from the same metrics.
