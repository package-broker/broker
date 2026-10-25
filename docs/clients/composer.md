---
title: Composer
sidebar_position: 1
description: Configure Composer to use Package Broker.
---

import TokenKinds from '../reference/_token-kinds.md';

Install Composer packages through a project URL. Use these steps in the directory containing your Magento, Symfony or Laravel application's `composer.json`.

## Prerequisites

You need Composer 2, a running broker, a project with packages available from a source, and a token that can read those packages. Composer 1 is rejected. Replace `<broker-host>`, `<project>` and `<vendor>/<package>` throughout with your broker's HTTPS host, project slug and a package visible to the token. Include the port in `<broker-host>` when using a nondefault port.

<!-- source: packages/core/src/registry/composer/routes.ts:75 -->
<!-- source: packages/core/src/registry/composer/routes.ts:81 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->

## Token kinds

<TokenKinds />

Both client pages use the shared token-kind table. For automated installs, follow [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md).

## Configure the repository

Run this from your application directory. The URL is the project root; Composer requests `packages.json` beneath it.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/core/src/registry/composer/routes.ts:77 -->
<!-- source: Mac live verification, 2026-10-25 (composer-repository): Composer 2.10.3 wrote the named broker array entry shown below. -->

```sh
composer config repositories.broker composer 'https://<broker-host>/<project>'
```

Review `composer.json`. Place the broker before other repositories. Composer repositories are canonical by default: when it contains a package, Composer does not look in lower-priority repositories for that package. Packagist remains available for names the broker does not contain. If your project must resolve everything through broker sources and proxies, run the second command below to disable direct Packagist access.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->
<!-- source: Mac live verification, 2026-10-25 (composer-priority): Composer 2.10.3 used canonical priority by default and fell back to Packagist for a missing name. -->

```json
{
  "repositories": [
    {
      "name": "broker",
      "type": "composer",
      "url": "https://<broker-host>/<project>"
    }
  ]
}
```

To disable direct Packagist access without manually converting repository structures:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->

```sh
composer config repositories.packagist.org false
```

Vendor credentials belong on a broker source. For Magento vendor credentials, follow [Vendor repositories as sources](../guides/mirror-vendor-repositories.md).

## Set credentials

Choose one of these methods. Credentials are keyed by host, including any nondefault port, rather than by project path. A host entry does not widen the token's project access. Do not commit `auth.json`; add it to your application's `.gitignore` before writing credentials.

<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->
<!-- source: packages/core/src/authz/scope.ts:102 -->

### Local auth.json

Create `auth.json` beside `composer.json`. Replace `<token>` locally. The username is the literal word `token`; the password is the complete PAT or service token.

<!-- source: packages/core/src/auth/client-matrix.test.ts:70 -->

```json
{
  "http-basic": {
    "<broker-host>": {
      "username": "token",
      "password": "<token>"
    }
  }
}
```

Alternatively, with `BROKER_TOKEN` already supplied in your terminal environment, write a bearer entry using Composer. The broker accepts both HTTP Basic and Bearer token authentication. This variable is a recipe input, not a broker runtime setting. Avoid shell tracing when handling credentials.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/core/src/auth/credential-parser.ts:103 -->
<!-- source: Mac live verification, 2026-10-25 (composer-bearer): Composer 2.10.3 wrote mode-600 auth.json; bearer install and gitignore check passed. -->

```sh
composer config --auth 'bearer.<broker-host>' "$BROKER_TOKEN"
```

### COMPOSER_AUTH

For automation, supply `COMPOSER_AUTH` as a secret environment variable containing this JSON, with placeholders replaced. It carries the same HTTP Basic credentials without writing `auth.json`. Keep the value out of workflow files and logs.

<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->
<!-- source: Mac live verification, 2026-10-25 (composer-env): Composer 2.10.3 installed using only the HTTP Basic COMPOSER_AUTH JSON. -->

<!-- prettier-ignore -->
```json
{"http-basic":{"<broker-host>":{"username":"token","password":"<token>"}}}
```

## Verify the install

In an existing application with a committed `composer.lock`, install its locked dependencies. These flags suppress package plugins and scripts; review your application's requirements before enabling them.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->

```sh
composer install --no-plugins --no-scripts
```

For a package not yet in your application, add one visible to your token:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:570 -->

```sh
composer require '<vendor>/<package>:^1.0' --no-plugins --no-scripts
```

Confirm the package appears in `composer.lock` and its distribution URL points to your broker. A lock file created before switching repositories may retain its previous distribution URLs; changing the repository setting alone does not rewrite that lock file. To move selected packages to broker URLs, run `composer update '<vendor>/<package>' --no-plugins --no-scripts`, naming each package you want re-resolved. This can change those packages and their required dependencies within your constraints. A full `composer update --no-plugins --no-scripts` re-resolves all dependencies and can change unrelated versions. `composer update --lock` does not move existing distribution URLs to the broker.

<!-- source: packages/core/src/registry/composer/render.ts:94 -->
<!-- source: Mac live verification, 2026-10-25 (composer-lock): A targeted composer update rewrote only the selected package to broker dist URLs; update --lock did not. -->

## Resolve authentication failures

| Response | Meaning and next step                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401      | Authentication was not accepted. Check credential placement, host and port, token expiry, revocation and principal status. Replace an expired or revoked token.         |
| 403      | Authentication succeeded, but a required permission is missing for a visible project. Ask someone managing the project to check the principal's grants and token scope. |
| 404      | The project or package is absent or hidden from this token. Check the project URL and access with someone managing that project.                                        |

<!-- source: packages/core/src/authz/engine.ts:346 -->
<!-- source: packages/core/src/authz/token-use.ts:100 -->
<!-- source: packages/core/src/registry/registry-leak-contract.test.ts:544 -->
<!-- source: packages/core/src/registry/registry-leak-contract.test.ts:813 -->

Continue with [npm, pnpm and yarn setup](npm-pnpm-yarn.md) for front-end packages or the [CI recipes](../ci/github-actions.md) for automated installs.
