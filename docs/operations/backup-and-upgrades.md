---
title: Upgrades and operations
sidebar_position: 1
description: Upgrade a deployment, apply migrations, rotate the master key and read health and logs.
---

## Upgrade

An upgrade is a new build from a newer checkout, followed by the database migrations of that build.

On Node:

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm pb build --config broker.config.ts --target node
```

Copy the new `.pb/node/` to where the server runs, run `npm install --omit=dev` in it, and restart the server. Keep the database and blob directory outside `.pb/`, so a rebuild never touches them. The server applies pending migrations at start. To apply them as a separate step instead, set `PB_MIGRATE=off` on the server and run:

```sh
pnpm pb migrate --sqlite "$HOME/pb-data/broker.sqlite" --out .pb/node
```

On Cloudflare, migrate first and deploy second:

```sh
pnpm pb build --config broker.config.ts --target cloudflare
pnpm pb cloudflare migrate --database-id <database id>
cd packages/runtime-cloudflare
npx wrangler deploy
```

Both migrate commands accept `--dry-run`, which lists the pending migrations without applying them. Without `--dry-run`, a run takes a lock in the database, so two runs at the same time do not both apply migrations. A run that finds the lock held waits up to 30 seconds and continues if the lock frees up in time; otherwise it exits with 4. The lock lasts 10 minutes and is renewed after each applied migration, on SQLite and on D1, so a crashed run blocks others for at most 10 minutes. Exit code 3 means a migration already recorded in the database differs from the one in the build; nothing is applied. All exit codes are in the [pb CLI reference](../reference/cli.md#exit-codes-for-migrate-and-bootstrap).

## Rotate the master key

The master key protects stored secrets; local password hashes are peppered with a key derived from it. Each key carries a version, and stored values record the version they were written with. To rotate:

1. Generate a key with a higher version than the current one:

   ```sh
   pnpm pb secrets generate-master-key --key-version 2 > "$HOME/pb-data/master-v2.key"
   chmod 600 "$HOME/pb-data/master-v2.key"
   ```

2. Make the old key a previous key and the new key the current one, in one change.

   On Node, set both and restart once, for example `PB_MASTER_KEY_FILE="$HOME/pb-data/master-v2.key"` and `PB_MASTER_KEY_PREVIOUS_FILE="$HOME/pb-data/master.key"`.

   On Workers, update both secrets in one request from `packages/runtime-cloudflare`:

   ```sh
   printf '{"PB_MASTER_KEY_PREVIOUS":"%s","PB_MASTER_KEY":"%s"}' "$(cat "$HOME/pb-data/master.key")" "$(cat "$HOME/pb-data/master-v2.key")" | npx wrangler secret bulk
   ```

   With two `wrangler secret put` calls instead, set `PB_MASTER_KEY_PREVIOUS` first and `PB_MASTER_KEY` second. Between the two calls the current and previous key are the same, the Worker rejects that configuration, and every request fails.

`PB_MASTER_KEY_PREVIOUS` holds up to three older keys, comma-separated, newest first, each with a lower version than the key before it. On Node, `PB_MASTER_KEY_FILE` and `PB_MASTER_KEY_PREVIOUS_FILE` read the values from files instead.

Values written with an older key stay readable while that key is listed. A local password hash is rewritten under the current key at the user's next successful sign-in; other stored values, such as TOTP secrets, keep their key version. There is no command yet that rewrites them, so keep the old key listed.

## Health checks

- `GET /health/live` answers `200 {"status":"live"}` while the process serves requests.
- `GET /health/ready` answers `200 {"status":"ready"}` when the database is reachable and the organization exists, and `503` with the code `not_ready` otherwise.

Neither needs authentication.

## Logs and metrics

On Node with the `stdio` adapter, every record is one JSON line: logs with `level` and `event`, and `counter` and `histogram` records for metrics such as `pb.http.requests` and `pb.http.duration_ms`. Each record carries `deployment_id` from `DEPLOYMENT_ID`. On Workers, logs go to Workers Logs and metrics to the Analytics Engine binding. Either runtime can also export to an OTLP endpoint; see [Configuration](../reference/configuration.md#observability).

## Stop the Node server

`SIGTERM` or `SIGINT` stops the job loop, flushes pending log and metric records, closes the database and exits with code 0.

## Backup and restore

Planned for 2.0.
