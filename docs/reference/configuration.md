---
title: Configuration
sidebar_position: 5
description: broker.config.ts, platform ports, Node environment variables and Worker bindings.
---

Package Broker is configured in two places. `broker.config.ts` is read by `pb build` and fixes the plugin set, the UI assets and the platform adapters in the bundle. Environment variables, and on Workers the bindings, are read when the server starts.

## `broker.config.ts`

The file default-exports the result of `defineConfig` from `@package-broker/core/config`. `defineConfig` returns its argument unchanged and exists for type checking. The repository root holds a working example:

<!-- source: packages/core/src/config.ts:102 -->
<!-- source: broker.config.ts:1 -->

```ts
import { defineAssets, defineConfig } from '@package-broker/core/config';
import github from '@package-broker/plugin-github';
import ssoOidc from '@package-broker/plugin-sso-oidc';

export default defineConfig({
  platform: 'cloudflare',
  plugins: [ssoOidc({ runtimeProviders: true }), github()],
  assets: [defineAssets({ kind: 'ui', provider: '@package-broker/ui-assets' })],
  platformPorts: {
    cloudflare: {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
      cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
      observability: {
        adapter: 'workers',
        analyticsBinding: 'ANALYTICS',
        deploymentIdEnv: 'DEPLOYMENT_ID',
      },
    },
    node: {
      blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
      cache: { adapter: 'lru', maxBytes: 33554432 },
      jobs: { adapter: 'database', maxRunning: 2 },
      observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
  },
});
```

| Key             | Required | Meaning                                                                                                                                                          |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`      | yes      | `'cloudflare'` or `'node'`. The target `pb build` uses when `--target` is not given.                                                                             |
| `plugins`       | yes      | The plugins compiled into the bundle. Enabling a plugin means adding its package as a dependency, listing it here and rebuilding. Nothing is loaded at run time. |
| `assets`        | no       | Build-time asset selections, see [Assets](#assets).                                                                                                              |
| `platformPorts` | no       | One stanza per target, `cloudflare` and `node`, see [Platform ports](#platform-ports).                                                                           |
| `registry`      | no       | Registry tuning, see [Registry](#registry).                                                                                                                      |
| `tokens`        | no       | Token lifetime limits, see [Tokens](#tokens).                                                                                                                    |
| `observability` | no       | `level` (`'debug'`, `'info'`, `'warn'` or `'error'`, default `'info'`) and `trustInboundTraceparent` (boolean, default `false`).                                 |
| `vulnerability` | no       | `{ enabled: boolean }`. Vulnerability checks are on unless `enabled` is `false`.                                                                                 |
| `mcp`           | no       | `{ enabled: boolean }`. Turns on the read-only MCP endpoint. On Workers it needs the `MCP_RATE_LIMIT` binding.                                                   |

<!-- source: packages/core/src/config.ts:21 -->
<!-- source: packages/core/src/config.ts:50 -->
<!-- source: packages/core/src/config.ts:120 -->
<!-- source: packages/cli/src/build.ts:170 -->

`observability.level` sets the lowest log level that is emitted; metrics are not affected. Set `observability.trustInboundTraceparent` to `true` only behind a proxy that sets or strips the W3C `traceparent` header; the server then continues the inbound trace.

<!-- source: packages/core/src/config.ts:50 -->
<!-- source: packages/core/src/platform/tracing.ts:61 -->

`pb build` validates `observability`, `vulnerability`, the plugins, `platformPorts` and `assets`, and copies `platformPorts`, `observability`, `registry`, `tokens`, `vulnerability` and `mcp` into the generated manifest. The server validates `registry`, `tokens` and `mcp` when it starts; on Workers, at the first request.

<!-- source: packages/cli/src/build.ts:172 -->
<!-- source: packages/cli/src/build-artifacts.ts:211 -->
<!-- source: packages/runtime-node/src/startup.ts:710 -->

### Assets

`defineAssets({ kind: 'ui', provider: '<package>' })` selects the package that supplies the web interface. `kind` must be `'ui'`, `provider` is a package name, and the list holds at most one `ui` entry. `pb build` resolves the provider from the directory of the config file and writes the interface into `assets/` in the out directory. The provider package is never part of the runtime bundle.

<!-- source: packages/core/src/asset-provider.ts:4 -->
<!-- source: packages/core/src/asset-provider.ts:24 -->
<!-- source: packages/core/src/config.ts:34 -->
<!-- source: packages/cli/src/build-assets.ts:142 -->

### Registry

| Key                                                      | Default                                    | Meaning                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `outbound.allowPrivateHosts`                             | none                                       | Private hosts the broker may fetch from.                                                                                           |
| `outbound.extraSelfOrigins`                              | none                                       | Up to 16 further origins of this deployment, for example a `workers.dev` alias. See [Workers fill limits](workers-fill-limits.md). |
| `userAgent.default`, `userAgent.composerStyle`           | `PackageBroker/2`, `Composer/2.8.0`        | User agents sent upstream.                                                                                                         |
| `upstreamContact`                                        | `https://github.com/package-broker/broker` | A `mailto:` address or an `https` URL.                                                                                             |
| `timers.metadataTtlSeconds`, `timers.negativeTtlSeconds` | `300`, `30`                                | Cache lifetimes for metadata and for "not found" answers, at most 86400.                                                           |
| `timers.waitBudgetMs`                                    | `8000`                                     | At most 25000.                                                                                                                     |
| `caps.metadataBytes`, `caps.archiveBytes`                | 32 MiB, 64 MiB                             | Size limits for upstream metadata and archives. See [Workers fill limits](workers-fill-limits.md).                                 |
| `npmAudit.enabled`                                       | `true`                                     | Forwarding of npm audit requests.                                                                                                  |

<!-- source: packages/core/src/registry/registry-config.ts:7 -->
<!-- source: packages/core/src/registry/registry-config.ts:49 -->
<!-- source: packages/core/src/registry/registry-config.ts:79 -->

On Node, `registry` requires a `node` stanza in `platformPorts`; on Workers it requires the ports stanza and the `DB` binding.

<!-- source: packages/runtime-node/src/startup.ts:738 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:1575 -->

### Tokens

`tokens.maxLifetimeDays.personal` (1 to 365) and `tokens.maxLifetimeDays.service` (1 to 3650) cap the lifetime of personal and service tokens. Both default to 365. See [Access model](access-model.md).

<!-- source: packages/core/src/authz/token-lifetime.ts:15 -->
<!-- source: packages/core/src/authz/token-lifetime.ts:31 -->

## Platform ports

`pb build` validates every stanza present, whatever the target. Without a stanza for the target it builds, it prints a warning and builds a bundle with the blob store, cache, jobs and observability ports disabled; a plugin that registers jobs then fails the build.

<!-- source: packages/core/src/platform/port-config.ts:414 -->
<!-- source: packages/cli/src/build.ts:212 -->

Each stanza has four sections: `blob`, `cache`, `jobs` and `observability`. Every section is required, and each target allows only its own adapters. A key that belongs to another adapter, or an unknown key, is rejected.

<!-- source: packages/core/src/platform/port-config.ts:63 -->
<!-- source: packages/core/src/platform/port-config.ts:192 -->

| Section         | Cloudflare adapter | Node adapters      |
| --------------- | ------------------ | ------------------ |
| `blob`          | `r2`               | `filesystem`, `s3` |
| `cache`         | `cache-api`        | `lru`              |
| `jobs`          | `queues`           | `database`         |
| `observability` | `workers`          | `stdio`            |

### `blob`

| Key                                                                             | Adapter      | Meaning                                                                                                            |
| ------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `maxBytes`                                                                      | all          | Required. Largest single blob in bytes, a positive integer of at most 67108864 (64 MiB).                           |
| `binding`                                                                       | `r2`         | Required. Name of the R2 binding.                                                                                  |
| `rootEnv`                                                                       | `filesystem` | Required. Name of the environment variable that holds the storage directory.                                       |
| `endpointEnv`, `regionEnv`, `bucketEnv`, `accessKeyIdEnv`, `secretAccessKeyEnv` | `s3`         | Required. Names of the environment variables that hold the S3-compatible endpoint, region, bucket and credentials. |
| `sessionTokenEnv`                                                               | `s3`         | Optional. Name of the variable that holds a session token.                                                         |
| `pathStyle`                                                                     | `s3`         | Optional boolean. Path-style bucket addressing.                                                                    |

<!-- source: packages/core/src/platform/port-config.ts:272 -->
<!-- source: packages/core/src/platform/blob.ts:158 -->

The directory named by `rootEnv` must be an absolute, normalized path with no symlink in it or above it. It must be owned by the user that runs the server and must not be writable by group or others. Missing directories are created.

<!-- source: packages/runtime-node/src/blob/filesystem.ts:187 -->

### `cache`

| Key         | Adapter     | Meaning                                                                                                     |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `namespace` | `cache-api` | Optional. 1 to 64 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `maxBytes`  | `lru`       | Optional. In-memory budget in bytes, a positive integer of at most 33554432 (32 MiB).                       |

<!-- source: packages/core/src/platform/port-config.ts:296 -->

### `jobs`

| Key          | Adapter  | Meaning                                       |
| ------------ | -------- | --------------------------------------------- |
| `maxRunning` | all      | Required. Jobs running at once, 1 or 2.       |
| `binding`    | `queues` | Required. Name of the queue producer binding. |

<!-- source: packages/core/src/platform/port-config.ts:315 -->

The `database` adapter keeps jobs in the SQLite database and runs them in the server process.

<!-- source: packages/runtime-node/src/startup.ts:586 -->

### `observability`

| Key                | Adapter   | Meaning                                                                                                                                                                             |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploymentIdEnv`  | all       | Required and must be `'DEPLOYMENT_ID'`.                                                                                                                                             |
| `analyticsBinding` | `workers` | Optional. Name of the Analytics Engine binding for metrics.                                                                                                                         |
| `traces`           | `workers` | Optional. `enabled` (required boolean), `headSamplingRate` (above 0, at most 1), `destinations` (1 to 10 names) and `persist` (boolean).                                            |
| `endpointEnv`      | all       | Optional. Name of the variable that holds an OTLP endpoint. When set, logs, metrics and request spans are also exported there, and the variable must be set when the server starts. |
| `headersEnv`       | all       | Optional, requires `endpointEnv`. Name of the variable that holds the OTLP request headers as a JSON object of strings. The variable must be set when the server starts.            |

<!-- source: packages/core/src/platform/port-config.ts:328 -->
<!-- source: packages/core/src/platform/port-config.ts:331 -->
<!-- source: packages/core/src/platform/port-config.ts:400 -->
<!-- source: packages/runtime-node/src/startup.ts:390 -->

The `stdio` adapter writes one JSON record per line. See [Observability](../operations/observability.md) for exports.

### Names in the stanza

The stanza holds names, never values. Every `...Env` key takes an environment variable name: uppercase letters, digits and single underscores, starting with a letter, at most 48 characters. Binding names start with a letter and contain letters, digits and `_`, at most 64 characters; on Cloudflare `DB` and `DEPLOYMENT_ID` are reserved. Each name may appear once per stanza. `pb build` rejects a value that looks like a credential.

<!-- source: packages/core/src/platform/port-config.ts:159 -->
<!-- source: packages/core/src/platform/port-config.ts:232 -->
<!-- source: packages/core/src/platform/port-config.ts:255 -->
<!-- source: packages/cli/src/build-artifacts.ts:112 -->

## Node environment variables

| Variable                                                  | Required                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PB_PUBLIC_URL`                                           | yes                                      | The origin clients use, for example `https://pb.example.test`. `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`. No path, query, fragment or credentials.                                                                                                                                                                                                                                                                                                                                                      |
| `PB_MASTER_KEY` or `PB_MASTER_KEY_FILE`                   | yes, one of the two                      | The master key from `pb secrets generate-master-key`, or the path to a regular file that holds it (at most 4096 bytes, one trailing newline is ignored). Setting both is an error.                                                                                                                                                                                                                                                                                                                                      |
| `PB_MASTER_KEY_PREVIOUS` or `PB_MASTER_KEY_PREVIOUS_FILE` | no                                       | Up to three older keys, comma-separated, newest first. Each must have a lower key version than the one before it, and no key may repeat another key's bytes. See [Backup and upgrades](../operations/backup-and-upgrades.md#rotate-the-master-key-while-retaining-old-versions).                                                                                                                                                                                                                                        |
| `PB_SQLITE_PATH`                                          | no                                       | SQLite database file. Default `./data/broker.sqlite`. The parent directory is created.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PORT`                                                    | no                                       | Listening port, 1 to 65535. Default `8787`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PB_SHUTDOWN_TIMEOUT_MS`                                  | no                                       | How long a graceful stop may take before the process is forced to exit, 1000 to 120000. Default `8000`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PB_MIGRATE`                                              | no                                       | `off` skips the migrations the server otherwise applies at start.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PB_ORG_SLUG` and `PB_ORG_NAME`                           | no, both or neither                      | Create the organization at start if the database has none. Setting only one of the two makes the start fail. The slug is 1 to 64 lowercase letters, digits and inner hyphens. Start fails if the database already holds an organization with another slug.                                                                                                                                                                                                                                                              |
| `PB_TRUSTED_PROXY`                                        | no                                       | `0` (default) or `1`. With `1`, the client address is taken from `CF-Connecting-IP` when present, otherwise from the leftmost `X-Forwarded-For` entry, otherwise from `Forwarded`. Set it only behind a proxy that removes or overwrites `CF-Connecting-IP` and replaces `X-Forwarded-For` instead of appending to it (for nginx, `proxy_set_header X-Forwarded-For $remote_addr;`, not `$proxy_add_x_forwarded_for`). Otherwise a client can choose the address recorded in audit records and used by IP-based limits. |
| `PB_GIT_ARCHIVE_ROOT`                                     | no                                       | Directory for archives built from Git sources. Default `git-archives` next to the SQLite file. Used when the registry is configured.                                                                                                                                                                                                                                                                                                                                                                                    |
| `PB_SSH_ARCHIVE_ROOT`                                     | no                                       | Directory for archives built from Git sources reached over SSH. Default `ssh-archives` next to the SQLite file. Used when the registry is configured.                                                                                                                                                                                                                                                                                                                                                                   |
| `PB_KEYRING_RESEED`                                       | no                                       | `1` records a missing keyring check value for one start. Set it only when the server reports that the check value is missing and you are sure the master key is the right one. Never set it during a restore.                                                                                                                                                                                                                                                                                                           |
| `DEPLOYMENT_ID`                                           | when the build has a `node` ports stanza | Label on log and metric records. 1 to 64 characters from `A-Z a-z 0-9 _ . -`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Variables named in the stanza                             | as the stanza says                       | For example `PB_BLOB_ROOT` in the root `broker.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PB_IDP_<PROVIDER>_CLIENT_SECRET`                         | for each OIDC provider                   | See [Authentication and sessions](authentication.md#single-sign-on).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PB_IDP_PROVIDERS`                                        | no                                       | Single sign-on providers read at run time when the plugin is built with `runtimeProviders: true`. See [Providers at run time](authentication.md#providers-at-run-time).                                                                                                                                                                                                                                                                                                                                                 |

<!-- source: packages/runtime-node/src/startup.ts:141 -->
<!-- source: packages/runtime-node/src/startup.ts:164 -->
<!-- source: packages/runtime-node/src/startup.ts:232 -->
<!-- source: packages/core/src/secrets/master-key.ts:86 -->
<!-- source: packages/runtime-node/src/entry.ts:13 -->
<!-- source: packages/runtime-node/src/entry.ts:51 -->
<!-- source: packages/runtime-node/src/startup.ts:673 -->
<!-- source: packages/runtime-node/src/client-ip.ts:42 -->
<!-- source: packages/runtime-node/src/startup.ts:750 -->
<!-- source: packages/runtime-node/src/startup.ts:759 -->
<!-- source: packages/runtime-node/src/startup.ts:804 -->
<!-- source: packages/runtime-node/src/startup.ts:621 -->
<!-- source: packages/core/src/secrets/keyring-verifier.ts:45 -->
<!-- source: packages/runtime-node/src/startup.ts:408 -->
<!-- source: packages/core/src/identity/secret-name.ts:3 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:5 -->

When startup fails, the server writes a `startup.failed` record to stderr with the error name, for example `StartupConfigError` or `SecretsConfigError`, and exits with code 1. For configuration errors the record also carries `config_key`, the name of the variable or setting that failed. An invalid `PORT` or `PB_SHUTDOWN_TIMEOUT_MS` is reported as a plain-text line instead, for example `Error: PORT must be an integer between 1 and 65535`.

<!-- source: packages/runtime-node/src/entry.ts:119 -->
<!-- source: packages/runtime-node/src/entry.ts:167 -->

## Worker bindings and variables

| Name                                      | Kind               | Meaning                                                                       |
| ----------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `DB`                                      | D1 binding         | The database. The name is fixed.                                              |
| The `blob.binding` name                   | R2 binding         | `STORAGE` in the root config.                                                 |
| The `jobs.binding` name                   | Queue producer     | `JOBS` in the root config. The same queue must have this Worker as consumer.  |
| The `observability.analyticsBinding` name | Analytics Engine   | `ANALYTICS` in the root config.                                               |
| `MCP_RATE_LIMIT`                          | Rate Limiting      | Required when `mcp.enabled` is `true`.                                        |
| `ASSETS`                                  | assets binding     | Optional. Serves the web interface; without it the UI routes are not mounted. |
| `DEPLOYMENT_ID`                           | variable           | As on Node.                                                                   |
| `PB_PUBLIC_URL`                           | variable           | As on Node.                                                                   |
| `PB_MASTER_KEY`                           | secret             | The master key. There is no `_FILE` form on Workers.                          |
| `PB_MASTER_KEY_PREVIOUS`                  | secret             | As on Node.                                                                   |
| `PB_KEYRING_RESEED`                       | variable           | As on Node.                                                                   |
| `PB_IDP_<PROVIDER>_CLIENT_SECRET`         | secret             | As on Node.                                                                   |
| `PB_IDP_PROVIDERS`                        | variable or secret | As on Node.                                                                   |

<!-- source: packages/runtime-cloudflare/src/index.ts:273 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:372 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:1012 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:1888 -->

The Worker needs the `nodejs_compat` compatibility flag, and it runs scheduled jobs from a Cron Trigger. `packages/runtime-cloudflare/wrangler.toml` sets the flag and has the bindings and the trigger as commented blocks. [Quickstart: Cloudflare](../getting-started/quickstart-cloudflare.md) walks through a deployment.

<!-- source: packages/runtime-cloudflare/wrangler.toml:4 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:2133 -->

The Worker does not apply migrations; `GET /health/ready` reports `not_ready` while the database schema differs from the build. Run `pb cloudflare migrate` before you deploy a new build.

<!-- source: packages/runtime-cloudflare/src/index.ts:1950 -->
