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

Use a service principal bound to one project with `project:read` and `project:packages:read`, and issue a token with scope `read`. Creating the principal requires `project:service-principals:write`; issuing the token requires `project:tokens:create`, the permissions it confers and fresh re-authentication. See [token kinds](../clients/composer.md#token-kinds) for expiry and project boundaries.

<!-- source: packages/core/src/api/routes/service-principals-schemas.ts:18 -->
<!-- source: packages/core/src/authz/service-principal-service.ts:431 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:96 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:415 -->

## Add masked variables

In the application's GitLab CI/CD variable settings, add `NPM_TOKEN` containing the complete project service token as a variable value, not a file variable. Select masked visibility, disable variable-reference expansion and mark it protected if the pipeline runs only on protected refs. Store the raw token once; the Composer job constructs `COMPOSER_AUTH` from it. JSON cannot be stored directly as a masked value under GitLab's masked-variable validation.

<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: gitlab-variables — CI (hosted runners): confirm raw NPM_TOKEN masking, protected-ref availability and disabled variable expansion; use a value variable. -->

Keep the literal `${NPM_TOKEN}` in the committed npm config; the client substitutes the CI variable when it runs. Do not print the token or the constructed JSON, enable shell tracing, or commit `auth.json`.

<!-- source: packages/core/src/auth/client-matrix.test.ts:83 -->
<!-- verify: gitlab-secret-redaction — CI (hosted runners): confirm the Composer job constructs and reads COMPOSER_AUTH, npm substitutes NPM_TOKEN and no credential appears in logs, caches or artifacts. -->

## Add the pipeline

Save this as `.gitlab-ci.yml` in the consuming application. Replace `<organization>` and `<project>` in both cache prefixes with the broker organization and project identifiers. Set `BROKER_HOST` to the broker host, including any nondefault port, without a scheme or path. Choose the runner images according to your application's PHP extensions and Node requirements.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:527 -->
<!-- verify: gitlab-workflow — CI (hosted runners): validate this complete file with GitLab CI Lint and run it once in a scratch GitLab repository; retain the pipeline URL. Confirm composer:2 and node:24 image contents, PHP extensions and runner reachability. -->
<!-- verify: gitlab-cache — CI (hosted runners): confirm cache.key.files, prefix expansion, cache paths and image entrypoints on the chosen GitLab runner. -->

```yaml
stages:
  - install

composer-install:
  stage: install
  image: composer:2
  variables:
    COMPOSER_CACHE_DIR: '$CI_PROJECT_DIR/.ci-cache/composer'
    BROKER_HOST: '<broker-host>'
  cache:
    key:
      prefix: '<organization>-<project>-$CI_PROJECT_ID-composer'
      files:
        - composer.lock
    paths:
      - .ci-cache/composer/files/
  script:
    - |
      export COMPOSER_AUTH="$(php -r 'echo json_encode(["http-basic" => [getenv("BROKER_HOST") => ["username" => "token", "password" => getenv("NPM_TOKEN")]]], JSON_THROW_ON_ERROR);')"
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

Both jobs receive `NPM_TOKEN` from CI/CD settings; the Composer job constructs `COMPOSER_AUTH` in its environment without printing it. Cache keys separate the broker organization, project, GitLab project and client, and change with the relevant lock file. These caches contain package archives, including private package contents. Restrict cache access to trusted runners and the intended project; keep protected and unprotected pipeline caches separate. Do not cache home directories, authentication files or npm logs.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:522 -->
<!-- verify: gitlab-cache-access — CI (hosted runners): confirm protected/unprotected cache separation and runner cache access for private packages in the scratch project. -->

Composer plugins and scripts are disabled in this recipe. Review any plugins or scripts your application needs before enabling them, since jobs have access to CI credentials. For an application using only one ecosystem, keep just that job and its lock file.

<!-- source: scripts/docker-smoke.mjs:815 -->

If you adapt this recipe for pnpm 12, commit only the scope registry line in the project's `.npmrc` and put the literal token reference in the runner user's `~/.npmrc`, as shown in [pnpm setup](../clients/npm-pnpm-yarn.md#pnpm). Supply `NPM_TOKEN` to the install step. Use the pnpm lock and cache paths for that job; project-level `_authToken` settings are ignored.

<!-- source: Mac live verification, 2026-10-25 (pnpm-scope): pnpm 12.8.1 and 12.15.0 installed successfully with user-level auth; project-level auth returned 401. -->

## Verify and separate publishing

Run the pipeline on a ref allowed to read the variables. Confirm both install jobs succeed, then rerun to check cache reuse. Inspect the locks for broker distribution URLs and the logs for credential exposure. If authentication fails, check that protected variables are available to this ref before replacing the token.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->
<!-- verify: gitlab-repeat — CI (hosted runners): retain first-run and cache-hit logs with successful authenticated installs and a check of protected-variable availability. -->

The install token has scope `read`, which excludes package-write permission. npm writes currently return HTTP 405, so the pipeline has no broker publish job. Keep credentials for another publishing destination in a separate job; do not widen this install token to make a publish command work.

<!-- source: packages/core/src/authz/scope.ts:71 -->
<!-- source: packages/core/src/registry/npm/routes.ts:363 -->
<!-- source: packages/core/src/registry/npm/routes.ts:421 -->

## If a token leaked

Stop affected jobs. Have someone with `project:tokens:revoke` revoke the token through the project's Tokens page or the authenticated administrative route `DELETE /_pb/projects/:project/tokens/:token`. Use the token record ID for `:token`, never the credential. Revocation makes subsequent authentication fail. Issue a replacement with scope `read`, replace the masked `NPM_TOKEN` variable and rerun the pipeline. Removing the exposed value from Git history or logs does not revoke it.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:185 -->
<!-- source: packages/core/src/authz/token-use.ts:114 -->
<!-- source: packages/ui/src/pages/tokens.tsx:724 -->

For planned rotation, use `POST /_pb/projects/:project/tokens/:token/rotate` with `overlapDays` set to `0`, `1` or `7`. It requires `project:tokens:create` and `project:tokens:revoke` and fresh re-authentication. Update the masked `NPM_TOKEN` variable with the replacement credential before the overlap ends. After a leak, revoke the exposed token first and issue a replacement without an overlap.

<!-- source: packages/core/src/api/routes/tokens-schemas.ts:215 -->
<!-- source: packages/core/src/api/routes/tokens-schemas.ts:269 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/core/src/authz/service-token-service.ts:419 -->
<!-- verify: gitlab-revoke-rotate — CI (hosted runners): exercise revocation and planned rotation with scratch tokens; confirm old credentials fail for both clients after revocation or expiry. -->

For GitHub's secret and workflow equivalents, use [GitHub Actions](github-actions.md).
