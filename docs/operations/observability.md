---
title: Observability
sidebar_position: 2
description: Send broker telemetry through OpenTelemetry Collector to an OTLP backend.
---

# Observability

## What the broker emits

The broker emits structured logs, counters, duration histograms and request traces.
Docker writes JSON logs to stdout (debug/info) and stderr (warn/error), and
metric JSON lines to stdout. Workers write structured console records to Workers
Logs and metrics to the configured Analytics Engine binding. OTLP export adds another output on either runtime.
Audit events use their own persistent store; these outputs do not replace it.

OTLP resource attributes are `service.name=package-broker`, `deployment.id` from
`DEPLOYMENT_ID`, and `process.runtime.name=node` or `cloudflare`. The runtime wiring
does not currently set `service.version`. `DEPLOYMENT_ID` must contain 1–64 ASCII
letters, digits, underscores, dots or hyphens.

Request logs use the event `http.request` and include `request_id`, `trace_id`,
`span_id`, method, registered route template, status and duration where available.
`token_id` identifies the authenticated token record, never the token credential;
it is null before token authentication in local logs and omitted when null in
OTLP. It is a log attribute, not a metric label. Local logs call the deployment
field `deployment_id`. Errors contain approved names and reason codes rather than
request data or exception messages.

The runtime derives a server span from each emitted request completion log, named
`METHOD <route template>` (or just the method for an unmatched route). Successful
health checks log at debug, so the default info level also suppresses their spans.
Set the build-config key `observability.level` to change the log level.
Inbound `traceparent` is trusted only when build configuration sets
`observability.trustInboundTraceparent: true`. The broker exports one server span
per request completion that passes the log-level filter. Each upstream request
inside it, redirects included, adds one `upstream.fetch` client span with the
server span as parent. Its attributes are `upstream.origin` (scheme, host and
port of the first hop the outbound policy accepted), `method`, `status` (final
response only), `redirects`, `cross_origin`, `duration_ms` and, on failure,
`outcome`. Refused targets are never recorded. The span ends when response
headers arrive, so failures while reading the body are not reflected. Upstream
spans are exported regardless of the log level. Background jobs export no
upstream spans. No configuration enables upstream `traceparent` propagation in
this release. Upstream activity also appears as `pb.upstream.requests` and
`pb.upstream.duration_ms` metrics. Cloudflare's platform tracing is a separate
source of spans; see [Workers tracing](../workers-install.md#tracing).

Metrics include `pb.http.requests`, `pb.http.duration_ms`, cache/blob operations,
job execution and upstream counters and histograms. OTLP sums and histograms use
delta temporality. `pb.obs.export_failures` counts unsuccessful exports. On Node,
this counter goes to the OTLP sink, so an unavailable Collector can also prevent
its delivery. On Workers, it goes to the Workers sink and its configured Analytics
Engine dataset. Delivery is bounded and best effort; confirm ingestion in the
backend, not just an HTTP success response.

## Turn on OTLP export

The broker sends **OTLP/HTTP JSON**, with `Content-Type: application/json`, to a
base URL plus `/v1/logs`, `/v1/metrics` or `/v1/traces`. Do not include a signal path
in the broker endpoint. It does not send gRPC or HTTP/protobuf.

Each POST has a 1500 ms deadline. Redirects are never followed. Non-2xx responses
and `partialSuccess` responses with rejected items count as export failures.
Between flushes, each signal buffers at most 500 records and 512 KiB. Records
that exceed either limit are dropped and counted in `pb.obs.dropped`, not
`pb.obs.export_failures`.

Environment variable names are chosen at build time. Add these fields to the
existing `platformPorts.node.observability` or
`platformPorts.cloudflare.observability` stanza in `broker.config.ts`, retaining
its other fields:

```ts
// Node
observability: {
  adapter: 'stdio',
  deploymentIdEnv: 'DEPLOYMENT_ID',
  endpointEnv: 'PB_OTLP_ENDPOINT',
  headersEnv: 'PB_OTLP_HEADERS',
},
// Workers
observability: {
  adapter: 'workers',
  analyticsBinding: 'ANALYTICS',
  deploymentIdEnv: 'DEPLOYMENT_ID',
  endpointEnv: 'PB_OTLP_ENDPOINT',
  headersEnv: 'PB_OTLP_HEADERS',
},
```

Rebuild and redeploy for the target runtime. `PB_OTLP_ENDPOINT` and
`PB_OTLP_HEADERS` are the exact names selected by this example, not built-in
variables. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` alone has no effect. Without
`endpointEnv`, OTLP is disabled. If `endpointEnv` is configured, its variable must
be set. If `headersEnv` is configured, its variable must hold a JSON object whose
values are strings; use `{}` for an unauthenticated receiver. To omit the headers
variable entirely, also omit `headersEnv` at build time. This format differs from
the comma-separated header format used by some OpenTelemetry SDKs. For an
authenticated ingress, populate that JSON object with its required headers from
your deployment's secret configuration. Do not put credentials in the URL.

Header names must match `[A-Za-z0-9-]{1,64}`. Values must contain 0–4096 printable
ASCII characters (space through `~`); control characters and non-ASCII characters
are refused. Names are case-insensitive and duplicate names are refused. These
names are also refused: `traceparent`, `tracestate`, `baggage`, `host`,
`content-length`, `content-type`, `connection`, `keep-alive`, `proxy-authenticate`,
`proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`. The broker
sets `Content-Type` itself. Invalid endpoint or header-set validation on Node raises
`StartupConfigError` with `PB_OTLP_ENDPOINT is not a valid OTLP endpoint or header set`
for these example variable names. A malformed header name or value in
`PB_OTLP_HEADERS` is therefore reported under the endpoint variable name,
`PB_OTLP_ENDPOINT`. Missing variables and malformed JSON header objects have their
own startup errors under the affected variable name.

### Docker

Set these variables on the broker container:

```sh
DEPLOYMENT_ID=broker-production
PB_OTLP_ENDPOINT=http://127.0.0.1:4318
PB_OTLP_HEADERS='{}'
```

Run the Collector in the broker's network namespace (for example with Docker's
`--network container:<broker-container>`), so loopback reaches its HTTP receiver.
The broker permits plain HTTP only for loopback in its current runtime wiring.
For a Collector in a separate network namespace, use an HTTPS ingress with a
trusted certificate, for example `https://collector.example.internal`, instead
of a plain HTTP container service address. Keep the receiver on a private network
and expose only the ports your deployment needs.

### Workers

Export the endpoint and headers variables in the shell that runs
`pb cloudflare setup` or `pb cloudflare deploy`. With the build configuration
above, use `PB_OTLP_ENDPOINT=https://collector.example.internal` and populate
`PB_OTLP_HEADERS` with the ingress's JSON header object (or `{}` for an
unauthenticated ingress). Pass `--secret PB_OTLP_HEADERS` to both commands, along
with your other deployment options. The CLI owns these bindings: it stores the
endpoint as a plain Worker var and the headers as a Worker secret, and validates
the endpoint and supplied headers before deployment. It also manages
`DEPLOYMENT_ID` and the configured Analytics Engine binding.

The endpoint shell variable must be present on every deploy; a missing or empty
value fails validation. On `pb cloudflare deploy`, headers validation and secret
updates apply only when `--secret PB_OTLP_HEADERS` is passed. With that flag,
a missing headers shell variable retains an existing secret; deployment fails
validation if no such secret exists. Without the flag, deploy neither validates
nor touches the headers secret. A missing secret then surfaces at request time as
a `KernelConfigError`.

`pb cloudflare setup` sets the headers secret on first setup only; rerunning setup
retains the existing secret. To rotate it, export `PB_OTLP_HEADERS` with the new
value and run `pb cloudflare deploy --secret PB_OTLP_HEADERS` with your other
deployment options.

Use an HTTPS ingress reachable from the Worker and forward its three `/v1/*`
paths to the Collector. See [Workers ingress authentication](#workers-ingress-authentication)
for a receiver with TLS and bearer authentication.

Cloudflare can also export platform Workers logs and traces to OTLP destinations
configured in its dashboard. That path is independent of the broker's port
configuration; enabling both can duplicate logs. See
[Workers tracing](../workers-install.md#tracing).

## Collector recipes

These files target **OpenTelemetry Collector contrib 0.140.1**. Each has an OTLP
HTTP receiver on `127.0.0.1:4318`, followed by `memory_limiter` and `batch` processors.
Replace backend `example.internal` hostnames and provide trusted TLS certificates.
All credentials come from Collector environment variables; they are separate from
broker ingress headers. Authorization variables hold the complete header value,
including the scheme required by the backend or its authentication proxy.

Every recipe defines traces, metrics and logs pipelines. Signals the selected
backend does not take go to the `nop` exporter, which accepts and discards them,
so the broker never counts export failures for those signals. To retain more
signals, combine the required exporters and pipelines into one Collector config,
sharing one receiver and processor definitions. Run one recipe at a time when
using the same listening ports. Before deploying, validate each chosen file with
its referenced environment variables set:

```sh
otelcol-contrib validate --config docs/operations/otel-collector/tempo.yaml
```

### Workers ingress authentication

Use [ingress-auth.yaml](./otel-collector/ingress-auth.yaml) as the receiver and
extension configuration for a Collector behind an HTTPS ingress. Keep the
Collector on loopback and run the ingress in the same network namespace. Forward
all three signal paths over TLS, preserve `Authorization`, and verify the
Collector certificate. Set `OTLP_TLS_CERT_FILE` and `OTLP_TLS_KEY_FILE` to readable
PEM certificate and private-key paths, and `OTLP_INGRESS_TOKEN` to the bearer token
on the Collector. The receiver listens on loopback, so its TLS certificate must
be valid for the name the ingress uses to reach it (`127.0.0.1` or `localhost`).
Receiver configuration:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
        tls:
          cert_file: ${env:OTLP_TLS_CERT_FILE}
          key_file: ${env:OTLP_TLS_KEY_FILE}
        auth:
          authenticator: bearertokenauth
extensions:
  bearertokenauth:
    token: ${env:OTLP_INGRESS_TOKEN}
```

The standalone file enables `bearertokenauth` in `service.extensions` and sends
all three signals to `nop` for ingress validation. Replace its exporters and
pipelines with the selected backend recipe's exporters and pipelines to retain
telemetry. Keep its receiver, extension and `service.extensions` when combining.
Set the broker's `PB_OTLP_HEADERS` secret to a JSON object whose `Authorization`
value is `Bearer ` followed by the same token as `OTLP_INGRESS_TOKEN`. Supply the
certificate/key files as well as environment variables when validating this file.

### Grafana Tempo: traces

Use [tempo.yaml](./otel-collector/tempo.yaml). Enable Tempo's OTLP HTTP receiver on
port 4318 and make it available through the HTTPS endpoint shown in the file.
The `otlphttp/tempo` exporter appends `/v1/traces`. Set `TEMPO_AUTHORIZATION` on the
Collector for your authentication proxy; Tempo itself does not provide an
authentication layer.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above. The broker endpoint points to the Collector.

### Grafana Loki: logs

Use [loki.yaml](./otel-collector/loki.yaml). Loki's native OTLP ingestion accepts
logs at `/otlp/v1/logs`; `otlphttp/loki` uses the base `/otlp`. Enable structured
metadata in Loki. `deployment.id` lands in structured metadata unless Loki's
`otlp_config` promotes it to an index label. Set `LOKI_AUTHORIZATION` on the
Collector for your authentication proxy. For a multi-tenant deployment, add its `X-Scope-OrgID` header from an
`${env:LOKI_TENANT_ID}` reference. The removed `loki` exporter is not used.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above.

### Elasticsearch: logs and traces

Use [elasticsearch.yaml](./otel-collector/elasticsearch.yaml). The `elasticsearch`
exporter writes directly to Elasticsearch over HTTPS. Set
`ELASTICSEARCH_API_KEY` on the Collector to the encoded API key value (without an
`ApiKey` prefix) with permission to write the exporter's data streams. Use an
Elasticsearch deployment compatible with the explicitly selected
`mapping: { mode: otel }`; check the exporter README in contrib 0.140.1 for the
minimum Elasticsearch version required by OTel mode. These are OTel data streams,
not an Elastic APM Server ingestion recipe.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above.

### Graylog: logs through OTLP

Use [graylog.yaml](./otel-collector/graylog.yaml). This recipe uses the Collector's
`otlp/graylog` **gRPC exporter**, not GELF. Create a Graylog OpenTelemetry (gRPC)
input on port 4317 in a Graylog version that supplies that input, enable TLS and
set `GRAYLOG_CA_FILE` on the Collector to the readable PEM CA certificate file
that validates the input's certificate. If an authentication proxy protects the input,
add `headers: { Authorization: '${env:GRAYLOG_AUTHORIZATION}' }` under
`otlp/graylog` and set that variable to its complete authorization header value.
This header is optional and absent from the supplied file. An older Graylog
deployment with only GELF inputs cannot receive this recipe's output.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above. Broker-to-Collector traffic remains HTTP JSON;
only Collector-to-Graylog traffic uses gRPC.

### InfluxDB v2: metrics

Use [influxdb.yaml](./otel-collector/influxdb.yaml). The `influxdb` exporter writes
metrics to the InfluxDB v2 API. Set `INFLUXDB_ORG`, `INFLUXDB_BUCKET` and
`INFLUXDB_TOKEN` on the Collector. Create the destination bucket and grant the
token write access to it. The broker exports delta sums and histograms, while the
exporter needs cumulative metrics; `deltatocumulative` converts them before the
`influxdb` exporter, as in the Prometheus recipe.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above.

### Prometheus: scrape the Collector

Use [prometheus.yaml](./otel-collector/prometheus.yaml). The `deltatocumulative`
processor converts the broker's delta sums and histograms for the `prometheus`
exporter. Resource attributes become metric labels, preserving the deployment
identifier on each series. Configure Prometheus to scrape the Collector:

```yaml
scrape_configs:
  - job_name: package-broker
    static_configs:
      - targets: ['127.0.0.1:8889']
```

The Collector serves `/metrics` at `127.0.0.1:8889`; run Prometheus in the same
network namespace for the scrape target above. Exposing this listener beyond the
host requires protecting the scrape path with network policy or a proxy with
authentication, because the exporter has no authentication. No Collector backend
credentials are needed for this recipe. A native scrape endpoint is planned.

Broker variables: `DEPLOYMENT_ID`, `PB_OTLP_ENDPOINT`, `PB_OTLP_HEADERS`, with the
Docker or Workers values above.
