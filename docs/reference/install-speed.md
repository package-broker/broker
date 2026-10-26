# Install speed

The harness measures two Composer operations separately: `install` delivers the
archives pinned in a lockfile; `resolve` looks up metadata and chooses versions
without installing them. Optional Magento Marketplace scenarios use a second
project. Neither measurement includes application startup or broker deployment.

## Methodology

The checked-in `fixtures/bench-install/project/composer.json` and `composer.lock`
select Laravel Framework 12, Guzzle 7, Doctrine DBAL 4, Symfony Console 7,
PHPUnit 12 and PHPStan 2: 77 production packages and 26 development packages.
Development packages are included. Use Node 24, Composer 2 and **PHP >= 8.4.1**
with the required extensions. The lock includes Symfony Clock 8.1 and Symfony
CSS Selector 8.1, which require that PHP version. The harness checks
`php -r 'echo PHP_VERSION;'` before preparation and fails clearly if it is lower.
JSON results include the actual versions, OS, CPU model/count, RAM, UTC date and
broker Git commit.

Each sample times the wall clock from spawning Composer until it exits:

```sh
# install: a copy of the pinned lock is present
composer install --no-interaction --no-scripts --no-plugins --prefer-dist --no-progress
# resolve: a fresh copy of composer.json without any lock
composer update --no-install --no-interaction --no-scripts --no-plugins
```

A locked install does no registry metadata lookup. For the supplied lock,
`upstream-direct` follows GitHub distribution URLs (including GitHub API redirects
to codeload.github.com); `broker-proxy` downloads archives from the local broker,
which proxies those upstream archives. Install includes extraction and normal
autoload generation. `composer dump-autoload` is not timed separately.

Resolve uses Packagist metadata at repo.packagist.org for `upstream-direct` and
broker metadata for `broker-proxy`, with packagist.org disabled in the latter.
Resolution may choose newer versions than the supplied lock because it uses the
project's version constraints. It does not download or extract archives.

| Scenario             | Install archive host                           | Resolve metadata host                          |
| -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `upstream-direct`    | GitHub/codeload URLs recorded in the lock      | repo.packagist.org                             |
| `broker-proxy`       | Loopback broker, proxying upstream archives    | Loopback broker with a Packagist proxy source  |
| `marketplace-direct` | repo.magento.com plus locked public dist hosts | repo.magento.com and repo.packagist.org        |
| `broker-marketplace` | Loopback broker, proxying both sources         | Loopback broker with Marketplace and Packagist |

The broker runs on loopback over plain HTTP while direct requests use TLS.

Direct generated composer.json files leave `repositories` absent. Marketplace's
direct metadata repository is configured in the temporary Composer home's
`config.json`, with Packagist remaining enabled. Broker projects list only the
broker repository and disable packagist.org. Changing repositories can produce
Composer's lock content-hash warning for the broker install scenario; the temporary
lock preserves the pinned versions and references. The supplied files are unchanged.

Neither install scenario performs metadata lookups during the timed install.
Before timing a broker install, the harness fetches pinned-package metadata and
rewrites temporary lock dist URLs to verified broker archive URLs, removing source
checkout fallbacks. Direct installs use the supplied lock without metadata
preparation. Thus broker install `cold` means cold archive storage with prepared
metadata. Packagist-only resolve `cold` starts with a fresh broker and empty
Composer metadata cache. Warm resolve still makes conditional metadata requests.
Project copying, broker startup, admin/source/token setup and first-use Magento
fixture creation are outside both timers.

Marketplace registers only names whose locked dist URL has host repo.magento.com
on the Marketplace source. All other names remain with the Packagist source.
Non-proxy sources are considered before proxies, so registered Marketplace names
win over Packagist proxy candidates. Project-level ownership is considered next;
ascending precedence breaks ties within that ordering. Marketplace uses precedence
0 and Packagist 100. The Marketplace resolution universe is limited to registered
names from its fixture lock; new Marketplace dependencies can require a refreshed
fixture. After enabling the Marketplace source, preparation calls
`POST /_pb/sources/<id>/sync`, expects 202, and waits up to three minutes until the
first registered name has versions served from `/bench/p2/`. This happens before
both install and resolve timers, so Marketplace resolve `cold` includes this
initial metadata synchronization.

The runtime uses the `pnpm bundle` Node output. Initial setup-token issuance uses
`pb admin bootstrap`; account setup, reauthentication, project/source management
and read-only token creation use HTTP.

Repetitions are interleaved: repetition 1 of every scenario/measurement, then
repetition 2, and so on. Within a scenario/measurement/repetition these states run
in order, each with its own home, cache, project and vendor directory:

| Cache state   | Composer cache               | Broker storage                              |
| ------------- | ---------------------------- | ------------------------------------------- |
| `cold`        | Empty, including metadata    | Fresh database/blob root                    |
| `warm-broker` | Empty, including metadata    | Retained from preceding sample; broker only |
| `warm`        | Copied from preceding sample | Retained for broker scenarios               |

Install and resolve have independent broker lifetimes and caches. Vendor directories
always start empty; resolve project copies never contain a lock. Authentication is
written only to a mode 0600 `auth.json` in the temporary home. Homes and broker data
are removed after use. Caches and install directories remain for inspection under
`.pb/bench-install/session-*`; remove them when finished.

SIGINT and SIGTERM kill the running Composer child, stop the broker, remove the
entire interrupted session (including every temporary home and broker database),
and exit 130. SIGKILL cannot be handled: inspect `.pb/bench-install/session-*`
for remaining `home/auth.json`, broker databases and runtime directories, remove
the affected session, and stop any surviving benchmark processes.

Composer has a 30-minute timeout, configurable with `--timeout-minutes`. A timeout
records exit code 124 and `timedOut: true`. Other failed samples retain their exit
codes and are excluded from statistics. A failed cache fill marks dependent states
as failed. Preparation failures record zero elapsed time and exit code 1. The
harness exits nonzero if a selected scenario/measurement has no successful sample.
Install package counts come from Composer's installed manifest; resolve has no
installed packages. `bytesDownloaded` is omitted because Composer 2 does not report an aggregate
download byte count. Subprocess output and HTTP response bodies never enter results.
Set `PB_BENCH_DEBUG=1` to print broker preparation errors for troubleshooting;
these diagnostics contain no credentials.

## Reproduce

From the repository root, with dependencies installed:

```sh
pnpm build
pnpm bundle
node scripts/bench-install.mjs --help
pnpm bench:install --dry-run
pnpm bench:install --runs 5 --timeout-minutes 30 --scenarios upstream-direct,broker-proxy --out .pb/bench-install/results.json
```

Dry-run prints the concrete base directory, per-sample directories, Composer argv
arrays and `pb admin bootstrap` argv without starting processes. Its session path
is a concrete preview; a measured invocation allocates a unique session directory.
The harness prints separate install and resolve Markdown tables and writes
individual samples to JSON. Keep the JSON alongside published tables.

To include Marketplace, set both `PB_BENCH_MAGENTO_PUBLIC_KEY` and
`PB_BENCH_MAGENTO_PRIVATE_KEY`, then run:

```sh
pnpm bench:install --runs 5 --scenarios marketplace-direct,broker-marketplace --out .pb/bench-install/marketplace-results.json
```

Without both keys, Marketplace scenarios print `skipped: no repo.magento.com keys`
and contribute no rows. On first use, the harness creates the fixture with:

```sh
composer create-project --no-install --no-interaction --no-scripts --no-plugins --repository-url=https://repo.magento.com/ magento/project-community-edition fixtures/bench-install/magento
```

If it has no lock, preparation runs
`composer update --no-install --no-interaction --no-scripts --no-plugins --prefer-dist --no-progress`.
These commands also have the configured timeout and use temporary authentication.
Later runs reuse that fixture lock. Record the resolved Magento version and keep
the same fixture when comparing machines or commits. Marketplace access and its
required PHP extensions must be available.

## Results

Results are published after the first measured run.

### Install

| Scenario | Cache state | Successful runs | Median ms | Min ms | Max ms |
| -------- | ----------- | --------------: | --------: | -----: | -----: |

### Resolve

| Scenario | Cache state | Successful runs | Median ms | Min ms | Max ms |
| -------- | ----------- | --------------: | --------: | -----: | -----: |

## Variance

Install varies with network latency/throughput, GitHub codeload and Marketplace
archive/CDN cache state, CPU contention, filesystem performance and PHP extensions.
Resolve also varies with packagist.org load, Marketplace metadata service load and
solver choices. A cold local cache does not imply a cold upstream CDN. Loopback
measurements do not describe a remote broker's network path. Interleaving reduces
time-order effects but does not eliminate them; change scenario order and repeat
when checking consistency.

## What this means

The tables will compare archive installation and metadata resolution separately
for these projects, environments and cache states. They cannot establish timings
for other projects, networks, registry deployments or application startup.
