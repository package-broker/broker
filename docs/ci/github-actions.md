---
title: GitHub Actions
sidebar_position: 1
description: Use Package Broker from GitHub Actions.
---

Install Composer and npm dependencies from a broker project using a read-only service token stored in repository secrets.

## Prerequisites

Configure the repository URLs in your application's [Composer setup](../clients/composer.md) and [npm setup](../clients/npm-pnpm-yarn.md#npm), and commit `composer.lock` and `package-lock.json`. Replace the client-config placeholders before running CI. The example assumes both package ecosystems are in the repository root and the runner can reach the broker over HTTPS.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:586 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:660 -->

Have someone with `project:service-principals:write` create a service principal bound to the project with `project:read` and `project:packages:read`. Someone with `project:tokens:create` and the permissions being conferred can issue its token with scope `read`. Issuance requires fresh re-authentication. Use the same project-bound token for the two secret representations below; [token kinds](../clients/composer.md#token-kinds) explains the boundary and expiry.

<!-- source: packages/core/src/api/routes/service-principals-schemas.ts:18 -->
<!-- source: packages/core/src/authz/service-principal-service.ts:431 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:96 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:402 -->

## Add repository secrets

In the consuming repository's Actions secret settings, create these secrets. Replace the placeholders in the secret settings, not in the workflow file:

| Secret          | Value                                                     |
| --------------- | --------------------------------------------------------- |
| `NPM_TOKEN`     | The complete project service token                        |
| `COMPOSER_AUTH` | The compact JSON object below, containing that same token |

<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: actions-secrets — CI (hosted runners): confirm GitHub repository secret placement and NPM_TOKEN environment substitution in the consuming application. -->

<!-- prettier-ignore -->
```json
{"http-basic":{"<broker-host>":{"username":"token","password":"<service-token>"}}}
```

Use the broker host, including a nondefault port if needed, as the JSON key. Commit only the client config with the literal `${NPM_TOKEN}` placeholder. Do not commit `auth.json`, token values or resolved authentication config.

<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->
<!-- verify: actions-secret-redaction — CI (hosted runners): run the workflow with scratch credentials and check that no credential appears in logs, caches or artifacts. -->

## Add the workflow

Save this as `.github/workflows/install.yml` in the consuming application. It runs on pushes to `main`; replace that branch only with branches whose code may use the install token. It sets `contents: read`, disables persisted checkout credentials and pins first-party actions by major version, following the broker repository's convention. There are no third-party actions in this recipe; if you add one, use a full commit SHA and a version comment.

<!-- source: .github/workflows/ci.yml:11 -->
<!-- source: .github/workflows/ci.yml:23 -->
<!-- source: .github/workflows/ci.yml:27 -->
<!-- verify: actions-workflow — CI (hosted runners): run this complete workflow once in a scratch GitHub repository and retain the run URL; confirm Ubuntu runner PHP and Composer availability and actions/cache@v4 inputs. -->
<!-- verify: actions-cache — CI (hosted runners): confirm both cache paths, organization/project isolation and lock hashes; actions/cache is not used at this HEAD. -->

```yaml
name: Install dependencies

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  install:
    runs-on: ubuntu-latest
    env:
      COMPOSER_CACHE_DIR: ${{ github.workspace }}/.ci-cache/composer
      npm_config_cache: ${{ github.workspace }}/.ci-cache/npm
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Check PHP and Composer
        run: |
          php --version
          composer --version
      - name: Restore package archives
        uses: actions/cache@v4
        with:
          path: |
            .ci-cache/composer/files
            .ci-cache/npm/_cacache
          key: ${{ runner.os }}-<organization>-<project>-composer-${{ hashFiles('composer.lock') }}-npm-${{ hashFiles('package-lock.json') }}
      - name: Install Composer dependencies
        env:
          COMPOSER_AUTH: ${{ secrets.COMPOSER_AUTH }}
        run: composer install --no-interaction --prefer-dist --no-progress --no-plugins --no-scripts
      - name: Install npm dependencies
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm ci
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:527 -->
<!-- source: scripts/docker-smoke.mjs:814 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:668 -->

Replace `<organization>` and `<project>` in the cache key with identifiers for this broker organization and project. The key changes when either lock file changes. The cache contains package archives, including private package contents; restrict cache access to the intended repository and trusted runners. It excludes `auth.json`, `.npmrc`, home directories and npm logs. The Composer flags suppress plugins and scripts; add only those your application requires after reviewing their credential access.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:522 -->
<!-- verify: actions-cache-access — CI (hosted runners): check GitHub's current cache read/write rules for the repository and any fork workflows before enabling private package caching. -->

If you adapt this recipe for pnpm 12, commit only the scope registry line in the project's `.npmrc` and put the literal token reference in the runner user's `~/.npmrc`, as shown in [pnpm setup](../clients/npm-pnpm-yarn.md#pnpm). Supply `NPM_TOKEN` to the install step. Use the pnpm lock and cache paths for that job; project-level `_authToken` settings are ignored.

<!-- source: Mac live verification, 2026-10-25 (pnpm-scope): pnpm 12.8.1 and 12.15.0 installed successfully with user-level auth; project-level auth returned 401. -->

## Verify and separate publishing

Confirm both install steps succeed on a first run and a second run using the cache. Inspect lock files for broker distribution URLs and check the job logs for credential exposure. If an application uses just one ecosystem, remove the other install step, cache path and lock hash together.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->
<!-- verify: actions-repeat — CI (hosted runners): retain first-run and cache-hit logs, including successful authenticated Composer and npm installs. -->

Use this token only for installs. Scope `read` does not grant package-write permission. The current npm registry rejects writes with HTTP 405, so this recipe has no npm publish step. Do not solve a failed publish by broadening the install token. Keep publishing credentials in a separate job if using another supported destination.

<!-- source: packages/core/src/authz/scope.ts:71 -->
<!-- source: packages/core/src/registry/npm/routes.ts:363 -->
<!-- source: packages/core/src/registry/npm/routes.ts:421 -->

## If a token leaked

Stop the affected jobs. Have someone with `project:tokens:revoke` revoke the exposed token using the broker's Tokens page for that project, or the authenticated administrative route `DELETE /_pb/projects/:project/tokens/:token`, where `:token` is the token record ID, not the credential. Revocation makes the credential fail subsequent authentication. Issue a replacement with scope `read`, update both repository secrets and rerun the install. Removing a value from Git history or logs does not revoke it.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:185 -->
<!-- source: packages/core/src/authz/token-use.ts:114 -->
<!-- source: packages/ui/src/pages/tokens.tsx:724 -->

For planned rotation, the administrative route is `POST /_pb/projects/:project/tokens/:token/rotate`. It requires `project:tokens:create` and `project:tokens:revoke`, fresh re-authentication, and an `overlapDays` value of `0`, `1` or `7`. The replacement credential is returned at issuance; update both secrets before any planned overlap ends. For a leak, revoke first and issue a new token rather than allowing an overlap with the exposed credential.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:215 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:269 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:419 -->
<!-- verify: actions-revoke-rotate — CI (hosted runners): exercise revocation and planned rotation with scratch tokens and confirm both clients reject the old credential after revocation or expiry. -->

For the corresponding variable and cache setup in GitLab, use [GitLab CI](gitlab-ci.md).
