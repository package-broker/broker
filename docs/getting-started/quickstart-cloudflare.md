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
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:871 -->

- An account API token scoped to the account you will use. The required account permissions, derived from the endpoints the CLI calls, are **Workers Scripts Edit**, **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit** and **Account Analytics Read**. **Billing Read** is optional. This recipe uses the account Workers address and does not need custom-domain or zone permissions.

  <!-- source: packages/cli/src/commands/cloudflare/api.ts:37 -->
  <!-- source: packages/cli/src/commands/cloudflare/api.ts:300 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:153 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:200 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:1058 -->
  <!-- source: packages/cli/src/commands/cloudflare/provision.ts:1152 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:558 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1194 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1793 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:2218 -->
  <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:2380 -->

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

Local sign-in is enabled by default. To start with SSO only, configure the provider and its secrets before setup, and add `--local-auth disabled`. The administrator domain must be verified and authoritative at that provider; Cloudflare Access also requires explicit e-mail verification trust. Follow [local sign-in policy and SSO bootstrap](../reference/authentication.md#first-administrator-through-sso) before choosing this mode.

Setup creates the key file with mode `0600`. Alternatively, `terminal` delivery reveals the key once and asks you to re-enter its last six characters without echoing them. The `env` option prompts `Saved master key environment variable:` and reads an already saved key from that named variable. Retain the key in a secret manager; losing it prevents recovery of encrypted credentials. After verifying that storage, delete the local key file.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:145 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:212 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:475 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:657 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:719 -->

Review the resource plan and type `yes` when asked. Setup builds the Worker, provisions D1, an R2 bucket, a jobs queue and a dead-letter queue, applies migrations, creates the organization, uploads the master key as a Worker secret, deploys the Worker with its UI assets and Analytics Engine binding, runs readiness and unauthenticated registry checks, and provisions the first administrator. With local sign-in enabled it issues a setup token; with local sign-in disabled it provisions an SSO administrator grant before deploying and issues no token. It does not yet test an authenticated package install; you do that below.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:485 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:675 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:781 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:205 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:650 -->
<!-- source: packages/cli/src/commands/cloudflare/provision.ts:926 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:605 -->

Success prints a JSON result with `status: "ok"`, `worker_url`, resource identifiers and smoke checks. Local enrollment returns `bootstrap_url`; SSO-only setup returns `login_url` ending in `/_pb/ui/#/login`. When issued, the local setup token is delivered separately to the terminal, never embedded in the URL. Keep the private `.pb/state/cloudflare` inventory for safe reruns and recovery. If local setup token delivery is lost, rerun the same setup with `--refresh-setup-token` to request a replacement; this invalidates the previous unused token and cannot reset an enrolled login.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:815 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:867 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:910 -->

For unattended setup, the CLI also supports `--worker-name`, `--org-slug`, `--org-name`, `--admin-email`, `--non-interactive`, `--yes`, `--key-file` (or `--master-key-env`) and `--token-file`. Noninteractive first setup requires explicit key delivery and, when local sign-in is enabled, a token output file; use distinct unused paths outside the checkout. Preserve the same deployment identity on reruns.

<!-- source: packages/cli/src/cli.ts:172 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:499 -->

Read [Workers fill limits and self-origin aliases](../reference/workers-fill-limits.md) before importing a large catalog or adding a custom domain alongside the account Workers alias; it explains metadata sizing, D1 invocation budgets and the required outbound deny entries.

### Custom domain

To use a custom hostname, its Cloudflare zone must be active in the same account as the Worker. In addition to the account permissions above, the API token needs **Zone Read**, **Workers Routes Edit** and **DNS Edit**, scoped to that zone.

When running setup above, add `--domain packages.example.com --public-url https://packages.example.com`, replacing both example hostnames with yours. `--domain` binds the hostname to the Worker; `--public-url` sets the canonical HTTPS origin used by the broker. Use the same hostname for both options.

If setup reports `domain_zone_not_found`, check the hostname, activate its zone in the selected account and ensure the token has access to that zone with the permissions above. If it reports `domain_zone_ambiguous`, resolve the duplicate matching zones in that account so exactly one active zone matches the hostname, then retry.

## First administrator

If you chose `--local-auth disabled`, open the returned `login_url` (`<broker-origin>/_pb/ui/#/login`) and sign in through the configured provider as the provisioned administrator. There is no setup token. Keep the same CLI release for reruns with `sso_*` inventory states.

With the default local sign-in mode, open the returned `bootstrap_url` and use the separately delivered setup token to enroll your password and authenticator. The token expires after 24 hours and works once. Follow [Set up the first administrator](../workers-install.md) for the browser steps or the curl alternative, then return here signed in.

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

## Verify the deployment

Run a separate smoke check from the broker checkout after creating the project; smoke reads the inventory under `.pb/state/cloudflare` in the current directory. In the same Bash terminal, replace `<worker-name>` with the name you chose during setup and `<project>` with your project slug. Load the Cloudflare API token again at the hidden prompt; `CLOUDFLARE_ACCOUNT_ID` must still identify the same account. In a new terminal, re-export `CLOUDFLARE_ACCOUNT_ID` with that account ID before running the check.

```sh
read -rs -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
pnpm pb cloudflare smoke --worker-name '<worker-name>' --project '<project>' --json
unset CLOUDFLARE_API_TOKEN
```

<!-- source: packages/cli/src/cli.ts:41 -->
<!-- source: packages/cli/src/commands/cloudflare/api.ts:148 -->

Expected output, selected fields:

```json
{ "command": "smoke", "status": "ok", "error": null }
```

Without `PB_SMOKE_TOKEN`, this checks readiness and rejection of unauthenticated Composer and npm requests. The install below verifies authenticated Composer access. On a later deployment, a failed smoke rolls the Worker back to the previous version unless `--no-rollback` is passed. On a first-deployment smoke failure there is no earlier version to restore; retain the resources and inspect the reported checks.

<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:416 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:462 -->
<!-- source: packages/cli/src/commands/cloudflare/smoke.ts:724 -->

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
chmod 600 auth.json
composer require '<vendor>/<package>:<version>' --no-plugins --no-scripts
composer install --no-plugins --no-scripts
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:570 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->

Check that `composer.lock` contains the private package and a distribution URL on your broker. These commands suppress package plugins and scripts; review your application's requirements before enabling them. For existing lock files and repository priority, follow the [Composer guide](../clients/composer.md). For JavaScript packages, see [npm, pnpm and yarn](../clients/npm-pnpm-yarn.md); for automated installs, use [GitHub Actions service tokens](../ci/github-actions.md).

<!-- source: packages/core/src/registry/composer/render.ts:94 -->

If an initial metadata fill returns 503, wait for the response's `Retry-After` interval and repeat the failed Composer command. Keep the broker repository configured so the private package still comes through it.

<!-- source: packages/core/src/registry/composer/routes.ts:63 -->

## Sign-in for a team

Team sign-in uses Cloudflare Access or an OpenID Connect provider such as Dex; grants to the provider's groups give users project access. Evaluating alone needs no identity provider: use the local administrator login. See the [access model](../reference/access-model.md) for group grants and token boundaries.

<!-- source: packages/core/src/identity/port.ts:131 -->
<!-- source: packages/core/src/identity/providers.test.ts:26 -->
<!-- source: docs/reference/access-model.md:31 -->

## Add single sign-on

The release build and the prebuilt Cloudflare distribution read OpenID Connect and Cloudflare Access providers from a providers file at deploy time, so adding single sign-on needs no rebuild. This example adds one OpenID Connect provider with the `id` `corp`.

<!-- source: broker.config.ts:7 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:117 -->

1. At your identity provider, register a client for the broker with the redirect URI `<broker-origin>/_pb/auth/sso/corp/callback`, where `<broker-origin>` is the `worker_url` from setup, or your `--public-url`. The provider must report the e-mail address as verified. Note the client ID and client secret.

   <!-- source: packages/core/src/auth/routes-sso.ts:299 -->
   <!-- source: packages/plugin-sso-oidc/src/oidc.ts:649 -->

2. In the broker checkout, create `providers.json`. Replace the issuer, client ID and domain with yours. The file holds no secret; keep it under version control or in your own backup, because the database backup does not contain it.

   ```json
   [
     {
       "id": "corp",
       "kind": "oidc",
       "displayName": "Corporate SSO",
       "issuer": "https://idp.example.test",
       "clientId": "package-broker",
       "policy": {
         "verifiedDomains": ["example.test"],
         "autoJoin": true,
         "emailAuthoritativeDomains": ["example.test"]
       }
     }
   ]
   ```

   `autoJoin: true` creates a user at the first sign-in for any verified e-mail address in `verifiedDomains`. `emailAuthoritativeDomains` lets an existing account with the same e-mail address, such as the administrator created by setup, be linked at its first sign-in through the provider; without it that sign-in is refused. List a domain there only when the provider alone controls the addresses in it. The fields are described in [Authentication and sessions](../reference/authentication.md#single-sign-on).

   <!-- source: packages/core/src/auth/identity-login.ts:230 -->
   <!-- source: packages/core/src/auth/identity-login.ts:266 -->

3. Load the Cloudflare API token and the client secret at hidden prompts. The client secret goes to `PB_IDP_CORP_CLIENT_SECRET`: `PB_IDP_`, the provider `id` in uppercase with `-` replaced by `_`, then `_CLIENT_SECRET`. `CLOUDFLARE_ACCOUNT_ID` must still identify the same account. Check the deploy with `--dry-run` first:

   ```sh
   read -rs -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
   printf '\n'
   read -rs -p 'Client secret: ' PB_IDP_CORP_CLIENT_SECRET
   printf '\n'
   export CLOUDFLARE_API_TOKEN PB_IDP_CORP_CLIENT_SECRET
   pnpm pb cloudflare deploy --worker-name '<worker-name>' \
     --providers providers.json --secret PB_IDP_CORP_CLIENT_SECRET --dry-run --json
   ```

   <!-- source: packages/core/src/identity/secret-name.ts:16 -->
   <!-- source: packages/cli/src/cli.ts:41 -->
   <!-- source: packages/cli/src/cli.ts:234 -->
   <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1918 -->

   The `identity` section of the result lists `corp` under `providers` with `"source": "runtime"`. The section shows no secret, issuer or trust anchor. An invalid entry refuses the command and names its rejection codes; a missing client secret refuses it and names the secret.

   <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:255 -->
   <!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:71 -->
   <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1906 -->

4. Run the same command without `--dry-run`, then clear the variables:

   ```sh
   pnpm pb cloudflare deploy --worker-name '<worker-name>' \
     --providers providers.json --secret PB_IDP_CORP_CLIENT_SECRET --json
   unset CLOUDFLARE_API_TOKEN PB_IDP_CORP_CLIENT_SECRET
   ```

   Deploy uploads the providers file as the plain-text Worker variable `PB_IDP_PROVIDERS` and the client secret as a Worker secret.

   <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1877 -->
   <!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1919 -->

5. Open `<broker-origin>/_pb/ui` in a private browser window and choose **Sign in with Corporate SSO**.

   <!-- source: packages/ui/src/auth.tsx:603 -->

If you ran setup with `--prebuilt`, add `--prebuilt` to both deploy commands. If your account is on Workers Paid and deploy reports that the Worker environment variable count exceeds 64, add `--workers-paid` to raise the limit to 128.

<!-- source: packages/cli/src/commands/cloudflare/setup.ts:502 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1929 -->

To change a provider later, edit the file and deploy it again with `--providers providers.json`; add `--secret` only for a new or changed client secret. A deploy without `--providers` keeps the live providers, and `--providers none` removes them. For limits, partial rollouts, removing a provider, moving it to a new issuer with `pb admin rebind-provider` and recovery, see [Runtime SSO providers](../reference/runtime-sso-providers.md).

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:137 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:136 -->

## Change local sign-in policy

After verifying SSO in a private browser window, disable new local sign-ins with:

```sh
pnpm pb cloudflare deploy --worker-name '<worker-name>' --local-auth disabled --rollout 100 --json
```

Add `--prebuilt` if that is how you installed. Deploy preserves the live mode when the setting is omitted. `PB_AUTH_LOCAL=enabled|disabled` is also accepted, but re-enabling always needs `--local-auth enabled`, explicitly repeated on resume, reinstall from an old journal, and a second deploy before smoke passes. Conflicting flag and environment values are refused. The managed plain-text Worker binding uses one variable slot. A successful deployment is required to apply a change.

Disabling retains existing local and SSO sessions until their normal expiry (12 hours maximum, or 1 hour idle); local reauthentication stops, with existing freshness lasting at most 10 minutes. PATs and service tokens keep working. Keep SSO provider secrets available and test an administrator action after sign-in.

Use matching CLI and runtime releases. An artifact without the runtime `packageBroker.localAuth: 1` capability marker cannot disable local sign-in. Finish a frozen deployment started before the upgrade with the previous release's CLI, then deploy again. The first rebuilt deploy after upgrading records provider trust policy as an SSO change and requires `--rollout 100`.

If active versions disagree on local sign-in mode, deploy refuses the split. Restore one known version to 100% through Cloudflare's deployment controls, then retry the full deployment. The early restrictive guard can turn off `workers.dev` before a later refusal; a successful deploy restores the intended exposure. See [refusals and recovery](../reference/authentication.md#deployment-refusals-and-recovery) for configuration errors, bootstrap warnings and recovery steps.

## What you operate

You own the Cloudflare account and billing, API token, saved master key, private installation inventory, deployed configuration, backups and restore checks. Preserve D1 data, R2 objects and the matching key together. Follow [Restore rehearsal](../operations/restore-rehearsal.md) to check recovery.

<!-- source: docs/operations/restore-rehearsal.md:1 -->

## Next steps

Plan [backups and upgrades](../operations/backup-and-upgrades.md), review [security and data residency](../security-and-residency.md), or migrate from [Private Packagist](../migration/from-private-packagist.md), [Satis](../migration/from-satis.md) or [Packeton](../migration/from-packeton.md).
