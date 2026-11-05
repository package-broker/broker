---
title: Plugin authoring
sidebar_position: 2
description: Write plugins for Package Broker.
---

## Supported imports

A plugin imports from `@package-broker/core` (the root) and `@package-broker/core/plugin`. Both expose the plugin API: `definePlugin`, the route, hook and port types, and the helpers first-party plugins use for identity and source providers.

The public conformance kit is also available at `@package-broker/core/plugin/testing`. Other implementation subpaths of `@package-broker/core`, such as `kernel/*`, `db/*`, `auth/*` or `sources/*`, is internal. It may change or disappear in any release, including a patch release, and plugins must not import it. An architecture test fails the build when a `packages/plugin-*` source file does.

## Ports

A plugin supplies the `identity`, `source` or `audit-trail` port, by listing it in `binds` and providing `identityProviders`, `sourceProviders` or `auditTrail`, respectively. Audit declarations require `apiVersion: 4`; API 3 remains supported for other plugins. Sink plugins declare `auditSinks`, without binding a port. <!-- source: packages/core/src/plugin.ts:93 --> The blob store, cache, jobs and observability are adapters chosen in `broker.config.ts` (the config key for the `job` port is `jobs`); the database is fixed by the runtime (D1 or SQLite). A plugin cannot bind any of them.

An identity factory receives `fetch`, a clock and an env reader limited to its own `PB_IDP_*` secrets. A source factory receives nothing. Both are validated at `pb build` and at boot.

## `access.check` hook

On core routes with the authenticated boundary, the `access.check` hook input carries `permission: 'authenticated'`. This is a placeholder meaning any logged-in principal, not a permission in the catalogue, and it cannot be assigned to roles. A hook that wants to restrict these routes decides using the fields of `principal`.

## `registry.read` hook

A plugin on API 4 may register `registry.read` to restrict package reads; an API 3 plugin that registers it fails the build. The hook can only take away: it returns nothing (no opinion), `{ deny: true, reason }` to refuse the whole request, or, in the versions phase, `{ deniedVersions: [{ versionId, revision, reason }] }` to hide named candidates. `reason` is `restricted` or `client_unsupported`. There is no allow verdict, no response rewrite and no `next()`. <!-- source: packages/core/src/plugin.ts --> <!-- source: packages/core/src/kernel/registry.ts --> <!-- source: packages/core/src/registry/policy/hooks.ts -->

The hook runs after authorization, so it never sees a request the caller may not make. In the `request` phase it receives the organization, project, principal kind and id, ecosystem, normalized client hints, the read kind and the package key. In the `versions` phase it receives up to 64 frozen candidate facts per call (ids, package key, version, revision, publish date and date basis). It never receives headers, cookies, tokens, e-mail addresses, upstream URLs or manifests. <!-- source: packages/core/src/registry/policy/hooks.ts --> <!-- source: packages/core/src/registry/policy/session.ts -->

All `registry.read` hooks of one request share one deadline, `registry.policy.hookBudgetMs` (default 1000 ms, the same default as `access.check`). The budget is not reset between pages or phases. A hook that throws, returns an unknown shape, names an unknown version or revision, or runs out of budget fails the request with `503 policy_unavailable`; a result that settles after the deadline is ignored. Hooks run in registration order, and a later hook cannot restore a candidate an earlier hook denied. <!-- source: packages/core/src/registry/policy/hooks-timeout.test.ts --> <!-- source: packages/core/src/registry/policy/hooks.test.ts -->

Hooks are compiled into the bundle like every plugin; nothing is loaded at run time. A deployment that relies on a hook must build both runtime bundles with it. A synchronous loop inside a hook cannot be interrupted by the deadline, so keep hook code free of blocking work.

## Audit trail and sinks (API 4)

A trail declares `binds: ['audit-trail']` and an `auditTrail` definition with optional `toggleEnv` and `create(ctx)`. Only one plugin may bind the port. The context exposes `active`, an organization-bound `journal` and `requestVerification()`. Return a handler for `listAudit`, `listProjectAudit` and `auditHead`; preserve the public response schemas. When inactive, return `audit_trail_unavailable`. Verification is requested through core, never by scheduling plugin SQL. The journal list accepts project/actor/action filters, a sequence cursor and limit, and returns sanitized events or withheld markers. <!-- source: packages/core/src/audit/plugin-api.ts:139 --> <!-- source: packages/core/src/kernel/plugin-ports.ts:1 -->

`journal.head()` includes `chainId`, `epoch`, head sequence/hash, retained boundary, pending count and `verification: null | { fromSeq, throughSeq, bodies, withheld, verifiedAt }`. This field describes the actual checked range, including a retained suffix or empty range. Preserve it in the trail's head response; do not turn a suffix check into a whole-history claim. The first-party trail exposes `lastVerifiedAt` only for a nonempty verified range. A withheld marker establishes a chain link, not a verified body. <!-- source: packages/core/src/audit/plugin-api.ts:115 --> <!-- source: packages/plugin-audit-trail/src/routes.ts:58 -->

A sink definition declares a unique `id`, `kind`, destination spec (`otlp-http-json` or `https-json`), activation (`build` or `env`), custody (`delivery` or `durable`), source-IP policy, optional batch/rejection limits and `create(ctx)`. Sink factories receive deployment id, runtime (`docker` or `cloudflare`), clock, a destination-bound fetch and an env reader for declared non-destination variables only. Core resolves destinations and injects credentials; a plugin sends only JSON body, content type and abort signal. No raw SQL, arbitrary endpoint, authentication headers or destination secrets are supplied through this context. Public HTTPS destinations need a credential; Node private-egress opt-in has separate semantics. <!-- source: packages/core/src/audit/plugin-api.ts:210 --> <!-- source: packages/core/src/audit/sinks/transport.ts:118 -->

Implement `deliver(batch, signal)` and, when the protocol supports it, `frontier(identity, signal)`. A version-1 batch contains frozen time, chain/epoch/organization, events and markers, and the exact through-sequence/hash. Preserve frozen retries and all marker identities; TypeScript fields are camelCase, webhook wire fields are snake_case. Do not compute canonical hashes in plugins. `sourceIp` is optional and unhashed. Bodies are bounded to 512 KiB and responses to 64 KiB. <!-- source: packages/core/src/audit/plugin-api.ts:240 --> <!-- source: packages/core/src/audit/wire.ts:1 -->

Delivery returns accepted (optionally with `partial_success` warning), uncertain (`partial_rejected` plus count), retry or rejected. ACKs echo chain, epoch and exact batch frontier. Return only fixed error codes (`network`, `timeout`, `refused`, `too_large`, `http_status`, `bad_response`), never response text, request data or credentials. Core owns retry leases, cursor/custody advancement, dispositions and retention. A durable declaration is a receiver guarantee, not proof supplied by the type system; see the [operator contract and qualification](../operations/audit.md#webhook-receiver-contract). <!-- source: packages/core/src/audit/plugin-api.ts:306 -->

### Public conformance kit

Import from the exported entry as it exists today:

```ts
import {
  auditCanonicalVectors,
  auditMarkerFixtures,
  auditSinkConformanceFixturesFor,
  runAuditSinkConformance,
  type AuditSinkConformanceAdapter,
} from '@package-broker/core/plugin/testing';
```

The kit also exports `auditSinkConformanceFixtures` and the conformance types/error. Supply an `AuditSinkConformanceAdapter`: acknowledgement mode, factory by generation, independent wire decoder and raw wire-record extractor, wire format, response encoder, partial-outcome semantics and optional frontier response/status overrides. Then `await runAuditSinkConformance(adapter)`; failures throw `AuditSinkConformanceError` naming the fixture. Do not build the independent extractor from the same encoder projections: that can make a broken encoding test itself. <!-- source: packages/core/package.json:17 --> <!-- source: packages/core/src/audit/plugin-testing.ts:614 --> <!-- source: packages/core/src/audit/plugin-testing.ts:735 -->

The fixtures exercise canonical vectors, duplicate/lost ACKs, overlapping deliveries, protocol-specific partial rejection and status handling, marker crashes and late originals, frozen batches across schema/generation changes, marker-only delivery, wrong epochs and receiver-frontier restore detection where supported. The kit checks protocol behavior with simulated transport, not real receiver durability, a complete runtime/database recovery or protection of an external archive. Run repository/runtime tests and receiver qualification as well. <!-- source: packages/core/src/audit/plugin-testing.ts:489 --> <!-- source: packages/core/src/audit/plugin-testing.ts:685 -->
