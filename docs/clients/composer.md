---
title: Composer
sidebar_position: 1
description: Configure Composer to use Package Broker.
---

import TokenKinds from '../reference/_token-kinds.md';

Install Composer packages through a project URL. Use these steps in the directory containing your Magento, Symfony or Laravel application's `composer.json`.

## Prerequisites

You need Composer 2, a running broker, a project with packages available from a source, and a token that can read those packages. Composer 1 is rejected. Replace `<broker-host>`, `<project>` and `<vendor>/package` throughout with your broker's HTTPS host, project slug and a package visible to the token. Include the port in `<broker-host>` when using a nondefault port.

<!-- source: packages/core/src/registry/composer/routes.ts:75 -->
<!-- source: packages/core/src/registry/composer/routes.ts:81 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->

<TokenKinds />

The [access-model reference](../reference/access-model.md) maintains this token-kind table. For automated installs, follow [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md).

## Configure the repository

Run this from your application directory. The URL is the project root; Composer requests `packages.json` beneath it.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/core/src/registry/composer/routes.ts:77 -->
<!-- verify: composer-repository — run this command with substituted placeholders on Composer 2 and confirm the repository order below. -->

```sh
composer config repositories.broker composer 'https://<broker-host>/<project>'
```

Review `composer.json`. Place the broker before other repositories. This example makes the broker canonical: when it contains a package, Composer does not look in lower-priority repositories for that package. Packagist remains available for names the broker does not contain. If your project must resolve everything through broker sources and proxies, append the object below to disable direct Packagist access.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->
<!-- verify: composer-priority — confirm Composer 2 canonical repository priority and Packagist fallback; canonical is a client setting, not a broker access control. -->

```json
{
  "repositories": [
    {
      "type": "composer",
      "url": "https://<broker-host>/<project>",
      "canonical": true
    }
  ]
}
```

To disable direct Packagist access, append this object to the `repositories` array:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->

```json
{ "packagist.org": false }
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

Alternatively, with `BROKER_TOKEN` already supplied in your terminal environment, write a bearer entry using Composer. This variable is a recipe input, not a broker runtime setting. Avoid shell tracing when handling credentials.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- verify: composer-bearer — run the bearer config command and install against the broker; confirm auth.json is excluded from version control. -->

```sh
composer config --auth 'bearer.<broker-host>' "$BROKER_TOKEN"
```

### COMPOSER_AUTH

For automation, supply `COMPOSER_AUTH` as a secret environment variable containing this JSON, with placeholders replaced. It carries the same HTTP Basic credentials without writing `auth.json`. Keep the value out of workflow files and logs.

<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->
<!-- verify: composer-env — run composer install with only COMPOSER_AUTH set against a project requiring authentication. -->

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
composer require '<vendor>/package:^1.0' --no-plugins --no-scripts
```

Confirm the package appears in `composer.lock` and its distribution URL points to your broker. A lock file created before switching repositories may retain its previous distribution URLs; changing the repository setting alone does not rewrite that lock file.

<!-- source: packages/core/src/registry/composer/render.ts:94 -->
<!-- verify: composer-lock — inspect the installed package and broker dist URL in a newly resolved lock; check how to update an existing application lock without changing unrelated dependencies. -->

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
