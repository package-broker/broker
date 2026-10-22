---
title: API reference
sidebar_position: 3
description: HTTP API reference.
---

## Package version vulnerability status

The existing `GET /_pb/packages/:package/versions` and
`GET /_pb/projects/:project/packages/:package/versions` responses include a nested
`vulnerability` object on each version. The version's top-level `status` remains its
catalogue lifecycle status. Organization reads require `org:sources:read`; project
reads require `project:packages:read` and retain the existing winner-or-owner
visibility rules. Pagination and error envelopes are unchanged. Each page contains
at most 100 visible versions. These reads use stored results and a bounded primary
database snapshot; they never trigger an outbound vulnerability check.

```json
{
  "status": "affected",
  "reason": null,
  "source": "osv",
  "fetchedAt": "2026-10-20T12:00:00.000Z",
  "lastKnownStatus": "affected",
  "advisoryCount": 1,
  "advisories": [
    {
      "id": "GHSA-example",
      "url": null,
      "severity": { "level": "unknown", "entries": [] },
      "detailsFetchedAt": null
    }
  ],
  "detailsComplete": false,
  "advisoriesTruncated": false
}
```

`status` is `affected`, `not_affected`, `unknown`, or `stale`. A complete successful
query with no advisory matches means `not_affected` in OSV at `fetchedAt`; it is not
a guarantee that a version is safe. `lastKnownStatus` retains the last complete
assessment. Once it is at least 24 hours old, the status becomes `stale`, with reason
`expired` (or `incomplete` after a continuation limit). An outage preserves a complete
assessment until it expires. Without a complete result, `unknown` has one of these
reasons:

| Reason                 | Meaning                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `not_checked`          | Public provenance cannot currently be established.            |
| `disabled`             | The deployment switch is off for an otherwise public version. |
| `unsupported_version`  | The release cannot be mapped to a supported OSV version.      |
| `pending`              | No current complete assessment exists.                        |
| `upstream_unavailable` | The attempt failed without a complete assessment.             |
| `incomplete`           | The bounded query or continuation budget was exhausted.       |

`advisoryCount` counts all matched advisory IDs. `advisories` contains at most 20,
ordered by ID; `advisoriesTruncated` indicates additional matches. Each advisory
includes sanitized severity entries and a nullable detail timestamp. `url` is always
null. `detailsComplete` indicates that all matched details are present and current;
missing details do not reduce the match count or change an affected assessment.

Hidden private holders, covering name patterns, configured private name claims,
malformed evidence, failed evidence reads, and evidence-budget overflow all return
the same mask: `unknown/not_checked`, null `source`, `fetchedAt` and
`lastKnownStatus`, zero `advisoryCount`, an empty `advisories` array, and false
`detailsComplete` and `advisoriesTruncated`. Evidence is bounded to 1,000 holders,
registrations and source configurations per snapshot and 256 KiB in aggregate.
The API never returns holder identities or provenance evidence. This mask still
exposes the documented public-eligibility bit by differing from eligible versions.
Disabling the feature suppresses cached findings; private versions keep the same
`not_checked` mask.

## Deployment configuration

Vulnerability checks are enabled by default. The approved policy sends only names
with verified organization-wide public provenance to the single allowlisted OSV
host, `api.osv.dev`. A public-looking registry URL or the current project's winning
source alone is insufficient proof. Source credentials are never sent to OSV.
The scheduled job runs every five minutes; ordinary API reads do not send requests.

Set the build-time switch in `broker.config.ts` to disable checks:

```ts
export default {
  // Other broker settings…
  vulnerability: { enabled: false },
};
```

The CLI validates the setting. Node deployments must rebuild and restart; Workers
deployments must rebuild and redeploy. There is no live environment toggle. A
disabled deployment registers no vulnerability job, does not send vulnerability
requests for old queued deliveries, and suppresses previous findings in API reads.

Authorization is evaluated in a fresh primary snapshot before every outbound
request, page and retry. A private claim committed after that snapshot can miss an
already authorized request; a later change cannot recall a name already sent.
The accepted policy uses this query-time window rather than promising perpetual
privacy after later catalogue changes.
