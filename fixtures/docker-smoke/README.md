# Docker functional smoke fixture

The smoke image uses a dedicated config. It preserves the root bundle configuration and allows only `fixture:8443` as a private upstream. Production defaults remain unchanged. The fixture uses HTTPS because the broker refuses plain HTTP upstreams; the smoke generates a one-day certificate and trusts it with `NODE_EXTRA_CA_CERTS`.

On a Docker host, run from a clean checkout with:

```sh
pnpm smoke:docker --functional
```

Without `--image`, the script builds `pb:docker-smoke` with `--build-arg CONFIG=fixtures/docker-smoke/broker.config.ts` and pulls `composer:2` before running the checks. The build has a ten-minute timeout; the Composer pull has a two-minute timeout. This path needs network access for uncached build inputs and Composer. The functional containers themselves use `--pull never` and an internal Docker network.

To reuse prebuilt images without building or pulling, prepare both images beforehand and pass `--image`:

```sh
docker build --build-arg CONFIG=fixtures/docker-smoke/broker.config.ts -t pb:test .
docker pull composer:2
pnpm smoke:docker --image pb:test --functional
```

Source creation uses the canonical URL `https://fixture:8443/`, a complete Composer repository config selecting `docker-smoke/fixture`, and `pollIntervalSeconds: 60`. It registers `docker-smoke/fixture` before enabling the source, then attaches it with a `PUT` and `{}` body. It reads the project's source list to verify attachment and enabled status, and the source's registered-name list to verify the fixture name. A source-creation HTTP 400 with `code="invalid_request"` and detail path `/body/url` can indicate that the image was built with the default configuration. Rebuild with the `CONFIG` argument above; changing the URL to HTTP cannot bypass the outbound policy.

If read-token issuance returns HTTP 403 with `code="reauth_required"`, the script calls `POST /_pb/auth/local/reauth` with the setup password and a freshly computed TOTP, using the session, Origin and CSRF headers. Setup consumes its TOTP time step, so the script waits for the next 30-second step if needed. It then retries the identical token request once, immediately after successful reauth. Reauth failure, a second token denial or another issuance error stops the smoke; there is no retry loop. The password, provisioning secret and both TOTP codes remain private and covered by the secret sentinel and diagnostic scrubber.

The host needs `openssl`. The fixture and broker join a unique internal Docker network. Composer shares the broker's network namespace, so the Node-accepted public origin `http://127.0.0.1:8787` also reaches the broker from Composer and appears in the lock file. Composer disables Packagist and uses empty, temporary home and cache directories. The package has no dependencies, scripts or plugins. The functional smoke runs its HTTP requests through `docker exec` using the broker's existing Node runtime. Readiness, setup, session management and authenticated metadata requests all reach that same loopback origin; no host route to a container IP or published functional port is needed on Docker Desktop or Linux. Session requests retain their Origin and session/CSRF headers. Startup requires Docker health and HTTP 200 from `/health/ready`, with a 60-second deadline and each HTTP probe capped at two seconds and the remaining deadline. Before starting Composer, the smoke polls authenticated package metadata for the fixture version, with its own 180-second deadline. Node claims queued jobs every second, but source polling runs on a minute schedule, first due at the next minute boundary. The longer ingestion window allows source polling, dispatch, package fanout and another polling attempt. OpenAPI exposes no management sync or refresh operation.

After ingestion succeeds or fails, the smoke reads `GET /_pb/projects/smoke/sources` again and prints only the fixture source's attachment, status, polling interval and `lastSuccessAt`. The source API exposes no last-error code, so the diagnostic explicitly reports `lastErrorCode: "not exposed by source API"`. A failed diagnostic read prints an unavailable message without replacing the ingestion failure. The normal failure diagnostics still include scrubbed broker logs. The fixture root advertises the package in `available-packages`, with `/p2/%package%.json` metadata and an empty dev response at `/p2/docker-smoke/fixture~dev.json`.

The broker mounts only the public CA file, read-only at `/tmp/fixture.crt`, with mode `0644`. Its fresh `/data` volume is initialized by normal container startup; certificate staging never copies into it. The fixture mounts the private directory to read its certificate key; the broker receives only the public certificate.

The script captures subprocess output and broker logs privately. It checks the captured output for the generated credentials before reporting success. Structured HTTP responses carry expected setup/session/token credentials privately, as host HTTP responses did; transport stderr remains covered by the secret sentinel. Every non-2xx functional HTTP response contributes a scrubbed diagnostic with its status, method, path, error envelope `code` and `details` paths. Repeated identical diagnostics are printed once after cleanup, including responses recovered by readiness or ingestion retries. Missing or malformed envelopes report an unavailable code and empty paths; response messages, values and other body fields remain private. On failure it also prints the failing container's last 40 log lines and exit state, redacting credentials and account e-mails. Broker diagnostics include the readiness probe target, last HTTP status or allowed error code, and last Docker health status. If Docker cannot provide logs or exit state, it prints a fixed unavailable message. It also checks the installed PHP file and the lock's broker dist URL. Temporary containers (including anonymous volumes), the named data volume, the internal network, credentials, certificates and the throwaway Composer project are removed on success, failure and handled interruption.

Run the daemon-free tests with:

```sh
node --test scripts/docker-smoke.test.mjs
pnpm vitest run --project cli src/docker-smoke.test.ts
```
