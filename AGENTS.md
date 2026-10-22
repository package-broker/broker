# Working in this repository

## What this repository is

Package Broker 2.0 is a Composer and npm package registry broker, licensed under AGPL-3.0-only. One codebase runs on two runtimes, Cloudflare Workers and Node (Docker or direct); plugins are composed into the bundle at build time.

## Task router

If you are changing something in the first column, read its role in the second first.

| Changing                      | Role                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `packages/core`               | Kernel: plugin and config API, auth, access model, registry logic, database port |
| `packages/db-sqlite`          | SQLite data layer: repositories, contract and testing helpers                    |
| `packages/runtime-cloudflare` | Cloudflare Workers runtime: Worker entry and its smoke script                    |
| `packages/runtime-node`       | Node runtime: HTTP entry                                                         |
| `packages/cli`                | The `pb` command: build composition, migrations, bootstrap and admin tooling     |
| `packages/ui`                 | Static UI assets                                                                 |
| `packages/ui-assets`          | Build-time bridge that hands the UI assets to `pb build`                         |
| `packages/plugin-github`      | GitHub source plugin (stub)                                                      |
| `packages/plugin-sso-oidc`    | Generic OIDC single sign-on plugin (stub)                                        |
| `broker.config.ts`            | Root build configuration consumed by `pnpm bundle`                               |
| `fixtures/`                   | Minimal config used by checks and tests                                          |
| `scripts/`                    | Repository checks: pack, tree-shake, client matrix, Node bundle smoke            |

## Always

- Run the validation commands below before proposing a change.
- Scope every query and cache key by organization.
- Keep plugin hooks deny-only: a hook can refuse a request, never widen access.
- Keep error names stable and error messages free of request data.

## Ask first

- New dependencies, lockfile or workspace changes.
- Migrations.
- Changes to a published contract: package `exports` maps, the plugin API, HTTP routes.
- Anything under `.github/`.

## Never

- Load code at run time. Plugins are composed at build time.
- Log or return secrets, tokens, cookies or credential-bearing URLs.
- Log or return e-mail addresses of accounts and identities the broker holds.
  Exception: the organization users and grants admin list routes may return account e-mails only to callers holding organization admin authority.
- Edit generated build manifests or `dist/`.
- Edit tests to make them pass.
- Commit without the `Signed-off-by:` trailer (`git commit -s`).

Publisher free text in package metadata (`description`, `deprecated`) is public package content and is served exactly as upstream serves it.

## Validation commands

- `pnpm check`: typecheck, lint, unit tests and build.
- `pnpm check:treeshake`: confirms each runtime bundle excludes code it must not ship.
- `pnpm check:pack`: confirms the packed packages contain what they publish.
- `pnpm smoke:cloudflare`: runs the Worker bundle in a local Workers simulator.
- `pnpm smoke:node`: starts the Node bundle and exercises it over HTTP.

`check:pack` and `check:treeshake` need `pnpm build`; the smokes also need `pnpm bundle`.

Focused run for one package: `pnpm vitest run --project <package>`, for example `pnpm vitest run --project core`.

## Where the long-form docs live

- `README.md`: overview and package list.
- `CONTRIBUTING.md`: sign-off, workflow, releases.
- `SECURITY.md`: how to report a vulnerability.

## Conventions

- Pull request titles follow Conventional Commits with the package directory as scope, for example `fix(runtime-node): change health route`.
- Pull requests are squash-merged.
- Write comments only where the code cannot say it.
