---
title: Outbound notifications
sidebar_position: 4
description: Turn on signed npm notifications, manage project endpoints and understand delivery limits, retention and the Workers egress gate.
---

# Outbound notifications

A project can send a signed HTTPS request to a receiver when a package published to the broker's hosted npm sources changes. This page is for the operator and the project administrator: how to turn the feature on, how endpoints behave, which limits apply and how deliveries leave each runtime. What the receiver gets and how it verifies a request is in [Notification receiver](../integrations/notification-receiver.md).

## Turn it on

Notifications are off unless the build configuration sets `notifications.enabled` to `true`:

```ts
export default defineConfig({
  // ...
  notifications: { enabled: true },
});
```

The value must be exactly a boolean and the block may hold no other key; `pb build` and both runtimes refuse anything else. While the flag is off, package changes record no notification work, no notification job is registered and no delivery is sent. The notification endpoint API remains available whenever migration `0009_npm_notifications.sql` is applied, so endpoints can be managed before delivery is enabled. With the flag on, missing database, authentication, platform services or notification schema prevents startup. With the flag off and the schema missing, the routes are omitted; a failed schema probe logs `notifications.schema_probe_failed` at warn level and omits them. Turning it on does not send anything about changes made before: only changes committed while it is on can be notified. On Cloudflare Workers, run the live egress gate below and keep its passing output before you turn it on.

## Manage endpoints

Endpoints belong to one project. Open the project in the scope switcher and choose **Notifications**, or use the API under `/_pb/projects/{project}/notifications`. Both need a signed-in person with the project settings permission (Project Owner, or Organization Admin for any project). API tokens, service identities and package publishers cannot read or change endpoints. An archived project's endpoints can be neither read nor changed until the project is restored.

Open **Projects**, then choose **Notifications** on the project row. An endpoint has a name, a method (`POST` or `PUT`), the event types it wants, one package filter, and destination settings: the HTTPS URL, optional custom headers, the signing key and an optional `json-v1` body template.

| Action                                        | API                                                                                          | Needs recent sign-in confirmation |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| Add an endpoint                               | `POST /_pb/projects/{project}/notifications`                                                 | Yes                               |
| Change name, method, events or package filter | `PATCH .../notifications/{id}` with `options`                                                | No                                |
| Replace destination settings                  | `PATCH .../notifications/{id}` with `secret`                                                 | Yes                               |
| Enable                                        | `POST .../notifications/{id}/enable`                                                         | No                                |
| Disable                                       | `POST .../notifications/{id}/disable`                                                        | No                                |
| Delete                                        | `DELETE .../notifications/{id}`                                                              | Yes                               |
| Read endpoints, deliveries and attempts       | `GET .../notifications`, `.../{id}`, `.../{id}/deliveries`, `.../{id}/deliveries/{delivery}` | No                                |

Every change to an existing endpoint sends `If-Match: "r<revision>"` with the revision the reader saw (the `ETag` of the endpoint). A stale revision answers 412 and changes nothing; a missing `If-Match` answers 428. When a sign-in confirmation is needed and missing, the API answers 403 with `reauth_required`. The API answers an endpoint of another project exactly like one that does not exist.

A new endpoint starts disabled. Nothing is delivered until someone enables it.

What a change does:

- Any change of name, method, events or package filter, a rename included, increases the endpoint's revision. Deliveries still waiting under the old revision are cancelled as superseded when their turn comes; they are not sent with the new settings.
- Replacing the destination settings replaces the URL, the signing key, the custom headers and the template together. A header or template you do not enter again is removed. The endpoint is disabled (reason: configuration changed) and must be enabled again.
- Changing the selected events while a template is configured requires entering the destination settings again, because the template is checked against the selected events.
- Enabling resets the failure count. It does not send events that happened while the endpoint was disabled, and it does not resend cancelled or failed deliveries.
- Disabling stops new deliveries once it is committed. A request already handed to the network can still arrive.
- Deleting cancels waiting deliveries. Delivery history stays readable until it expires.

Destination settings are write-only. The API and the admin UI show only that a destination, signing key, headers and a template are configured; the URL (which may carry a token in its path or query), header values, key and template are never returned, logged or written to audit records. There is no test-send action. To check a receiver, enable the endpoint and publish or deprecate a test package.

### Destination and header rules

- The URL is `https://` on port 443 with no user name, password, fragment, other port or IP address. Single-label names, local and internal suffixes (`.localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, `.corp`, `.test`, `.example`, `.invalid`, `.onion`) and the broker's own origins are refused. The URL is at most 2,048 characters.
- At most 16 custom headers, with at most 8 KiB of values together. A name is `Authorization` or starts with `X-`; `X-Package-Broker-*`, `X-Forwarded-*`, `X-B3-*`, `X-Real-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `X-Request-ID`, `X-Amzn-Trace-Id` and `X-Cloud-Trace-Context` are refused, as is every other name. Names are compared without case and may not repeat. Values have no control characters.
- The signing key is a random 32-byte key, base64url-encoded without padding (43 characters). Generate it, give it to the receiver, and enter it in the broker; for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
- The package filter is the stored package key with up to four `*` wildcards and at most 50 characters, matched against the whole key. Filters use lowercase letters, digits and `. _ ~ @ ! / -`. `*` also matches `/`, so `@example/*` covers every package of the scope. Packages published with capital letters under older npm rules are stored with `!` before each capital letter (`!my!package` for `MyPackage`); write the filter in that form. Regular expressions are not supported.

## What gets notified

The event types, their fields and the body format are listed in [Notification receiver](../integrations/notification-receiver.md#the-event-body). For operators:

- An event goes only to the endpoints of the project where the change happened. An organization administrator's tombstone has no such project; it notifies every active project the hosted source is attached to.
- Notifications follow the package state. They do not evaluate registry read policy, and the body says nothing about policy.
- One `npm deprecate` request changes at most 64 versions; a larger request is refused with `deprecation_too_many`. Each changed version is one event.
- Publishing never waits for a receiver, and a receiver failure never undoes a package change.

## Retries, failures and automatic disable

Each delivery gets at most eight attempts, planned at 0, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 18 hours and 23 hours 55 minutes after the event, and expires 24 hours after the event. Retries keep at least 5 minutes between attempts and honour `Retry-After` up to one hour. After downtime, missed attempts are not sent in a burst.

The endpoint is disabled immediately when the receiver answers 401 or 403 (reason: credentials), 410 (reason: gone), when the destination is refused before sending (reason: policy) or when the sealed settings cannot be read (reason: credentials). It is also disabled after ten consecutive deliveries end in failure (reason: failures). Disabling cancels its waiting deliveries. Template rendering failures are broker defects: they fail the delivery without increasing the endpoint failure streak. Transient database, cryptography or transport exceptions fail the job for retry and do not disable the endpoint. Fix the cause, then enable a disabled endpoint again.

## Limits and retention

| Limit                                 | Value                                                    |
| ------------------------------------- | -------------------------------------------------------- |
| Endpoints per project                 | 20, deleted ones excluded                                |
| Events per package operation          | 64                                                       |
| Retained events per organization      | 10,000                                                   |
| Retained deliveries per organization  | 10,000                                                   |
| Attempts per delivery                 | 8 (so at most 80,000 retained attempts per organization) |
| Delivery body                         | 16 KiB                                                   |
| Waiting delivery lifetime             | 24 hours                                                 |
| Finished delivery and attempt history | 7 days after the delivery finished                       |

When an organization is at its event or delivery limit, the broker first removes its oldest finished deliveries and orphaned events. If there is still no room, the package change commits without notification work and one `notification.overflow` audit record is written for that operation. Notification delivery is not guaranteed; an overflow is the documented loss. Watch for `notification.overflow` in the audit log.

An hourly job expires waiting deliveries after 24 hours, resolves attempts whose worker vanished as `unknown`, cancels deliveries whose endpoint, project or source admission changed, restarts lost delivery jobs, and removes history older than seven days. Each invocation repairs at most 20 deliveries, restarts at most 20 dispatch operations and prunes at most ten pages with a 100-delivery page limit, leaving additional work for later runs. These bounds keep the worst-case sweep at 362 SQL statements on both Workers and Node, with room for the job runner below the Workers 500-statement limit. It also removes deleted endpoints and their sealed settings once no history refers to them. Audit records follow the audit retention policy, not this one.

## Audit

Configuration changes write `notification.create`, `.update`, `.credential_set`, `.enable`, `.disable` and `.delete` with the endpoint and project IDs, revision, method, events, filter, the names of changed fields and whether headers and a template are configured. Delivery work writes `notification.delivery_started` before each network request, then `.delivery_finished` or `.delivery_cancelled`, `notification.auto_disable` and `notification.overflow`, with IDs, attempt number, fixed outcome codes, status code and duration. No audit record contains a URL, header, key, template, body, receiver response or endpoint name.

## Rotate a signing key

1. Let the receiver accept both the old and the new key.
2. Replace the endpoint's destination settings with the new key (confirm your sign-in). The endpoint is disabled and deliveries waiting under the old settings are cancelled.
3. Enable the endpoint.
4. Remove the old key from the receiver once requests already in flight have finished.

## Delivery transport

Every delivery attempt goes through one internal transport contract. It sends only `POST` or `PUT`, only to `https://` destinations on port 443, with a fixed `application/json` body of at most 16 KiB and a 10-second budget. It never follows a redirect: a 3xx response is a permanent failure. It reads the status and a bounded `Retry-After` header, then cancels the receiver body, so a receiver that never finishes its body cannot hold the connection open. Nothing else from the response is kept.
<!-- source: packages/core/src/notifications/transport.ts -->

Immediately before every attempt the destination is checked again: user information, fragments, control characters, explicit ports, IP literals in any notation, single-label and local names, and the broker's own origins are refused without a connection.

On Node, the destination is resolved on every attempt through the DNS guard with no private-host exception, even when `outbound.allowPrivateHosts` lists the host for sources. Every A and AAAA answer must be public; the connection is made to the address that was checked and TLS is verified against the original host name. Resolution has a 3-second budget. A failed or slow resolution is retried later; a private answer is a policy refusal.
<!-- source: packages/runtime-node/src/notifications/transport.ts -->

On Cloudflare Workers, the broker uses the native `fetch` with `redirect: 'manual'` after the same URL checks. Workers cannot pin the checked address to the connection, so a host name that resolves to a private address is stopped by the Cloudflare egress boundary, not by the broker. The live gate below proves that boundary.
<!-- source: packages/runtime-cloudflare/src/notifications/transport.ts -->

## Live Workers egress gate

A local simulator or a mocked `fetch` cannot show what Cloudflare refuses, so enabling notifications on Workers requires a passing live run of the egress gate. The gate deploys a throwaway Worker named `pb-notify-gate-<random>` to your account through the Cloudflare API, runs every case twice (raw platform `fetch` without the broker's precheck, then the broker transport), deletes the Worker and prints one line of JSON. The JSON holds case identifiers, expectations, outcome kinds, status codes, error class names and Cloudflare error codes when present; destinations, hosts, tokens and account values are never printed. The exit code is 0 only when every case ran live and passed and the prohibited receivers counted zero bytes; 1 when the gate ran and failed; 2 when it could not run.
<!-- source: packages/runtime-cloudflare/scripts/notification-egress-gate.mjs -->

### What you prepare

- A public HTTPS receiver that answers `POST` and `PUT` with a 2xx status (`PB_GATE_PUBLIC_URL`).
- A public HTTPS URL that answers with a redirect to one of the instrumented prohibited receivers (`PB_GATE_REDIRECT_URL`). The redirect must not be followed, so the counter stays at zero.
- A public HTTPS URL that accepts the connection and never answers (`PB_GATE_SLOW_URL`).
- A host name you control whose DNS answer is a private address where an instrumented listener runs (`PB_GATE_PRIVATE_HOST_URL`).
- An `https://<IP literal>/` URL of an instrumented listener on a public address (`PB_GATE_DIRECT_IP_URL`).
- A counter endpoint that returns `{"bytes": <total bytes received by every instrumented prohibited listener>}` (`PB_GATE_COUNTER_URL`, optional bearer token `PB_GATE_COUNTER_TOKEN`). Count bytes received at the TCP socket, before TLS or HTTP parsing, including TLS handshake bytes even when no HTTP request reaches the listener. An HTTP access log or request-body counter does not qualify. The gate reads it before and after the run; any increase fails the gate.

The gate also probes fixed prohibited targets itself: `127.0.0.1`, `10.0.0.1`, `100.64.0.1`, `[::1]`, `169.254.169.254` and `localhost`.

### Running it

The account token needs Workers Scripts edit permission. Build first, because the fixture Worker is bundled from the built core package:

```sh
pnpm build
CLOUDFLARE_ACCOUNT_ID=<account id> \
CLOUDFLARE_API_TOKEN=<token> \
PB_GATE_PUBLIC_URL=https://<receiver>/ok \
PB_GATE_REDIRECT_URL=https://<receiver>/redirect \
PB_GATE_SLOW_URL=https://<receiver>/slow \
PB_GATE_PRIVATE_HOST_URL=https://<controlled host resolving to a private address>/ \
PB_GATE_DIRECT_IP_URL=https://<public IP of a listener>/ \
PB_GATE_COUNTER_URL=https://<counter>/bytes \
PB_GATE_COUNTER_TOKEN=<optional> \
node packages/runtime-cloudflare/scripts/notification-egress-gate.mjs
```

Cases run concurrently within one bounded request. The client retries the read-only readiness probe, then sends the cases once with a 30-second timeout; a failed run is not retried automatically because a public receiver may already have accepted it. Keep the printed JSON as the release evidence. A `blocked` case passes when the call threw, the broker refused it, or the platform answered with an error status; a 2xx or 3xx from a prohibited target fails it. The verdict logic is covered by `node --test scripts/notification-egress-gate.test.mjs`, which uses a fake runner and therefore can never produce release evidence.
