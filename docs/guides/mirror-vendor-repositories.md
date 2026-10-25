---
title: Vendor repositories as sources
sidebar_position: 1
description: Add vendor repositories as project sources with separate credentials.
---

Connect a vendor Composer repository to a project, store that project's vendor credentials, then check installs and access from a second project. Project-owned sources serve only their owner project. <!-- source: packages/core/src/catalogue/visibility.ts:71 -->

## Prerequisites

- A deployed broker with two active projects, `client-a` and `client-b`. The walkthrough uses an organization admin session for setup because registering names and enabling private sources require `org:sources:write`. <!-- source: packages/core/src/authz/permissions.ts:101 --> <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 --> <!-- source: packages/core/src/api/routes/source-names.ts:145 --> <!-- source: packages/core/src/sources/source-service.ts:306 -->
- Separate project service principals with `project:read` and `project:packages:read`, and a `read` service token for each. Do not use an organization-wide token for this isolation check. <!-- source: packages/core/src/authz/scope.ts:71 --> <!-- source: packages/core/src/authz/service-token-service.ts:261 -->
- A Composer project and a vendor package/version that the first project's vendor account may download. Composer 1 requests to the broker are refused. <!-- source: packages/core/src/registry/composer/routes.ts:80 -->
- For the Magento Marketplace example, credentials for `repo.magento.com` that entitle the first project to the chosen package. In the examples, `<vendor>/<package>`, `<version>` and `<broker-host>` are placeholders. Vendor credential placeholders are `<magento-public-key>` and `<magento-private-key>`; broker service tokens use `pb_svc_<selector>_<secret>`. Vendor keys do not use a broker token prefix. <!-- source: packages/core/src/sources/credentials.ts:110 --> <!-- source: packages/core/src/secrets/token-format.ts:74 -->

<!-- verify: Magento credentials (Node) and owner (Cloudflare): confirm the current Magento Marketplace public-key/username and private-key/password mapping, package entitlement and repository URL with the vendor. Run this walkthrough on both deployed runtimes with authorized test credentials and capture redacted results before publication. -->

## 1. Add a project-owned source

Select project `client-a` in the UI, open **Sources**, then **Add source**. Set the following fields. Creating through the project view binds the source to that project; using the organization view would create an organization-owned source. <!-- source: packages/ui/src/pages/sources.tsx:417 --> <!-- source: packages/core/src/api/routes/sources.ts:264 -->

| Field                           | Value                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Source name                     | `marketplace-client-a`                                                                                           |
| Ecosystem                       | `composer`                                                                                                       |
| Source type                     | Composer repository (`composer_repository`)                                                                      |
| Repository URL                  | `https://repo.magento.com`                                                                                       |
| Package names (one per line)    | The purchased package, written as `<vendor>/<package>` after replacing both placeholders.                        |
| Package patterns (one per line) | Leave empty for this check.                                                                                      |
| Visible to new projects         | Select it so discovered packages receive the visibility flag. Project ownership still limits them to `client-a`. |
| Additional archive hosts        | Leave empty until a vendor-documented download hostname is required. Credentials are also sent to listed hosts.  |

<!-- source: packages/ui/src/pages/sources/source-form.tsx:48 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:64 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:117 -->
<!-- source: packages/core/src/sources/credential-origins.ts:62 -->
<!-- source: packages/core/src/ingest/composer/composer-repository.ts:208 -->
<!-- source: packages/core/src/sources/policy-fetch.ts:309 -->
<!-- source: packages/core/src/catalogue/visibility.ts:71 -->
<!-- source: packages/db-sqlite/src/repositories/catalogue-write-package.ts:104 -->
<!-- verify: Magento credentials: confirm Magento's current archive hosts from the vendor and the redacted install trace before adding any host. -->

Save the source. It starts paused. Keep it paused while setting its credential and registering package names. Empty package and pattern selections select no packages. <!-- source: packages/db-sqlite/src/repositories/source.ts:655 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:123 -->

The API equivalent is `POST /_pb/projects/client-a/sources` with the following JSON body. Project-scoped routes use the project slug (`client-a`), not its ID. The response is 201 with `{"id":"<source-id>"}`; use that ID as `:source` below. Creating a project source requires `project:sources:write`. <!-- source: packages/core/src/api/routes/sources-schemas.ts:5 --> <!-- source: packages/core/src/api/routes/sources-schemas.ts:50 --> <!-- source: packages/core/src/api/routes/sources-schemas.ts:164 --> <!-- source: packages/core/src/api/routes/sources.ts:264 -->

```json
{
  "name": "marketplace-client-a",
  "ecosystem": "composer",
  "type": "composer_repository",
  "url": "https://repo.magento.com",
  "config": {
    "selection": { "packages": ["<vendor>/<package>"] },
    "distHosts": []
  },
  "defaultVisibleToNewProjects": true
}
```

<!-- source: packages/core/src/api/routes/sources-schemas.ts:19 -->

## 2. Set the project's vendor credentials

In the source's **More** menu, choose **Set credential**. Select `http_basic`, enter `<magento-public-key>` in `username` and `<magento-private-key>` in `password`, replacing the placeholders with the vendor-issued values, then choose **Save credential**. Reauthenticate if prompted and enter the credential again. The broker stores this credential with the source's project ownership and does not show it again. <!-- source: packages/ui/src/pages/sources.tsx:992 --> <!-- source: packages/ui/src/pages/sources.tsx:808 --> <!-- source: packages/ui/src/pages/sources.tsx:184 --> <!-- source: packages/core/src/sources/source-service.ts:894 -->

The corresponding credential operation is `PUT /_pb/projects/:project/sources/:source/credential`. It requires `project:sources:write` and a freshly reauthenticated user session. Send `kind` and a JSON-encoded `material` string as follows, replacing the placeholders. A package-install service token cannot perform it. <!-- source: packages/core/src/api/routes/sources-schemas.ts:200 --> <!-- source: packages/core/src/api/routes/sources-schemas.ts:53 --> <!-- source: packages/core/src/api/routes/sources.ts:320 -->

```json
{
  "kind": "http_basic",
  "material": "{\"username\":\"<magento-public-key>\",\"password\":\"<magento-private-key>\"}"
}
```

<!-- source: packages/core/src/api/routes/sources-schemas.ts:53 -->
<!-- source: packages/core/src/sources/credentials.ts:110 -->

For another vendor, choose the credential kind required by that repository. The broker supports HTTP Basic, bearer, allowed header and query credentials for Composer repositories. Keep credential values out of repository URLs. <!-- source: packages/core/src/sources/credentials.ts:3 --> <!-- source: packages/core/src/sources/source-service.ts:391 --> <!-- source: packages/core/src/sources/config.ts:459 -->

## 3. Register names, enable, attach and sync

Switch the top-bar scope to **Organization**, open **Sources**, and find `marketplace-client-a` (include project-owned sources in the list). Open **More → Registered names** and add the exact purchased package as the registered pattern. Registration prevents public proxies from supplying matching names; it does not grant another project access to this source. Registration and the enable route require a user session with `org:sources:write`; enabling this project-owned source also checks `project:sources:write` in its owner project. The organization admin role supplies both. <!-- source: packages/ui/src/pages/sources.tsx:1001 --> <!-- source: packages/ui/src/pages/sources.tsx:1437 --> <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 --> <!-- source: packages/core/src/api/routes/source-names.ts:145 --> <!-- source: packages/core/src/sources/source-service.ts:306 --> <!-- source: packages/core/src/catalogue/visibility.ts:123 -->

Still in Organization → Sources, choose **More → Enable**. Switch the top-bar scope back to project `client-a`, open **Sources**, and choose **Attach** if the source is not attached, then **Sync now**. Wait for a successful sync before installing. Enabling, attaching and syncing are separate actions; an accepted sync request is not a completed sync. <!-- source: packages/ui/src/pages/sources.tsx:964 --> <!-- source: packages/ui/src/pages/sources.tsx:1288 --> <!-- source: packages/ui/src/pages/sources.tsx:934 --> <!-- source: packages/core/src/api/routes/sources.ts:313 -->

| Operation                   | HTTP route                                                                 | Result                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register the package name   | `POST /_pb/sources/:source/names`, body `{"pattern":"<vendor>/<package>"}` | 201 with the registration id. <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 --> <!-- source: packages/core/src/api/routes/source-names.ts:145 --> <!-- source: packages/core/src/sources/source-service.ts:306 --> |
| Enable the source           | `POST /_pb/sources/:source/enable`                                         | 204. <!-- source: packages/core/src/api/routes/source-names-schemas.ts:69 --> <!-- source: packages/core/src/api/routes/source-names.ts:180 --> <!-- source: packages/db-sqlite/src/repositories/registered-name.ts:112 -->               |
| Attach to its owner project | `PUT /_pb/projects/:project/sources/:source/attachment`, body `{}`         | 204. <!-- source: packages/core/src/api/routes/source-attachment-schemas.ts:8 --> <!-- source: packages/core/src/api/routes/source-attachment.ts:50 -->                                                                                   |
| Request sync                | `POST /_pb/projects/:project/sources/:source/sync`                         | 202 when accepted. <!-- source: packages/core/src/api/routes/sources-schemas.ts:215 --> <!-- source: packages/core/src/api/routes/sources.ts:313 -->                                                                                      |

Attachment and sync require `project:sources:write` in the owner project. <!-- source: packages/core/src/api/routes/source-attachment-schemas.ts:13 --> <!-- source: packages/core/src/api/routes/sources-schemas.ts:215 -->

Keep `client-b` without this package for the isolation check below. If it later purchases the same package, create its own project source and credential. Exact registered patterns are unique within the organization and ecosystem: repeating `<vendor>/<package>` on its second source returns `pattern_taken`. Registrations belong to a source; the first source's registration cannot enable the second source. An organization operator must choose a distinct valid pattern covering the purchased package for the second source, reviewing the additional names that pattern reserves; keep its package selection restricted to its purchases. If no acceptable distinct pattern is available, this setup cannot enable the second source. Sharing the vendor URL does not require sharing credentials. <!-- source: packages/db-sqlite/migrations/0001_init.sql:952 --> <!-- source: packages/db-sqlite/src/repositories/registered-name.ts:214 --> <!-- source: packages/db-sqlite/src/repositories/registered-name.ts:51 --> <!-- source: packages/db-sqlite/src/repositories/registered-name.ts:71 --> <!-- source: packages/db-sqlite/src/repositories/source-selection.ts:16 --> <!-- source: packages/db-sqlite/src/repositories/source.ts:135 -->

## 4. Install as the first project

In a disposable Composer project directory, configure the broker URL and the first project's token. Replace all angle-bracket placeholders. The bearer credential is a broker service token, separate from the vendor keys saved in step 2. The authentication command writes local Composer credentials; keep that file out of version control. <!-- source: packages/ui/src/pages/tokens/client-config.ts:1 -->

```sh
composer config repositories.client-a composer 'https://<broker-host>/client-a'
composer config --auth 'bearer.<broker-host>' 'pb_svc_<selector>_<secret>'
composer require '<vendor>/<package>:<version>' --no-interaction --no-plugins --no-scripts --prefer-dist
```

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/e2e/src/registry.spec.ts:946 -->
<!-- source: /Users/lbajsarowicz/lbajsarowicz/package-broker/v2-research/40-tasks/DOC-verify-report.md:22 -->
<!-- source: /Users/lbajsarowicz/lbajsarowicz/package-broker/v2-research/40-tasks/DOC-verify-report.md:26 -->

Composer writes a repository entry with `"name": "client-a"`; repositories are canonical by default. In an existing project, move chosen locked packages to broker URLs with `composer update <vendor>/<package>` (name each package to re-resolve). `composer update --lock` leaves existing dist URLs unchanged. A full `composer update` re-resolves all dependencies and can change versions across the project.

<!-- verify: Magento credentials (Node) and owner (Cloudflare): run the three Composer commands with real placeholders substituted in a disposable project on the Mac. Record Composer version, broker revision, runtime and redacted successful install output; confirm that the archive is served by the broker. -->

## Verify isolation

Use an HTTP client to request the following metadata and archive URLs with the indicated bearer token. Replace the package placeholders with the same package that installed above. Give the second service principal access to `client-b` so the requests to `client-b` check package isolation within an accessible project. Do not use a PAT belonging to an organization admin for these checks. <!-- source: packages/core/src/registry/composer/routes.ts:103 --> <!-- source: packages/core/src/authz/engine.ts:210 -->

| Request                                                         | Credential                       | Expected result                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET https://<broker-host>/client-a/p2/<vendor>/<package>.json` | First project's `pb_svc_` token  | 200 with the purchased package's metadata after successful sync. <!-- source: packages/core/src/registry/composer/routes.ts:103 -->                                                                                                                          |
| `GET https://<broker-host>/client-a/p2/<vendor>/<package>.json` | Second project's `pb_svc_` token | 404 when the token has no access to `client-a`. <!-- source: packages/core/src/authz/engine.ts:222 -->                                                                                                                                                       |
| `GET https://<broker-host>/client-b/p2/<vendor>/<package>.json` | Second project's `pb_svc_` token | 404 if `client-b` has no source supplying that package. The first project's cached metadata or archive does not make it visible. <!-- source: packages/core/src/catalogue/visibility.ts:71 --> <!-- source: packages/core/src/catalogue/cache-keys.ts:12 --> |
| `GET <client-a-dist-url>`                                       | Second project's `pb_svc_` token | 404 when the token has no access to `client-a`, even with cached bytes. <!-- source: packages/core/src/registry/composer/routes.ts:164 --> <!-- source: packages/core/src/authz/engine.ts:222 -->                                                            |
| `GET <same-dist-url-with-client-b-slug>`                        | Second project's `pb_svc_` token | 404 if `client-b` has no source supplying the package, even with cached bytes. <!-- source: packages/core/src/registry/composer/routes.ts:164 --> <!-- source: packages/core/src/registry/dist-service.ts:272 -->                                            |

Copy a version's `dist.url` from the first successful metadata response as `<client-a-dist-url>`. Fetch it with the first project's token to warm the archive cache (expect 200), then run both negative archive requests above. For the last request, replace only the `/client-a/` project segment with `/client-b/`, keeping the package and archive filename. <!-- source: packages/core/src/registry/composer/routes.ts:164 --> <!-- source: packages/core/src/registry/dist-service.ts:272 -->

<!-- verify: Magento credentials (Node) and owner (Cloudflare): execute all three metadata requests and both negative dist/archive requests with separate project-bound read service tokens after the successful install. Warm the archive with the first token (200), then repeat the metadata and negative archive checks. Capture only status codes and redacted metadata. -->

A 401 means authentication failed and does not prove project isolation. A 403 can mean the principal sees the project but lacks the requested operation; check its permissions before interpreting the result. Do not remove the source ownership boundary to resolve a denial. <!-- source: packages/core/src/authz/token-use.ts:48 --> <!-- source: packages/core/src/authz/engine.ts:210 -->

## Source behavior and cache

Configure source type, package selection, archive retention and removal policy. Archive fetching and cache reuse follow the behavior below. <!-- source: packages/core/src/api/routes/sources-schemas.ts:19 --> <!-- source: packages/core/src/db/source.ts:33 -->

| Choice or behavior         | Effect                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer repository source | Sync reads selected package metadata from the vendor. An archive request first checks visible stored bytes; missing bytes for a current version can trigger a fetch and storage through the source. <!-- source: packages/core/src/ingest/composer/composer-repository.ts:131 --> <!-- source: packages/core/src/registry/dist-service.ts:272 --> |
| Public proxy               | Admits public names on demand, subject to private-name reservations; it is a separate source type. <!-- source: packages/core/src/catalogue/package-access.ts:124 --> <!-- source: packages/core/src/catalogue/visibility.ts:123 -->                                                                                                              |
| Removal policy `flag`      | A package marked removed at the vendor can remain eligible. This does not guarantee that an archive never fetched can still be downloaded from the vendor. <!-- source: packages/core/src/catalogue/visibility.ts:170 --> <!-- source: packages/core/src/registry/dist-service.ts:229 -->                                                         |
| Removal policy `exclude`   | A removed package becomes ineligible; possession of cached bytes does not bypass resolution. <!-- source: packages/core/src/catalogue/visibility.ts:170 --> <!-- source: packages/core/src/registry/dist-service.ts:272 -->                                                                                                                       |
| Archive retention override | Can lengthen organization retention. It does not widen project visibility or promise permanent retention. <!-- source: packages/ui/src/pages/sources/source-form.tsx:119 -->                                                                                                                                                                      |

## Troubleshoot credentials

If sync or install fails, check the source's last error and whether it has a credential. The source response exposes `hasCredential` and error state, not credential material. <!-- source: packages/core/src/api/routes/sources-schemas.ts:64 -->

| Symptom                                      | Check                                                                                   | Action                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor authentication or entitlement failure | Confirm the keys belong to the purchasing project and the selected package is entitled. | Replace the credential in that project's source, then sync again. <!-- source: packages/core/src/api/routes/sources.ts:320 --> <!-- verify: Magento credentials: confirm current vendor authentication and entitlement failure responses with Magento Marketplace. -->                                                                                                                              |
| Reauthentication required when saving        | Check whether the UI asks you to sign in again.                                         | Reauthenticate and re-enter the credential; the UI does not replay the secret. <!-- source: packages/ui/src/pages/sources.tsx:184 -->                                                                                                                                                                                                                                                               |
| Metadata works, archive fails                | Check whether the archive host differs from the repository host.                        | Add only a vendor-confirmed hostname to Additional archive hosts; the source credential is sent there too. <!-- source: packages/core/src/sources/credential-origins.ts:62 --> <!-- source: packages/core/src/ingest/composer/composer-repository.ts:208 --> <!-- source: packages/core/src/sources/policy-fetch.ts:309 -->                                                                         |
| No packages after sync                       | Check the package selection, attachment, source state and **Visible to new projects**.  | Select the exact package name, attach to the owner project, register names, enable and sync. With the empty attachment body above, discovered packages need **Visible to new projects** selected; an explicit project package selection can also grant visibility. <!-- source: packages/ui/src/pages/sources/source-form.tsx:123 --> <!-- source: packages/core/src/catalogue/visibility.ts:86 --> |

## Next

Use [Access model](../reference/access-model.md) to check roles and token scopes, [Composer](../clients/composer.md) for client setup, or return to [Troubleshoot credentials](#troubleshoot-credentials) for vendor credential failures.
