# Package Broker 2.0

A package registry broker for Composer and npm that runs on Cloudflare Workers or on Node. This repository is the 2.0 monorepo skeleton: the build composition, versioning, dependency and CI mechanisms are wired; there are no product features yet.

> Pre-release. The 2.0 line is under active development towards its first release candidate: no tagged release exists yet, the API and the plugin contract still change, and contributions are welcome under the Developer Certificate of Origin, see [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute. Security reports are welcome at any time, see [SECURITY.md](SECURITY.md).

## Prerequisites

- Node 24 (see `.nvmrc`) and pnpm (`corepack enable`; the version is pinned in `package.json`).
- For the Cloudflare runtime: a Cloudflare account on the Workers Paid plan, and the `nodejs_compat` compatibility flag on the Worker. The bundle imports `node:async_hooks` to scope deferred work to the request that started it, and `node:buffer` and `node:zlib` for the package codecs; `packages/runtime-cloudflare/wrangler.toml` already sets the flag.

## Packages

| Package                              | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `@package-broker/core`               | Plugin API (`./plugin`) and config API (`./config`) |
| `@package-broker/runtime-cloudflare` | Worker entry                                        |
| `@package-broker/runtime-node`       | Node HTTP entry                                     |
| `@package-broker/cli`                | `pb` command: `build`, `version`                    |
| `@package-broker/ui`                 | Static UI assets                                    |
| `@package-broker/ui-assets`          | Build-time bridge that hands the UI to `pb build`   |
| `@package-broker/plugin-*`           | First-party plugins (`sso-oidc`, `github`)          |

## Source selection

Narrowing a source's package list, patterns, registered names or npm scopes stops refreshing packages outside the current selection. Those packages keep their status, metadata and visibility; narrowing does not mark them absent or include them in the mass-removal share. Widening the selection resumes refreshing them. Only upstream absence within the current selection can use the existing guarded removal path. There is no separate `outside_selection` status or flag.

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

`pb build` validates the plugin set, writes `.pb/<target>/generated/manifest.ts` and `manifest.json`, and bundles the runtime entry for the target to `.pb/<target>/worker.js` (Cloudflare) or `.pb/<target>/server.js` (Node) with `metafile.json`. The generated config import is relative to `manifest.ts`, keeping absolute build-machine paths out of the generated source, source map and metafile.

`broker.config.ts` selects the UI with `assets: [defineAssets({ kind: 'ui', provider: '@package-broker/ui-assets' })]`. The declaration is inert: `pb build` resolves the provider, checks the UI manifest and stages the files into `<out>/assets` beside the bundle, with the deployment descriptor in `<out>/assets.json`. A config without `assets` builds a headless broker. Run `pnpm build` before `pnpm bundle` so the UI output exists.

The Worker serves the staged files through the `ASSETS` binding, with the Worker running first so every request passes the runtime:

```toml
[assets]
binding = "ASSETS"
directory = "../../.pb/cloudflare/assets"
run_worker_first = true
html_handling = "none"
not_found_handling = "none"
```

With a custom output directory (`pb build --out <dir>`), point `directory` at `<dir>/assets`. On Node, `server.js` reads the `assets` directory next to it, so deploy the whole output directory.

Plugin code may import only the `@package-broker/core` root and `@package-broker/core/plugin`. Every other `@package-broker/core/*` subpath is internal and may change in any release; an architecture test enforces this for the first-party plugins.

`pnpm check:treeshake` builds the `minimal` fixture (`fixtures/minimal.config.ts`) and fails if any `plugin-*` package appears in its bundle.

## Keyring recovery and startup

Apply migrations before bootstrapping an organization with `PB_ORG_SLUG` and `PB_ORG_NAME`.
With `PB_MIGRATE=off`, Node can wait for externally applied migrations and keeps requests
unready until keyring verification succeeds. Organization bootstrap requires that gate to
have succeeded at startup.

If key-dependent rows exist but the keyring verifier has been lost, restore and verify the
master key configuration before setting `PB_KEYRING_RESEED=1` for one start. Re-seeding
trial-decrypts one credential per used key version before recording a verifier and refuses
keys that cannot authenticate those credentials. When there are no credential rows,
re-seeding is blind: token and password hashes cannot prove that the configured master keys
are correct. Credentials also cannot prove a key version used only by hashes. Confirm those
keys from a trusted backup. An existing verifier is never replaced; leaving the switch set
emits `keyring.reseed_ignored` at warn level.

Cloudflare caches a configuration failure for 30 seconds per environment fingerprint.
Changing the configuration gets a new verification attempt immediately. Node shares each
deferred attempt between requests and starts at most one attempt per second.

## Versioning

Releases are cut by Release Please with the prerelease strategy: the product packages (`core`, `cli`, `runtime-cloudflare`, `runtime-node`, `ui`) share one version through a `linked-versions` group and ship as `2.0.0-rc.X`, while each `plugin-*` package versions independently as `0.1.0-rc.X` until GA, with tags in the form `<component>-v<version>`. A Docker image published to GHCR with all first-party plugins is planned (T835).

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).
