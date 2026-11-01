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

### Web login recovery

During collection, the session enters `delivering` before the broker decrypts the token and builds the response. It becomes `consumed` after the response body is built. If delivery remains unconfirmed in `delivering` for more than five minutes, the expiry job revokes the PAT and records `login_delivery_unconfirmed`; the job runs every 60 seconds. If the `consumed` write commits but the response never reaches the client, the token stays valid. Revoke that token in the UI before trying login again.

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

## Web login

For an interactive human login, use npm's browser flow with the project registry:

```sh
npm login --auth-type=web --registry=https://<broker-host>/<project>/npm/
```

Open the URL printed by npm, sign in to the broker, review the project and requested access, and approve. npm polls until approval and saves the issued personal token in your user npm configuration. Keep that file outside the repository. The token remains subject to your grants, expiry and revocation; login does not grant publishing permission. Legacy username/password registry login is unsupported.

pnpm 12.5.1 does not support `login --auth-type=web`; **pnpm users log in with npm**, then use the user-level npm credential with pnpm as described above. Yarn 4.9.2 refuses `yarn npm login --web-login`; use a broker token in the Yarn configuration above. Yarn Classic users can also configure a broker token through `.npmrc`. Do not enter broker passwords into a client's legacy registry login prompt.

<!-- source: scripts/client-matrix-login.mjs -->
<!-- source: packages/core/src/api/routes/npm-login.ts -->

## Publishing

An administrator must configure an npm hosted source, register a name or scope claim for it, and attach it to the project. Publishing requires `org:packages:publish` and a token with `write` scope that permits package writes. An install-only token cannot publish. Keep CI publishing credentials separate from read credentials.

Set the package's `name` and `version` in `package.json` and run your build first. Configure the publishing token for the project registry with the client-specific placement above, then run one of:

```sh
npm publish --registry=https://<broker-host>/<project>/npm/ --provenance=false
pnpm publish --registry=https://<broker-host>/<project>/npm/ --provenance=false
# Yarn Classic
yarn publish --registry=https://<broker-host>/<project>/npm/
# Yarn Berry: uses npmRegistryServer in .yarnrc.yml
yarn npm publish
```

Disable any provenance setting inherited from your environment or client configuration. The broker rejects provenance attachments with `provenance_unsupported`; it does not verify or store them. For token-free GitHub Actions publishing, see [trusted publishing](../guides/npm-trusted-publishing.md).

An immediately active publish returns HTTP **201**. A publish held for approval or policy scanning returns HTTP **202** with `ok: true`, `held` and a `status` URL. A successful CLI exit can therefore mean the package is held, not installable. Review it in the broker's Publishes view; the status URL is a management resource requiring authorized human access, not an unauthenticated polling link. Held versions remain unavailable to installs until all required approval and scan gates pass; rejection or expiry does not release them. Do not retry a held publish as a new upload of the same name/version. Existing name/version bytes are immutable.

<!-- source: packages/core/src/registry/npm/publish-service.ts -->
<!-- source: packages/core/src/registry/npm/publish-body.ts -->
<!-- source: scripts/client-matrix-runtime.mjs -->

For packages built from tagged repositories rather than published by a client, see [npm repository ingestion](../guides/npm-repository-ingest.md). Continue with [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md) for secret placement and client caches, or [Composer setup](composer.md) for PHP packages.
