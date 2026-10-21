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
