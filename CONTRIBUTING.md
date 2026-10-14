# Contributing

## Contributor License Agreement

Every contributor must sign the Contributor License Agreement in [CLA.md](CLA.md) before a pull request can be merged.

## Workflow

- Node 24 and pnpm (version pinned in `package.json`; run `corepack enable`).
- `pnpm install --frozen-lockfile`, then `pnpm check` runs typecheck, lint, unit tests and build.
- Pull requests are squash-merged. The pull request title is the commit message and must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(core): add plugin hook` or `fix(runtime-node)!: change health route`.
- Use the package directory name as the scope.

## Releases

Releases are produced by [Release Please](https://github.com/googleapis/release-please) in manifest mode. Merging to `main` opens or updates one release pull request that bumps versions and writes each package's `CHANGELOG.md`. Merging that pull request creates the `<component>-v<version>` tags and GitHub Releases. Do not edit versions or changelogs by hand.
