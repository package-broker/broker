# Package Broker 2.0

Package Broker is a self-hosted, open-source (AGPL-3.0-only) private Composer and npm registry with role-based access control per project. It runs on Cloudflare Workers or your own Node host with Docker. The current implementation serves Composer and npm registries and includes a web UI, personal access and service tokens, package sources including Packagist and npmjs proxy sources, and SSO through Cloudflare Access or OIDC.

Visit [package.broker](https://package.broker), follow the [Cloudflare quickstart](https://package.broker/docs/getting-started/quickstart-cloudflare) or [Docker quickstart](https://package.broker/docs/getting-started/quickstart-docker), or read the [comparisons](https://package.broker/compare). The container image is not published yet.

> Pre-release. The 2.0 line is published as release candidates under the npm `rc` tag (`npm i @package-broker/cli@rc`); the API and the plugin contract can still change, and contributions are welcome under the Developer Certificate of Origin, see [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute. Security reports are welcome at any time, see [SECURITY.md](SECURITY.md).

## Prerequisites

- Node 24 (see `.nvmrc`) and pnpm (`corepack enable`; the version is pinned in `package.json`).
- For the Cloudflare runtime: a Cloudflare account on the Workers Paid plan, and the `nodejs_compat` compatibility flag on the Worker. The bundle imports `node:async_hooks` to scope deferred work to the request that started it, and `node:buffer` and `node:zlib` for the package codecs; `packages/runtime-cloudflare/wrangler.toml` already sets the flag.

## Packages

| Package                              | Purpose                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `@package-broker/core`               | Plugin API (`./plugin`) and config API (`./config`)                                                                        |
| `@package-broker/runtime-cloudflare` | Worker entry                                                                                                               |
| `@package-broker/runtime-node`       | Node HTTP entry                                                                                                            |
| `@package-broker/cli`                | `pb` commands: `build`, `migrate`, `bootstrap`, `cloudflare`, `secrets`, `admin`, `import`, `source`, `openapi`, `version` |
| `@package-broker/ui`                 | Static UI assets                                                                                                           |
| `@package-broker/ui-assets`          | Build-time bridge that hands the UI to `pb build`                                                                          |
| `@package-broker/plugin-*`           | First-party plugins (`sso-oidc`, `github`)                                                                                 |

## Source selection

Narrowing a source's package list, patterns, registered names or npm scopes stops refreshing packages outside the current selection. Those packages keep their status, metadata and visibility; narrowing does not mark them absent or include them in the mass-removal share. Widening the selection resumes refreshing them. Only upstream absence within the current selection can use the existing guarded removal path. There is no separate `outside_selection` status or flag.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm --filter @package-broker/e2e exec playwright install chromium
pnpm check
```

`pnpm check` includes required UI browser tests and needs Chromium (`playwright install chromium`).

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

## Node client IP behind a proxy

Node records the socket peer address in sessions and audit `source_ip` by default,
ignoring `cf-connecting-ip`, `x-forwarded-for` and `forwarded`. Set `PB_TRUSTED_PROXY=1` only when
Node is reachable exclusively through a trusted proxy that removes client-supplied
values and writes these headers. `PB_TRUSTED_PROXY=0` (or unset) keeps the default;
other values fail startup. Programmatic servers use `trustedProxy: true`.

When enabled, `cf-connecting-ip` takes precedence over the first `x-forwarded-for`
entry, followed by the first `forwarded` element's `for` parameter. Missing, empty
or invalid selected values fall back to the socket address (or `null` without a
socket peer). Both IPv4 and IPv6 literals are accepted, including bracketed IPv6
with a port in `forwarded`.
Cloudflare's client IP handling is unchanged.

## Operating sources

### GitHub token source request ceiling

Token sources list tags in pages of 100, with at most 500 pages per sync. A full
500th page fails with the stable `invalid_response` code rather than publishing
an incomplete tag list. This means fewer than 50,000 tags can be listed in a
successful sync. Configured branches are looked up individually, with four
requests in flight at a time; workers stop taking new branches after a failure.

For N selected winning refs, manifest sizes take `ceil(N / 100)` GraphQL requests.
Text reads take up to N further requests in the worst case (1 MiB manifests),
with smaller manifests batched under an 8 MiB escaped response budget. Add one
repository metadata request for describing the package, one discovery request
(`contents/composer.json` when no package name is configured, otherwise another
repository metadata request), and the tag and configured branch requests. Large
tag histories can therefore consume thousands of API requests per sync; GitHub
rate limits pause the sync with a bounded retry time.

Each package sync step has a ceiling on manifest text and on GitHub API requests
(every request of the step, including repository metadata and tag pages):

| Runtime            | Manifest text (sum over winning refs) | GitHub API requests |
| ------------------ | ------------------------------------- | ------------------- |
| Cloudflare Workers | 64 MiB                                | 1,000               |
| Node               | 256 MiB                               | 5,000               |

Manifests above 1 MiB are skipped and do not count. The text check runs after
the size requests and before any text is read. A source over either ceiling
fails with the stable `too_large` code and is retried like other upstream
failures; it does not publish a partial version list. Manifest texts are read
one batch at a time, so memory stays bounded below the ceiling. The Workers
request ceiling assumes the Workers Paid limit of 1,000 subrequests per
invocation, still to be verified on hosted Workers. See
[Workers fill limits](docs/reference/workers-fill-limits.md) for the
measurements.

### Accepting a refused source removal

A source sync refuses to remove packages when the removal would exceed the share guard (25% of the
source, exempting sources below 10 packages). A refusal changes nothing in the catalogue and does
not pin the source: the next sync lists again and applies the guard again. The last refusal (time,
absent, listed and successfully fetched counts) is shown on the source (`lastRemovalRefusal`).

An organization admin can arm a one-shot acceptance with `POST /_pb/sources/:source/accept-removal`
(no body). It returns 204, 404 for an invisible source, and 409 when the source has no recorded
refusal, an acceptance is already armed, or the last refusal had no successfully listed packages.
The CLI uses the same endpoint:

```sh
pb source accept-removal --url https://broker.example.com --source <source-id>
```

Set `PB_SESSION` and `PB_CSRF_TOKEN` from the admin session in the environment. The acceptance is
audited as `source.removal_accepted` with the source id and the refusal facts it accepts
(`removalAcceptanceArmed` on the source shows it). The next finalize that the guard would refuse
applies once, only if it removes no more than the accepted absent count, and consumes the
acceptance with a `source.removal_applied` audit row. A larger removal is refused again and disarms
the acceptance. Any other completed sync clears an unused acceptance and
the recorded refusal. Incomplete listings and invalid candidate evidence still refuse finalization.

## Versioning

Releases are cut by Release Please with the prerelease strategy: the product packages (`core`, `cli`, `runtime-cloudflare`, `runtime-node`, `ui`) share one version through a `linked-versions` group and ship as `2.0.0-rc.X`, while each `plugin-*` package versions independently as `0.1.0-rc.X` until GA, with tags in the form `<component>-v<version>`. A Docker image published to GHCR with all first-party plugins is planned (T835).

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).
