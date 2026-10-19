---
title: pb CLI
sidebar_position: 6
description: Reference for the pb command.
---

`pb` is the command-line tool in `@package-broker/cli`. In a source checkout, run `pnpm build` once and then call it as `pnpm pb <command>` from the repository root.

`pb --help` prints the usage and the exit codes. An unknown command or flag prints the usage and exits with 2. The usage also lists `pb openapi`, which does not work yet: it always exits with 1 and prints `no_api_specs`.

The database and admin commands print their result as one JSON object on stdout. Messages and errors go to stderr.

## Targets

Commands that touch a database take one target:

- `--sqlite <file>`: a local SQLite file, used by the Node runtime.
- `--cloudflare --database-id <uuid>` for `pb admin`, or `--database-id <uuid>` for `pb cloudflare`: a D1 database, reached through the Cloudflare D1 HTTP API. These commands read `CLOUDFLARE_ACCOUNT_ID` (32 lowercase hex characters) and `CLOUDFLARE_API_TOKEN` from the environment and exit with 2 if either is missing or malformed. The token needs the D1 Edit permission.

## `pb build`

```sh
pnpm pb build [--config <file>] [--target cloudflare|node] [--out <dir>]
```

Validates `broker.config.ts` (or `--config`), then writes the bundle for one target. `--target` defaults to the `platform` in the config. `--out` defaults to `.pb/<target>`.

Output in the out directory:

- `worker.js` (Cloudflare) or `server.js` (Node), with a source map and `metafile.json`.
- `generated/manifest.ts` and `generated/manifest.json`: the plugin set, the platform ports and the migration list.
- `migrations/`: the SQL migrations of core and the enabled plugins.
- Node only: `package.json` listing the native SQLite driver. Run `npm install --omit=dev` in the out directory before starting `server.js`.

Exit codes: 0 success; 2 invalid configuration found by the build checks (each problem is printed as `error: ...`); 1 any other failure. When a plugin option or a ports setting is invalid, the build exits with 1 and prints only the error name, for example `error: TypeError`. Check the values against the [configuration reference](configuration.md).

## `pb migrate`

```sh
pnpm pb migrate --sqlite <file> [--out <dir>] [--dry-run]
```

Applies the migrations from a Node build (`--out`, default `.pb/node`) to a SQLite file. It creates the file if it does not exist. The Node server runs the same migrations at start unless `PB_MIGRATE=off`.

Without `--dry-run`, a run takes a lock in the database before it applies anything. The lock lasts 10 minutes and is renewed after each applied migration. A run that finds the lock held waits up to 30 seconds for it, then exits with 4. `--dry-run` takes no lock.

The result lists migration IDs under `applied`, `skipped` (already recorded), `pending` (with `--dry-run`, nothing is written) and `unknown` (recorded in the database but absent from the build).

## `pb cloudflare migrate`

```sh
pnpm pb cloudflare migrate --database-id <uuid> [--out <dir>] [--dry-run]
```

Applies the migrations from a Cloudflare build (`--out`, default `.pb/cloudflare`) to a D1 database, with the same lock rules as `pb migrate`. Without `--dry-run` it prints its lock holder ID to stderr. The Worker never migrates on its own.

## Exit codes for `migrate` and `bootstrap`

These apply to `pb migrate`, `pb bootstrap`, `pb cloudflare migrate` and `pb cloudflare bootstrap`.

| Code | Meaning                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                                                                                                                                                                     |
| 1    | Other error.                                                                                                                                                                                                                                 |
| 2    | Usage error, invalid slug, missing or malformed Cloudflare credentials, or a build whose routes fail validation.                                                                                                                             |
| 3    | A recorded migration's checksum differs from the build, or a migration file differs from the manifest. Nothing is applied.                                                                                                                   |
| 4    | `migrate` commands only: another run held the migration lock for more than 30 seconds, or the database is busy. Run again later. A busy database during `bootstrap` gives 1.                                                                 |
| 5    | The database already holds an organization with a different slug.                                                                                                                                                                            |
| 6    | Cloudflare only: the request was sent and the answer was lost. Run the command again; it reads the recorded state. If the lock is held by the holder printed earlier, it expires at most 10 minutes after that run's last applied migration. |

## `pb bootstrap` and `pb cloudflare bootstrap`

```sh
pnpm pb bootstrap --sqlite <file> --slug <slug> --name <name>
pnpm pb cloudflare bootstrap --database-id <uuid> --slug <slug> --name <name>
```

Creates the organization in a migrated database. A deployment holds one organization. The slug is 1 to 64 lowercase letters, digits and inner hyphens. Running it again with the same slug prints the existing organization with `"created":false` and exits with 0; a different slug exits with 5.

The Node server can do the same at start through `PB_ORG_SLUG` and `PB_ORG_NAME`.

## `pb secrets generate-master-key`

```sh
pnpm pb secrets generate-master-key [--key-version <n>]
```

Prints a new master key in the form `pbmk_v<version>_<key>` to stdout. `--key-version` is an integer from 1 to 999999, default 1. Use a higher version than the current key when you rotate. Exit code 2 means an invalid version.

## `pb admin bootstrap`

```sh
pnpm pb admin bootstrap --email <e-mail> (--sqlite <file> | --cloudflare --database-id <uuid>) [--token-file <path>]
```

Adds the e-mail as a user with a local login and the `organization_admin` role, and issues a one-time setup token valid for 24 hours. If a user with that e-mail already exists but has not finished local setup, it gives them the role and a fresh token (result `refreshed`). It does not check for other administrators. Use the token with `POST /_pb/auth/local/setup/start` and `.../setup/finish`, described in [Authentication and sessions](authentication.md#local-accounts).

On success stdout holds `{"result":"created"|"refreshed","setupToken":...,"tokenFile":...,"expiresAt":"...","next":[...]}`, where `next` names the two setup requests. With `--token-file`, the token is written to that file, which must not exist yet, and `setupToken` is `null`. Without it the token is in `setupToken`, with a warning on stderr when stdout is not a terminal. Prefer `--token-file` so the token stays out of logs.

If the user has already finished local setup, no token is issued and the token file is not created. If the `organization_admin` role was missing permissions, the command adds them, prints `{"result":"already_set_up","toppedUp":<number added>}` and exits with 0. Otherwise it changes nothing and exits with 6. To give such a user a new password and TOTP secret, use `pb admin reset-local`.

## `pb admin reset-local`

```sh
pnpm pb admin reset-local --email <e-mail> (--sqlite <file> | --cloudflare --database-id <uuid>) [--token-file <path>]
```

Issues a new setup token for an existing user, so they can set a new password and TOTP secret. Use it for a locked-out administrator or a lost authenticator. In one step it:

- clears the user's password and TOTP secret, or creates a local login if the user had none (for example a user who signed in only through single sign-on);
- sets the user's status to active;
- gives the user the `organization_admin` role;
- revokes all of the user's sessions.

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

## `pb admin show-provider-binding`

```sh
pnpm pb admin show-provider-binding --provider <id> (--sqlite <file> | --cloudflare --database-id <uuid>)
```

Prints the trust anchor recorded for a single sign-on provider ID. The broker records the anchor at the first successful sign-in through that provider and refuses later sign-ins when the configured provider no longer matches it. Exit codes: 0 found; 2 usage error or invalid provider ID (`local` is reserved); 5 no organization; 6 nothing is bound for that provider; 7 outcome unknown, safe to run again.

## `pb admin rebind-provider`

```sh
pnpm pb admin rebind-provider --provider <id> --confirm <id> --expected-anchor <anchor> --new-anchor <anchor> (--sqlite <file> | --cloudflare --database-id <uuid>)
```

Replaces the recorded trust anchor of a provider, for example after the provider's issuer changed. `--confirm` must repeat `--provider`, and `--new-anchor` must differ from `--expected-anchor`. The swap happens only if the current anchor equals `--expected-anchor`. An OIDC anchor is `oidc:<issuer>`; a Cloudflare Access anchor is `access:<team domain>/<audience>`.

A rebind cuts every existing link to that provider. In the same step it:

- blocks the user identifiers (subjects) seen under the old anchor;
- revokes the personal access tokens tied to those identities;
- deletes the sessions started through the provider, the groups recorded from it and the identities themselves.

The user accounts stay. Because their link to the provider is gone and linking an existing user is not available yet, those users cannot sign in through the provider afterwards; their sign-ins are refused like any other user whose e-mail already exists. Plan a rebind as a cut-over, not a migration.

Exit codes: 0 success; 2 usage error, `--confirm` differs from `--provider`, equal anchors, or an invalid provider or anchor; 5 no organization; 6 no binding with that provider and expected anchor, nothing changed; 7 the D1 answer was lost and the swap may have applied (a re-run that reports 6 means it did, or that the expected anchor is wrong).

## `pb version`

Prints the CLI version.
