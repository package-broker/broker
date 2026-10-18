# Plugin API and composition

Decisions on how a deployment is assembled from plugins, how far plugins are trusted, and what the public API exposes.

## ADR-004: Modular build composition at build time with deny-only hooks

Status: Accepted, 2026-10-15

### Context

The module set must be decided when the artifact is built, on Cloudflare and on Docker, because Workers cannot load code at runtime without Worker Loader.

### Decision

- A deployment lists its plugins and platform in `broker.config.ts`. `pb build` validates the list and generates a static manifest with static imports plus a JSON manifest. The same command produces the Workers bundle, the Node bundle and the Docker image.
- Plugins are trusted code, reviewed and pinned by the operator like any dependency (see [ADR-025](#adr-025-plugins-run-in-process-an-execution-boundary-for-untrusted-plugins-is-nice-to-have) for untrusted plugins).
- `definePlugin` declares an id, capabilities, port bindings, typed hooks and events, routes, migrations and permissions. Ids are unique. Two plugins binding the same port is a build error.
- Routes, OpenAPI and migrations from plugins are merged into the core outputs.
- Hooks may only deny. The core permission model is the sole authority for granting access.
- Plugins may contribute UI pages through a build-time manifest of routes, menu entries and required permissions (Nice to have).
- Users with their own plugin list build from a template repository and its lockfile.
- Ports fall into two groups. `blob`, `cache`, `job` and `observability` are adapters chosen in `broker.config.ts` (the config key for `job` is `jobs`); the database is fixed by the runtime (D1 or SQLite) and has no choice. A plugin cannot bind any of these. `identity` and `source` are contributed by plugins: a plugin lists them in `binds` and supplies the provider factory. One plugin binds each of them at most.
- Two plugin keys are special-cased because they return provider instances rather than hook or route declarations: `identityProviders` is required when `binds` contains `identity` and rejected otherwise, and `sourceProviders` is required when `binds` contains `source` and rejected otherwise (it needs `apiVersion` 3 or later). An identity factory receives `fetch`, a clock and an env reader limited to its own `PB_IDP_*` secrets. A source factory receives nothing. The kernel validates the keys at `pb build` and at boot and rejects a missing, extra or non-function key as a configuration error.
- `session` and `secrets` are not ports. Nothing binds them, so they are not in the `PortName` type.
- The supported import surface for plugins is the `@package-broker/core` root and `@package-broker/core/plugin`. Every other subpath of core is internal and may change in any release. An architecture test fails when a `packages/plugin-*` source file imports one.

### Consequences

- Positive: no runtime loading, a small attack surface, and the same composition on both runtimes; a hook cannot widen access by mistake.
- Negative: changing the module set needs a rebuild and redeploy; plugin authors cannot add permissive logic and must express grants through core roles.
- Follow-ups: a CI step reads the bundler metafile and fails when an excluded module is present; the plugin API compatibility contract (peer range plus integer `apiVersion`) is part of [ADR-023](release-and-versioning.md#adr-023-repository-strategy-versioning-and-release-process).

## ADR-025: Plugins run in-process; an execution boundary for untrusted plugins is Nice to have

Status: Accepted, 2026-10-15

### Context

Every plugin is compiled into the same bundle ([ADR-004](#adr-004-modular-build-composition-at-build-time-with-deny-only-hooks)) and runs in the same isolate or process with the same bindings, including the database and master key. That is acceptable while plugins are written by the project owner or reviewed and pinned by the operator, like a Composer dependency in a shop. A boundary matters only for third-party plugins, a public marketplace or a vendor writing plugins for another deployment; none is planned for 2.0. A prototype showed Dynamic Workers load plugin code with only an RPC stub in `env` and no outbound fetch, in open beta on Workers Paid at about $0.0000004 per invocation.

### Decision

- Plugins execute in-process and are trusted code.
- An execution boundary (service bindings with RPC, Workers for Platforms, Dynamic Workers, or a separate process on Docker) is Nice to have and is not built for 2.0.
- The plugin API stays narrow, with declared capabilities ([ADR-004](#adr-004-modular-build-composition-at-build-time-with-deny-only-hooks)), so that moving a plugin behind a boundary later does not change its code.

### Consequences

- Positive: no runtime cost or complexity for a case that does not exist yet.
- Negative: a malicious or faulty plugin has full access to deployment secrets; operators must review and pin plugins; no third-party plugin store is possible until the boundary exists.
- Follow-ups: revisit when a third-party plugin is requested; the AGPL plugin-composition question ([ADR-001](licensing-and-contribution-terms.md#adr-001-package-broker-20-is-a-backwards-incompatible-open-source-rewrite-built-rather-than-bought)) is settled before the plugin API is documented for third parties.

## ADR-015: Every UI action in the public API; read-only MCP in the MVP; access as code through a Terraform provider

Status: Accepted, 2026-10-15

### Context

The UI, automation and AI clients must see the same capabilities. Every UI action is in the public API and read-only MCP is in the MVP. Access as code is a Terraform provider, with no export or import CLI. An MCP prototype ran an OpenAPI-generated server with OAuth 2.1 and PKCE on Node and workerd.

### Decision

- The REST API is described in OpenAPI (Hono with zod-openapi). Every UI action exists in it and the UI uses only the public API. Routes carry `{permission, boundary}` entries that feed OpenAPI ([ADR-009](identity-and-sessions.md#adr-009-identity-and-access-through-oidc-single-sign-on-grants-to-sso-groups-or-emails-configurable-roles)).
- Errors use one envelope on every route: code, client-safe message and request id. The internal cause goes to logs only.
- The MVP ships `plugin-mcp` part 1: a read-only MCP server generated from the OpenAPI document, stateless HTTP, authenticated with a PAT or service token holding the `read` scope as Bearer. It exposes only what the token's projects allow.
- Destructive MCP tools (off by default, per-tool opt-in) and OAuth 2.1 client registration policies (PKCE, protected resource metadata, DCR or client-ID metadata documents, consent screen, per-grant revocation) are P1.
- Access configuration as code is a Terraform provider for the broker API covering projects, grants, package subsets, sources without secrets and token policies (Nice to have). No `pb access export` or `pb access import` command is built.

### Consequences

- Positive: one surface for UI, scripts, MCP and Terraform; no second code path for administration; no OAuth server is needed in the MVP.
- Negative: the API needs stable versioning from the first release; the Terraform provider is deferred, so teams that want access as code in the MVP script the API directly.
- Follow-ups: the vendor access API ([ADR-018](registry-and-sources.md#adr-018-catalogue-dates-and-licence-freeze-foundations-in-the-first-schema)) is part of the same OpenAPI document; MCP tool descriptions and errors follow MCP tool-design guidance.
