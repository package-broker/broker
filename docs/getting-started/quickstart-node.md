---
title: 'Quickstart: Node'
sidebar_position: 2
description: Build Package Broker from source and run it on Node with SQLite.
---

This page takes you from a source checkout to a running Node server with SQLite and a signed-in administrator. Package Broker 2.0 has no tagged release yet, so you build from the repository.

The 2.0 line is a pre-release. Composer and npm registry routes, projects and tokens are not served yet; after this quickstart you can sign in and nothing more. See [Composer](../clients/composer.md) and [npm, pnpm and yarn](../clients/npm-pnpm-yarn.md).

## Prerequisites

- Node 24 or newer.
- pnpm, through `corepack enable`. The version is pinned in `package.json`.
- npm, to install the production dependency of the built server.
- An authenticator app that reads `otpauth://` URIs. Local accounts require a TOTP code.

## 1. Build

```sh
git clone https://github.com/package-broker/broker.git
cd broker
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm pb build --config broker.config.ts --target node
```

`pb build` writes the server to `.pb/node/`: `server.js`, the migrations, and a `package.json` that lists `better-sqlite3`. Install that dependency next to the server:

```sh
cd .pb/node
npm install --omit=dev
cd ../..
```

`better-sqlite3` is a native module. npm downloads a prebuilt binary for common platforms; where none exists it compiles one, which needs Python and a C++ toolchain.

## 2. Create the data directory and the master key

From the repository root:

```sh
mkdir -p "$HOME/pb-data"
chmod 700 "$HOME/pb-data"
pnpm pb secrets generate-master-key > "$HOME/pb-data/master.key"
chmod 600 "$HOME/pb-data/master.key"
```

`~/pb-data` holds the database, the blobs and the secrets of this quickstart. It sits outside the checkout, so a rebuild or a `git clean` does not touch it, and nothing secret ends up in the repository.

The key is printed once. Keep a copy in a secret manager. Local passwords are peppered with a key derived from it, so losing it locks every local account out.

## 3. Start the server

From the repository root:

```sh
cd .pb/node
PB_PUBLIC_URL=http://127.0.0.1:8787 \
PB_MASTER_KEY_FILE="$HOME/pb-data/master.key" \
PB_SQLITE_PATH="$HOME/pb-data/broker.sqlite" \
PB_BLOB_ROOT="$HOME/pb-data/blobs" \
DEPLOYMENT_ID=local \
PB_ORG_SLUG=acme \
PB_ORG_NAME="Acme" \
node server.js
```

On start the server applies pending migrations and, because `PB_ORG_SLUG` and `PB_ORG_NAME` are set, creates the organization. It listens on port 8787 unless `PORT` says otherwise. It writes one JSON record per line: warnings and errors to stderr, everything else to stdout.

`PB_BLOB_ROOT` must be an absolute path with no symlink anywhere in it, owned by the user that runs the server and not writable by group or others. The server creates the directory if it is missing. On macOS this rules out paths under `/tmp`, which is a symlink to `/private/tmp`.

In a second terminal, check readiness:

```sh
curl http://127.0.0.1:8787/health/ready
```

The answer is `{"status":"ready"}` once the database is reachable and the organization exists.

Every variable is described in the [configuration reference](../reference/configuration.md).

## 4. Create the first administrator

In the second terminal, from the repository root:

```sh
pnpm pb admin bootstrap --email admin@example.test --sqlite "$HOME/pb-data/broker.sqlite" --token-file "$HOME/pb-data/setup-token"
```

This creates the user with the `organization_admin` role and writes a one-time setup token to `~/pb-data/setup-token`. The token expires after 24 hours. `--token-file` refuses to overwrite an existing file.

## 5. Set the password and TOTP

State-changing auth requests must carry an `Origin` header equal to `PB_PUBLIC_URL`. The commands below build each JSON body with the shell's `printf` and pass it to `curl` on stdin, so the token and the password appear neither in shell history nor in the process list.

Start the setup:

```sh
printf '{"token":"%s"}' "$(cat "$HOME/pb-data/setup-token")" |
  curl -X POST http://127.0.0.1:8787/_pb/auth/local/setup/start \
    -H 'content-type: application/json' \
    -H 'origin: http://127.0.0.1:8787' \
    --data @-
```

The response holds `provisioningUri` and `secret`. Add the URI to your authenticator app.

Choose a password of 12 to 128 characters, without `"` or `\` so the `printf` body stays valid JSON. Type it at the first prompt (nothing is echoed) and the current code from the app at the second:

```sh
read -rs PB_PASSWORD
read -r PB_CODE
printf '{"token":"%s","password":"%s","code":"%s"}' "$(cat "$HOME/pb-data/setup-token")" "$PB_PASSWORD" "$PB_CODE" |
  curl -i -X POST http://127.0.0.1:8787/_pb/auth/local/setup/finish \
    -H 'content-type: application/json' \
    -H 'origin: http://127.0.0.1:8787' \
    --data @-
rm "$HOME/pb-data/setup-token"
```

A `204` response sets the session cookies.

## 6. Sign in

A TOTP code is accepted once, so wait for the app to show a new code and enter it at the prompt:

```sh
read -r PB_CODE
printf '{"email":"admin@example.test","password":"%s","code":"%s"}' "$PB_PASSWORD" "$PB_CODE" |
  curl -c "$HOME/pb-data/cookies.txt" -X POST http://127.0.0.1:8787/_pb/auth/local/login \
    -H 'content-type: application/json' \
    -H 'origin: http://127.0.0.1:8787' \
    --data @-
unset PB_PASSWORD
curl -b "$HOME/pb-data/cookies.txt" http://127.0.0.1:8787/_pb/session
```

`/_pb/session` returns the signed-in user and the session expiry. The cookie file holds a live session, so delete it when you are done. Sessions, re-authentication and single sign-on are described in [Authentication and sessions](../reference/authentication.md).

## Stop the server

`SIGTERM` or `SIGINT` (Ctrl-C) stops the server. It stops the job loop, flushes pending log and metric records, closes the database and exits with code 0.
