# Package Broker 2.0

A package registry broker for Composer and npm that runs on Cloudflare Workers or on Node. This repository is the 2.0 monorepo skeleton: the build composition, versioning, dependency and CI mechanisms are wired; there are no product features yet.

> Pre-release. The 2.0 line is under active development towards its first release candidate: no tagged release exists yet, the API and the plugin contract still change, and contributions are welcome under the Developer Certificate of Origin, see [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute. Security reports are welcome at any time, see [SECURITY.md](SECURITY.md).

## Prerequisites

- Node 24 (see `.nvmrc`) and pnpm (`corepack enable`; the version is pinned in `package.json`).
- For the Cloudflare runtime: a Cloudflare account on the Workers Paid plan.

## Packages

| Package                              | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `@package-broker/core`               | Plugin API (`./plugin`) and config API (`./config`) |
| `@package-broker/runtime-cloudflare` | Worker entry                                        |
| `@package-broker/runtime-node`       | Node HTTP entry                                     |
| `@package-broker/cli`                | `pb` command: `build`, `version`                    |
| `@package-broker/ui`                 | Static UI assets                                    |
| `@package-broker/plugin-*`           | First-party plugins (`sso-oidc`, `github`)          |

## Develop

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Build with a plugin set

The enabled plugins are listed in `broker.config.ts`. Enabling a plugin means adding its package as a dependency, adding it to that list, and rebuilding.

```sh
pnpm build
pnpm pb build --config broker.config.ts --target cloudflare   # or --target node
```

`pb build` validates the plugin set, writes `.pb/<target>/generated/manifest.ts` and `manifest.json`, and bundles the runtime entry for the target to `.pb/<target>/worker.js` (Cloudflare) or `.pb/<target>/server.js` (Node) with `metafile.json`.

`pnpm check:treeshake` builds the `minimal` fixture (`fixtures/minimal.config.ts`) and fails if any `plugin-*` package appears in its bundle.

## Versioning

Releases are cut by Release Please with the prerelease strategy: the product packages (`core`, `cli`, `runtime-cloudflare`, `runtime-node`, `ui`) share one version through a `linked-versions` group and ship as `2.0.0-rc.X`, while each `plugin-*` package versions independently as `0.1.0-rc.X` until GA, with tags in the form `<component>-v<version>`. The Docker image is published to GHCR only and compiles in all first-party plugins.

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).
