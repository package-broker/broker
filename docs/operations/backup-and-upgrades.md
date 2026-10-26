---
title: Backup and upgrades
sidebar_position: 1
description: Back up application state and keys, restore to an empty deployment, and plan upgrades and master key rotation.
---

Use this how-to when you operate an existing deployment. Rehearse each change on isolated resources before changing production. Keep the database, stored archives, deployment configuration and matching master keys as one recovery set.

<!-- source: packages/runtime-node/src/restore-rehearsal/rehearsal.test.support.ts:74 -->

## What the operator owns

- Choose where the database, archives and external secrets live, and control access to their backups.
- Schedule backups, choose retention and recovery objectives, and test a restore periodically and before an upgrade.
- Retain the exact deployed artifact and its configuration, including plugin composition and external storage settings.
- Maintain the public address, TLS, deployment resources and source credentials.
- Review readiness, failed jobs and logs; configure log export and retention for your deployment.
- Plan upgrades and master key changes, and keep a recovery set from before each change.

<!-- source: packages/core/src/config.ts:21 -->
<!-- source: packages/runtime-node/src/startup.ts:736 -->

The broker has migration and key-generation commands; the CLI does not expose a general backup, restore or complete master-key rotation command. The restore test suites use disposable fixtures. See [Restore rehearsal](restore-rehearsal.md) for developer checks and the isolated Cloudflare exercise.

<!-- source: packages/cli/src/cli.ts:28 -->

## Choose the recovery set

| State                                  | Docker / Node                                                                             | Workers                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Application state and migration ledger | SQLite database, including committed WAL state                                            | D1 export                                                                         |
| Archive bytes and metadata             | Filesystem blob root, including `.media` sidecars; any separately configured object store | R2 objects, content types and metadata                                            |
| Other persisted archives               | SSH and Git archive roots                                                                 | Preserve any additional storage configured by your build                          |
| Secrets                                | Current and still-used previous master keys, plus other externally supplied secrets       | Original secret values retained outside Cloudflare                                |
| Deployment identity                    | Exact image/artifact, build configuration and runtime settings                            | Exact Worker/assets, bindings, routes, configuration and CLI deployment inventory |

<!-- source: Dockerfile:92 -->
<!-- source: packages/runtime-node/src/startup.ts:803 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/rehearsal.test.support.ts:156 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/r2-objects.mjs:61 -->
<!-- source: packages/cli/src/commands/cloudflare/inventory.ts:103 -->

The Docker defaults put SQLite and blobs under `/data`; SSH and Git archive roots default beside the SQLite file. Mount and back up the whole `/data` volume. If you override these paths or use external storage, include those locations too. A database file alone is insufficient.

<!-- source: Dockerfile:92 -->
<!-- source: packages/runtime-node/src/startup.ts:803 -->

Node accepts `PB_MASTER_KEY` or `PB_MASTER_KEY_FILE`, and `PB_MASTER_KEY_PREVIOUS` or `PB_MASTER_KEY_PREVIOUS_FILE`. Each pair is mutually exclusive. Workers reads `PB_MASTER_KEY` and `PB_MASTER_KEY_PREVIOUS`. Back up the values or file contents, including every version still used by stored data; a file path or a platform secret name is insufficient. Do not print these values or put them in a command line.

<!-- source: packages/runtime-node/src/startup.ts:192 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:432 -->
<!-- source: packages/db-sqlite/src/repositories/keyring-verifier.ts:103 -->

## Back up Docker

This recipe follows the [Docker quickstart](../getting-started/quickstart-docker.md): one container owns the whole `/data` volume, the master key is `/data/master.key`, and `PB_MASTER_KEY_FILE=/data/master.key` selects it. Set `BROKER_CONTAINER` to that container's name and `BACKUP_DIR` to an absolute, unused backup directory outside the mounted data. These are recipe inputs, not broker settings. The volume copy includes the key, so store the entire backup as secret material. Include any retained previous-key files and their runtime settings too.

For a deployment that supplies key values through an environment file instead, set `DEPLOYMENT_ENV_FILE` to the original protected file. The alternative commands below copy and restore it. If keys are bind-mounted from outside `/data`, copy each file with `cp "$KEY_FILE" "$BACKUP_DIR/master.key"` (after creating the backup directory), repeat for previous-key files, and record their read-only mounts and `_FILE` settings for restore.

<!-- source: Dockerfile:92 -->
<!-- source: packages/runtime-node/src/startup.ts:192 -->
<!-- source: scripts/docker-smoke.mjs:1072 -->
<!-- verify: docker-round-trip — maintainer: run these Docker CLI commands against a disposable deployment, including separate key-file and external-storage variants. -->

1. Block incoming traffic and stop external producers. Stop every process writing the data or object store. Keep them stopped across the database/archive/secret snapshot boundary, and suspend credential and master-key changes until the recovery set is complete.
2. Copy the stopped container's entire data directory. Do not copy only the main file of a live SQLite database.

<!-- source: packages/runtime-node/src/restore-rehearsal/rehearsal.test.support.ts:131 -->

```sh
set -eu
set +x
umask 077
: "${BROKER_CONTAINER:?}" "${BACKUP_DIR:?}"
mkdir "$BACKUP_DIR"
mkdir "$BACKUP_DIR/data"
docker stop "$BROKER_CONTAINER"
docker cp "$BROKER_CONTAINER:/data/." "$BACKUP_DIR/data/"
docker inspect --format '{{.Image}}' "$BROKER_CONTAINER" > "$BACKUP_DIR/image-id"
```

For the environment-file alternative, also run this while writers and key changes remain stopped:

```sh
cp "${DEPLOYMENT_ENV_FILE:?}" "$BACKUP_DIR/deployment.env"
chmod 600 "$BACKUP_DIR/deployment.env"
```

3. Save the deployment definition and any external object-store snapshot with this set. Keep the image available in your artifact store; an image identifier alone does not preserve the artifact. Record the backup time and checksums through your backup system. Protect the complete set because it contains authentication material.
4. Only after the complete copy succeeds, restart the original container and reopen traffic after readiness succeeds.

<!-- source: Dockerfile:107 -->

```sh
docker start "$BROKER_CONTAINER"
```

A failed copy leaves the broker stopped. Resolve the failure before reopening traffic; do not accept a partial backup. A new recovery set counts as valid only after a test restore or startup of its restored copy with the saved keys succeeds. An old environment file can contain stale keys even when every copy command succeeds; complete [Verify the restore](#verify-the-restore) before relying on the set.

## Restore Docker into an empty volume

Keep the same private shell settings (`set -eu`, shell tracing off and `umask 077`) used for the backup.

Verify the complete backup against the checksums recorded by your backup system before copying any files. Use the same artifact as the backup first. Supply `RESTORE_VOLUME` and `RESTORE_CONTAINER` as new, unused names. The following procedure refuses an existing volume, copies the backup before startup, and restores ownership for the image's runtime user. For the isolated local rehearsal below, override the public address to the loopback address shown in the command. Before starting it, pause all restored sources or block outbound traffic to vendors at the rehearsal host's firewall; the restored credentials can otherwise allow scheduled syncs against production vendor accounts. Keep local client access available for acceptance checks. Do not connect this copy to production external storage or producers. A production recovery should retain its configured public address instead. If your deployment uses key files outside `/data`, add their restored read-only bind mounts and `_FILE` settings before startup; an environment file containing paths does not preserve those files.

<!-- source: Dockerfile:98 -->
<!-- source: packages/runtime-node/src/startup.ts:232 -->
<!-- source: scripts/docker-smoke.mjs:1014 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/rehearsal.test.support.ts:131 -->
<!-- verify: docker-round-trip — maintainer: verify fresh-volume refusal, restored ownership, original login/token and archive digest; record actual output and duration. -->

```sh
set -eu
set +x
umask 077
: "${BACKUP_DIR:?}" "${RESTORE_VOLUME:?}" "${RESTORE_CONTAINER:?}"
IMAGE_ID="$(cat "$BACKUP_DIR/image-id")"
if docker volume inspect "$RESTORE_VOLUME" >/dev/null 2>&1; then
  printf '%s\n' 'Choose a new restore volume.' >&2
  exit 1
fi
docker volume create "$RESTORE_VOLUME"
docker run --rm --user 0:0 --entrypoint node \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --mount "type=bind,src=$BACKUP_DIR/data,dst=/backup,readonly" \
  "$IMAGE_ID" -e '
const fs = require("node:fs");
if (fs.readdirSync("/data").length) throw Error("Restore target is not empty");
fs.cpSync("/backup", "/data", { recursive: true, preserveTimestamps: true });
for (const path of ["/data", ...fs.readdirSync("/data", { recursive: true }).map(p => "/data/" + p)]) {
  fs.lchownSync(path, 1000, 1000);
}
'
docker run --detach --name "$RESTORE_CONTAINER" \
  --env PB_MASTER_KEY_FILE=/data/master.key \
  --env PB_PUBLIC_URL=http://127.0.0.1:8788 \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --publish 127.0.0.1:8788:8787 "$IMAGE_ID"
```

For a rotated keyring, use this startup command instead, replacing `/data/master.previous.keys` with the saved previous-key file's actual path. Include its restored read-only mount if outside `/data`. Use the command above only when the deployment has no retained previous keys:

<!-- source: packages/runtime-node/src/startup.ts:216 -->

```sh
docker run --detach --name "$RESTORE_CONTAINER" \
  --env PB_MASTER_KEY_FILE=/data/master.key \
  --env PB_MASTER_KEY_PREVIOUS_FILE=/data/master.previous.keys \
  --env PB_PUBLIC_URL=http://127.0.0.1:8788 \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --publish 127.0.0.1:8788:8787 "$IMAGE_ID"
```

For the environment-file alternative, use this startup command instead (after the same volume restore and outbound-traffic restriction):

```sh
docker run --detach --name "$RESTORE_CONTAINER" \
  --env-file "$BACKUP_DIR/deployment.env" \
  --env PB_PUBLIC_URL=http://127.0.0.1:8788 \
  --mount "type=volume,src=$RESTORE_VOLUME,dst=/data" \
  --publish 127.0.0.1:8788:8787 "$IMAGE_ID"
```

Hold public traffic until [Verify the restore](#verify-the-restore) passes. Never repair a wrong-key restore by generating a replacement key or setting `PB_KEYRING_RESEED`; recover the matching saved key values.

<!-- source: packages/core/src/secrets/keyring-verifier.ts:111 -->

## Back up and restore Workers

Quiesce all writers, including HTTP mutations, scheduled jobs, queue consumers and external producers. A D1 export and an R2 copy taken while writers run do not form a coordinated recovery set. Hold traffic at a maintenance deployment until the complete restore and verification finish. Use fresh D1, R2 and Worker resources for rehearsal; preserve the original resources until acceptance.

<!-- source: packages/runtime-cloudflare/src/index.ts:349 -->
<!-- source: packages/runtime-cloudflare/src/restore-rehearsal/rehearsal.test.support.ts:1 -->
<!-- verify: workers-round-trip — maintainer with scoped Cloudflare/R2 credentials: prove writer drain, D1 export/import, all referenced R2 bytes/metadata and original key delivery on fresh resources; capture sanitized output. -->

From the matching source checkout, with Wrangler, AWS CLI and credentials already available in the protected operator environment, supply these recipe inputs: `D1_NAME`, `WRANGLER_CONFIG`, `R2_BUCKET`, `BACKUP_DIR` (absolute and unused), and `WORKER_SECRETS_FILE` (the original protected JSON map of secret names to values). Also supply `PB_REHEARSAL_R2_ENDPOINT` for your bucket's jurisdiction; this variable belongs to the repository's object-copy helper, not the runtime. `r2-objects.mjs` is the restore rehearsal helper, not a published backup CLI; use the version from the matching checkout and rehearse it before relying on the set. Retain the configuration, deployment inventory and exact Worker/assets separately with the backup.

<!-- source: packages/runtime-node/src/restore-rehearsal/r2-objects.mjs:7 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/r2-objects.mjs:12 -->
<!-- source: packages/db-sqlite/migrations/0001_init.sql:32 -->
<!-- source: packages/db-sqlite/migrations/0001_init.sql:223 -->
<!-- source: packages/core/src/platform/blob-lifecycle.ts:114 -->
<!-- source: packages/core/src/platform/blob-lifecycle.ts:146 -->

The inventory covers every organization in the exported database. An interrupted purge can remove an object before marking its row deleted. List the actual bucket objects, exclude absent objects from the helper's input and retain those rows in `missing-objects.json` for review. This lets the copy finish without pretending missing bytes were saved. Investigate every missing row: expected purge remnants need a recorded explanation, while missing archives still required by installs make the recovery set incomplete. Keep the database export unchanged.

<!-- verify: workers-inventory — maintainer with scoped Cloudflare/R2 credentials: verify paginated object listing, interrupted-purge reporting and refusal to accept a recovery set with a required archive missing. -->

After all writers have drained, suspend source-credential and master-key changes until the recovery set is complete:

```sh
set -eu
set +x
umask 077
: "${D1_NAME:?}" "${WRANGLER_CONFIG:?}" "${R2_BUCKET:?}"
: "${BACKUP_DIR:?}" "${WORKER_SECRETS_FILE:?}" "${PB_REHEARSAL_R2_ENDPOINT:?}"
mkdir "$BACKUP_DIR"
wrangler d1 export "$D1_NAME" --config "$WRANGLER_CONFIG" \
  --remote --output "$BACKUP_DIR/database.sql"
wrangler d1 execute "$D1_NAME" --config "$WRANGLER_CONFIG" --remote \
  --command "SELECT org_id, sha256, size_bytes, storage_key, media_type, purge_after, purge_generation FROM blob WHERE org_id IN (SELECT id FROM organization) AND deleted_at IS NULL ORDER BY org_id, sha256" \
  --json > "$BACKUP_DIR/reference-candidates.json"
AWS_PAGER='' aws s3api list-objects-v2 \
  --endpoint-url "$PB_REHEARSAL_R2_ENDPOINT" --bucket "$R2_BUCKET" \
  --output json > "$BACKUP_DIR/object-list.json"
node --input-type=module - "$BACKUP_DIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.argv[2];
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
const candidates = read('reference-candidates.json').flatMap(part => part.results ?? []);
const keys = new Set((read('object-list.json').Contents ?? []).map(object => object.Key));
const present = candidates.filter(row => keys.has(row.storage_key));
const missing = candidates.filter(row => !keys.has(row.storage_key));
write('missing-objects.json', missing);
write('references.json', [{ results: present }]);
if (present.length === 0) write('r2-inventory.json', []);
console.log(`Missing objects: ${missing.length}`);
console.log('Inventory recorded; review missing-objects.json privately.');
NODE
cp "$WORKER_SECRETS_FILE" "$BACKUP_DIR/secrets.json"
chmod 600 "$BACKUP_DIR/secrets.json"
cp "$WRANGLER_CONFIG" "$BACKUP_DIR/source-config.jsonc"
if node -e 'const fs = require("node:fs"); const refs = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(refs.some(part => part.results.length > 0) ? 0 : 1)' "$BACKUP_DIR/references.json"; then
  node packages/runtime-node/src/restore-rehearsal/r2-objects.mjs \
    backup "$BACKUP_DIR" "$R2_BUCKET"
else
  printf '%s\n' 'No present archives; empty R2 inventory recorded. Review missing-objects.json.'
fi
```

The rehearsal helper verifies each present archive's length and SHA-256 and stores its content type and metadata. Its restore check compares bytes and content type; compare restored custom metadata against `r2-inventory.json` separately. Its backup operation requires a nonempty archive inventory, so the branch above records an empty manifest when no objects are present. Keep additional storage used by your configured plugins in the recovery set. Cloudflare secret listings cannot recover secret values; obtain them from the original protected secret source. Store this recovery set as secret material. It counts as valid only after a test restore or startup of the restored copy with its saved keys succeeds, missing-object reports are resolved, and [Verify the restore](#verify-the-restore) passes. A stale original secrets file can otherwise make a successful export unrestorable.

<!-- source: packages/runtime-node/src/restore-rehearsal/r2-objects.mjs:61 -->
<!-- verify: workers-empty-inventory — maintainer: check empty D1 blob inventory and empty target bucket explicitly; verify that a deployment with no archives restores without the nonempty-fixture helper. -->

To restore, reserve an empty database and bucket and a dedicated Worker serving maintenance. Supply `RESTORE_D1_NAME`, `RESTORE_R2_BUCKET`, and `RESTORE_WRANGLER_CONFIG` pointing only to these resources. Check that no application tables, objects or configured secret names exist at the destination. Verify the backup checksums before any writes. Configure fresh queue/cache namespaces so production jobs and cached responses cannot satisfy the rehearsal. Before deploying the saved Worker, remove all scheduled triggers from the rehearsal configuration and deployment; keep them disabled through verification so restored production credentials cannot trigger scheduled vendor syncs. Keep production writers and producers disconnected from these resources.

<!-- source: packages/runtime-node/src/restore-rehearsal/r2-objects.mjs:81 -->
<!-- source: packages/runtime-cloudflare/src/index.ts:2123 -->
<!-- verify: workers-restore-guards — maintainer / CI with the deployment Wrangler version: confirm secret list --format json, destination refusal and absent scheduled triggers before the restored Worker starts. -->

```sh
set -eu
set +x
umask 077
: "${BACKUP_DIR:?}" "${PB_REHEARSAL_R2_ENDPOINT:?}"
: "${RESTORE_D1_NAME:?}" "${RESTORE_R2_BUCKET:?}" "${RESTORE_WRANGLER_CONFIG:?}"
RESTORE_CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$RESTORE_CHECK_DIR"' EXIT HUP INT TERM
wrangler d1 execute "$RESTORE_D1_NAME" --config "$RESTORE_WRANGLER_CONFIG" \
  --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'" \
  --json > "$RESTORE_CHECK_DIR/destination-tables.json"
wrangler secret list --config "$RESTORE_WRANGLER_CONFIG" --format json \
  > "$RESTORE_CHECK_DIR/destination-secrets.json"
node --input-type=module - "$RESTORE_CHECK_DIR" "$BACKUP_DIR" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const read = name => JSON.parse(readFileSync(join(process.argv[2], name), 'utf8'));
assert.equal(read('destination-tables.json').flatMap(part => part.results ?? []).length, 0, 'Destination has application tables');
assert.equal(read('destination-secrets.json').length, 0, 'Destination has secrets');
assert.ok(Array.isArray(JSON.parse(readFileSync(join(process.argv[3], 'r2-inventory.json'), 'utf8'))), 'Missing archive inventory');
NODE
node packages/runtime-node/src/restore-rehearsal/r2-objects.mjs \
  empty "$BACKUP_DIR" "$RESTORE_R2_BUCKET"
wrangler d1 execute "$RESTORE_D1_NAME" --config "$RESTORE_WRANGLER_CONFIG" \
  --remote --file "$BACKUP_DIR/database.sql" --yes
wrangler secret bulk "$BACKUP_DIR/secrets.json" --config "$RESTORE_WRANGLER_CONFIG"
if node -e 'const fs = require("node:fs"); const inventory = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(inventory.length > 0 ? 0 : 1)' "$BACKUP_DIR/r2-inventory.json"; then
  node packages/runtime-node/src/restore-rehearsal/r2-objects.mjs \
    restore "$BACKUP_DIR" "$RESTORE_R2_BUCKET"
  cp "$BACKUP_DIR/r2-inventory.json" "$RESTORE_CHECK_DIR/r2-inventory.json"
  node packages/runtime-node/src/restore-rehearsal/r2-objects.mjs \
    check "$RESTORE_CHECK_DIR" "$RESTORE_R2_BUCKET"
else
  printf '%s\n' 'Empty archive inventory; destination bucket checked empty; object restore skipped.'
fi
```

Deploy the saved Worker and assets with the restored configuration and no scheduled triggers, then verify before opening traffic. Enable schedules only when the verified deployment is intended to resume vendor syncs. The [isolated restore rehearsal](restore-rehearsal.md) contains the resource provisioning and maintenance deployment procedure. If any restore step fails, discard the disposable target and retry with fresh resources; do not import again over partially restored state.

## Verify the restore

Record the candidate identity, backup time, archive length/digest and elapsed restore time. Readiness alone does not prove recovery:

1. Check readiness: the Node image checks `GET /health/ready` and expects HTTP 200.
2. Sign in using the original password and authenticator enrollment. Confirm an original install token still works, and an unauthenticated install fails.
3. Install a previously stored archive with source access unavailable and empty derived caches. Compare its bytes with the length and SHA-256 recorded before backup.
4. Confirm an excluded project remains inaccessible. In a separate disposable negative test, omitted keys, wrong keys and missing/corrupt archives must fail verification.

<!-- source: Dockerfile:107 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/fixture.test.support.ts:278 -->
<!-- source: packages/runtime-node/src/restore-rehearsal/restore-rehearsal.test.ts:84 -->
<!-- verify: restore-acceptance — maintainer: attach Docker and real D1/R2 round-trip logs, digest comparison and negative controls for the same immutable candidate. Miniflare results alone do not establish deployed-account acceptance. -->

Use the [access model token table](../reference/access-model.md) when selecting an install token. Do not issue a broader token to hide a failed recovery.

## Rotate the master key while retaining old versions

Take and rehearse a complete recovery set first. The keyring supports one current key and up to three previous keys. Versions must be unique and descending; the current version must be higher than every retained version. Keep all still-used keys in the recovery set.

<!-- source: packages/core/src/secrets/master-key.ts:35 -->
<!-- source: packages/core/src/secrets/master-key.ts:109 -->

Check capacity before generating another key. If the current key and three previous keys are all still in use, another activation would exceed the supported keyring. Resolve old-key retirement through a supported procedure before proceeding; do not drop an in-use key to make room.

<!-- source: packages/core/src/secrets/master-key.ts:115 -->
<!-- source: packages/db-sqlite/src/repositories/keyring-verifier.ts:103 -->

From a source checkout after `pnpm build`, supply `NEXT_KEY_VERSION` as the next version number and `NEW_KEY_FILE` as an unused protected output path. The command prints the key to standard output; redirect it to a file and keep shell tracing disabled.

<!-- source: package.json:18 -->
<!-- source: packages/cli/src/commands/admin.ts:68 -->

```sh
set -eu
set +x
umask 077
: "${NEXT_KEY_VERSION:?}" "${NEW_KEY_FILE:?}"
(set -C; node packages/cli/dist/bin.js secrets generate-master-key --key-version "$NEXT_KEY_VERSION" > "$NEW_KEY_FILE")
```

Docker users can use the CLI in their image instead. In the same private shell, supply `IMAGE_ID` as the deployed image and use an unused `NEW_KEY_FILE`:

<!-- source: Dockerfile:90 -->

```sh
: "${IMAGE_ID:?}" "${NEXT_KEY_VERSION:?}" "${NEW_KEY_FILE:?}"
(set -C; docker run --rm --entrypoint pb "$IMAGE_ID" \
  secrets generate-master-key --key-version "$NEXT_KEY_VERSION" > "$NEW_KEY_FILE")
```

1. Through your deployment's secret delivery mechanism, set `PB_MASTER_KEY` to the new file's contents and `PB_MASTER_KEY_PREVIOUS` to the comma-separated old keys, newest first. Node can instead read the corresponding `_FILE` settings. Apply current and previous values together before restarting or deploying.
2. Start the isolated candidate and verify readiness, an old install token, original local login and a source credential. New encrypted writes use the current key; old data can still be read using retained versions.
3. Keep the previous keys loaded. There is a credential resealing service, but this CLI exposes no command to run it. Password hashes and token peppers can also retain old versions. Startup refuses removal of a version still used by credentials, tokens or local logins. Do not treat generating and activating a key as completion of old-key retirement.
4. Take a new recovery set after activation. Retain the previous set and its keys for its entire recovery window.

<!-- source: packages/runtime-node/src/startup.ts:192 -->
<!-- source: packages/core/src/secrets/cipher.ts:47 -->
<!-- source: packages/core/src/secrets/credential-store.ts:106 -->
<!-- source: packages/db-sqlite/src/repositories/keyring-verifier.ts:103 -->
<!-- source: packages/cli/src/cli.ts:28 -->
<!-- verify: master-key-activation — maintainer: activate a higher-version key with retained old versions on both runtimes; verify login, old token and source credential; show that removing an in-use old key is refused. Complete retirement needs a separately supported re-encryption/token/password procedure. -->

## Upgrade between release candidates

Keep the current immutable artifact and a tested recovery set. Read the target release's notes and `UPGRADE_NOTES.md` **before applying any migration or starting new code**. This checkout does not contain that file; obtain the target release's operator instructions and confirm compatibility before proceeding. Do not infer a safe release-candidate transition from version numbers alone.

<!-- source: packages/cli/src/commands/sqlite.ts:20 -->
<!-- verify: release-upgrade-notes — release owner / maintainer: select two published 2.0.0-rc artifacts, obtain the target UPGRADE_NOTES.md or equivalent release instructions, and verify the exact transition and rollback boundary. -->

On a restored copy, use the **target** CLI and migration bundle to inspect pending migrations. From the target source checkout, `pnpm build` builds the CLI but does not create runtime migration bundles. `pnpm bundle` creates those bundles using the repository's `broker.config.ts`; use it only if that is your deployment's build configuration. Otherwise set `OPERATOR_BUILD_CONFIG` to your configuration and run the explicit `pb build` commands below. Include the deployment's plugins: a bundle missing their migrations reports already-applied plugin migrations as `unknown`. Supply `SQLITE_COPY` as the restored database path, or `D1_ID` as the isolated database ID. The Cloudflare CLI reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment.

<!-- source: package.json:11 -->
<!-- source: package.json:19 -->
<!-- source: packages/cli/src/cli.ts:30 -->
<!-- source: packages/cli/src/cli.ts:38 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:82 -->
<!-- source: packages/cli/src/commands/sqlite.ts:25 -->
<!-- source: packages/db-sqlite/src/migrations/runner.ts:37 -->

```sh
pnpm build
pnpm pb build --config "${OPERATOR_BUILD_CONFIG:?}" --target node --out .pb/node
pnpm pb build --config "$OPERATOR_BUILD_CONFIG" --target cloudflare --out .pb/cloudflare
```

Run the dry run for your runtime:

```sh
pnpm pb migrate --sqlite "${SQLITE_COPY:?}" --out .pb/node --dry-run
```

Or, for Workers:

```sh
pnpm pb cloudflare migrate --database-id "${D1_ID:?}" --out .pb/cloudflare --dry-run
```

Docker users should use the host SQLite dry run above with a disposable database copy from the stopped rehearsal volume. Build the host bundle from the target release checkout using the same `OPERATOR_BUILD_CONFIG` as the image's `CONFIG` build argument. The image does not include `generated/manifest.json`, which `pb migrate` requires under `--out`; `/app` cannot serve as the migration bundle.

<!-- source: Dockerfile:9 -->
<!-- source: Dockerfile:20 -->
<!-- source: packages/cli/src/commands/built-manifest.ts:71 -->

When the release instructions permit it, repeat the selected migration command without `--dry-run` on the isolated target, deploy the target artifact, and run the restore acceptance checks and an install. Record applied, skipped, unknown and pending migration identifiers. Investigate unknown migrations or checksum mismatches before production; do not edit the ledger to suppress them.

<!-- source: packages/db-sqlite/src/migrations/runner.ts:37 -->
<!-- source: packages/cli/src/commands/sqlite.ts:36 -->
<!-- verify: rc-upgrade — maintainer: rehearse target migration, startup, install and recovery for the selected RC pair on Docker and Workers. -->

For production, quiesce writers, take a fresh recovery set, apply the approved target migrations and deploy the tested artifact. Node migrates on startup unless `PB_MIGRATE=off`; account for that before starting a new image. Keep traffic held until checks pass. A code rollback is not a database rollback: after an incompatible migration, restore the complete pre-upgrade set or follow the release's forward-repair instructions. Writes after the backup are absent from a restored set. The Cloudflare deployment code refuses code rollback across a recorded contract migration boundary.

<!-- source: packages/runtime-node/src/startup.ts:750 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:2044 -->

## Read logs and maintain the deployment

Use [Observability](observability.md) to configure exports and retention. Keep backup/restore results, candidate identities and sanitized migration outcomes with your operating records. Review source sync failures and backup failures, monitor storage growth, and repeat the restore exercise after storage or secret-delivery changes. Choose retention periods for your operating needs; the broker does not establish a year of log retention merely by running.

For Docker, read recent container output; keep the result private and share only the fixed event/error name and necessary non-secret context:

<!-- source: packages/runtime-node/src/startup.ts:825 -->
<!-- verify: operator-logs — maintainer: check Docker log retrieval and Workers log export/tail through the selected platform tooling; confirm tokens, source credentials, account e-mails and credential-bearing URLs are absent from retained evidence. -->

```sh
docker logs --since 1h "${BROKER_CONTAINER:?}"
```

For Workers, stream live logs using the deployment's Wrangler configuration. Apply the same private-output handling; configure persistent exports separately through [Observability](observability.md).

<!-- verify: workers-tail — maintainer / CI: confirm wrangler tail against the deployed Worker using its configuration and check sanitized log output. -->

```sh
wrangler tail --config "${WRANGLER_CONFIG:?}"
```
