# Contributing

Contributions are welcome. This repository is pre-release, so the API and the plugin contract still change; the notes below describe how to propose a change that can be reviewed and merged. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md); how the project is run is in [GOVERNANCE.md](GOVERNANCE.md).

## Before you start

For anything beyond a small fix, open an issue first and describe the problem you want to solve, so the approach can be agreed before you invest time in it. Small fixes (typos, documentation, clear bugs) can go straight to a pull request. The issue forms cover bug reports, feature requests, plugin proposals and documentation requests.

## Setup

You need Node 24 or newer (`.nvmrc` and the `engines` field in `package.json` say which) and pnpm. The pnpm version is pinned in `package.json`; `corepack enable` provides it. You do not need a Cloudflare account to develop or to run the checks: the Cloudflare runtime runs locally in Miniflare, and the Node runtime runs as a plain process. An account is needed only to deploy (see README.md).

One command installs, builds, tests and exercises both runtimes:

```sh
corepack enable && pnpm install --frozen-lockfile && pnpm --filter @package-broker/e2e exec playwright install chromium && pnpm check && pnpm bundle && pnpm smoke:cloudflare && pnpm smoke:node
```

`pnpm check` also runs the required UI browser tests, so it needs Chromium, which the `playwright install chromium` step provides. `pnpm bundle` builds the Cloudflare and Node bundles from `broker.config.ts`. `pnpm smoke:cloudflare` runs the Worker bundle in Miniflare, and `pnpm smoke:node` starts the Node bundle and exercises it over HTTP.

## Gates

A pull request must pass the checks CI runs. The last two rows are not part of pull request CI; run them when you change packaging, the prebuilt distributions or the Docker image.

| Command                                    | What it checks                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                           | TypeScript project references                                                                                                                                                                                                |
| `pnpm lint`                                | ESLint and the Prettier style                                                                                                                                                                                                |
| `pnpm test`                                | Unit tests (Vitest)                                                                                                                                                                                                          |
| `pnpm test:scripts`                        | Node tests for the repository scripts (release, prebuilt and smoke helpers)                                                                                                                                                  |
| `pnpm build`                               | TypeScript build and the UI build                                                                                                                                                                                            |
| `pnpm check`                               | `typecheck`, `lint`, `test` and `build`, plus the required UI browser tests; needs Chromium                                                                                                                                  |
| `pnpm check:treeshake`                     | Each runtime bundle excludes code it must not ship; needs a build                                                                                                                                                            |
| `pnpm check:pack`                          | Packed packages contain what they publish; needs a build                                                                                                                                                                     |
| `pnpm smoke:cloudflare`, `pnpm smoke:node` | The runtime bundles start and answer; need `pnpm bundle`                                                                                                                                                                     |
| `pnpm client-matrix`                       | Installs through one package manager client; set `CLIENT` and `CLIENT_VERSION` as CI does (composer, npm, pnpm, yarn)                                                                                                        |
| `pnpm smoke:prebuilt`                      | The packed prebuilt distributions install into a scratch project and start; needs `pnpm build`, `pnpm bundle`, `pnpm stage:prebuilt --write-cli-expected` and network access for `npm install`. The release workflow runs it |
| `pnpm smoke:docker --functional`           | Builds the Docker image with the smoke fixture config and installs a fixture package through it with Composer; needs a Docker host, `openssl` and network access. See `fixtures/docker-smoke/README.md`                      |

CI also checks the `Signed-off-by` trailer on every commit and the pull request title format (see below).

`pnpm format` rewrites files to the Prettier style that `pnpm lint` checks.

To run a subset of the tests while you work, select one package by its directory name:

```sh
pnpm vitest run --project core
```

## Developer Certificate of Origin

Contributions are accepted under the repository licence (AGPL-3.0-only). Every commit in a pull request must carry a `Signed-off-by:` trailer with your name and e-mail address, which attests the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or have the right to submit it under that licence. Add the trailer with `git commit -s`. CI rejects a pull request with an unsigned commit; `git commit --amend -s` or `git rebase --signoff` adds the trailer to existing commits. No copyright assignment and no separate licence grant are collected.

## Branches and pull requests

Branch from `main` and open the pull request against `main`. Keep a pull request to one logical change. Pull requests are squash-merged, and the pull request title becomes the commit message, so it must follow [Conventional Commits](https://www.conventionalcommits.org/) with the package directory as scope, for example `feat(core): add plugin hook` or `fix(runtime-node)!: change health route`. Fill in the pull request template, describe the problem and the approach, and add or update tests for the behaviour you change. A pull request that changes the admin UI (`packages/ui/src`) shows one Before and one After screenshot per changed screen in the collapsed Screenshots section of the template; the `ui screenshots` check fails without them unless the description ticks "No visible UI change".

Read the [UI guidelines](docs/contributing/ui-guidelines.md) before changing the admin UI.

## Decisions and contracts

Architecture decisions are recorded as ADRs in [`docs/decisions/`](docs/decisions/README.md). A change that affects the architecture, the plugin API, the security model, the licence or the contribution terms needs a decision record first; a record is changed only by a later record that supersedes it. If your change alters a recorded decision, say so in the pull request.

A change to a published contract (package `exports` maps, the plugin API, HTTP routes, configuration) also adds entries to `BACKWARD_COMPATIBILITY.md` and `UPGRADE_NOTES.md` once those files exist. `AGENTS.md` lists the same rules for coding agents.

## Proposing a plugin or adapter

Plugins are composed into the bundle at build time and may import only the `@package-broker/core` root and `@package-broker/core/plugin`. Open a plugin proposal issue naming the port or hook you target and the first adapter or use case, and say why it cannot live in its own repository. See [ADR-004](docs/decisions/plugin-api-and-composition.md#adr-004-modular-build-composition-at-build-time-with-deny-only-hooks) for the composition model.

## What is not accepted

- Hooks that widen access. Hooks are deny-only; grants come from the core roles and permission model.
- Loading code at run time. There is no runtime plugin loading.
- Logging or returning secrets, tokens, cookies, credential-bearing URLs, or the e-mail addresses of accounts and identities the broker holds.
- Edits to tests made only to turn them green, and hand edits to generated build manifests or `dist/`.

## Security issues

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md).

## Releases

Releases are produced by [Release Please](https://github.com/googleapis/release-please) in manifest mode. Merging to `main` opens or updates one release pull request that bumps versions and writes each package's `CHANGELOG.md`; the release App opens that pull request so its required checks run. Merging that pull request creates the `<component>-v<version>` tags and GitHub Releases. Do not edit versions or changelogs by hand.
