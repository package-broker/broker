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
