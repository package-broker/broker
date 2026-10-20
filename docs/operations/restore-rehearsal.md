# Restore rehearsal

Run only against disposable deployment resources. The helpers preserve authentication in an isolated deployment; T858's deployed-account cache epoch rotation and session/PAT invalidation are separate work. Never set `PB_KEYRING_RESEED` during a restore.

The Node rehearsal directory exports `seedDeployment`, `backupDeployment`, `destroyDeployment`, `restoreDeployment`, `inventory`, `checkInventory`, `startDeployment`, and `verifyDeployment`. The Cloudflare directory exports equivalent operations over Miniflare D1/R2. `exportDatabase` produces a logical snapshot of bound statements, including byte-preserving TEXT and BLOB parameters, schema, migration ledger, indexes and triggers. Inserts are chunked to at most 100 bound parameters per statement, with SQL kept below 100,000 bytes. The JSON backup retains complete byte values; `bindSnapshot` decodes them before restore. Callers must quiesce writes before the database/object snapshot boundary. Node uses SQLite's online backup API, including committed WAL pages; it does not copy a live SQLite main file. Filesystem media sidecars and R2 content type metadata are part of the object backup. Node restore refuses an existing main database or any `-wal`, `-shm`, or `-journal` sidecar before writing the target.

Fixtures use deterministic local gzip/tar bytes, the repository's two-organization contract fixture, admin bootstrap, password/TOTP setup and reauthentication, guarded personal-token issuance, catalogue lease guards and verified blob writers. The tenancy fixture uses the existing test-only `seedTwoOrganizations` helper; it removes the singleton index in the disposable database to exercise foreign-organization denial. It never changes a real deployment. PAT issuance uses the supported domain service with an authenticated session, CSRF and a mutation fence; management HTTP endpoints are not needed. Local setup and reauthentication share a fixed handler clock, restored after both requests settle; their TOTP steps precede the separate login code. Real timers remain active. All verification requests use shipped auth and registry routes. Sources have no upstream URL or dist URL, so a missing restored object cannot be refetched. Restored runtimes use fresh, empty derived caches. Expected length and digest come from bytes recorded before backup, never from the restored object.

## Build and offline development checks

From the repository root, with dependencies already installed:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm vitest run --project runtime-node src/restore-rehearsal/inventory.test.ts src/restore-rehearsal/restore-rehearsal.test.ts
pnpm vitest run --project runtime-cloudflare src/restore-rehearsal/inventory.test.ts
node packages/runtime-node/dist/restore-rehearsal/run.test.support.js identity
node packages/runtime-node/dist/restore-rehearsal/run.test.support.js node
node packages/runtime-node/src/restore-rehearsal/mutations.mjs node
```

The native Node command executes compiled startup/core/database modules and prints candidate identity, original length/SHA-256, the four happy-path checks, measured restore/start milliseconds, wrong-key refusal and the omitted-blob control. Tests use the normal source aliases; native commands verify the actual successful build. Candidate identity is source revision plus a deterministic hash over production JavaScript under the four core/database/runtime `dist` trees. Rehearsal/test modules are excluded. No bundle is manually edited.

Mutations change only owned rehearsal helpers and restore their original contents in `finally`. A mutation counts only when a behavioral assertion fails; setup/collection/listener failures abort the mutation runner. Run mutations serially, with no concurrent build or test against those helpers.

## Host listener and RC gates

These commands need host listener permission; an EPERM result is NOT RUN, never an acceptance pass:

```sh
pnpm vitest run --project runtime-node src/restore-rehearsal/http.test.ts
pnpm vitest run --project runtime-cloudflare src/restore-rehearsal
node packages/runtime-cloudflare/dist/restore-rehearsal/run.test.support.js
node packages/runtime-node/src/restore-rehearsal/mutations.mjs cloudflare
pnpm vitest run --project runtime-node --project runtime-cloudflare
pnpm check
pnpm bundle
pnpm check:pack
pnpm check:treeshake
pnpm smoke:cloudflare
pnpm smoke:node
```

For final acceptance, use the immutable RC artifact selected by T447, and record its artifact SHA-256 in both reports. Run both native commands from that same successfully built candidate. Set `PB_REHEARSAL_CANDIDATE` to the identity printed by `identity`; the helpers refuse an identity mismatch before restoring. The identity of compiled modules is not interchangeable with a source revision or a bundle hash. Also record the bundle hashes and non-secret runtime configuration. Development evidence against another candidate does not establish RC equivalence.

## Real Cloudflare manual procedure — not executed by the worker

All commands below are MANUAL and need real Cloudflare/R2 credentials. The worker inspected installed Wrangler 4.151.0 help for D1 create/list/export/execute, R2 create/get, queues create/consumer removal, secret bulk/list, deploy/delete and tail. AWS CLI 2.38.1 supplies the S3-compatible object operations. No deployed-account command was run. Have the selected candidate's prebuilt Worker bundle, installed Wrangler/AWS CLI, a Workers Paid account, and scoped Cloudflare and R2 credentials available on the operator host. Do not run dependency installation in the worker.

Use a dedicated test account or reserve the unique resource names below. Do not point this procedure at an existing production Worker, database, queue or bucket. Keep shell tracing disabled. Supply `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, AWS credentials (or `AWS_PROFILE`) and `PB_WORKERS_SUBDOMAIN` through the protected operator environment; never paste their values into a report.

```sh
set -eu
set +x
umask 077
export WRANGLER_SEND_METRICS=false
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}" "${PB_WORKERS_SUBDOMAIN:?}"
export PB_REHEARSAL_CANDIDATE="$(node packages/runtime-node/dist/restore-rehearsal/run.test.support.js identity)"
# This makes an owned temporary directory and prints only its path.
export LAB="$(node packages/runtime-node/dist/restore-rehearsal/run.test.support.js prepare)"
export RUN="pb-rehearsal-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export REHEARSAL_ENTRY="$PWD/packages/runtime-node/dist/restore-rehearsal/run.test.support.js"
export REHEARSAL_R2="$PWD/packages/runtime-node/src/restore-rehearsal/r2-objects.mjs"
export CANDIDATE_WORKER="$PWD/.pb/cloudflare/worker.js"
export CANDIDATE_ASSETS="$PWD/.pb/cloudflare/assets"
export PB_REHEARSAL_R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.eu.r2.cloudflarestorage.com"
node -e 'const fs=require("node:fs"),c=require("node:crypto"); fs.writeFileSync(process.env.LAB+"/worker.sha256",c.createHash("sha256").update(fs.readFileSync(process.env.CANDIDATE_WORKER)).digest("hex")+"\n")'
# Compare worker.sha256 with T447's pinned artifact before provisioning anything.
wrangler whoami
```

`prepare` retains a protected local seed SQL file, a separately stored secret file, scoped object inventory/bytes, a wrong-key file and a verification oracle. This is lab state; it includes the original PAT and TOTP recovery material and must never be printed. For an already seeded disposable account deployment, replace these seed inputs with its own protected secrets/oracle, not secret names from Cloudflare. Secret values cannot be recovered with `wrangler secret list`.

Create source and fresh restore targets. The suffixes also isolate queue and derived cache namespaces. Each D1/R2 creation must succeed; stop on a collision. Queues here have producers only, no consumers or cron triggers; the seeded lease jobs are already completed. Analytics uses a single disposable dataset named from this run.

```sh
for MODE in source happy wrong-key missing-keys missing-blobs corrupt-blobs; do
  export MODE
  wrangler d1 create "$RUN-$MODE" --jurisdiction eu > "$LAB/$MODE-create.txt"
  wrangler r2 bucket create "$RUN-$MODE" --jurisdiction eu
  wrangler queues create "$RUN-$MODE"
  wrangler d1 list --json > "$LAB/d1-list.json"
  node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {LAB,RUN,MODE,CANDIDATE_WORKER,CANDIDATE_ASSETS,PB_WORKERS_SUBDOMAIN}=process.env;
const name=`${RUN}-${MODE}`;
const db=JSON.parse(fs.readFileSync(`${LAB}/d1-list.json`)).find(row=>row.name===name);
assert.ok(db?.uuid);
const base={name,compatibility_date:'2026-10-01',compatibility_flags:['nodejs_compat'],workers_dev:true,
 d1_databases:[{binding:'DB',database_name:name,database_id:db.uuid}],r2_buckets:[{binding:'STORAGE',bucket_name:name,jurisdiction:'eu'}],
 queues:{producers:[{binding:'JOBS',queue:name}]},analytics_engine_datasets:[{binding:'ANALYTICS',dataset:RUN.replaceAll('-','_')}],
 vars:{DEPLOYMENT_ID:name,PB_PUBLIC_URL:`https://${name}.${PB_WORKERS_SUBDOMAIN}.workers.dev`}};
fs.writeFileSync(`${LAB}/${MODE}.jsonc`,JSON.stringify({...base,main:CANDIDATE_WORKER,assets:{binding:'ASSETS',directory:CANDIDATE_ASSETS,run_worker_first:true,html_handling:'none',not_found_handling:'none'}}));
fs.writeFileSync(`${LAB}/${MODE}-maintenance.mjs`,'export default {fetch(){return new Response("Rehearsal maintenance",{status:503})}}');
fs.writeFileSync(`${LAB}/${MODE}-maintenance.jsonc`,JSON.stringify({...base,main:`${LAB}/${MODE}-maintenance.mjs`}));
JS
  # Reserve the fresh Worker with a 503-only script. No secrets have been loaded.
  wrangler deploy --config "$LAB/$MODE-maintenance.jsonc" --no-bundle
  wrangler secret list --config "$LAB/$MODE-maintenance.jsonc" --format json > "$LAB/$MODE-secret-names.json"
  node -e 'const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1])).length)throw Error("secret destination is not empty")' "$LAB/$MODE-secret-names.json"
  node "$REHEARSAL_R2" empty "$LAB" "$RUN-$MODE"
  wrangler d1 execute "$RUN-$MODE" --config "$LAB/$MODE.jsonc" --remote --command "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" --json > "$LAB/$MODE-empty.json"
  node -e 'const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1])).flatMap(x=>x.results||[]).length)throw Error("database destination is not empty")' "$LAB/$MODE-empty.json"
done
```

Seed and verify the **source** through the candidate. Upstream is unavailable by construction: the fixture has no upstream URLs. The source must pass before taking a backup.

```sh
wrangler d1 execute "$RUN-source" --config "$LAB/source.jsonc" --remote --file "$LAB/seed.sql" --yes
node "$REHEARSAL_R2" seed "$LAB/backup" "$RUN-source"
wrangler deploy --config "$LAB/source.jsonc" --no-bundle --secrets-file "$LAB/private/secrets.json"
node "$REHEARSAL_ENTRY" verify "$LAB" "https://$RUN-source.$PB_WORKERS_SUBDOMAIN.workers.dev" happy
```

Quiesce every writer before export: replace the isolated source with maintenance, remove any queue consumers if the chosen configuration added them, remove cron triggers, and wait out in-flight invocations. The generated configuration has neither consumers nor triggers. For a configuration with a consumer, the exact removal command is `wrangler queues consumer worker remove "$RUN-source" "$RUN-source"`; do not run it for a consumer that does not exist. Drain any external producer before this step. Do not back up a fixture with a running lease.

```sh
wrangler deploy --config "$LAB/source-maintenance.jsonc" --no-bundle
sleep 60
wrangler d1 execute "$RUN-source" --config "$LAB/source.jsonc" --remote --command "SELECT count(*) AS active FROM job WHERE state = 'running'" --json > "$LAB/active.json"
node -e 'const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1])).flatMap(x=>x.results||[]).some(x=>x.active!==0))throw Error("writers have not drained")' "$LAB/active.json"
mkdir "$LAB/remote-backup"
wrangler d1 export "$RUN-source" --config "$LAB/source.jsonc" --remote --output "$LAB/remote-backup/database.sql"
# Preserve secret VALUES from the protected original source, including still-used previous key versions.
cp "$LAB/private/secrets.json" "$LAB/remote-backup/secrets.json"
cp "$LAB/source.jsonc" "$LAB/remote-backup/source-config.jsonc"
cp "$LAB/candidate.txt" "$LAB/worker.sha256" "$LAB/remote-backup/"
wrangler d1 execute "$RUN-source" --config "$LAB/source.jsonc" --remote --command "SELECT org_id, sha256, size_bytes, storage_key, media_type FROM blob WHERE deleted_at IS NULL ORDER BY org_id, sha256" --json > "$LAB/remote-backup/references.json"
node "$REHEARSAL_R2" backup "$LAB/remote-backup" "$RUN-source"
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const root=process.env.LAB+'/remote-backup';
const checksums={};
for(const file of fs.readdirSync(root,{recursive:true}).sort())if(fs.statSync(path.join(root,file)).isFile())checksums[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
fs.writeFileSync(path.join(root,'checksums.json'),JSON.stringify(checksums),{mode:0o600});
JS
```

Destroy source resources before restoring. Only these run-specific resources are deleted. Keep the immutable artifact and protected backup until acceptance evidence is archived.

```sh
node "$REHEARSAL_R2" delete "$LAB/remote-backup" "$RUN-source"
wrangler delete "$RUN-source" --config "$LAB/source.jsonc"
wrangler queues delete "$RUN-source"
wrangler r2 bucket delete "$RUN-source" --jurisdiction eu
wrangler d1 delete "$RUN-source" --config "$LAB/source.jsonc" --skip-confirmation
```

Restore to the already checked empty targets, with traffic held at 503 until each restore completes. Recheck empty DB/bucket/secret lists immediately before this loop if anything else could have accessed the reserved resources. Verify the entire backup before writes; restore DB, then keys, then object bytes/metadata. Each scenario gets a fresh Worker/cache namespace, so no source cache can satisfy verification. Record actual duration per scenario.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const root=process.env.LAB+'/remote-backup';
for(const [file,expected] of Object.entries(JSON.parse(fs.readFileSync(root+'/checksums.json'))))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),expected);
JS
for MODE in happy wrong-key missing-keys missing-blobs corrupt-blobs; do
  START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
  wrangler d1 execute "$RUN-$MODE" --config "$LAB/$MODE.jsonc" --remote --file "$LAB/remote-backup/database.sql" --yes
  case "$MODE" in
    wrong-key) SECRET_FILE="$LAB/private/wrong-secrets.json" ;;
    missing-keys) SECRET_FILE='' ;;
    *) SECRET_FILE="$LAB/remote-backup/secrets.json" ;;
  esac
  if [ -n "$SECRET_FILE" ]; then
    wrangler secret bulk "$SECRET_FILE" --config "$LAB/$MODE-maintenance.jsonc"
  fi
  if [ "$MODE" != missing-blobs ]; then
    node "$REHEARSAL_R2" restore "$LAB/remote-backup" "$RUN-$MODE"
    node "$REHEARSAL_R2" check "$LAB/remote-backup" "$RUN-$MODE"
  fi
  if [ "$MODE" = corrupt-blobs ]; then
    node "$REHEARSAL_R2" corrupt "$LAB/remote-backup" "$RUN-$MODE"
    if node "$REHEARSAL_R2" check "$LAB/remote-backup" "$RUN-$MODE"; then exit 1; fi
  fi
  wrangler deploy --config "$LAB/$MODE.jsonc" --no-bundle
  node "$REHEARSAL_ENTRY" verify "$LAB" "https://$RUN-$MODE.$PB_WORKERS_SUBDOMAIN.workers.dev" "$MODE"
  node -e 'console.log(process.argv[1]+" restore/start/verify elapsed_ms="+(Date.now()-Number(process.argv[2])))' "$MODE" "$START_MS"
done
```

The wrong-key and missing-key cases must return 503 even for authenticated dist requests. To observe the T707 error, run `wrangler tail "$RUN-wrong-key" --config "$LAB/wrong-key.jsonc" --format json --search "Master key version 1 does not match"` in a second terminal, trigger the `verify ... wrong-key` command again, and retain only the fixed KernelConfigError name and master-key mismatch/version diagnostic, not raw invocation records. Stop the tail with Ctrl-C. Happy verification requires real password/TOTP login, original PAT acceptance, excluded-project and foreign-organization denial, unauthenticated refusal, exact archive length and the original SHA-256. Missing/corrupt objects must fail that same byte oracle. An error from inventory transport is not evidence of byte corruption; confirm the assertion shows a length/digest mismatch.

The Miniflare wrappers cover missing/truncated/same-length corruption independently, all three non-empty target refusals with preservation checks, stripped keys and mutation proofs. Run those host gates as well; remote success does not replace them. Do not retry a restore over the same target: discard it and reserve new empty resources.

Cleanup only the remaining rehearsal names, after saving sanitized output, hashes and measured timings:

```sh
for MODE in happy wrong-key missing-keys missing-blobs corrupt-blobs; do
  node "$REHEARSAL_R2" delete "$LAB/remote-backup" "$RUN-$MODE"
  wrangler delete "$RUN-$MODE" --config "$LAB/$MODE.jsonc"
  wrangler queues delete "$RUN-$MODE"
  wrangler r2 bucket delete "$RUN-$MODE" --jurisdiction eu
  wrangler d1 delete "$RUN-$MODE" --config "$LAB/$MODE.jsonc" --skip-confirmation
done
# LAB is an owned mkdtemp directory printed by prepare. Retain it until evidence is reviewed.
case "$LAB" in */pb-rehearsal-manual-*) rm -rf -- "$LAB" ;; *) exit 1 ;; esac
```

The disposable Analytics Engine dataset has no per-dataset delete operation in the inspected Wrangler CLI; it receives no application traffic after Worker deletion and expires under account retention. Record its generated name in the report; records remain subject to account retention. For production backups include separately retained filesystem/S3/R2 bytes, all external secrets and referenced master-key versions, consistent DB state and exact deployment configuration/artifact identity; derived caches and in-process execution state are excluded. A bucket binding, secret name, or database path is not a backup of its contents.
