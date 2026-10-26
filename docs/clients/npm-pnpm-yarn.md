---
title: npm, pnpm and yarn
sidebar_position: 2
description: Configure npm, pnpm and yarn to use Package Broker.
---

Map a package scope to one broker project, then use a token to install packages from that project.

## Prerequisites

You need a running broker, a project with an npm source, and a token that can read the package. Replace `<broker-host>`, `<project>`, `<scope>` and `<package>` with your HTTPS host, project slug, package scope without the leading `@`, and an available package name. Include a nondefault port in the host. Run the section for your chosen client in the application directory.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/registry/npm/routes.ts:368 -->

## Token kinds

See [token kinds in the access model](/docs/reference/access-model#token-kinds) for token boundaries, expiry and revocation.

Supply `NPM_TOKEN` through your terminal environment or CI secret settings before installing. It is a client recipe variable, not a broker runtime setting. Keep the literal `${NPM_TOKEN}` placeholder in committed config; never replace it with a token in a committed file. Avoid shell tracing and commands that print authentication configuration.

<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (npm-env): npm 11.17, pnpm 12 with user-level auth, Yarn 1.22.22 and Yarn 4.9.2 expanded NPM_TOKEN. -->

The registry is `https://<broker-host>/<project>/npm/`. Scope the credential to this host and path. A package scope mapping chooses a registry; it does not grant project access.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/authz/scope.ts:102 -->

## npm

Add these lines to `.npmrc` beside `package.json`. Other package scopes continue using your existing registry settings.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (npm-scope): npm install and npm ci with an empty cache passed; the lock used the broker archive URL; wrong token returned E401. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
```

Install a package, then use the lock file on subsequent CI runs:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->

```sh
npm install '@<scope>/<package>'
npm ci
```

## pnpm

Keep only the scope mapping in the application's `.npmrc`. pnpm 12 ignores repository-controlled auth settings, including an `_authToken` containing an environment placeholder:

<!-- source: packages/ui/src/pages/tokens/client-config.ts:6 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:124 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (pnpm-scope): pnpm 12.8.1 and 12.15.0 ignored project auth; user-level auth with the project scope mapping passed. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
```

Put the credential reference in your user-level `~/.npmrc`, outside the application repository. Keep the placeholder literal; pnpm expands it from your environment:

```ini
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
```

Add a dependency and commit the resulting `pnpm-lock.yaml`. Use the locked install in CI:

<!-- source: .github/workflows/ci.yml:32 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (pnpm-install): pnpm add and pnpm install --frozen-lockfile passed with user-level auth; no credential in the lock. -->

```sh
pnpm add '@<scope>/<package>'
pnpm install --frozen-lockfile
```

## Yarn Classic (1.x)

Add these lines to `.npmrc`; Classic reads npm-style registry credentials:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:708 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (yarn-classic): Yarn 1.22.22 add and frozen install passed; wrong token returned 401; no credential in yarn.lock. -->

```ini
@<scope>:registry=https://<broker-host>/<project>/npm/
//<broker-host>/<project>/npm/:_authToken=${NPM_TOKEN}
always-auth=true
```

The top-level `always-auth=true` applies to all registries in this config, including non-broker scopes. Review this effect if the application uses multiple registries. Yarn 1 on Node 24 may print a `DEP0169` deprecation warning.

Add a package and keep `yarn.lock` for subsequent installs:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:721 -->

```sh
yarn add '@<scope>/<package>'
yarn install --frozen-lockfile
```

## Yarn Berry (2.x and later)

Use `.yarnrc.yml` instead of `.npmrc`. Scope names under `npmScopes` omit `@`. Keep the token on the project registry entry and set `npmAlwaysAuth` so package reads carry it.

<!-- source: packages/core/src/auth/client-matrix.test.ts:149 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (yarn-berry): Yarn 4.9.2 accepted this registry key, including its trailing slash; wrong token failed with mirror/global cache disabled. -->

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
<!-- source: verified 2026-10-25 on Node 24 / Docker (yarn-immutable): Yarn 4.9.2 add and immutable install passed; lock contained a package resolution, no URL or credential. -->

```sh
yarn add '@<scope>/<package>'
yarn install --immutable
```

## Verify the install

Confirm the dependency appears in the client's lock file and that its archive is downloaded from the project's broker URL. Berry records a package resolution rather than an archive URL in its lock. Test a second install from the lock with an empty client cache; disable Berry's mirror and global cache for authentication checks (`enableMirror: false` and `enableGlobalCache: false`). Scope mapping affects package resolution; an old lock may still refer to a previous registry and needs review after a registry change.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:651 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:730 -->
<!-- source: verified 2026-10-25 on Node 24 / Docker (npm-locks): fresh locks contained no credentials; pnpm used user-level auth. Berry stores a package resolution rather than an archive URL. -->
<!-- verify: npm-locks-existing — CI (hosted runners): exercise pre-existing npm, pnpm, Yarn Classic and Berry locks after a registry switch, including empty-cache installs. -->

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
