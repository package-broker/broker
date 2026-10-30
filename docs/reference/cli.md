---
title: pb CLI
sidebar_position: 6
description: Reference for the pb command.
---

`pb` is the command-line tool in `@package-broker/cli`. In a source checkout, run `pnpm build` once and then call it as `pnpm pb <command>` from the repository root.

<!-- source: package.json:18 -->

`pb --help` (or `-h`) prints the usage and the exit codes. An unknown command, or a flag the command does not accept, prints the usage to stderr and exits with 2. The `pb cloudflare` commands print a JSON `invalid_input` result instead when `--json` is given.

<!-- source: packages/cli/src/cli.ts:34 -->
<!-- source: packages/cli/src/cli.ts:387 -->
<!-- source: packages/cli/src/cli.ts:392 -->

The database and admin commands print their result as one JSON object on stdout. Messages and errors go to stderr.

## Targets

Commands that touch a database take one target:

- `--sqlite <file>`: a local SQLite file, used by the Node runtime.
- `--cloudflare --database-id <uuid>` for `pb admin`, or `--database-id <uuid>` for `pb cloudflare`: a D1 database, reached through the Cloudflare D1 HTTP API.

All `pb cloudflare` commands and the D1 targets of `pb admin` read `CLOUDFLARE_ACCOUNT_ID` (32 lowercase hex characters) and `CLOUDFLARE_API_TOKEN` from the environment and exit with 2 if either is missing or malformed.

<!-- source: packages/cli/src/cli.ts:371 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:88 -->
<!-- source: packages/cli/src/commands/admin.ts:94 -->
<!-- source: packages/cli/src/commands/cloudflare/api.ts:234 -->

## `pb build`

```sh
pnpm pb build [--config <file>] [--target cloudflare|node] [--out <dir>]
```

Validates `broker.config.ts` (or `--config`), then writes the bundle for one target. `--target` defaults to the `platform` in the config. `--out` defaults to `.pb/<target>`.

<!-- source: packages/cli/src/build.ts:170 -->
<!-- source: packages/cli/src/build.ts:253 -->

Output in the out directory:

- `worker.js` (Cloudflare) or `server.js` (Node), with a source map and `metafile.json`.
- `generated/manifest.ts` and `generated/manifest.json`: the plugin set, the platform ports and the migration list.
- `migrations/`: the SQL migrations of core and the enabled plugins.
- `build-info.json`.
- `assets/` and `assets.json` when `assets` selects a UI provider.
- Node only: `package.json` listing the native SQLite driver. Run `npm install --omit=dev` in the out directory before starting `server.js`.

<!-- source: packages/cli/src/build.ts:294 -->
<!-- source: packages/cli/src/build.ts:307 -->
<!-- source: packages/cli/src/build.ts:345 -->
<!-- source: packages/cli/src/build-assets.ts:16 -->

Exit codes: 0 success; 2 invalid configuration found by the build checks (each problem is printed as `error: ...`) or an unknown `--target`; 1 any other failure, including an invalid plugin option or ports setting (`error: Error: invalid broker config: ...`). Check the values against the [configuration reference](configuration.md).

<!-- source: packages/cli/src/cli.ts:836 -->
<!-- source: packages/cli/src/bin.ts:9 -->

## `pb migrate`

```sh
pnpm pb migrate --sqlite <file> [--out <dir>] [--dry-run]
```

Applies the migrations from a Node build (`--out`, default `.pb/node`) to a SQLite file. It creates the file if it does not exist. The Node server runs the same migrations at start unless `PB_MIGRATE=off`.

<!-- source: packages/cli/src/cli.ts:818 -->
<!-- source: packages/runtime-node/src/startup.ts:750 -->

Without `--dry-run`, a run takes a lock in the database before it applies pending migrations. The lock lasts 10 minutes and is renewed with each applied migration. A run that finds the lock held waits up to 30 seconds for it, then exits with 4. `--dry-run` takes no lock. On a database without a migration table, the first migration that creates that table runs before the lock is taken.

<!-- source: packages/db-sqlite/src/migrations/runner.ts:15 -->
<!-- source: packages/db-sqlite/src/migrations/runner.ts:268 -->
<!-- source: packages/db-sqlite/src/migrations/runner.ts:327 -->
<!-- source: packages/db-sqlite/src/migrations/runner.ts:357 -->

The result lists migration IDs under `applied`, `skipped` (already recorded), `pending` (with `--dry-run`, nothing is written) and `unknown` (recorded in the database but absent from the build).

<!-- source: packages/db-sqlite/src/migrations/runner.ts:37 -->

## `pb cloudflare migrate`

```sh
pnpm pb cloudflare migrate [--prebuilt] --database-id <id> [--out <dir>] [--dry-run]
```

Applies the migrations from a Cloudflare build (`--out`, default `.pb/cloudflare`) to a D1 database, with the same lock rules as `pb migrate`. Without `--dry-run` it prints its lock holder ID to stderr. The Worker never migrates on its own. `PB_D1_MIGRATION_TIMEOUT_MS` (1 to 600000, default 300000) limits how long the command waits for D1.

<!-- source: packages/cli/src/commands/cloudflare.ts:65 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:322 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:1953 -->

## Exit codes for `migrate` and `bootstrap`

These apply to `pb migrate`, `pb bootstrap`, `pb cloudflare migrate` and `pb cloudflare bootstrap`.

| Code | Meaning                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                                                                                                                                                                     |
| 1    | Other error.                                                                                                                                                                                                                                 |
| 2    | Usage error, invalid slug, missing or malformed Cloudflare credentials, or a build whose routes fail validation.                                                                                                                             |
| 3    | A recorded migration's checksum differs from the build, or a migration file differs from the manifest. Nothing pending is applied.                                                                                                           |
| 4    | `migrate` commands only: another run held the migration lock for more than 30 seconds, or the database is busy. Run again later. A busy database during `bootstrap` gives 1.                                                                 |
| 5    | The database already holds an organization with a different slug.                                                                                                                                                                            |
| 6    | Cloudflare only: the request was sent and the answer was lost. Run the command again; it reads the recorded state. If the lock is held by the holder printed earlier, it expires at most 10 minutes after that run's last applied migration. |

<!-- source: packages/cli/src/commands/sqlite.ts:38 -->
<!-- source: packages/cli/src/commands/sqlite.ts:44 -->
<!-- source: packages/cli/src/commands/sqlite.ts:71 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:381 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:404 -->

## `pb bootstrap` and `pb cloudflare bootstrap`

```sh
pnpm pb bootstrap --sqlite <file> --slug <slug> --name <name>
pnpm pb cloudflare bootstrap --database-id <id> --slug <slug> --name <name>
```

Creates the organization in a migrated database. A deployment holds one organization. The slug is 1 to 64 lowercase letters, digits and inner hyphens. Running it again with the same slug prints the existing organization with `"created":false` and exits with 0; a different slug exits with 5.

<!-- source: packages/core/src/db/organization.ts:4 -->
<!-- source: packages/cli/src/commands/sqlite.ts:71 -->

The Node server can do the same at start through `PB_ORG_SLUG` and `PB_ORG_NAME`.

## `pb secrets generate-master-key`

```sh
pnpm pb secrets generate-master-key [--key-version <n>]
```

Prints a new master key in the form `pbmk_v<version>_<key>` to stdout. `--key-version` is an integer from 1 to 999999, default 1. Use a higher version than the current key when you rotate. Exit code 2 means an invalid version.

<!-- source: packages/cli/src/commands/admin.ts:68 -->
<!-- source: packages/core/src/secrets/master-key.ts:34 -->

## `pb admin bootstrap`

```sh
pnpm pb admin bootstrap --email <e-mail> (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]
```

Adds the e-mail as a user with a local login and the `organization_admin` role, and issues a one-time setup token valid for 24 hours. If a user with that e-mail already exists but has not finished local setup, it gives them the role and a fresh token (result `refreshed`) and sets their status to active, which also reactivates a suspended user. It does not check for other administrators. Use the token in the web interface at `/_pb/ui/setup`, or with `POST /_pb/auth/local/setup/start` and `.../setup/finish`, described in [Authentication and sessions](authentication.md#local-accounts).

<!-- source: packages/cli/src/commands/admin.ts:51 -->
<!-- source: packages/cli/src/commands/admin.ts:345 -->

On success stdout holds `{"result":"created"|"refreshed","setupToken":...,"tokenFile":...,"expiresAt":"...","next":[...]}`, where `next` names the two setup requests. With `--token-file`, the token is written to that file (mode 600), which must not exist yet, and `setupToken` is `null`. Without it the token is in `setupToken`, with a warning on stderr when stdout is not a terminal. Prefer `--token-file` so the token stays out of logs.

<!-- source: packages/cli/src/commands/admin.ts:145 -->
<!-- source: packages/cli/src/commands/admin.ts:351 -->
<!-- source: packages/cli/src/commands/admin.ts:360 -->

If the user has already finished local setup, no token is issued and the token file is not created. If the `organization_admin` role was missing permissions, the command adds them, prints `{"result":"already_set_up","toppedUp":<number added>}` and exits with 0. Otherwise it changes nothing and exits with 6. To give such a user a new password and TOTP secret, use `pb admin reset-local`.

<!-- source: packages/cli/src/commands/admin.ts:400 -->

## `pb admin reset-local`

```sh
pnpm pb admin reset-local --email <e-mail> (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]
```

Issues a new setup token for an existing user, so they can set a new password and TOTP secret. Use it for a locked-out administrator or a lost authenticator. In one step it:

- clears the user's password, TOTP secret and sign-in lock, or creates a local login if the user had none (for example a user who signed in only through single sign-on);
- sets the user's status to active;
- gives the user the `organization_admin` role;
- revokes all of the user's sessions.

<!-- source: packages/db-sqlite/src/repositories/admin-bootstrap.ts:436 -->
<!-- source: packages/db-sqlite/src/repositories/admin-bootstrap.ts:489 -->
<!-- source: packages/db-sqlite/src/repositories/admin-bootstrap.ts:498 -->

Stdout reports `"result":"reset"`. Output and `--token-file` otherwise work as for `pb admin bootstrap`.

## Exit codes for `pb admin bootstrap` and `reset-local`

| Code | Meaning                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                                                                  |
| 1    | Other error.                                                                                                                              |
| 2    | Usage error, invalid e-mail, the token file already exists, or the SQLite file does not exist.                                            |
| 5    | No organization. Run `pb bootstrap` or `pb cloudflare bootstrap` first.                                                                   |
| 6    | `bootstrap`: the user has already finished setup and no permission was missing. `reset-local`: no user with that e-mail. Nothing changed. |
| 7    | The outcome is unknown (D1 answer lost, or a signal arrived). Running the command again is safe.                                          |
| 8    | `reset-local`: the organization has no `organization_admin` role yet. Run `pb admin bootstrap` first.                                     |

<!-- source: packages/cli/src/cli.ts:66 -->
<!-- source: packages/cli/src/commands/admin.ts:138 -->
<!-- source: packages/cli/src/commands/admin.ts:429 -->

## `pb admin show-provider-binding`

```sh
pnpm pb admin show-provider-binding --provider <id> (--sqlite <file> | --cloudflare --database-id <id>)
```

Prints `{"provider":...,"anchor":...,"createdAt":...}`, the trust anchor recorded for a single sign-on provider ID. The broker records the anchor at the first successful sign-in through that provider and refuses later sign-ins when the configured provider no longer matches it. Exit codes: 0 found; 1 other error; 2 usage error or invalid provider ID (`local` is reserved); 5 no organization; 6 nothing is bound for that provider; 7 outcome unknown, safe to run again.

<!-- source: packages/cli/src/commands/admin.ts:532 -->
<!-- source: packages/cli/src/cli.ts:68 -->

## `pb admin rebind-provider`

```sh
pnpm pb admin rebind-provider --provider <id> --confirm <id> --expected-anchor <anchor> --new-anchor <anchor> (--sqlite <file> | --cloudflare --database-id <id>)
```

Replaces the recorded trust anchor of a provider, for example after the provider's issuer changed. `--confirm` must repeat `--provider`, and `--new-anchor` must differ from `--expected-anchor`. The swap happens only if the current anchor equals `--expected-anchor`. An OIDC anchor is `oidc:<issuer>`; a Cloudflare Access anchor is `access:<team domain>/<audience>`.

<!-- source: packages/cli/src/commands/admin.ts:459 -->
<!-- source: packages/core/src/identity/port.ts:62 -->

A rebind cuts every existing link to that provider. In the same step it:

- blocks the user identifiers (subjects) seen under the old anchor;
- revokes the personal access tokens tied to those identities;
- deletes the sessions started through the provider, the groups recorded from it and the identities themselves.

<!-- source: packages/db-sqlite/src/repositories/provider-binding.ts:49 -->

The user accounts stay. Their next sign-in through the provider is treated like a sign-in for an e-mail that already exists: it links only when the e-mail domain is in the provider's `policy.emailAuthoritativeDomains`, and is refused otherwise. Plan a rebind as a cut-over, not a migration. Stdout reports `{"provider":...,"identities":<n>,"sessions":<n>}`.

<!-- source: packages/core/src/auth/identity-login.ts:266 -->
<!-- source: packages/cli/src/commands/admin.ts:504 -->

Exit codes: 0 success; 1 other error; 2 usage error, `--confirm` differs from `--provider`, equal anchors, or an invalid provider or anchor; 5 no organization; 6 no binding with that provider and expected anchor, nothing changed; 7 the D1 answer was lost and the swap may have applied (a re-run that reports 6 means it did, or that the expected anchor is wrong).

<!-- source: packages/cli/src/cli.ts:67 -->

## `pb cloudflare` install commands

These commands install and operate a deployment on Cloudflare. They record the resources they create in an inventory file under `.pb/state/cloudflare/` in the project. The Worker script is named `<worker-name>-<environment>`, where the environment defaults to `production`. Each command takes `--json` for a JSON result on stdout and `--dry-run` to show the plan without changing anything. `--prebuilt` uses the prebuilt Cloudflare distribution instead of a local build.

<!-- source: packages/cli/src/commands/cloudflare/inventory.ts:628 -->
<!-- source: packages/cli/src/commands/cloudflare/inventory.ts:957 -->
<!-- source: packages/cli/src/cli.ts:418 -->

### `pb cloudflare setup`

```sh
pnpm pb cloudflare setup [--workers-paid] [--prebuilt] [--providers <file|none>] [--local-auth enabled|disabled] --worker-name <slug> --org-slug <slug> --org-name <name> --admin-email <email> [--key-file <path> | --master-key-env <name>] [--token-file <path>] [--non-interactive] [--yes] [--refresh-setup-token] [--json] [--dry-run]
```

One guided run: build (or use the prebuilt bundle), provision, migrate, create the organization, deliver the master key, deploy, smoke-test and issue the administrator's setup token. The result names the setup page, `<origin>/_pb/ui/setup`. Without a terminal, `--token-file`, one of `--key-file` or `--master-key-env`, and `--yes` (to create resources) are required. Key and token files must lie outside the checkout and the build and state directories, must have mode 600 and must not be symlinks.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:152 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:403 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:515 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:702 -->

### `pb cloudflare provision`

```sh
pnpm pb cloudflare provision [--prebuilt] --worker-name <slug> [--config <file>] [--environment <slug>] [--jurisdiction eu|default] [--inventory <file>] [--out <dir>] [--adopt-resource <kind:id>] [--abandon-intent <op-id>] [--domain <hostname>] [--yes] [--json] [--dry-run]
```

Creates, or adopts with `--adopt-resource`, the D1 database, R2 bucket, queues and Analytics Engine dataset the build needs, and records them in the inventory. Running it again is safe. Creating resources needs `--yes` or a confirmation at the terminal. The jurisdiction defaults to `eu`.

<!-- source: packages/cli/src/commands/cloudflare/provision.ts:212 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:602 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:964 -->

### `pb cloudflare deploy`

```sh
pnpm pb cloudflare deploy [--workers-paid] [--prebuilt] [--providers <file|none>] [--local-auth enabled|disabled] --worker-name <slug> [--out <dir>] [--rollout <1..100>] [--domain <hostname>] [--public-url <https-origin>] [--routes <zone:pattern...>] [--secret <ENV_NAME>] [--secrets <ENV_NAMES>] [--json] [--dry-run]
```

Uploads the Worker with the bindings from the inventory and activates it. `--rollout` below 100 sends that share of traffic to the new version and needs an existing version. `--routes` takes newline-separated `<zone id>:<pattern>` entries and requires `--public-url`. `--secret` and `--secrets` name environment variables whose values are set as Worker secrets. An inventory is required; run `provision` first.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1294 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1342 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1544 -->

### `--providers`, `--local-auth` and `--workers-paid`

`pb cloudflare setup` and `pb cloudflare deploy` take three more options:

- `--providers <file>` reads a JSON file of single sign-on provider definitions (at most 65536 bytes), refuses it when any entry is invalid, and deploys it as the plain-text Worker variable `PB_IDP_PROVIDERS`. Every OIDC entry's client secret `PB_IDP_<ID>_CLIENT_SECRET` must already be a Worker secret or be delivered in the same run with `--secret` or `--secrets`. `--providers none` removes the variable; pass a file named `none` as `./none`. Without `--providers`, deploy keeps the value of the live deployment. The artifact must be built with `ssoOidc({ runtimeProviders: true })`, as the release configuration and the prebuilt distribution are.
- `--local-auth enabled|disabled` sets the plain-text Worker variable `PB_AUTH_LOCAL`. Omitted, it preserves the live setting (a fresh installation defaults to enabled). Changing from disabled to enabled requires the explicit flag, and `PB_AUTH_LOCAL` in the CLI environment must agree with it. A mode change needs `--rollout 100`. See [Authentication](authentication.md#enable-or-disable-local-sign-in).
- `--workers-paid` raises the limit on the Worker's variables and secrets, counted together, from 64 to 128. Use it when the account is on Workers Paid. It is not saved; pass it on every run that needs the higher limit.

Shape, precedence, partial rollouts, the dry-run `identity` section and trust anchor changes are described in [Runtime SSO providers](runtime-sso-providers.md#deploying-on-cloudflare).

<!-- source: packages/cli/src/cli.ts:180 -->
<!-- source: packages/cli/src/cli.ts:199 -->
<!-- source: packages/cli/src/cli.ts:234 -->
<!-- source: packages/cli/src/cli.ts:249 -->
<!-- source: packages/cli/src/cli.ts:65 -->
<!-- source: packages/cli/src/cli.ts:66 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:18 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:71 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1877 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1896 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:136 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:137 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:119 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1929 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:812 -->

### `pb cloudflare smoke`

```sh
pnpm pb cloudflare smoke --worker-name <slug> [--project <slug>] [--smoke-token-env <name>] [--deadline-seconds <1..300>] [--no-rollback] [--json] [--dry-run]
```

Checks `/health/ready` on the deployment. With a token (read from `PB_SMOKE_TOKEN`, or the variable named by `--smoke-token-env`) and `--project`, it also fetches the project's Composer and npm endpoints. On failure it rolls back to the previous version unless `--no-rollback` is given. `--deadline-seconds` defaults to 120.

<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:416 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:460 -->

### `pb cloudflare teardown` and `pb cloudflare janitor`

```sh
pnpm pb cloudflare teardown --inventory <file> [--config <file>] [--project <dir>] [--inventory-id <owner_digest> --i-understand-this-deletes] [--json] [--dry-run]
pnpm pb cloudflare janitor --repository-id <numeric-id> [--inventory <file>] [--config <file>] [--project <dir>] [--json] [--dry-run]
```

`teardown` deletes every resource recorded in an inventory. For a production inventory, pass the inventory's `identity.owner_digest` as `--inventory-id` together with `--i-understand-this-deletes`. Adopted D1 and R2 resources always require `--i-understand-this-deletes`. Deleting a Worker removes its versions.

`janitor` removes test installs created by CI runs (`run_identity` `pb-e2e-<repository-id>-<epoch-seconds>`) whose run and inventory update are older than 6 hours. It never passes `--i-understand-this-deletes`, so an expired inventory that holds an adopted D1 database or R2 bucket is not cleaned up at all: nothing in it is deleted and the command exits with status 2. Remove such an install with `teardown`.

<!-- source: packages/cli/src/commands/cloudflare/teardown.ts:970 -->
<!-- source: packages/cli/src/commands/cloudflare/janitor.ts:64 -->
<!-- source: packages/cli/src/commands/cloudflare/janitor.ts:31 -->
<!-- source: packages/cli/src/cli.ts:65 -->

### Exit codes for the install commands

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 0    | Success, or for `teardown` and `janitor`: cleaned or skipped.                                          |
| 1    | Provider or cleanup failure.                                                                           |
| 2    | Invalid input, unsafe path, missing confirmation, invalid inventory or wrong inventory ID.             |
| 3    | `--prebuilt`: the prebuilt bundle's checksum does not match.                                           |
| 4    | Another run holds the install or inventory lock.                                                       |
| 5    | `setup`: the database already holds an organization with a different slug.                             |
| 6    | The outcome is unknown, or a resource or deletion outcome is unresolved.                               |
| 7    | `setup`: the setup token must be refreshed (`--refresh-setup-token`), or the admin outcome is unknown. |
| 8    | Concurrent deployment, ownership or configuration conflict.                                            |
| 9    | Smoke failed on an existing deployment.                                                                |
| 10   | Rollback failed or its outcome is unknown.                                                             |
| 11   | A contract migration blocks rollback, or pending migrations were not applied.                          |
| 12   | Smoke failed on a first deployment with no earlier release.                                            |

<!-- source: packages/cli/src/cli.ts:64 -->
<!-- source: packages/cli/src/cli.ts:65 -->
<!-- source: packages/cli/src/prebuilt.ts:29 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:727 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:836 -->

## `pb import`

The import commands move an existing registry into the broker. Planning runs offline and writes a manifest; `submit` sends it to a running broker. Approval, apply and acceptance happen in the web interface. The commands that talk to a broker read an import token from `PB_IMPORT_TOKEN` or `--token-file` (not both), and `--broker` is the broker's origin. See the [migration guides](../migration/from-private-packagist.md) for complete walk-throughs.

<!-- source: packages/cli/src/cli.ts:66 -->
<!-- source: packages/cli/src/commands/import.ts:348 -->
<!-- source: packages/cli/src/import/client.ts:31 -->

### Plan an import

```sh
pnpm pb import satis plan --config <satis.json> --out <manifest> [--project <slug>] [--repository-map <file>] [--credentials <file>] [--baseline <manifest>] [--mode merge|override]
pnpm pb import private-packagist fetch --org <short-name> --snapshot <out.json> [--api-key-file <path>] [--api-secret-file <path>] [--versions] [--require-org-match]
pnpm pb import private-packagist plan --snapshot <file> --map <file> --out <manifest> --credentials-out <file> [--members <csv>] [--baseline <manifest>] [--mode merge|override] [--include-org-admins] [--runtime workers|node] [--packagist existing:<name>] [--compact-selection --compact-vendor <vendor>...] [--accept-project-widening <slug>...] [--quiet]
pnpm pb import private-packagist dates --snapshot <file> --map <file> --baseline <manifest> --out <manifest> [--package <name>...] [--quiet]
```

- `satis plan` builds a manifest from a `satis.json`. It never overwrites `--out`.
- `private-packagist fetch` reads an organization from the Private Packagist API into a snapshot. The API key and secret come from files given by the flags or by `PP_API_KEY_FILE` and `PP_API_SECRET_FILE`; each file must belong to you, have mode 600 and be at most 4 KiB.
- `private-packagist plan` turns a snapshot into a manifest and a credentials file.
- `private-packagist dates` adds release dates to a baseline manifest.

<!-- source: packages/cli/src/commands/import-satis.ts:45 -->
<!-- source: packages/cli/src/commands/import-private-packagist.ts:30 -->
<!-- source: packages/cli/src/commands/import-private-packagist.ts:183 -->
<!-- source: packages/cli/src/commands/import-private-packagist.ts:250 -->

The planning commands exit with 0 on success and 2 on any failure; `fetch` exits with 1 when the API request fails.

### Run an import

```sh
pnpm pb import submit --manifest <file> --receipt <file> --principal <label> --broker <origin> [--resume] [--token-file <path>]
pnpm pb import status <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]
pnpm pb import credentials <run> --manifest <file> --credentials <map> --broker <origin> [--token-file <path>]
pnpm pb import verify <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]
pnpm pb import accept <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]
```

- `submit` sends the manifest and writes a receipt file, which must not exist unless `--resume` is given. `--resume` needs the same token. `--principal` is a label stored in the receipt, not a secret.
- `status` prints the run's state.
- `credentials` uploads source credentials for the run. Each entry in the map refers to a value as `env:NAME` or `file:path`.
- `verify` asks the broker to verify the applied run and prints the state.
- `accept` reports whether the run has been accepted; acceptance itself happens in the web interface.
- `--wait` waits up to 300 seconds; `--wait-seconds` sets a shorter wait.

<!-- source: packages/cli/src/commands/import.ts:214 -->
<!-- source: packages/cli/src/commands/import.ts:363 -->
<!-- source: packages/cli/src/commands/import.ts:382 -->
<!-- source: packages/cli/src/cli.ts:470 -->

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | Success.                                                          |
| 1    | API error, or the run failed, was rolled back or cancelled.       |
| 2    | Local validation failed.                                          |
| 3    | An action in the web interface is pending, or the wait timed out. |
| 6    | The outcome is unknown.                                           |

<!-- source: packages/cli/src/cli.ts:66 -->

### `pb import cutover-check`

```sh
pnpm pb import cutover-check --project-dir <dir> --old-repository <url> --new-repository <url> --old-auth-env <VAR> --new-auth-env <VAR> [--lock <file>]... [--timeout-seconds <seconds>] [--json]
```

Runs Composer against the old and the new repository for the project in `--project-dir` and compares the resolved packages, and checks any extra `--lock` files. `--old-auth-env` and `--new-auth-env` name environment variables that hold a `COMPOSER_AUTH` JSON value for each repository. `composer` must be on `PATH`. `--timeout-seconds` is 1 to 7200, default 1800. Exit codes: 0 passed; 1 the results differ or Composer failed; 2 invalid input or a local failure.

<!-- source: packages/cli/src/import/cutover.ts:154 -->
<!-- source: packages/cli/src/import/cutover.ts:376 -->
<!-- source: packages/cli/src/import/cutover.ts:578 -->

## `pb source accept-removal`

```sh
PB_SESSION=... PB_CSRF_TOKEN=... pnpm pb source accept-removal --url <https-origin> --source <id>
```

Accepts the removal that made the broker refuse the last sync of a source, so the next sync goes ahead. The source must have such a refused sync; otherwise the broker answers `409`. The command uses an organization administrator's session: the session cookie value in `PB_SESSION` and the CSRF token in `PB_CSRF_TOKEN`. Exit codes: 0 accepted; 1 the broker refused the request (no refused sync, unknown source or not authorized); 2 invalid origin, source ID or environment; 6 network failure, outcome unknown.

<!-- source: packages/cli/src/commands/source.ts:11 -->
<!-- source: packages/core/src/sources/source-service.ts:760 -->

## `pb openapi`

```sh
pnpm pb openapi --out <file>
```

Writes the OpenAPI document of the HTTP API to a file. The command is not listed in `pb --help`. Exit codes: 0 written; 1 the document could not be written; 2 `--out` is missing or is a directory.

<!-- source: packages/cli/src/cli.ts:358 -->
<!-- source: packages/cli/src/cli.ts:464 -->
<!-- source: packages/cli/src/commands/openapi.ts:13 -->

## `pb version`

Prints the CLI version.

<!-- source: packages/cli/src/cli.ts:830 -->
