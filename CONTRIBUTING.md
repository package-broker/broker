# Contributing

Contributions are welcome. This repository is pre-release, so the API and the plugin contract still change; the notes below describe how to propose a change that can be reviewed and merged.

## Before you start

For anything beyond a small fix, open an issue first and describe the problem you want to solve, so the approach can be agreed before you invest time in it. Small fixes (typos, documentation, clear bugs) can go straight to a pull request.

## Development setup

You need Node 24 or newer (the `engines` field in `package.json` and `.nvmrc` say which) and pnpm. The pnpm version is pinned in `package.json`; run `corepack enable` to get it.

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Gates

A pull request must pass these four checks, which CI also runs:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

`pnpm check` runs all of them plus required UI browser tests. It needs Chromium: run `pnpm --filter @package-broker/e2e exec playwright install chromium` first. `pnpm format` rewrites files to the Prettier style that `pnpm lint` checks.

## Developer Certificate of Origin

Contributions are accepted under the repository licence (AGPL-3.0-only). Every commit in a pull request must carry a `Signed-off-by:` trailer with your name and e-mail address, which attests the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or have the right to submit it under that licence. Add the trailer with `git commit -s`. CI rejects a pull request with an unsigned commit; `git commit --amend -s` or `git rebase --signoff` adds the trailer to existing commits.

## Pull requests

Keep a pull request to one logical change. Pull requests are squash-merged, and the pull request title becomes the commit message, so it must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(core): add plugin hook` or `fix(runtime-node)!: change health route`. Use the package directory name as the scope. Fill in the pull request template when GitHub shows it, describe the problem and the approach, and add or update tests for the behaviour you change.

## Decision records

Architecture decisions are recorded in `docs/decisions/` once that directory is published. If your change alters a recorded decision, say so in the pull request.

## Security issues

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

A code of conduct will be added to the repository; until then, be respectful and constructive in issues and reviews.

## Releases

Releases are produced by [Release Please](https://github.com/googleapis/release-please) in manifest mode. Merging to `main` opens or updates one release pull request that bumps versions and writes each package's `CHANGELOG.md`. Merging that pull request creates the `<component>-v<version>` tags and GitHub Releases. Do not edit versions or changelogs by hand.
