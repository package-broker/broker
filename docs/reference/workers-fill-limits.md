# Workers fill limits and self-origin aliases

The Cloudflare deployment requires Workers Paid. D1 allows 1,000 queries per
Worker invocation on Paid, versus 50 on Free. The ingest planner reserves at most
450 SQL statements per chunk, leaving room for request authentication, session
coordination and enqueueing a continuation. A batch is counted by its SQL
statements in this budget, rather than as one query. Each continuation must run
in a new invocation; do not loop over chunks in one request.

The D1 integration test `ingest-apply.d1.test.ts` runs each full-budget chunk inside
one Worker `fetch` invocation, including both session and job write guards. It
counts statements inside that invocation and checks completion and stale-version
removal after all continuations. Miniflare does not establish the hosted D1 query
limit: the statement count must also be checked against the published limit.

## Metadata sizing

`registry.caps.metadataBytes` limits upstream metadata fetches in the registry
fill path. A provider's smaller limit still applies. The default is **8 MiB
(8388608 bytes) on Cloudflare** and 32 MiB on Node. An explicit
`registry.caps.metadataBytes` overrides the default on either runtime, up to the
32 MiB product maximum. Composer p2 also has its own 16 MiB limit. Large npm
packuments are staged in blob storage and parsed incrementally,
rather than parsed as one 32 MiB JSON object. Byte limits alone do not bound the
number of versions, parsed object size, concurrent fills or CPU cost.

Run the local on-demand fill benchmark after building and bundling:

```sh
pnpm build
pnpm bundle
node scripts/benchmark-fill-workers.mjs
```

The benchmark sends an authenticated first npm metadata request to the production
Worker bundle, with local D1/R2 and an intercepted synthetic upstream. It compares
exactly 32, 8 and 4 MiB documents containing 10,000 versions, with three fresh
Miniflare instances per size. It records response status, applied versions,
queued continuations, elapsed time, workerd process CPU and sampled process RSS.
Use `FILL_BENCH_REPEATS=1` for one pass. It requires permission to bind loopback
sockets and inspect the child process with `ps`.

Host measurements on Darwin arm64 (Apple M5 Pro, Node v24.19.0,
Miniflare 5.20261006.1-alpha, workerd 1.20261006.1) gave the following ranges.
The 4, 8 and 32 MiB cases ran three times each; supplementary 12 and 16 MiB cases
ran twice each. Baseline process RSS was about 155 MiB.

| Document | Wall time (ms) | Process CPU (ms) | Peak RSS (MiB) | RSS growth (MiB) |
| -------- | -------------- | ---------------- | -------------- | ---------------- |
| 4 MiB    | 324–338        | 380–390          | 251.7–253.0    | about 97         |
| 8 MiB    | 452–477        | 510–530          | 269.8–270.4    | about 115        |
| 12 MiB   | 589–608        | 650–670          | 283.6–299.9    | about 129–145    |
| 16 MiB   | 762–810        | 830–860          | 310.9–311.2    | about 156        |
| 32 MiB   | 1375–1421      | 1430–1480        | 392.5–397.5    | about 240        |

Every case applied 92 versions, queued one continuation and returned 503, with
two upstream requests and a valid first fill. The approximate cost was 45 ms of
process CPU and 5 MiB of process RSS per MiB of document, plus fixed overhead.
CPU did not constrain the choice against the 30-second Paid CPU budget. The
8 MiB Cloudflare default is the largest tested size whose whole-process RSS
growth stayed below the 128 MB isolate limit, even if all that growth counted
toward the isolate; 12 MiB and above exceeded that comparison point.

Process RSS includes the local D1/R2 simulators and workerd overhead; it is not
isolate heap usage. Process CPU is also a local proxy, not billed Worker CPU.
These measurements support a conservative default, not a guarantee that the
hosted memory or CPU limit will be met. Dense or non-uniform metadata, concurrent
fills sharing an isolate, and hosted telemetry remain unmeasured. Operators
should check those conditions before raising the cap and may lower it for more
headroom.

## GitHub token source sizing

A GitHub token source reads every winning ref's `composer.json` through the
GitHub API on each package sync step. Per step, the sum of manifest sizes and
the number of GitHub API requests (repository metadata, tag pages, branch
lookups and GraphQL size and text reads) are capped:

| Runtime            | Manifest text | GitHub API requests |
| ------------------ | ------------- | ------------------- |
| Cloudflare Workers | 64 MiB        | 1,000               |
| Node               | 256 MiB       | 5,000               |

Manifests above 1 MiB are skipped and not counted. A source over either ceiling
fails with `too_large` before any manifest text is read, and the sync is retried
like other upstream failures. Below the ceiling, texts are read one batch (at
most 8 MiB of escaped response) at a time while versions are applied.

The catalogue stores at most 256 KiB of metadata per version, so a manifest
larger than that is read but its version is refused. Every continuation of a
package sync reads the manifests again. With 250 KB manifests one step applies
about 33 versions, so a full sync of N such refs takes about
`ceil(N / 33) × (N / 5 + N / 50 + 3)` API requests: about 480 for 256 refs
(64 MB). The 1,000-request Workers ceiling assumes the Workers Paid limit of
1,000 subrequests per invocation; verify it on hosted Workers before
changing it.

Run the GitHub fill measurement without building:

```sh
cd packages/e2e
node src/github-fill-measure.mjs
GH_MEASURE_TAGS=256 GH_MEASURE_BYTES=250000 node src/github-fill-measure.mjs
```

It runs one provider describe in workerd for token and App sources against a
synthetic local GitHub (REST, GraphQL and git smart HTTP with real packfiles).
It drains the versions the way the apply window does, converting and retaining
admitted versions, and records outcome, subrequests, workerd process CPU and
RSS. By default V8 old space is capped at 128 MiB (`GH_MEASURE_HEAP_MIB`, `0`
for no cap) as a local stand-in for the isolate limit.
`GH_MEASURE_UNBOUNDED=1` disables the token ceiling, and
`GH_MEASURE_SOURCE_ROOT` points at another checkout's `packages/*/src` to
measure a different revision.

Host measurements (Darwin arm64, Apple M5 Pro, Node v24.19.0, workerd
1.20261006.1; baseline RSS 58 MiB; N tags plus one branch; 128 MiB V8 cap):

| Source | Manifests                | Outcome                          | Subrequests | Process CPU (ms) | RSS growth (MiB) |
| ------ | ------------------------ | -------------------------------- | ----------- | ---------------- | ---------------- |
| Token  | 256 × 250 KB             | complete, 33 versions per step   | 60          | 230              | 127              |
| Token  | 63 × 1 MiB               | complete, versions refused       | 68          | 260              | 100–102          |
| Token  | 200 × 1 MiB              | `too_large` before any text read | 8           | 10               | 8–9              |
| Token  | 200 × 1 MiB, no ceiling  | complete, versions refused       | 209         | 810              | 105–110          |
| Token  | 200 × 4 KiB              | complete                         | 11          | 20–30            | 19               |
| App    | 63 × 1 MiB, 256 × 250 KB | `too_large`                      | 7–8         | 160–220          | 125–151          |
| App    | 200 × 4 KiB              | complete                         | 5           | 50–60            | 51–53            |

App sources read manifests over git and are bounded by the 24 MiB retained pack
budget on Workers instead of these ceilings; repositories whose manifests and
packs exceed it fail with `too_large`. As with npm, these are process figures
from a local simulator, not hosted isolate memory or billed CPU.

## Custom domains with `pb cloudflare`

For `pb cloudflare setup` or `pb cloudflare deploy` with a custom domain, the hostname's Cloudflare zone must be active in the same account as the Worker. In addition to the account permissions listed in the [Cloudflare quickstart](../getting-started/quickstart-cloudflare.md#what-you-need), the API token needs **Zone Read**, **Workers Routes Edit** and **DNS Edit**, scoped to that zone.

Pass `--domain packages.example.com --public-url https://packages.example.com` to bind the hostname and set the broker's canonical HTTPS origin, replacing both example hostnames with yours. The hostname in `--public-url` must match `--domain`.

`domain_zone_not_found` means no matching active zone was found in the selected account. Check the hostname and account, activate the zone and grant the token access to that zone with the permissions above, then retry.

`domain_zone_ambiguous` means more than one matching active zone was found in the selected account. Resolve the duplicate matching zones so exactly one active zone matches the hostname, then retry.

## Deny every hostname serving the broker

The outbound policy automatically denies the origin of `PB_PUBLIC_URL`. When a
custom domain is used, add the exact `workers.dev` alias and every other active
alias to `registry.outbound.extraSelfOrigins` in `broker.config.ts`:

```ts
registry: {
  outbound: {
    extraSelfOrigins: ['https://package-broker.my-account.workers.dev'],
  },
},
```

Replace `my-account` and the Worker name with the deployed values. Also list any
active environment or preview hostname that can serve the broker. Entries are
exact http(s) origins, with at most 16 extra origins. They are normalized and
participate in the same self-origin deny checks as the public origin, including
redirect targets.

The account subdomain alone does not identify the Worker name, environment names,
preview aliases or custom domains. There is no account-subdomain binding in this
runtime. The broker therefore uses explicit origins instead of inferring aliases
or denying all Workers belonging to an account. If a hostname should not serve
requests, disable that route at deployment time; when disabling `workers.dev`,
set `workers_dev = false` in the Wrangler configuration as well as checking the
deployed setting. Rebuild and redeploy after changing registry configuration.

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and
[workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
