---
title: 'Quickstart: Cloudflare'
sidebar_position: 1
description: Deploy Package Broker on Cloudflare Workers, create your first project and source, and install a private Composer package.
---

Run one broker for your agency on Cloudflare Workers, then install one private Composer package through it. You can evaluate alone with a local administrator account.

## What you need

- Git, Node.js 24 or later, and pnpm 12.5.1. Install these before starting; `.nvmrc` selects Node.js 24.

  <!-- source: package.json:5 -->
  <!-- source: .nvmrc:1 -->

- PHP compatible with your package and Composer 2 on the machine where you will install it. Composer 1 is refused.

  <!-- source: packages/core/src/registry/composer/routes.ts:81 -->

- A Cloudflare account with **Workers Paid**, Queues, R2 and Analytics Engine enabled, and an account Workers subdomain already registered in the dashboard. Setup checks service availability; it does not enable billing or register that subdomain.

  <!-- source: packages/cli/src/commands/cloudflare/api.ts:37 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:85 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:120 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:585 -->

- An account API token scoped to the account you will use. The required account permissions, derived from the endpoints the CLI calls, are **Workers Scripts Edit**, **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit** and **Account Analytics Read**. **Billing Read** is optional. This recipe uses the account Workers address and does not need custom-domain or zone permissions.

  <!-- source: packages/cli/src/commands/cloudflare/api.ts:37 -->
  <!-- source: packages/cli/src/commands/cloudflare/api.ts:300 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:153 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:200 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:1058 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:1152 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:278 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:925 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1451 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1767 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1917 -->

- A private Composer vendor repository containing a package you can install, its credentials, your administrator e-mail address, an authenticator app and a safe place to retain the generated master key.

## Get the code

Run these commands in a terminal on your trusted workstation:

```sh
git clone https://github.com/package-broker/broker.git
cd broker
pnpm install --frozen-lockfile
pnpm build
```

<!-- source: package.json:5 -->
<!-- source: package.json:10 -->
<!-- source: Dockerfile:7 -->
<!-- source: packages/cli/package.json:30 -->

The repository runs its built CLI as `pnpm pb`; a global `pb` installation is unnecessary.

<!-- source: package.json:18 -->

## Deploy the broker

In a Bash terminal with command tracing disabled, set `CLOUDFLARE_ACCOUNT_ID` to the 32-hex account ID from the Cloudflare dashboard. Replace `<account-id>` below with that ID. Run `read`, paste the API token at the hidden prompt and press Enter; the token is neither echoed nor entered in shell history. Do not put it in command arguments or the checkout. Run setup in the same interactive terminal:

```sh
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
read -rs -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
pnpm pb cloudflare setup
unset CLOUDFLARE_API_TOKEN
```

<!-- source: packages/cli/src/commands/cloudflare/api.ts:204 -->
<!-- source: packages/cli/src/cli.ts:578 -->

Answer the prompts below; the prompt text is quoted verbatim:

| Prompt                                                           | Answer for this evaluation                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `workerName:`                                                    | A lowercase slug, such as `broker`.                                                                                             |
| `orgSlug:`                                                       | A lowercase slug, such as `agency`.                                                                                             |
| `orgName:`                                                       | Your organization name.                                                                                                         |
| `adminEmail:`                                                    | Your administrator e-mail address.                                                                                              |
| `Environment [production]:`                                      | Press Enter for `production`.                                                                                                   |
| `Deployment ID [worker-environment]:`                            | Press Enter for the suggested deployment ID.                                                                                    |
| `Jurisdiction [eu/default; default eu]:`                         | Press Enter for `eu`; choose `default` only if that is your intended storage placement.                                         |
| `Optional creation location hint [none]:`                        | Leave blank.                                                                                                                    |
| `Canonical HTTPS origin [workers.dev]:`                          | Leave blank to use the account Workers address.                                                                                 |
| `Optional custom domain [none]:`                                 | Leave blank.                                                                                                                    |
| `Master key delivery [terminal/key-file/env; default terminal]:` | Choose `key-file`.                                                                                                              |
| `Key file outside the checkout:`                                 | An unused absolute path in an existing private directory outside the checkout, such as `<private-directory>/broker-master-key`. |

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:445 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:451 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:471 -->

Setup creates the key file with mode `0600`. Alternatively, `terminal` delivery reveals the key once and asks you to re-enter its last six characters without echoing them. The `env` option prompts `Saved master key environment variable:` and reads an already saved key from that named variable. Retain the key in a secret manager; losing it prevents recovery of encrypted credentials. After verifying that storage, delete the local key file.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:145 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:212 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:475 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:657 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:719 -->

Review the resource plan and type `yes` when asked. Setup builds the Worker, provisions D1, an R2 bucket, a jobs queue and a dead-letter queue, applies migrations, creates the organization, uploads the master key as a Worker secret, deploys the Worker with its UI assets and Analytics Engine binding, runs readiness and unauthenticated registry checks, and issues the first administrator's setup token. It does not yet test an authenticated package install; you do that below.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:485 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:675 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:781 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:205 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:650 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:926 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:605 -->

Success prints a JSON result with `status: "ok"`, `worker_url`, `bootstrap_url`, resource identifiers and smoke checks. The setup token is delivered separately to the terminal, never embedded in the URL. Keep the private `.pb/state/cloudflare` inventory for safe reruns and recovery. If delivery is lost, rerun the same setup with `--refresh-setup-token` to request a replacement; this invalidates the previous unused token and cannot reset an enrolled login.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:815 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:867 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:910 -->

For unattended setup, the CLI also supports `--worker-name`, `--org-slug`, `--org-name`, `--admin-email`, `--non-interactive`, `--yes`, `--key-file` (or `--master-key-env`) and `--token-file`. Noninteractive first setup requires explicit key delivery and a token output file; use distinct unused paths outside the checkout. Preserve the same deployment identity on reruns.

<!-- source: packages/cli/src/cli.ts:172 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:499 -->

Read [Workers fill limits and self-origin aliases](../reference/workers-fill-limits.md) before importing a large catalog or adding a custom domain alongside the account Workers alias; it explains metadata sizing, D1 invocation budgets and the required outbound deny entries.

## First administrator

Open the returned `bootstrap_url` and use the separately delivered setup token to enroll your password and authenticator. The token expires after 24 hours and works once. Follow [Set up the first administrator](../workers-install.md) for the browser steps or the curl alternative, then return here signed in.

<!-- source: packages/cli/src/commands/admin.ts:51 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:876 -->

## First project, source and token

Use the returned `worker_url` as `<broker-origin>`. Open `<broker-origin>/_pb/ui` and sign in as the administrator. Use the scope selector to choose the organization, then open **Projects**. Under **New project**, enter a name and a lowercase slug such as `evaluation`, leave the token policy defaults, and choose **Create project**. Copy the project ID for token creation; `<project>` below means the slug.

<!-- source: packages/ui/src/app.tsx:159 -->
<!-- source: packages/ui/src/pages/projects.tsx:505 -->

1. In organization scope, open **Sources** and create a source with **Add source**, ecosystem **composer**, source type **Composer repository**, a source name and the vendor repository's HTTPS URL, for example `https://vendor.example.com`. Enter the exact private package name in **Package names (one per line)** and set **Sync interval (seconds)**, for example `300`. Leave additional archive hosts empty unless the vendor serves archives from a separate host you trust with its credentials.

   <!-- source: packages/ui/src/pages/sources/source-form.tsx:49 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:65 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:118 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:842 -->

2. Save the source. In **Set credential**, choose `http_basic`, enter the vendor's username and password, and choose **Save credential**. For a vendor that uses bearer authentication, choose `bearer` and enter its token instead. Store vendor credentials here, separately from the broker token Composer will use.

   <!-- source: packages/ui/src/pages/sources.tsx:57 -->
   <!-- source: packages/ui/src/pages/sources.tsx:320 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1313 -->

3. Open **More** and choose **Registered names**. In the **Registered names** dialog, add the same exact package name with **Add name**, then close the dialog. Open **More** and choose **Enable** on the source. The package selection and registered names are separate settings; complete both.

   <!-- source: packages/ui/src/pages/sources.tsx:968 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1015 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1400 -->

4. Still in organization scope, choose **Sync now**, then **Refresh sources** until the source reports a successful sync. Select your project in the scope selector, open **Sources**, find the organization source and choose **Attach**. Open **Packages** in project scope and check for the private package and a version you can install before continuing.

   <!-- source: packages/ui/src/pages/sources.tsx:835 -->
   <!-- source: packages/ui/src/pages/sources.tsx:905 -->
   <!-- source: packages/ui/src/pages/sources.tsx:949 -->

5. Open **Tokens**, select **My personal tokens**, and expand **Issue token**. Enter a name, choose **Read**, choose a lifetime, select **Selected projects**, and paste the project ID into **Selected project IDs (space separated; re-enter when renewing)**. Choose **Issue token**, complete reauthentication if requested, and confirm issuance. Save the complete `pb_pat_` value when it appears; it is shown once. If asked for another authenticator code immediately after setup, wait for the next code.

   <!-- source: packages/ui/src/pages/tokens.tsx:815 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:851 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:920 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:973 -->
   <!-- source: scripts/docker-smoke.mjs:724 -->

## Install a private package

If you do not have an application yet, create an empty directory outside the broker checkout, open a terminal there, and use a local editor to create `composer.json` containing:

```json
{
  "name": "evaluation/application"
}
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:553 -->

In your application's directory containing `composer.json`, replace `<broker-host>` with the broker host, including any port, `<project>` with your project slug, and `<vendor>/<package>` and `<version>` with the package and version you just checked. Vendor repositories must also supply any private dependencies you need; Packagist remains available for public packages.

```sh
composer config repositories.broker composer 'https://<broker-host>/<project>'
```

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/core/src/registry/composer/routes.ts:75 -->

Add `auth.json` to your application's `.gitignore`. With a private local editor, create `auth.json` beside `composer.json`, replacing `<personal-token>` with the complete `pb_pat_` token. Use the literal username `token` and key credentials by host and port, without the project path. Keep the file private and out of version control.

```json
{
  "http-basic": {
    "<broker-host>": {
      "username": "token",
      "password": "<personal-token>"
    }
  }
}
```

<!-- source: packages/core/src/auth/client-matrix.test.ts:70 -->

Add the package, then verify an install from the resulting lock file:

```sh
composer require '<vendor>/<package>:<version>' --no-plugins --no-scripts
composer install --no-plugins --no-scripts
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:570 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->

Check that `composer.lock` contains the private package and a distribution URL on your broker. These commands suppress package plugins and scripts; review your application's requirements before enabling them. For existing lock files and repository priority, follow the [Composer guide](../clients/composer.md). For JavaScript packages, see [npm, pnpm and yarn](../clients/npm-pnpm-yarn.md); for automated installs, use [GitHub Actions service tokens](../ci/github-actions.md).

<!-- source: packages/core/src/registry/composer/render.ts:94 -->

## Sign-in for a team

Team sign-in uses Cloudflare Access or an OpenID Connect provider such as Dex; grants to the provider's groups give users project access. Evaluating alone needs no identity provider: use the local administrator login. See the [access model](../reference/access-model.md) for group grants and token boundaries.

<!-- source: packages/core/src/identity/port.ts:131 -->
<!-- source: packages/core/src/identity/providers.test.ts:26 -->
<!-- source: docs/reference/access-model.md:31 -->

## Next steps

Plan [backups and upgrades](../operations/backup-and-upgrades.md), review [security and data residency](../security-and-residency.md), or migrate from [Private Packagist](../migration/from-private-packagist.md), [Satis](../migration/from-satis.md) or [Packeton](../migration/from-packeton.md).
