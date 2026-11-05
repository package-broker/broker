---
title: Security and data residency
sidebar_position: 8
description: Security model and data residency of Package Broker.
---

## Known vulnerability advisory checks

Package Broker periodically checks eligible public Composer and npm package versions against OSV's known vulnerability advisories. The API and the packages page show the result, source and last successful check time. Results can be incomplete or out of date and do not establish that a package is safe. These are version-level advisory checks: they do not scan source code or artifacts, analyze malware, audit a transitive dependency tree, review lock files, enforce installation policy, send alerts or guarantee that every vulnerability will be found. This feature does not establish a security certification or SOC 2 compatibility.

Checks are enabled by default. The OSV job uses one allowlisted host, `api.osv.dev`, and never forwards source credentials to OSV. The browser reads stored results from the broker; opening the packages page does not call OSV or start a check. See the [API reference](reference/api.md) for the response contract.

## Which names may be sent to OSV

Eligibility uses canonical ecosystem and package keys within one organization, across all its projects and organization-level sources. It is not inferred from the current project's winner, visibility, an npm scope or a public-looking URL. All of the following must hold:

- The candidate version still belongs to the organization and package, and its lifecycle status is `active` or `removed_upstream`.
- At least one stored package for that name has a trusted public proxy source, and every stored package for that name in the organization has such a source. Pausing, detaching, hiding, removing or quarantining a holder does not remove its veto.
- No registered exact name or wildcard pattern covers the name, including registrations on paused or hidden sources. Explicit non-proxy configured claims also veto it before ingestion: VCS `packageName`, Composer selection packages/patterns, and npm registry `scopes` such as `@company/*`.
- A trusted Composer proxy is `packagist_proxy` with the built-in metadata origin `https://repo.packagist.org` and no origin override. Its optional `githubToken: true` credential supports GitHub access and does not disqualify that fixed metadata origin; the token is never sent to OSV. A trusted npm proxy is `npmjs_proxy` using `https://registry.npmjs.org`, without an origin override or registry credential. Ordinary `composer_repository` and `npm_registry` sources are not proof of public provenance.
- The name and release mapping are supported, checks are enabled, and every evidence read succeeds. Missing sources, invalid organization/parent links, malformed names/configuration/patterns, evidence read errors and evidence-budget overflow fail closed.

A public scoped npm package can qualify under the same rule. A public package shadowed by a private copy anywhere in the organization cannot qualify, even if the visible public source wins. A source with neither a stored package, a covering registration nor an explicit configured claim does not claim that name; undiscovered upstream names are outside the broker's current catalogue evidence. This is a public-provenance rule under that evidence model, not a guarantee about future catalogue changes.

## Outbound disclosure and residency

These OSV checks send eligible public package names, ecosystems and exact versions to Google's OSV service outside the deployment. OSV can observe that public package inventory, the request timing and the network egress IP address. Advisory-detail requests also disclose the advisory IDs being retrieved. This external processing is separate from where the deployment stores metadata in D1 and artifacts in R2. Choosing D1/R2 storage placement does not make OSV traffic remain in that storage location; assess storage residency and advisory egress separately. Cached assessments are scoped to the organization.

The broker takes a fresh primary database snapshot immediately before every outbound request, including each retry, continuation page and advisory-detail request after pacing. It sends the authorized tuples immediately; queued references and previously cached eligibility are not dispatch authorization. Writes recheck eligibility, and API reads mask old findings when public provenance no longer holds.

The policy accepts the snapshot-to-send privatization window: a private claim committed before the authorization snapshot prevents dispatch; one committed after that snapshot, even before the physical send, can miss that request. Later privatization cannot recall an authorized or in-flight disclosure. This policy does not promise perpetual privacy for a formerly public name.

Masked results use only `Not checked` and `Only verified public proxy packages are checked.` for a visible proxy. Hidden holders, registrations, malformed evidence and evidence-budget overflow have identical presentation, without a hidden-holder hint. A visibly non-proxy source may instead say `Not checked: private package` using already-authorized source context. Masking still exposes an eligibility bit: a transition from a visible assessment to `Not checked` reveals that eligibility changed, even though the reason and any hidden holder remain concealed.

## Supported versions, freshness and capacity

Composer names map to OSV's `Packagist` ecosystem using canonical vendor/name. Supported releases have two to four numeric components, optionally prefixed with one `v` (removed for the query), with supported alpha/a, beta/b, RC/rc or pl/p release suffixes. Stored pretty release spelling is used rather than Composer's padded normalized version. Branches, branch aliases, references, constraints and stability flags are unsupported. npm maps to OSV's `npm` ecosystem using decoded names, including scoped names, and exact validated release semver with prerelease/build identifiers. Tags, ranges and git/file/workspace references are unsupported. Unsupported input is shown as unchecked, never as a negative assessment.

The scheduled job runs every five minutes. A complete result becomes stale after 24 hours; failures do not reset the last successful time or erase last-known matches. Only a complete query with zero matches means `No known advisories` in OSV at that time. Missing advisory details retain the positive match with unavailable severity and pending details. The page displays at most 20 advisory IDs per version and states the total when truncated.

Capacity is bounded rather than a freshness guarantee: each invocation has a 20-second deadline, requests contain at most 20 queries, continuations stop at four pages or 200 unique IDs per version, and failures use backoff. Evidence snapshots are bounded to 1,000 holders, registrations and source configurations and 256 KiB in aggregate. Large catalogues, backlogs, upstream outages or limits can leave versions pending, incomplete or stale; a five-minute schedule does not mean every version is checked every five minutes.

## Operator off switch

Set `BrokerConfig.vulnerability.enabled` to `false` in `broker.config.ts`:

```ts
export default {
  // Other broker settings…
  vulnerability: { enabled: false },
};
```

This is a build-time setting. Rebuild and restart Node deployments; rebuild and redeploy Workers deployments. There is no live environment toggle. A disabled deployment registers no OSV vulnerability job, sends no OSV requests for old queued deliveries and suppresses cached findings in API reads. Otherwise-public versions show `Vulnerability checks disabled`; private or unverified provenance keeps the generic mask.

## Independent npm audit

Both runtimes forward bulk npm audit requests to `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`. This is independent of OSV checks and `vulnerability.enabled`; it does not use the OSV advisory cache. Set `registry.npmAudit.enabled` to `false` at build time to disable forwarding; disabled requests return 501 `npm_audit_disabled`. Rebuild and restart or redeploy to apply the setting.
<!-- source: packages/runtime-node/src/index.ts -->
<!-- source: packages/runtime-cloudflare/src/index.ts -->
<!-- source: packages/core/src/registry/module.ts -->

A project must have an attached npmjs proxy; otherwise audit returns 501 with an explicit message requiring an npmjs.org proxy source. Only exact valid versions whose project winner is an npmjs proxy and whose organization-wide public provenance is freshly verified may leave the deployment. Registered names, configured private claims and non-proxy holders anywhere in the organization veto disclosure, including hidden or paused holders. Verification failure or evidence overflow returns a safe 502 without forwarding. An empty eligible set returns `{}` without an upstream request. The snapshot-to-send window described above applies here too.
<!-- source: packages/core/src/registry/npm/audit.ts -->
<!-- source: packages/db-sqlite/src/repositories/vulnerability.ts -->

Audit discloses the eligible public names and exact versions, timing and egress IP to the npm registry outside the deployment's storage residency. Requests use the configured default user agent without source credentials, client authorization, cookies or request tracing headers. Responses contain only sanitized advisory fields for names actually sent. Audit accepts at most 1 MiB of decompressed JSON, 1,000 distinct names and 2,000 distinct name/version pairs; exceeding a cap returns 413 without a partial audit. Legacy quick-audit endpoints return 501 rather than forwarding lockfiles.
<!-- source: packages/core/src/registry/npm/audit.ts -->
<!-- source: packages/core/src/registry/npm/audit-response.ts -->
<!-- source: packages/core/src/registry/npm/routes.ts -->

Cache-backed npm audit and advisory monitoring/notifications and lock-file review are separate work. A version's known-advisory result does not implement those features.
