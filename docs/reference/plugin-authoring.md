---
title: Plugin authoring
sidebar_position: 2
description: Write plugins for Package Broker.
---

## Supported imports

A plugin imports from `@package-broker/core` (the root) and `@package-broker/core/plugin`. Both expose the plugin API: `definePlugin`, the route, hook and port types, and the helpers first-party plugins use for identity and source providers.

Every other subpath of `@package-broker/core`, such as `kernel/*`, `db/*`, `auth/*` or `sources/*`, is internal. It may change or disappear in any release, including a patch release, and plugins must not import it. An architecture test fails the build when a `packages/plugin-*` source file does.

## Ports

A plugin supplies only the `identity` and `source` ports, by listing them in `binds` and providing `identityProviders` or `sourceProviders`. The blob store, cache, jobs and observability are adapters chosen in `broker.config.ts` (the config key for the `job` port is `jobs`); the database is fixed by the runtime (D1 or SQLite). A plugin cannot bind any of them.

An identity factory receives `fetch`, a clock and an env reader limited to its own `PB_IDP_*` secrets. A source factory receives nothing. Both are validated at `pb build` and at boot.

## `access.check` hook

On core routes with the authenticated boundary, the `access.check` hook input carries `permission: 'authenticated'`. This is a placeholder meaning any logged-in principal, not a permission in the catalogue, and it cannot be assigned to roles. A hook that wants to restrict these routes decides using the fields of `principal`.

## `registry.read` hook

A plugin on API 4 may register `registry.read` to restrict package reads; an API 3 plugin that registers it fails the build. The hook can only take away: it returns nothing (no opinion), `{ deny: true, reason }` to refuse the whole request, or, in the versions phase, `{ deniedVersions: [{ versionId, revision, reason }] }` to hide named candidates. `reason` is `restricted` or `client_unsupported`. There is no allow verdict, no response rewrite and no `next()`. <!-- source: packages/core/src/plugin.ts --> <!-- source: packages/core/src/kernel/registry.ts --> <!-- source: packages/core/src/registry/policy/hooks.ts -->

The hook runs after authorization, so it never sees a request the caller may not make. In the `request` phase it receives the organization, project, principal kind and id, ecosystem, normalized client hints, the read kind and the package key. In the `versions` phase it receives up to 64 frozen candidate facts per call (ids, package key, version, revision, publish date and date basis). It never receives headers, cookies, tokens, e-mail addresses, upstream URLs or manifests. <!-- source: packages/core/src/registry/policy/hooks.ts --> <!-- source: packages/core/src/registry/policy/session.ts -->

All `registry.read` hooks of one request share one deadline, `registry.policy.hookBudgetMs` (default 1000 ms, the same default as `access.check`). The budget is not reset between pages or phases. A hook that throws, returns an unknown shape, names an unknown version or revision, or runs out of budget fails the request with `503 policy_unavailable`; a result that settles after the deadline is ignored. Hooks run in registration order, and a later hook cannot restore a candidate an earlier hook denied. <!-- source: packages/core/src/registry/policy/hooks-timeout.test.ts --> <!-- source: packages/core/src/registry/policy/hooks.test.ts -->

Hooks are compiled into the bundle like every plugin; nothing is loaded at run time. A deployment that relies on a hook must build both runtime bundles with it. A synchronous loop inside a hook cannot be interrupted by the deadline, so keep hook code free of blocking work.
