---
title: Configuration
sidebar_position: 5
description: broker.config.ts, platform ports and runtime environment variables.
---

Package Broker is configured in two places. `broker.config.ts` is read by `pb build` and fixes the plugin set and the platform adapters in the bundle. Environment variables, and on Workers the bindings, are read when the server starts.

## `broker.config.ts`

The file default-exports the result of `defineConfig` from `@package-broker/core/config`. `defineConfig` returns its argument unchanged and exists for type checking. The repository root holds a working example:

```ts
import { defineConfig } from '@package-broker/core/config';
import github from '@package-broker/plugin-github';
import ssoOidc from '@package-broker/plugin-sso-oidc';

export default defineConfig({
  platform: 'cloudflare',
  plugins: [ssoOidc(), github()],
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

| Key                                     | Required | Meaning                                                                                                                                                          |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`                              | yes      | `'cloudflare'` or `'node'`. The target `pb build` uses when `--target` is not given.                                                                             |
| `plugins`                               | yes      | The plugins compiled into the bundle. Enabling a plugin means adding its package as a dependency, listing it here and rebuilding. Nothing is loaded at run time. |
| `platformPorts`                         | no       | One stanza per target, `cloudflare` and `node`, described below.                                                                                                 |
| `observability.trustInboundTraceparent` | no       | `true` makes the server continue an inbound W3C `traceparent`. Set it only behind a proxy that sets or strips that header. Default `false`.                      |

`pb build` validates every stanza present, whatever the target. Without a stanza for the target it builds, it prints a warning and builds a bundle with the blob store, cache, jobs and observability ports disabled; a plugin that registers jobs then fails the build.

The type also accepts `registry` and `mcp` keys. `pb build` ignores both on the current `main`.

## Platform ports

Each stanza has four sections: `blob`, `cache`, `jobs` and `observability`. Every section is required, and each target allows only its own adapters.

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

The directory named by `rootEnv` must be an absolute, normalized path with no symlink in it or above it. It must be owned by the user that runs the server and must not be writable by group or others. The server creates it if it is missing.

### `cache`

| Key         | Adapter     | Meaning                                                                                                     |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `namespace` | `cache-api` | Optional. 1 to 64 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `maxBytes`  | `lru`       | Optional. In-memory budget in bytes, a positive integer of at most 33554432 (32 MiB).                       |

### `jobs`

| Key          | Adapter  | Meaning                                       |
| ------------ | -------- | --------------------------------------------- |
| `maxRunning` | all      | Required. Jobs running at once, 1 or 2.       |
| `binding`    | `queues` | Required. Name of the queue producer binding. |

The `database` adapter keeps jobs in the SQLite database and runs them in the server process.

### `observability`

| Key                | Adapter   | Meaning                                                                                                                                                                             |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploymentIdEnv`  | all       | Required and must be `'DEPLOYMENT_ID'`.                                                                                                                                             |
| `analyticsBinding` | `workers` | Optional. Name of the Analytics Engine binding for metrics.                                                                                                                         |
| `endpointEnv`      | all       | Optional. Name of the variable that holds an OTLP endpoint. When set, logs, metrics and request spans are also exported there, and the variable must be set when the server starts. |
| `headersEnv`       | all       | Optional, requires `endpointEnv`. Name of the variable that holds the OTLP request headers as a JSON object of strings. The variable must be set when the server starts.            |

The `stdio` adapter writes one JSON record per line to stdout and stderr.

### Names in the stanza

The stanza holds names, never values. Every `...Env` key takes an environment variable name: uppercase letters, digits and single underscores, starting with a letter, at most 48 characters. Binding names start with a letter and contain letters, digits and `_`, at most 64 characters; on Cloudflare `DB` and `DEPLOYMENT_ID` are reserved. Each name may appear once per stanza. `pb build` rejects a value that looks like a credential.

## Node environment variables

| Variable                                                  | Required                                 | Meaning                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PB_PUBLIC_URL`                                           | yes                                      | The origin clients use, for example `https://pb.example.test`. `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`. No path, query or credentials.                                                                                                   |
| `PB_MASTER_KEY` or `PB_MASTER_KEY_FILE`                   | yes, one of the two                      | The master key from `pb secrets generate-master-key`, or the path to a file that holds it (at most 4096 bytes, one trailing newline is ignored). Setting both is an error.                                                                                 |
| `PB_MASTER_KEY_PREVIOUS` or `PB_MASTER_KEY_PREVIOUS_FILE` | no                                       | Up to three older keys, comma-separated, newest first. Each must have a lower key version than the one before it, and no key may repeat another key's bytes. See [Upgrades and operations](../operations/backup-and-upgrades.md#rotate-the-master-key).    |
| `PB_SQLITE_PATH`                                          | no                                       | SQLite database file. Default `./data/broker.sqlite`. The parent directory is created.                                                                                                                                                                     |
| `PORT`                                                    | no                                       | Listening port, 1 to 65535. Default `8787`.                                                                                                                                                                                                                |
| `PB_MIGRATE`                                              | no                                       | `off` skips the migrations the server otherwise applies at start.                                                                                                                                                                                          |
| `PB_ORG_SLUG` and `PB_ORG_NAME`                           | no, both or neither                      | Create the organization at start if the database has none. Setting only one of the two makes the start fail. The slug is 1 to 64 lowercase letters, digits and inner hyphens. Start fails if the database already holds an organization with another slug. |
| `DEPLOYMENT_ID`                                           | when the build has a `node` ports stanza | Label on log and metric records. 1 to 64 characters from `A-Z a-z 0-9 _ . -`.                                                                                                                                                                              |
| Variables named in the stanza                             | as the stanza says                       | For example `PB_BLOB_ROOT` in the root `broker.config.ts`.                                                                                                                                                                                                 |
| `PB_IDP_<PROVIDER>_CLIENT_SECRET`                         | for each OIDC provider                   | See [Authentication and sessions](authentication.md#single-sign-on).                                                                                                                                                                                       |

When startup fails, the server logs a `startup.failed` record with the error name, for example `StartupConfigError` or `SecretsConfigError`, and exits with code 1. If it fails before `DEPLOYMENT_ID` is read, the record has no `deployment_id`. The record does not name the variable, so check the values above. An invalid `PORT` is the exception: the server prints a plain-text line naming `PORT` and the value it received, then exits with code 1.

## Worker bindings and variables

| Name                                      | Kind             | Meaning                                                                      |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `DB`                                      | D1 binding       | The database. The name is fixed.                                             |
| The `blob.binding` name                   | R2 binding       | `STORAGE` in the root config.                                                |
| The `jobs.binding` name                   | Queue producer   | `JOBS` in the root config. The same queue must have this Worker as consumer. |
| The `observability.analyticsBinding` name | Analytics Engine | `ANALYTICS` in the root config.                                              |
| `DEPLOYMENT_ID`                           | variable         | As on Node.                                                                  |
| `PB_PUBLIC_URL`                           | variable         | As on Node, but `https` only.                                                |
| `PB_MASTER_KEY`                           | secret           | The master key. There is no `_FILE` form on Workers.                         |
| `PB_MASTER_KEY_PREVIOUS`                  | secret           | As on Node.                                                                  |
| `PB_IDP_<PROVIDER>_CLIENT_SECRET`         | secret           | As on Node.                                                                  |
| `ASSETS`                                  | assets binding   | Optional. Serves the web interface.                                          |

The Worker needs the `nodejs_compat` compatibility flag, and it runs scheduled jobs from a Cron Trigger. `packages/runtime-cloudflare/wrangler.toml` sets the flag and has the trigger as a commented block. [Quickstart: Cloudflare](../getting-started/quickstart-cloudflare.md) shows a complete file.

The Worker does not apply migrations. Run `pb cloudflare migrate` before you deploy a new build.
