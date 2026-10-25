---
title: 'Quickstart: Cloudflare'
sidebar_position: 1
description: Deploy Package Broker on Cloudflare Workers and install a Composer package.
---

Deploy a broker, create an administrator and a project, then install `composer/semver` through that project's Packagist proxy. This tutorial builds from a source checkout; the README currently identifies 2.0 as a pre-release with no tagged release. <!-- source: README.md:5 -->

## Prerequisites

- Node 24 and pnpm. Enable pnpm with `corepack enable`; the repository pins its version in `package.json`. <!-- source: README.md:9 -->
- A Cloudflare account on the **Workers Paid plan**. The Worker needs `nodejs_compat`; the deployment command supplies it. See [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). <!-- source: README.md:10 --> <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:42 --> <!-- verify: Confirm current Workers Paid pricing and account capabilities against Cloudflare before the hosted run. -->
- R2 enabled, Queues and Analytics Engine available, and a registered `workers.dev` subdomain. Load `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` into your operator environment. The token must be able to provision and inspect these resources, query D1, and upload and deploy Workers. <!-- source: packages/cli/src/commands/cloudflare/provision.ts:100 --> <!-- source: packages/cli/src/commands/cloudflare/api.ts:204 --> <!-- source: packages/cli/src/commands/cloudflare/api.ts:66 --> <!-- verify: Confirm the exact Cloudflare dashboard permission names and least required token grants for this command sequence on the Mac. -->
- A checkout of this repository, a POSIX shell, a browser, and an authenticator app. Use a private terminal with shell tracing disabled for credential setup. <!-- source: packages/ui/src/setup.tsx:406 -->
- Composer 2 and PHP on the machine where you will install the test package. <!-- source: scripts/docker-smoke.mjs:811 --> <!-- verify: Record Composer/PHP versions and required PHP extensions during the fresh-machine run; validate composer/semver 3.4.3 against live Packagist. -->

Review [what you operate](#what-you-operate) before creating resources. Run the following commands from the repository root, in the same shell. Replace quoted angle-bracket placeholders with your values; never put credential values into command history or a run log.

## 1. Build the Worker

<!-- source: README.md:9 -->
<!-- source: README.md:38 -->
<!-- source: README.md:48 -->
<!-- source: package.json:16 -->

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm pb build --config broker.config.ts --target cloudflare
```

Expected result (files, rather than terminal output):

<!-- source: packages/cli/src/build.ts:257 -->
<!-- source: packages/cli/src/build.ts:307 -->
<!-- source: packages/cli/src/build.ts:325 -->
<!-- source: README.md:55 -->

```text
.pb/cloudflare/worker.js
.pb/cloudflare/build-info.json
.pb/cloudflare/migrations/
.pb/cloudflare/assets/
```

## 2. Provision Cloudflare resources

Use a new Worker name for this tutorial. Keep `pb-tutorial` the same in every command. Provisioning creates resources that incur charges on your Cloudflare account.

<!-- source: packages/cli/src/cli.ts:32 -->
<!-- source: packages/cli/src/commands/cloudflare/api.ts:204 -->

```sh
: "${CLOUDFLARE_ACCOUNT_ID:?Load the account ID first}"
: "${CLOUDFLARE_API_TOKEN:?Load the API token first}"
pnpm pb cloudflare provision --worker-name pb-tutorial --yes --json
```

Expected output, selected fields only; IDs vary:

<!-- source: packages/cli/src/commands/cloudflare/provision.ts:655 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:1186 -->

```json
{
  "command": "provision",
  "status": "ok",
  "database_id": "<database-id>",
  "r2_bucket": "<bucket-id>",
  "queue_names": ["<jobs-queue>", "<dead-letter-queue>"]
}
```

Keep the returned `database_id` for the bootstrap commands. Keep the private inventory under `.pb/state/cloudflare/`; subsequent commands use it to identify this installation. If provisioning reports `outcome_unknown`, retain the inventory and inspect the reported state before repeating a create. <!-- source: packages/cli/src/commands/cloudflare/inventory.ts:915 --> <!-- source: packages/cli/src/commands/cloudflare/api.ts:58 -->

## 3. Apply migrations and create the organization

<!-- source: packages/cli/src/cli.ts:222 -->
<!-- source: packages/cli/src/cli.ts:38 -->

```sh
pnpm pb cloudflare migrate --worker-name pb-tutorial --json
pnpm pb cloudflare bootstrap --database-id '<database-id>' --slug tutorial --name Tutorial
```

Expected output, selected fields from the two responses:

<!-- source: packages/cli/src/commands/cloudflare.ts:194 -->
<!-- source: packages/cli/src/commands/cloudflare.ts:505 -->
<!-- source: packages/db-sqlite/src/repositories/organization.ts:161 -->

```text
migrate: {"status":"ok","pending_migrations":[]}
bootstrap: {"created":true,"slug":"tutorial"}
```

The lines above are summaries, not literal CLI lines. The migration response also lists applied migrations. A successful repeat of bootstrap for the same organization returns `created: false`. <!-- source: packages/db-sqlite/src/repositories/organization.ts:167 -->

## 4. Create the master key and deploy

Create a private directory outside the checkout. Generate the master key once and retain it for recovery. The subshell refuses to overwrite an existing key file. Back up this file privately before continuing.

<!-- source: packages/cli/src/cli.ts:39 -->
<!-- source: packages/cli/src/commands/admin.ts:68 -->
<!-- verify: Run the POSIX shell key-file creation and environment-loading recipe on the Mac; confirm no key reaches recorded output. -->

```sh
set +x
umask 077
private_dir="$HOME/.package-broker-quickstart"
mkdir -p "$private_dir"
chmod 700 "$private_dir"
(set -C; pnpm --silent pb secrets generate-master-key > "$private_dir/master.key")
export PB_MASTER_KEY="$(cat "$private_dir/master.key")"
pnpm pb cloudflare deploy --worker-name pb-tutorial --secret PB_MASTER_KEY --json
unset PB_MASTER_KEY
```

<!-- source: packages/cli/src/cli.ts:33 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1475 -->

Expected output, selected fields only:

<!-- source: packages/cli/src/commands/cloudflare/api.ts:121 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1220 -->

```json
{
  "command": "deploy",
  "status": "ok",
  "worker_url": "https://pb-tutorial.<account-subdomain>.workers.dev"
}
```

Use the returned `worker_url` as your broker address. The command sets `PB_PUBLIC_URL` to that origin and disables preview endpoints. <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:687 --> <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1413 -->

## 5. Create the administrator

Use your administrator e-mail address. The command grants the organization admin role and writes a one-time setup token to a private file. It must be a new file. <!-- source: packages/cli/src/commands/admin.ts:145 --> <!-- source: packages/cli/src/commands/admin.ts:345 -->

<!-- source: packages/cli/src/cli.ts:40 -->

```sh
pnpm pb admin bootstrap --cloudflare --database-id '<database-id>' \
  --email '<administrator-email>' --token-file "$private_dir/admin-setup.token"
```

Expected output, selected fields only; no token is printed:

<!-- source: packages/cli/src/commands/admin.ts:360 -->

```json
{ "setupToken": null, "tokenFile": "<private-directory>/admin-setup.token" }
```

Open `<broker-address>/_pb/ui/setup`. Read the token file in a private local editor and paste the token into the form. Scan the QR code with your authenticator, choose and confirm a password, and enter the current six digit code. Select **Open Package Broker** after setup finishes. The setup token expires after 24 h. <!-- source: packages/cli/src/commands/admin.ts:51 --> <!-- source: packages/ui/src/setup.tsx:379 --> <!-- source: packages/ui/src/setup.tsx:416 --> <!-- source: packages/ui/src/setup.tsx:505 -->

Expected browser result:

<!-- source: packages/ui/src/setup.tsx:513 -->

```text
Setup complete
Your administrator account is ready and you are signed in.
```

For setup recovery or a terminal-only enrollment, see [Set up the first administrator](../workers-install.md).

## 6. Create a project and attach a Packagist proxy

In **Projects**, expand **New project**. Enter project name `Tutorial` and slug `quickstart`, keep **Maximum token scope** at `read`, and select **Create project**. Copy the project ID from the project list for the next step. <!-- source: packages/ui/src/pages/projects.tsx:364 --> <!-- source: packages/ui/src/pages/projects.tsx:498 --> <!-- source: packages/ui/src/pages/projects.tsx:437 -->

Choose the `quickstart` project in the top scope selector and open **Sources**. Select **Add source**, keep ecosystem **Composer**, choose **Packagist proxy**, and name it `Packagist`. Keep the other defaults and select **Add source**. Select **Attach** on its row if it is not attached. This proxy reads public packages on demand; it needs no source credential. <!-- source: packages/ui/src/app.tsx:168 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:40 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:56 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:839 --> <!-- source: packages/ui/src/pages/sources.tsx:1288 -->

Expected result in the source list:

<!-- source: packages/ui/src/pages/sources.tsx:1238 -->

```text
Packagist
Composer · Packagist proxy
Attached to this project
```

## 7. Issue a read token

In **Tokens**, select **My personal tokens**, expand **Issue token**, and enter name `tutorial-install`. Choose scope **Read**, keep the offered default lifetime, choose **Selected projects**, and enter the project ID copied in step 6. Select **Issue token**, complete reauthentication if requested, and select **Confirm token issue** if that confirmation appears. Copy the token into a private local editor. You cannot see it again after closing the secret panel. <!-- source: packages/ui/src/pages/tokens.tsx:807 --> <!-- source: packages/ui/src/pages/tokens.tsx:918 --> <!-- source: packages/ui/src/pages/tokens.tsx:1013 --> <!-- source: packages/ui/src/pages/tokens.tsx:200 --> <!-- source: packages/ui/src/pages/tokens.tsx:842 -->

Expected browser result (the secret value is omitted):

<!-- source: packages/ui/src/pages/tokens.tsx:867 -->

```text
Copy token
Close secret panel
```

## 8. Verify the deployment

<!-- source: packages/cli/src/cli.ts:34 -->

```sh
pnpm pb cloudflare smoke --worker-name pb-tutorial --project quickstart --json
```

Expected output, selected fields:

<!-- source: packages/cli/src/commands/cloudflare/api.ts:121 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:696 -->

```json
{ "command": "smoke", "status": "ok", "error": null }
```

Without a smoke token this checks readiness and rejection of unauthenticated Composer and npm requests. The install below verifies authenticated Composer access. On a first-deployment smoke failure there is no earlier version to restore; retain the resources and inspect the named checks. <!-- source: packages/cli/src/commands/cloudflare/smoke.ts:408 --> <!-- source: packages/cli/src/commands/cloudflare/api.ts:74 -->

<!-- verify: Complete provision, migrate, deploy, smoke and browser setup against hosted Cloudflare; record a fresh-machine run log with date, OS, tool versions and wall-clock time. -->

## 9. Install the test package

Create an empty directory outside the broker checkout and save this as `composer.json`, replacing `<broker-address>` with the returned HTTPS origin, without a trailing slash. Disabling Composer's default Packagist repository ensures the install uses your project.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:3 -->
<!-- source: scripts/docker-smoke.mjs:788 -->
<!-- source: packages/core/src/sources/git/fixtures/github-semver-41-refs.json:6 -->
<!-- source: packages/core/src/sources/git/fixtures/github-semver-41-refs.json:153 -->

```json
{
  "name": "tutorial/install",
  "require": { "composer/semver": "3.4.3" },
  "repositories": [
    { "type": "composer", "url": "<broker-address>/quickstart" },
    { "packagist.org": false }
  ]
}
```

In that directory, create `auth.json` in your private editor. Replace `<broker-hostname>` with the hostname only and `<read-token>` with the token from step 7. Keep this file out of version control and run logs; never put the token in the repository URL. <!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->

```json
{ "bearer": { "<broker-hostname>": "<read-token>" } }
```

Run in the install directory:

<!-- source: packages/e2e/src/registry.spec.ts:930 -->
<!-- source: scripts/docker-smoke.mjs:837 -->
<!-- verify: Validate the Composer bearer-auth recipe, live package download and output excerpt on the Mac with the new Workers project. -->

```sh
chmod 600 auth.json
composer install
```

Expected success excerpt; progress formatting varies by Composer version:

```text
Installing composer/semver (3.4.3)
Generating autoload files
```

Confirm that `composer.lock` and `vendor/composer/semver/` exist. If an initial metadata fill returns 503, wait for the response's `Retry-After` interval and rerun the install; do not add a direct Packagist fallback. <!-- source: packages/core/src/registry/composer/routes.ts:65 -->

## What you operate

You own the Cloudflare account and billing, API token, saved master key, private installation inventory, deployed configuration, data backups and restore checks. Preserve D1 data, R2 objects and the matching key together. See [Restore rehearsal](../operations/restore-rehearsal.md) for recovery checks and [Workers fill limits and self-origin aliases](../reference/workers-fill-limits.md) before adding a custom domain. <!-- source: broker.config.ts:10 --> <!-- source: packages/cli/src/commands/cloudflare/inventory.ts:915 --> <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1488 -->

Continue with [Composer client setup](../clients/composer.md) or the [Docker quickstart](quickstart-docker.md).
