---
title: npm, pnpm and yarn
sidebar_position: 2
description: Configure npm, pnpm and yarn to use Package Broker.
---

import TokenKinds from '../reference/_token-kinds.md';

Map a package scope to one broker project, then use a token to install packages from that project.

## Prerequisites

You need a running broker, a project with an npm source, and a token that can read the package. Replace `<broker-host>`, `<project>` and `<scope>` with your HTTPS host, project slug and package scope, without the leading `@`. Include a nondefault port in the host. Run the section for your chosen client in the application directory.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/registry/npm/routes.ts:368 -->

<TokenKinds />

The [access-model reference](../reference/access-model.md) maintains this token-kind table. Supply `NPM_TOKEN` through your terminal environment or CI secret settings before installing. It is a client recipe variable, not a broker runtime setting. Keep the literal `${NPM_TOKEN}` placeholder in committed config; never replace it with a token in a committed file. Avoid shell tracing and commands that print authentication configuration.

<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: npm-env — verify environment substitution of NPM_TOKEN in each client's config without logging the value. -->

The registry is `https://<broker-host>/<project>/npm/`. Scope the credential to this host and path. A package scope mapping chooses a registry; it does not grant project access.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/authz/scope.ts:102 -->

## npm

Add these lines to `.npmrc` beside `package.json`. Other package scopes continue using your existing registry settings.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: npm-scope — test scope-to-registry mapping, path-scoped auth and install with the npm version used by your application. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
```

Install a package, then use the lock file on subsequent CI runs:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->

```sh
npm install '@<scope>/widget'
npm ci
```

## pnpm

Add these lines to the application's `.npmrc`:

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- verify: pnpm-scope — test pnpm scope mapping, environment substitution and install; the existing real-client suite skips pnpm installs. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
```

Add a dependency and commit the resulting `pnpm-lock.yaml`. Use the locked install in CI:

<!-- source: .github/workflows/ci.yml:32 -->
<!-- verify: pnpm-install — run pnpm add and pnpm install --frozen-lockfile against the authenticated broker project. -->

```sh
pnpm add '@<scope>/widget'
pnpm install --frozen-lockfile
```

## Yarn Classic (1.x)

Add these lines to `.npmrc`; Classic reads npm-style registry credentials:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:708 -->
<!-- verify: yarn-classic — test scope mapping and NPM_TOKEN substitution with Yarn 1; the existing fixture uses a default registry rather than a scope mapping. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
always-auth=true
```

Add a package and keep `yarn.lock` for subsequent installs:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:721 -->

```sh
yarn add '@<scope>/widget'
yarn install --frozen-lockfile
```

## Yarn Berry (2.x and later)

Use `.yarnrc.yml` instead of `.npmrc`. Scope names under `npmScopes` omit `@`. Keep the token on the project registry entry and set `npmAlwaysAuth` so package reads carry it.

<!-- source: packages/core/src/auth/client-matrix.test.ts:149 -->
<!-- verify: yarn-berry — test npmScopes mapping, npmRegistries host/path matching and NPM_TOKEN substitution on Yarn 4; the unit test models headers rather than invoking Berry. -->

```yaml
npmScopes:
  <scope>:
    npmRegistryServer: 'https://<broker-host>/<project>/npm/'
npmRegistries:
  '//<broker-host>/<project>/npm/':
    npmAlwaysAuth: true
    npmAuthToken: '${NPM_TOKEN}'
```

Add a package, then use an immutable install with the committed lock file:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:727 -->
<!-- verify: yarn-immutable — run yarn add and yarn install --immutable with the application's Berry release. -->

```sh
yarn add '@<scope>/widget'
yarn install --immutable
```

## Verify the install

Confirm the dependency appears in the client's lock file and that its archive is downloaded from the project's broker URL. Test a second install from the lock with an empty client cache. Scope mapping affects package resolution; an old lock may still refer to a previous registry and needs review after a registry change.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:730 -->
<!-- verify: npm-locks — inspect fresh and pre-existing locks for each client, including Berry; ensure no credential is written to a lock or config file. -->

For 401, check token placement, host/path, expiry and revocation. For 403, check grants and token scope. An inaccessible project or package can return 404. See [Composer authentication failures](composer.md#resolve-authentication-failures) for the shared status meanings.

<!-- source: packages/core/src/authz/engine.ts:346 -->
<!-- source: packages/core/src/registry/registry-leak-contract.test.ts:544 -->
<!-- source: packages/core/src/registry/registry-leak-contract.test.ts:813 -->

## Publishing

This version serves npm installs but rejects npm package writes with HTTP 405 after access checks. Publishing through npm, pnpm, Yarn Classic or Yarn Berry is therefore unavailable. A token with scope `write` does not enable an unsupported registry operation. Do not use an install token for a publishing job; keep any publishing credentials separate when a supported publishing endpoint becomes available.

<!-- source: packages/core/src/registry/npm/routes.ts:363 -->
<!-- source: packages/core/src/registry/npm/routes.ts:421 -->
<!-- source: packages/core/src/authz/scope.ts:71 -->

Continue with [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md) for secret placement and client caches, or [Composer setup](composer.md) for PHP packages.
