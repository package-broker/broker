# Release and versioning

Decisions on repository layout, versioning and the release process.

## ADR-023: Repository strategy, versioning and release process

Status: Accepted, 2026-10-15; the bullet on pull request CI is superseded by [ADR-028](#adr-028-pull-requests-test-only-what-they-change-the-release-tests-everything-end-to-end)

### Context

The release process has to settle how releases are built, whether plugins live in separate repositories, whether to use Release Please and Renovate, what CI runs on every pull request, how releases run, whether v1's npm publishing is reusable, whether a dedicated GitHub Action for Workers is needed and whether a Helm chart is possible. The Helm chart is Nice to have; the remaining questions are answered by the decisions below.

### Decision

- The 2.0 code lives in a new repository, `package-broker/broker`. v1 is end of life and receives no fixes; `package-broker/server` holds the 1.x code for reference.
- Versioning starts at `2.0.0-rc.1` and continues `2.0.0-rc.X` until GA. Release Please runs with `prerelease: true` and `prerelease-type: rc`; the product packages (`core`, `cli`, `runtime-cloudflare`, `runtime-node`, `ui`) are linked on one version; the first tag is `v2.0.0-rc.1`. Plugins keep independent versions with component tags.
- The default Docker image ships with all first-party plugins compiled in, inert until configured.
- Images are published on GHCR only, no Docker Hub mirror.
- The Helm chart is Nice to have. A later `ha` mode ships with multi-replica support.
- One pnpm monorepo for core, runtimes, CLI, UI, chart and first-party plugins. Plugins declare a peer range on `@package-broker/core` and an integer `apiVersion`. A plugin moves to its own repository only when it is third-party, closed or differently licensed ([ADR-001](licensing-and-contribution-terms.md#adr-001-package-broker-20-is-a-backwards-incompatible-open-source-rewrite-built-rather-than-bought)), or released on a different cadence.
- Release Please in manifest mode with linked product packages and independent plugins; squash merges with a linted PR title.
- Renovate (hosted app) with a three-day minimum release age enforced in Renovate and pnpm; Dependabot alerts on, version updates off. GitHub-owned and internal actions use `@vN`; third-party actions are pinned to a commit SHA with a version comment.
- CI on every pull request in parallel jobs with a 15-minute p50 budget and a 20-minute cap, including `client-matrix` tests with real `composer`, `npm`, `pnpm` and `yarn` against the Node and workerd builds and bundle-inspection assertions.
- npm Trusted Publishing from GitHub Actions for five public product packages (`core`, `cli`, `runtime-cloudflare`, `runtime-node`, `ui`) plus public first-party plugins. Signed multi-arch images on GHCR with provenance and SBOM; the Workers bundle as a release asset.
- v2 of the Cloudflare deploy action as a thin composite over `pb cloudflare provision`, `migrate`, `deploy` and `smoke`.
- Release workflows use no personal access token.
- Other release questions keep their recommended defaults.

### Consequences

- Positive: one version story, a short pull-request loop and supply-chain controls; reuse of the trusted-publishing step that already works in v1.
- Negative: a monorepo release tool needs configuration for linked and independent packages; a three-day release-age quarantine delays urgent fixes unless security releases are exempted.
- Follow-ups: the repository and rc release configuration are set up in `package-broker/broker`.

## ADR-027: No stacked pull requests; a feature lands as atomic pull requests behind a flag or as one complete pull request

Status: Accepted, 2026-11-01

### Context

Features were delivered as chains of pull requests, each based on the branch of the one before it. Because pull requests are squash-merged, every merge at the bottom of a chain forced a rebase of every pull request above it, fixes made at the top had to be carried down by hand, and each pull request waited for the one below it before it could enter the merge queue. Conflict resolution during those cascades dropped code that had already been reviewed, and a fix that existed only at the top of a chain left the pull requests below it failing CI.

### Decision

- A pull request targets `main` and never another pull request's branch. A pull request that needs code from an unmerged pull request is not opened until that code is on `main`.
- A feature lands in one of two shapes:
  - a series of atomic pull requests, each merged to `main` on its own, with behaviour that is not yet complete behind a feature flag that is off by default;
  - one pull request whose commits together form the complete feature. Each commit is a reviewable step; the pull request is squash-merged like any other.
- A feature flag hides everything the unfinished feature adds: routes, jobs, admin UI, configuration and published contracts. With the flag off, both runtimes behave exactly as they did before the feature, and a test proves it. The flag is read from the broker configuration, so Cloudflare Workers and Node see the same value.
- A flag is removed by a follow-up pull request once the feature has shipped in a release; flags are not kept as permanent configuration.

### Consequences

- Positive: pull requests are independent, enter the merge queue in parallel and never need a rebase cascade; what is reviewed is what lands.
- Negative: atomic pull requests carry the cost of the flag and of the flag-off test; a single complete pull request is larger to review.
- Follow-ups: a feature-flag section in the broker configuration that both runtimes read.

## ADR-028: Pull requests test only what they change; the release tests everything end to end

Status: Accepted, 2026-11-01

### Context

[ADR-023](#adr-023-repository-strategy-versioning-and-release-process) runs the full suite, including the client matrix against both runtimes, on every pull request. A change to one package or to the documentation therefore pays for the browser tests, the client matrix and both smokes, and the same tree is tested again in the merge queue.

### Decision

- Pull request and merge-queue checks run for the workspace packages a change touches and for every package that depends on them, following the workspace dependency graph.
- Checks that are not tied to one package run when their inputs change: the client matrix when the registry routes, authentication or the matrix harness change; the UI browser tests when the admin UI or its fixtures change; the runtime smokes when a runtime package or its bundle inputs change.
- A change to shared inputs selects everything: the lockfile, the workspace and TypeScript base configuration, the lint and test configuration, and the CI workflows.
- The release pull request opened by Release Please runs the complete suite: every package, both smokes, the UI browser tests and the full client matrix on Cloudflare Workers and Node. A release is not merged until that run is green.
- This supersedes the [ADR-023](#adr-023-repository-strategy-versioning-and-release-process) bullet that runs the full suite on every pull request.

### Consequences

- Positive: a pull request pays only for what it can break; documentation and single-package changes land in minutes.
- Negative: a regression the dependency graph does not see, for example through shared fixtures or runtime-only wiring, surfaces on the release pull request instead of at merge time, and is fixed there by an ordinary pull request.
- Follow-ups: a selection step in CI that computes the affected packages and checks, with tests for the selection rules.
