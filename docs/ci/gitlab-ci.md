---
title: GitLab CI
sidebar_position: 2
description: Use Package Broker from GitLab CI.
---

Install Composer and npm dependencies from a broker project using masked CI/CD variables and lock-file cache keys.

## Prerequisites

Complete [Composer setup](../clients/composer.md) and [npm setup](../clients/npm-pnpm-yarn.md#npm) in the consuming application. Commit `composer.lock` and `package-lock.json`. The example assumes both ecosystems are in the repository root and that a Docker runner can reach your broker over HTTPS.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:586 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:660 -->

Use a service principal bound to one project with `project:read` and `project:packages:read`, and issue a token with scope `read`. Creating the principal requires `project:service-principals:write`; issuing the token requires `project:tokens:create`, the permissions it confers and fresh re-authentication. See [token kinds](../reference/access-model.md#token-kinds) for expiry and project boundaries.

<!-- source: packages/core/src/api/routes/service-principals-schemas.ts:18 -->
<!-- source: packages/core/src/authz/service-principal-service.ts:431 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:96 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:415 -->

## Add masked variables

In the application's GitLab CI/CD variable settings, add both variables as variable values, not file variables. Select masked visibility, disable variable-reference expansion and mark them protected if the pipeline runs only on protected refs. Store the same project service token in both representations:

| Variable        | Value                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| `NPM_TOKEN`     | The complete service token                                                        |
| `COMPOSER_AUTH` | The compact JSON object below, with the broker host and service token substituted |

<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: gitlab-variables — confirm current GitLab masking requirements, protected-ref availability and disabled variable expansion; use value variables rather than file variables. -->

<!-- prettier-ignore -->
```json
{"http-basic":{"<broker-host>":{"username":"token","password":"<service-token>"}}}
```

Keep the JSON on one line without whitespace. Include a nondefault port in the host key when needed. Keep the literal `${NPM_TOKEN}` in the committed `.npmrc`; the client substitutes the CI variable when it runs. Do not print either variable or commit `auth.json`.

<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->
<!-- verify: gitlab-secret-redaction — confirm Composer reads COMPOSER_AUTH directly, npm substitutes NPM_TOKEN and no token appears in logs, caches or artifacts. -->

## Add the pipeline

Save this as `.gitlab-ci.yml` in the consuming application. Replace `<organization>` and `<project>` in both cache prefixes with the broker organization and project identifiers. Choose the runner images according to your application's PHP extensions and Node requirements.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:527 -->
<!-- verify: gitlab-workflow — validate this complete file with GitLab CI Lint and run it once in a scratch GitLab repository; retain the pipeline URL. Confirm composer:2 and node:24 image contents, PHP extensions and runner reachability. -->
<!-- verify: gitlab-cache — confirm cache.key.files, prefix expansion, cache paths and image entrypoints on the chosen GitLab runner. -->

```yaml
stages:
  - install

composer-install:
  stage: install
  image: composer:2
  variables:
    COMPOSER_CACHE_DIR: '$CI_PROJECT_DIR/.ci-cache/composer'
  cache:
    key:
      prefix: '<organization>-<project>-$CI_PROJECT_ID-composer'
      files:
        - composer.lock
    paths:
      - .ci-cache/composer/files/
  script:
    - composer install --no-interaction --prefer-dist --no-progress --no-plugins --no-scripts

npm-install:
  stage: install
  image: node:24
  variables:
    npm_config_cache: '$CI_PROJECT_DIR/.ci-cache/npm'
  cache:
    key:
      prefix: '<organization>-<project>-$CI_PROJECT_ID-npm'
      files:
        - package-lock.json
    paths:
      - .ci-cache/npm/_cacache/
  script:
    - npm ci
```

<!-- source: scripts/docker-smoke.mjs:814 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:668 -->

The jobs receive `COMPOSER_AUTH` and `NPM_TOKEN` from CI/CD settings. Cache keys separate the broker organization, project, GitLab project and client, and change with the relevant lock file. These caches contain package archives, including private package contents. Restrict cache access to trusted runners and the intended project; keep protected and unprotected pipeline caches separate. Do not cache home directories, authentication files or npm logs.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:522 -->
<!-- verify: gitlab-cache-access — confirm protected/unprotected cache separation and runner cache access for private packages in the scratch project. -->

Composer plugins and scripts are disabled in this recipe. Review any plugins or scripts your application needs before enabling them, since jobs have access to CI credentials. For an application using only one ecosystem, keep just that job and its lock file.

<!-- source: scripts/docker-smoke.mjs:815 -->

## Verify and separate publishing

Run the pipeline on a ref allowed to read the variables. Confirm both install jobs succeed, then rerun to check cache reuse. Inspect the locks for broker distribution URLs and the logs for credential exposure. If authentication fails, check that protected variables are available to this ref before replacing the token.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->
<!-- verify: gitlab-repeat — retain first-run and cache-hit logs with successful authenticated installs and a check of protected-variable availability. -->

The install token has scope `read`, which excludes package-write permission. npm writes currently return HTTP 405, so the pipeline has no broker publish job. Keep credentials for another publishing destination in a separate job; do not widen this install token to make a publish command work.

<!-- source: packages/core/src/authz/scope.ts:71 -->
<!-- source: packages/core/src/registry/npm/routes.ts:363 -->
<!-- source: packages/core/src/registry/npm/routes.ts:421 -->

## If a token leaked

Stop affected jobs. Have someone with `project:tokens:revoke` revoke the token through the project's Tokens page or the authenticated administrative route `DELETE /_pb/projects/:project/tokens/:token`. Use the token record ID for `:token`, never the credential. Revocation makes subsequent authentication fail. Issue a replacement with scope `read`, replace both masked variables and rerun the pipeline. Removing the exposed value from Git history or logs does not revoke it.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:185 -->
<!-- source: packages/core/src/authz/token-use.ts:114 -->
<!-- source: packages/ui/src/pages/tokens.tsx:724 -->

For planned rotation, use `POST /_pb/projects/:project/tokens/:token/rotate` with `overlapDays` set to `0`, `1` or `7`. It requires issuance and revocation authority and fresh re-authentication. Update both masked variables with the replacement credential before the overlap ends. After a leak, revoke the exposed token first and issue a replacement without an overlap.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:215 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:269 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:419 -->
<!-- verify: gitlab-revoke-rotate — exercise revocation and planned rotation with scratch tokens; confirm old credentials fail for both clients after revocation or expiry. -->

For GitHub's secret and workflow equivalents, use [GitHub Actions](github-actions.md).
