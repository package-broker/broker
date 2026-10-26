# Release and versioning

Decisions on repository layout, versioning and the release process.

## ADR-023: Repository strategy, versioning and release process

Status: Accepted, 2026-10-15

### Context

The release process has to settle how releases are built, whether plugins live in separate repositories, whether to use Release Please and Renovate, what CI runs on every pull request, how releases run, whether v1's npm publishing is reusable, whether a dedicated GitHub Action for Workers is needed and whether a Helm chart is possible. The Helm chart is Nice to have; the remaining questions are answered by the decisions below.

### Decision

- The 2.0 code lives in a new repository, `package-broker/broker`. v1 is end of life; `package-broker/server` is archived.
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
