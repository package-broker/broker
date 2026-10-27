---
title: Packagist and npmjs proxy sources
sidebar_position: 2
description: Add public Composer and npm proxy sources, understand stored archives and registry outages, and configure retention.
---

Use a Packagist proxy for public Composer packages from `repo.packagist.org`, or an npmjs proxy for public npm packages from `registry.npmjs.org`. Packages appear when a client first requests them; adding a proxy does not import the entire public registry.

<!-- source: packages/ui/src/pages/sources/source-form.tsx:57 -->
<!-- source: packages/ui/src/pages/sources/proxy-message.ts:1 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:610 -->

## Add a proxy source

Creating a project-owned source requires `project:sources:write`; creating an organization-owned source requires organization admin authority. Select the project that will use the proxy, open **Sources**, then **Add source**. Enter a source name and choose the matching ecosystem and source type:

| Ecosystem  | Source type                         | Registry URL                 |
| ---------- | ----------------------------------- | ---------------------------- |
| `composer` | Packagist proxy (`packagist_proxy`) | `https://repo.packagist.org` |
| `npm`      | npmjs proxy (`npmjs_proxy`)         | `https://registry.npmjs.org` |

The form displays the registry URL; you do not enter it. These source types accept only the exact URLs above; use a Composer repository or private npm registry source for another host. Leave **Use GitHub token** off for a Packagist proxy without a credential. An npmjs proxy takes no credential.

<!-- source: packages/core/src/api/routes/sources-schemas.ts:164 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:41 -->
<!-- source: packages/core/src/sources/config.ts:490 -->
<!-- source: packages/core/src/sources/config.test.ts:353 -->
<!-- source: packages/core/src/sources/config.test.ts:465 -->

Select **Visible to new projects** so the default project attachment admits public names from this source. Project access and private-name reservations still apply. Choose **Add source**. Proxy sources start active. A source created in the project view belongs to that project. In the project source list, choose **Attach** if the source is not attached. To share an organization-owned source, create it in the organization view, then attach it from each project's **Sources** page. Attached sources are tried in precedence order; use **Move up**, **Move down** and **Save source order** to change that order.

<!-- source: packages/core/src/catalogue/visibility.ts:220 -->
<!-- source: packages/db-sqlite/src/repositories/source.ts:723 -->
<!-- source: packages/ui/src/pages/sources.tsx:423 -->
<!-- source: packages/ui/src/pages/sources.tsx:461 -->
<!-- source: packages/ui/src/pages/sources.test.ts:550 -->

Connect the client using [Composer setup](../clients/composer.md) or [npm, pnpm and Yarn setup](../clients/npm-pnpm-yarn.md). The install request still needs a broker token and project package access. A public proxy is not anonymous access. Private-name reservations prevent a proxy from supplying a reserved private name.

<!-- source: packages/core/src/catalogue/package-access.ts:124 -->
<!-- source: packages/core/src/catalogue/visibility.ts:123 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:704 -->

## Stored metadata and archives

The broker persists package metadata and rewrites download URLs to its own archive routes. An archive request checks access before serving stored bytes. If eligible bytes are missing for a current version, the broker can fetch and verify them, then store them by SHA-256 digest. Concurrent fills share a fetch lease. A digest mismatch quarantines the version rather than silently replacing its bytes.

<!-- source: docs/architecture.md:92 -->
<!-- source: packages/core/src/registry/dist-service.ts:272 -->
<!-- source: packages/core/src/ingest/dist-fetch.ts -->

Fresh proxy metadata is served without a registry request. Stale metadata can still be served while a refresh is queued, including when enqueueing fails. A first request without stored metadata can fail if the public registry is unavailable. A stored archive can be served while its original registry is unavailable, provided access and version eligibility still allow it; an archive never fetched cannot be recovered from the broker's storage.

See the [proxy cache and outage decision](../decisions/registry-and-sources.md#adr-008-restricted-public-proxies-artifacts-persisted-by-digest-upstream-removals-kept-for-one-year) for the recorded stale-serving and archive policy, and [backups and upgrades](../operations/backup-and-upgrades.md) for protecting stored bytes.

<!-- source: packages/core/src/ingest/proxy-contract.test.ts:771 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:818 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:854 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:869 -->

## Retention and removal

The source form's **Archive retention (days)** field uses the organization setting when blank. An override can lengthen retention but cannot shorten it. Retention jobs schedule eligible removed-package archives for deletion and purge bytes after their deadline. For packages removed at the registry, the organization setting `retention_removed_upstream_days` defaults to 365 days; a longer source override extends that period. Retention is not a promise of permanent storage.

<!-- source: packages/ui/src/pages/sources/source-form.tsx:119 -->
<!-- source: packages/core/src/sources/config.test.ts:570 -->
<!-- source: packages/db-sqlite/migrations/0001_init.sql:37 -->
<!-- source: packages/db-sqlite/src/repositories/retention-jobs.test.ts:166 -->
<!-- source: packages/db-sqlite/src/repositories/retention-jobs.test.ts:202 -->

Unreferenced, refetchable blobs are also eligible for cleanup after the seven-day grace period defined by `ORPHAN_GRACE_DAYS`.

<!-- source: packages/db-sqlite/src/repositories/blob-references.ts:9 -->
<!-- source: packages/db-sqlite/src/repositories/retention-jobs.test.ts:183 -->

The source removal policy also affects installs: `flag` can keep a version removed from its registry eligible, while `exclude` makes it ineligible. Stored bytes do not bypass that policy or project access checks. See [source behavior and cache](mirror-vendor-repositories.md#source-behavior-and-cache).

<!-- source: packages/core/src/catalogue/visibility.ts:170 -->

## Limits

- These proxies fetch public packages on demand; they do not replace a credentialed vendor source such as [Magento Marketplace](mirror-vendor-repositories.md).
- Public fallback remains subject to source attachment, project visibility and private-name reservations. Another project's stored package does not grant access.
- Registry failures can prevent uncached installs. Definitive not-found responses are negatively cached; a registry error is not treated as proof that a package does not exist.
- Changing a client's registry configuration does not replace download URLs already in a lock file. Follow the client setup and review lock-file URLs before relying on broker archives.

<!-- source: packages/core/src/ingest/proxy-contract.test.ts:664 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:681 -->
<!-- source: packages/core/src/ingest/proxy-contract.test.ts:743 -->
<!-- source: docs/clients/composer.md:126 -->
<!-- source: docs/clients/npm-pnpm-yarn.md -->
