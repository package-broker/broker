# Loopback upstream fixtures

Import `startFixtureService` from `./service.js` in an e2e scenario. It returns
`origin`, `controlSecret`, `webhookSecret`, `address`, and an async `close()`.
Always close it in a `finally` block. There is no CLI that prints credentials.
The server binds an ephemeral port on `127.0.0.1`; the host is not configurable.
It uses Hono with a Node HTTP adapter and makes no outbound requests.
`createFixtureApp(origin, options)` exposes the same Hono handlers for in-process
protocol tests. The contract suite exercises both transports; a failed socket
bind fails the HTTP cases and is never converted into a skip or a pass.

Options are `brokerOrigin` (an HTTP(S) origin without credentials),
`webhookSecret` (to match the broker's configured fixture webhook secret), and
`recordedHeaders` (default: authorization, cookie, proxy-authorization).
The control secret is independently generated per server run. Pass it only in
`Authorization: Bearer <controlSecret>` to the control routes.

| Method and route                                     | Behavior                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /p2/fx/lib.json`                                | Packagist v2 metadata, SHA-1 dist digest and local ZIP URL.                                                                           |
| `GET /p2/fx/zip-bomb.json`                           | Metadata pointing to the bounded ZIP bomb.                                                                                            |
| `GET /p2/fx/oversized.json`                          | Oversized JSON manifest response.                                                                                                     |
| `GET /p2/fx/oversized-archive.json`                  | Metadata pointing to the ZIP containing an oversized manifest.                                                                        |
| `GET /p2/fx/digest-mismatch.json`                    | Metadata with a deliberately incorrect archive digest.                                                                                |
| `GET /packages.json`, `GET /p/*`                     | Live Composer v1 root, provider include, and hash-addressed providers.                                                                |
| `GET /dists/*`                                       | Deterministic ZIPs for the live Composer v1 graph.                                                                                    |
| `GET /composer-v1/*`                                 | Exact original Composer v1 corpus response bytes; see corpus provenance.                                                              |
| `GET /fixture-lib`                                   | npm packument with dist-tags, versions, SHA-1 and SHA-512 SRI.                                                                        |
| `GET /fixture-lib/-/fixture-lib-1.0.0.tgz`           | Deterministic npm tarball.                                                                                                            |
| `GET /git/lib.git/info/refs?service=git-upload-pack` | Git protocol v2 advertisement; requires `Git-Protocol: version=2`.                                                                    |
| `POST /git/lib.git/git-upload-pack`                  | v2 ls-refs or exact recorded local fetch requests. Unknown requests return 400.                                                       |
| `GET /hostile/:name`                                 | Exact corpus bytes, including the two Git responses, raw delta pack and framed delta response. Names are in `../../corpus/README.md`. |
| `POST /_control/mode`                                | JSON `{ "mode": "normal" }`; modes below.                                                                                             |
| `GET /_control/requests`                             | `{ counts, observations, dropped }`.                                                                                                  |
| `POST /_control/reset`                               | Clear counts and observations; mode stays as configured.                                                                              |
| `POST /_control/webhook`                             | Signed GitHub push envelope `{ body, headers }`.                                                                                      |

Modes apply to all upstream routes and leave controls available:

- `normal`: ordinary fixtures.
- `outage`: fixed 503 body.
- `digest-mismatch`: metadata stays unchanged; live Composer and npm archive routes
  return the pinned incorrect bytes.
- `redirect-private`: 302 to `http://10.0.0.1/fixture`.
- `redirect-broker`: 302 to the configured broker origin; rejected if none was supplied.

Counters use fixed method/route identities (for example `GET npm-packument`),
never URLs or query strings. An observation contains that route and a map from
the configured lower-case header names to `present` or `absent`. Header values
are never retained. Assert `observation.headers.authorization === 'absent'`
for credential-containment checks. At most 1000 observations are retained;
`dropped` makes truncation explicit while counters continue to increment.
Control requests are excluded from both counters and the recorder. Request
bodies are bounded at 64 KiB; errors use fixed messages and the service has no
request logger.

The webhook control returns exact UTF-8 JSON bytes and an HMAC-SHA256 GitHub
signature using the separate webhook secret. The scenario harness delivers this
envelope to the broker with its HTTP client. Keeping delivery in the harness
allows the fixture service itself to make zero outbound requests. The event is
synthetic and contains no account e-mail address.

Git is a bounded protocol-v2 replay fixture, not a general Git daemon. The
advertised ref is the one in the existing local recording; its exact fetch
request and full prebuilt pack response are reusable through `gitRecording()`.
The filtered recording deliberately returns an empty body. The delta pack is
available through the hostile byte route for parser rejection scenarios. No
external Git process or public registry is needed to serve any fixture.
