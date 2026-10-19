---
title: 'Quickstart: Cloudflare'
sidebar_position: 1
description: Deploy Package Broker on Cloudflare Workers with D1 and R2.
---

This page takes you from a source checkout to a Worker backed by D1, R2 and Queues, with a signed-in administrator. Package Broker 2.0 has no tagged release yet, so you build from the repository.

The 2.0 line is a pre-release. Composer and npm registry routes, projects and tokens are not served yet; after this quickstart you can sign in and nothing more.

## Prerequisites

- A Cloudflare account on the Workers Paid plan. The broker uses Queues.
- Wrangler, logged in to that account (`npx wrangler login`).
- Node 24 or newer and pnpm, through `corepack enable`.
- The account ID and an API token with the D1 Edit permission. The `pb cloudflare` and `pb admin --cloudflare` commands call the D1 HTTP API with them.
- An authenticator app that reads `otpauth://` URIs.

## 1. Build

```sh
git clone https://github.com/package-broker/broker.git
cd broker
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm pb build --config broker.config.ts --target cloudflare
```

`pb build` writes the Worker to `.pb/cloudflare/worker.js` and the migrations to `.pb/cloudflare/migrations/`.

## 2. Create the resources

The names below are examples. Use your own and keep them consistent with the next step.

```sh
npx wrangler d1 create pb-db --jurisdiction eu
npx wrangler r2 bucket create pb-blobs --jurisdiction eu
npx wrangler queues create pb-jobs
npx wrangler queues create pb-jobs-dlq
```

Note the database ID that `d1 create` prints. The jurisdiction is fixed when a database or bucket is created. It covers D1 and R2 only, not Workers, the Cache API, Queues, logs or Analytics Engine.

## 3. Fill in `wrangler.toml`

`packages/runtime-cloudflare/wrangler.toml` is a template with every block commented out. Uncomment the blocks and replace the placeholders. The binding names (`DB`, `STORAGE`, `JOBS`, `ANALYTICS`) and `DEPLOYMENT_ID` must stay as they are, because `broker.config.ts` and the runtime read them. Add `database_id` and `PB_PUBLIC_URL` yourself:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pb-db"
database_id = "<id from d1 create>"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "pb-blobs"
jurisdiction = "eu"

[[queues.producers]]
binding = "JOBS"
queue = "pb-jobs"

[[queues.consumers]]
queue = "pb-jobs"
max_batch_size = 1
max_batch_timeout = 1
max_retries = 4
max_concurrency = 2
dead_letter_queue = "pb-jobs-dlq"

[triggers]
crons = ["* * * * *"]

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "pb_metrics"

[vars]
DEPLOYMENT_ID = "pb"
PB_PUBLIC_URL = "https://package-broker.<your-subdomain>.workers.dev"

[observability]
enabled = true

[observability.logs]
invocation_logs = false
```

The template puts `invocation_logs` directly under `[observability]`; Wrangler 4 warns about that, so the example above nests it under `[observability.logs]`.

`PB_PUBLIC_URL` is the origin users and clients reach the Worker at: the `workers.dev` URL or a custom domain. On Workers it must be `https`, without a path. The `workers.dev` URL is `https://<worker name>.<account subdomain>.workers.dev`; the account subdomain is shown in the Cloudflare dashboard under Workers & Pages, and `wrangler deploy` prints the full URL. If the value is wrong, correct it and deploy again. The `[assets]` block serves the web interface, which is still a placeholder; you can leave it commented out.

## 4. Apply migrations and create the organization

From the repository root. `read -rs` waits for you to paste the API token without echoing it, so it stays out of shell history:

```sh
export CLOUDFLARE_ACCOUNT_ID=<32-character account id>
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
pnpm pb cloudflare migrate --database-id <database id>
pnpm pb cloudflare bootstrap --database-id <database id> --slug acme --name "Acme"
```

The Worker does not migrate on its own. Run `pb cloudflare migrate` with the build you deploy, every time you deploy a new build. `pb cloudflare bootstrap` is safe to run again with the same slug.

## 5. Deploy and set the master key

```sh
mkdir -p "$HOME/pb-data"
chmod 700 "$HOME/pb-data"
pnpm pb secrets generate-master-key > "$HOME/pb-data/master.key"
chmod 600 "$HOME/pb-data/master.key"
cd packages/runtime-cloudflare
npx wrangler deploy
tr -d '\n' < "$HOME/pb-data/master.key" | npx wrangler secret put PB_MASTER_KEY
cd ../..
```

The key file stays outside the checkout. Between `wrangler deploy` and `wrangler secret put` the Worker has no master key, and every request to it fails; the secret takes effect as soon as `secret put` finishes. Keep a copy of the master key in a secret manager. Local passwords are peppered with a key derived from it, so losing it locks every local account out.

Check readiness:

```sh
curl https://package-broker.<your-subdomain>.workers.dev/health/ready
```

The answer is `{"status":"ready"}` once D1 is reachable and the organization exists.

## 6. Create the first administrator

From the repository root, with the same two variables exported:

```sh
pnpm pb admin bootstrap --email admin@example.test --cloudflare --database-id <database id> --token-file "$HOME/pb-data/setup-token"
```

Then set the password and TOTP and sign in with the requests in [Quickstart: Node](quickstart-node.md#5-set-the-password-and-totp), replacing `http://127.0.0.1:8787` with your `PB_PUBLIC_URL` in both the URL and the `Origin` header.

## Exit code 6 or 7

If the D1 HTTP API accepts a request but the answer is lost, `pb cloudflare migrate` and `pb cloudflare bootstrap` exit with 6 and `pb admin bootstrap` with 7. The change may have been applied. Run the same command again; all three are safe to repeat. See the [pb CLI reference](../reference/cli.md).
