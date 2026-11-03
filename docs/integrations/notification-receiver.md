---
title: Notification receiver
description: Verify, deduplicate and process the signed npm notifications a project sends to your HTTPS endpoint.
---

A project can send a signed HTTPS request to your service when a local npm package changes: a version is published or released, a version or package is unpublished, a deprecation changes or a dist-tag moves. This page is for whoever writes the receiving service. How an administrator turns the feature on and manages endpoints is in [Outbound notifications](../operations/notifications.md).

## What arrives

Each delivery is one `POST` or `PUT` request (the endpoint's configured method) to the configured `https://` URL with a JSON body of at most 16 KiB and these headers:

| Header                       | Value                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `Content-Type`               | `application/json`                                                                      |
| `X-Package-Broker-Timestamp` | Integer Unix seconds when this attempt was signed.                                      |
| `X-Package-Broker-Signature` | `v1=` followed by 64 lowercase hex characters (HMAC-SHA256).                            |
| `X-Package-Broker-Delivery`  | Opaque delivery ID. It is the same on every attempt of this delivery.                   |
| `Idempotency-Key`            | The same value as `X-Package-Broker-Delivery`.                                          |
| `X-Package-Broker-Event`     | Opaque event ID. One event sent to two endpoints has one event ID and two delivery IDs. |

The endpoint's custom headers (for example `Authorization`) are sent too. The broker does not follow redirects and does not read your response body: any 2xx status means delivered.

## Verify every request

The signing key is the random 32-byte key, base64url-encoded without padding (43 characters), that the administrator entered for the endpoint. The broker computes HMAC-SHA256 with that key over these bytes:

```text
v1\n<timestamp>\n<delivery id>\n<event id>\n<method>\n<raw body bytes>
```

`\n` is a single line feed, `<method>` is `POST` or `PUT`, and the body is the exact bytes received, before any JSON parsing or re-encoding. Every retry is signed again with a fresh timestamp; the body, delivery ID and event ID do not change.

Reject a request unless all of these hold, in this order:

1. The timestamp is within 300 seconds of your clock, in either direction. Keep the receiver's clock synchronized.
2. The signature matches, compared in constant time.
3. The delivery ID has not been processed before. Keep processed delivery IDs for at least seven days.

This Node module (no dependencies) does exactly that. Store the processed IDs in the same transaction as the work you do, so a crash cannot record one without the other; the in-memory `Map` here stands in for that store.

```js title="receiver.mjs"
import { createHmac, timingSafeEqual } from 'node:crypto';

const WINDOW_SECONDS = 300;
const KEEP_SECONDS = 7 * 24 * 60 * 60;

export function createReceiver({
  signingKey,
  handle,
  seen = new Map(),
  now = () => Math.floor(Date.now() / 1000),
}) {
  const key = Buffer.from(signingKey, 'base64url');
  if (key.length !== 32) throw new Error('The signing key must be 32 bytes, base64url encoded');

  const inFlight = new Map();

  return async function receive({ method, headers, body }) {
    const timestamp = headers.get('x-package-broker-timestamp') ?? '';
    const signature = headers.get('x-package-broker-signature') ?? '';
    const deliveryId = headers.get('x-package-broker-delivery') ?? '';
    const eventId = headers.get('x-package-broker-event') ?? '';
    if (method !== 'POST' && method !== 'PUT') return 'rejected';
    if (!/^[1-9][0-9]{0,15}$/.test(timestamp) || deliveryId === '' || eventId === '')
      return 'rejected';
    const current = now();
    if (Math.abs(current - Number(timestamp)) > WINDOW_SECONDS) return 'rejected';

    const match = /^v1=([0-9a-f]{64})$/.exec(signature);
    if (match === null) return 'rejected';
    const expected = createHmac('sha256', key)
      .update(`v1\n${timestamp}\n${deliveryId}\n${eventId}\n${method}\n`)
      .update(body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(match[1], 'hex'))) return 'rejected';

    for (const [id, expires] of seen) if (expires <= current) seen.delete(id);
    // Wait for this delivery's previous handler; a failed handler leaves it retryable.
    while (inFlight.has(deliveryId)) await inFlight.get(deliveryId);
    if (seen.has(deliveryId)) return 'duplicate';
    let release;
    inFlight.set(
      deliveryId,
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    try {
      await handle(JSON.parse(Buffer.from(body).toString('utf8')));
      seen.set(deliveryId, now() + KEEP_SECONDS);
      return 'accepted';
    } finally {
      inFlight.delete(deliveryId);
      release();
    }
  };
}
```

Answer `duplicate` with a 2xx status too: the broker only retries when it did not see a 2xx, so a duplicate means an earlier response was lost, and repeating the work would apply it twice. Answer `rejected` with 401. A 401 or 403 disables the endpoint for repair, so a key mismatch shows up in the broker instead of retrying for a day.

The in-flight map serializes one receiver instance. Multiple processes must use a shared transactional claim with the business work and processed ID. A handler failure releases the claim without recording the ID, so a waiting retry can try again.

Test vectors include valid POST/PUT, body/method/header tampering, stale timestamps, sequential replay, **two concurrent valid replays** (one accepted, one duplicate, one application of work), and an in-flight handler failure followed by a successful retry.

A broker test (`packages/core/src/notifications/receiver-vectors.test.ts`) runs this exact code block against signatures made by the broker's own signer, so the sample and the broker cannot drift apart.

## Delivery guarantees

Delivery is at least once within a bounded window, not exactly once. A request can reach you and the broker can still record it as failed or unknown, for example when the connection drops after you answered. Deduplicate on the delivery ID.

Order is not guaranteed. Two events for the same package can arrive in either order, and a retry can arrive after a later event. Use `occurredAt` and the package registry itself when order matters. An event does not promise that the version is still downloadable when you process it.

Each attempt has 10 seconds in total. Respond quickly and do slow work after responding.

| Your response                                  | What the broker does                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Any 2xx                                        | Delivered.                                                                                     |
| 408, 425, 429, any 5xx, network error, timeout | Retried, if attempts and time remain.                                                          |
| 3xx                                            | Permanent failure. Redirects are never followed.                                               |
| 401 or 403                                     | Permanent failure, and the endpoint is disabled until an administrator repairs and enables it. |
| 410                                            | Permanent failure, and the endpoint is disabled as removed by the receiver.                    |
| Any other 4xx                                  | Permanent failure.                                                                             |

A delivery gets at most eight attempts within 24 hours of the event. The attempts are planned at 0, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 18 hours and 23 hours 55 minutes after the event. A retry never starts earlier than its planned time or less than 5 minutes after the previous attempt finished. A `Retry-After` header (seconds or an HTTP date) can push it later; the broker clamps it to between 1 second and 1 hour. A retry that would start 24 hours or more after the event is not sent, and the delivery expires.

Ten consecutive deliveries that end in failure disable the endpoint. Expired deliveries and deliveries out of attempts count toward the ten; an attempt whose result is unknown does not. When an administrator enables the endpoint again, it receives only new events. Nothing missed while it was disabled is sent later.

## The event body

Unless the administrator configured a template, the body is this envelope, encoded as compact JSON:

```json
{
  "schemaVersion": 1,
  "id": "01JC5Z8N3K6W2Q9R4T7V0XA1BD",
  "type": "npm.package.released",
  "occurredAt": "2026-11-01T12:00:00.000Z",
  "operationId": "01JC5Z8N3J4H8M2P6S9U1WY3ZC",
  "organizationId": "01JC5Z7A2B3C4D5E6F7G8H9J0K",
  "projectId": "01JC5Z7B9C8D7E6F5G4H3J2K1M",
  "package": { "ecosystem": "npm", "name": "@example/library", "version": "1.2.3" },
  "data": { "releaseCause": "approval_and_scan" }
}
```

`schemaVersion` is 1; a breaking change will use a new version. All IDs are opaque broker IDs. `package.name` is the npm package name as clients see it. The body never carries an actor, account e-mail, token, source or tarball URL, manifest, readme, description or deprecation message.

| `type`                            | When                                                                                                                             | `package.version`                                        | `data`                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.package.published`           | A version published in this project became active immediately, with no approval or scan hold.                                    | The version.                                             | `{}`                                                                                                                                                                                                                                              |
| `npm.package.released`            | A held version became active for the first time, after approval and/or scanning. A released version never also gets `published`. | The version.                                             | `releaseCause`: `approval`, `scan` or `approval_and_scan`, from the holds the version started with.                                                                                                                                               |
| `npm.package.unpublished`         | A version or the whole package was removed.                                                                                      | The version, or `null` when `removalScope` is `package`. | `removalScope`: `version` or `package`. `removalKind`: `window` for a publisher's unpublish within the unpublish window, `tombstone` for an organization administrator's removal.                                                                 |
| `npm.package.deprecation_changed` | The deprecated state of one version changed, including a change of only the message.                                             | The version.                                             | `deprecated`: `true` or `false`. The message itself is never sent.                                                                                                                                                                                |
| `npm.package.dist_tag_changed`    | A dist-tag was added, moved or deleted.                                                                                          | Same as `data.version`.                                  | `tag`. `previousVersion`: the old target, or `null` when the tag is new. `version`: the new target, or `null` when the tag was deleted. `cause`: `explicit` for a dist-tag command, `unpublish` when removing a version moved or deleted the tag. |

One npm command can produce several events that share an `operationId`: deprecating several versions produces one event per changed version, and an unpublish produces `unpublished` plus one `dist_tag_changed` with `cause: unpublish` for every tag it moved or deleted. A first publish creates its `latest` tag as part of the `published` event, not as a separate tag event. Repeating an identical change (same deprecation state and message, same tag target) produces nothing.

Events are about packages published to the broker's hosted npm sources. Upstream proxy fills, cache refreshes and imports produce none.

### Which project's endpoints receive an event

An event goes to the endpoints of the project in which the change happened, and only to those whose selected events and package filter match. Other projects that share the same hosted source receive nothing. One exception: an organization administrator's tombstone is not made in any project, so it notifies every active project the hosted source is attached to, since those are the projects whose installs change.

Notifications follow the package state and do not evaluate registry read policy. A receiver may hear about a version that a policy rule hides from some installs; the body says nothing about policy.

## Templates

An administrator can replace the envelope with a `json-v1` template. A template is a JSON object or array of literal values in which a string that is exactly `{{path}}` is replaced by one scalar from the event. There are no loops, conditions, helpers or text interpolation: `"Release {{package.name}}"` is refused.

Paths available for every event type: `schemaVersion`, `id`, `type`, `occurredAt`, `operationId`, `organizationId`, `projectId`, `package.ecosystem`, `package.name`, `package.version`. Per type: `data.releaseCause` (released); `data.removalScope`, `data.removalKind` (unpublished); `data.deprecated` (deprecation_changed); `data.tag`, `data.previousVersion`, `data.version`, `data.cause` (dist_tag_changed). A template is checked against every event type the endpoint selects, so it may use a `data.*` path only when every selected type has it. `package.version`, `data.previousVersion` and `data.version` can be `null` where the table above says so.

A template is at most 8 KiB, 8 levels deep and 128 values, and the rendered body is at most 16 KiB. The broker renders the body once per delivery and sends the same bytes on every attempt. Keys `__proto__`, `constructor` and `prototype` are refused.

## Rotate the signing key

There is no overlap period on the broker side, so the receiver carries both keys for a while:

1. Make the receiver accept signatures made with either the old or the new key.
2. In the broker, replace the endpoint's destination settings with the new key. This needs a recent sign-in confirmation, disables the endpoint and cancels deliveries still waiting under the old settings.
3. Enable the endpoint.
4. After the requests already in flight have finished (at most a few seconds), remove the old key from the receiver.

Deliveries cancelled in step 2 are not sent again.
