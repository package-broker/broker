---
title: Vendor repositories as sources
sidebar_position: 1
description: Add vendor repositories as project sources with separate credentials.
---

Connect a vendor Composer repository to a project, store that project's vendor credentials, then check installs and access from a second project. Project-owned sources serve only their owner project. <!-- source: packages/core/src/catalogue/visibility.ts:71 -->

## Prerequisites

- A deployed broker with two active projects, `client-a` and `client-b`. The walkthrough uses an organization admin session for setup because registering names and enabling private sources require organization source authority. <!-- source: packages/core/src/authz/permissions.ts:101 --> <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 -->
- Separate project service principals with `project:read` and `project:packages:read`, and a `read` service token for each. Do not use an organization-wide token for this isolation check. <!-- source: packages/core/src/authz/scope.ts:71 --> <!-- source: packages/core/src/authz/service-token-service.ts:261 -->
- A Composer project and a vendor package/version that the first project's vendor account may download. Composer 1 requests to the broker are refused. <!-- source: packages/core/src/registry/composer/routes.ts:80 -->
- For the Magento Marketplace example, credentials for `repo.magento.com` that entitle the first project to the chosen package. In the examples, `<vendor>/<package>`, `<version>` and `<broker-host>` are placeholders. Vendor credential placeholders are `<magento-public-key>` and `<magento-private-key>`; broker service tokens use `pb_svc_<selector>_<secret>`. Vendor keys do not use a broker token prefix. <!-- source: packages/core/src/sources/credentials.ts:110 --> <!-- source: packages/core/src/secrets/token-format.ts:74 -->

<!-- verify: On the Mac, confirm the current Magento Marketplace public-key/username and private-key/password mapping, package entitlement and repository URL with the vendor. Run this walkthrough on both deployed runtimes with authorized test credentials and capture redacted results before publication. -->

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
<!-- source: packages/core/src/catalogue/visibility.ts:71 -->
<!-- source: packages/db-sqlite/src/repositories/catalogue-write-package.ts:104 -->
<!-- verify: Confirm Magento's current archive hosts from the vendor and the redacted install trace before adding any host. -->

Save the source. It starts paused. Keep it paused while setting its credential and registering package names. Empty package and pattern selections select no packages. <!-- source: packages/db-sqlite/src/repositories/source.ts:655 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:123 -->

## 2. Set the project's vendor credentials

In the source's **More** menu, choose **Set credential**. Select `http_basic`, enter `<magento-public-key>` in `username` and `<magento-private-key>` in `password`, replacing the placeholders with the vendor-issued values, then choose **Save credential**. Reauthenticate if prompted and enter the credential again. The broker stores this credential with the source's project ownership and does not show it again. <!-- source: packages/ui/src/pages/sources.tsx:992 --> <!-- source: packages/ui/src/pages/sources.tsx:808 --> <!-- source: packages/ui/src/pages/sources.tsx:184 --> <!-- source: packages/core/src/sources/source-service.ts:894 -->

The corresponding credential operation is `PUT /_pb/projects/:project/sources/:source/credential`. It accepts a credential kind and a JSON-encoded material string; it requires a freshly reauthenticated user session. A package-install service token cannot perform it. <!-- source: packages/core/src/api/routes/sources-schemas.ts:200 --> <!-- source: packages/core/src/api/routes/sources-schemas.ts:53 --> <!-- source: packages/core/src/api/routes/sources.ts:320 -->

For another vendor, choose the credential kind required by that repository. The broker supports HTTP Basic, bearer, allowed header and query credentials for Composer repositories. Keep credential values out of repository URLs. <!-- source: packages/core/src/sources/credentials.ts:3 --> <!-- source: packages/core/src/sources/source-service.ts:391 --> <!-- source: packages/core/src/sources/config.ts:459 -->

## 3. Register names, enable, attach and sync

Open **More → Registered names** and add the exact purchased package as the registered pattern. Registration prevents public proxies from supplying matching names; it does not grant another project access to this source. An organization admin must register names and enable the source, even when the source belongs to a project. <!-- source: packages/ui/src/pages/sources.tsx:1001 --> <!-- source: packages/ui/src/pages/sources.tsx:1437 --> <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 --> <!-- source: packages/core/src/catalogue/visibility.ts:123 -->

Choose **More → Enable**. In project `client-a`, choose **Attach** if the source is not attached, then **Sync now**. Wait for a successful sync before installing. Enabling, attaching and syncing are separate actions; an accepted sync request is not a completed sync. <!-- source: packages/ui/src/pages/sources.tsx:964 --> <!-- source: packages/ui/src/pages/sources.tsx:1288 --> <!-- source: packages/ui/src/pages/sources.tsx:934 --> <!-- source: packages/core/src/api/routes/sources.ts:313 -->

| Operation                   | HTTP route                                                                 | Result                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Register the package name   | `POST /_pb/sources/:source/names`, body `{"pattern":"<vendor>/<package>"}` | 201 with the registration id. <!-- source: packages/core/src/api/routes/source-names-schemas.ts:40 --> |
| Enable the source           | `POST /_pb/sources/:source/enable`                                         | 204. <!-- source: packages/core/src/api/routes/source-names-schemas.ts:69 -->                          |
| Attach to its owner project | `PUT /_pb/projects/:project/sources/:source/attachment`, body `{}`         | 204. <!-- source: packages/core/src/api/routes/source-attachment-schemas.ts:8 -->                      |
| Request sync                | `POST /_pb/projects/:project/sources/:source/sync`                         | 202 when accepted. <!-- source: packages/core/src/api/routes/sources-schemas.ts:215 -->                |

Repeat the source setup in `client-b` only for packages purchased for that project, using its own credentials. Sharing the same vendor URL does not require sharing a source or credential. <!-- source: packages/db-sqlite/src/repositories/source.ts:135 -->

## 4. Install as the first project

In a disposable Composer project directory, configure the broker URL and the first project's token. Replace all angle-bracket placeholders. The bearer credential is a broker service token, separate from the vendor keys saved in step 2. The authentication command writes local Composer credentials; keep that file out of version control. <!-- source: packages/ui/src/pages/tokens/client-config.ts:1 -->

```sh
composer config repositories.client-a composer 'https://<broker-host>/client-a'
composer config --auth 'bearer.<broker-host>' 'pb_svc_<selector>_<secret>'
composer require '<vendor>/<package>:<version>' --no-interaction --no-plugins --no-scripts --prefer-dist
```

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/e2e/src/registry.spec.ts:946 -->
<!-- verify: Run the three Composer commands with real placeholders substituted in a disposable project on the Mac. Record Composer version, broker revision, runtime and redacted successful install output; confirm that the archive is served by the broker. -->

## Verify isolation

Use an HTTP client to request the following metadata URLs with the indicated bearer token. Replace the package placeholders with the same package that installed above. Give the second service principal access to `client-b` so the final row checks package isolation within an accessible project. Do not use a PAT belonging to an organization admin for these checks. <!-- source: packages/core/src/registry/composer/routes.ts:103 --> <!-- source: packages/core/src/authz/engine.ts:210 -->

| Request                                                         | Credential                       | Expected result                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET https://<broker-host>/client-a/p2/<vendor>/<package>.json` | First project's `pb_svc_` token  | 200 with the purchased package's metadata after successful sync. <!-- source: packages/core/src/registry/composer/routes.ts:103 -->                                                                                                                          |
| `GET https://<broker-host>/client-a/p2/<vendor>/<package>.json` | Second project's `pb_svc_` token | 404 when the token has no access to `client-a`. <!-- source: packages/core/src/authz/engine.ts:222 -->                                                                                                                                                       |
| `GET https://<broker-host>/client-b/p2/<vendor>/<package>.json` | Second project's `pb_svc_` token | 404 if `client-b` has no source supplying that package. The first project's cached metadata or archive does not make it visible. <!-- source: packages/core/src/catalogue/visibility.ts:71 --> <!-- source: packages/core/src/catalogue/cache-keys.ts:12 --> |

<!-- verify: Execute all three metadata requests on the Mac with separate project-bound read service tokens after the successful install. Capture only status codes and redacted package metadata. Repeat after warming the archive cache. -->

A 401 means authentication failed and does not prove project isolation. A 403 can mean the principal sees the project but lacks the requested operation; check its permissions before interpreting the result. Do not remove the source ownership boundary to resolve a denial. <!-- source: packages/core/src/authz/token-use.ts:48 --> <!-- source: packages/core/src/authz/engine.ts:210 -->

## Source behavior and cache

There is no configurable source cache mode in the source schema at this revision. The implemented choices are the source type, package selection, archive retention and removal policy. <!-- source: packages/core/src/api/routes/sources-schemas.ts:19 --> <!-- source: packages/core/src/db/source.ts:33 -->

| Choice or behavior         | Effect                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer repository source | Sync reads selected package metadata from the vendor. An archive request first checks visible stored bytes; missing bytes for a current version can trigger a fetch and storage through the source. <!-- source: packages/core/src/ingest/composer/composer-repository.ts:131 --> <!-- source: packages/core/src/registry/dist-service.ts:272 --> |
| Public proxy               | Admits public names on demand, subject to private-name reservations; it is a separate source type. <!-- source: packages/core/src/catalogue/package-access.ts:124 --> <!-- source: packages/core/src/catalogue/visibility.ts:123 -->                                                                                                              |
| Removal policy `flag`      | A package marked removed at the vendor can remain eligible. This does not guarantee that an archive never fetched can still be downloaded from the vendor. <!-- source: packages/core/src/catalogue/visibility.ts:170 --> <!-- source: packages/core/src/registry/dist-service.ts:229 -->                                                         |
| Removal policy `exclude`   | A removed package becomes ineligible; possession of cached bytes does not bypass resolution. <!-- source: packages/core/src/catalogue/visibility.ts:170 --> <!-- source: packages/core/src/registry/dist-service.ts:272 -->                                                                                                                       |
| Archive retention override | Can lengthen organization retention. It does not widen project visibility or promise permanent retention. <!-- source: packages/ui/src/pages/sources/source-form.tsx:119 -->                                                                                                                                                                      |

## Troubleshoot credentials

If sync or install fails, check the source's last error and whether it has a credential. The source response exposes `hasCredential` and error state, not credential material. <!-- source: packages/core/src/api/routes/sources-schemas.ts:64 -->

| Symptom                                      | Check                                                                                   | Action                                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor authentication or entitlement failure | Confirm the keys belong to the purchasing project and the selected package is entitled. | Replace the credential in that project's source, then sync again. <!-- source: packages/core/src/api/routes/sources.ts:320 --> <!-- verify: Confirm current vendor authentication and entitlement failure responses with Magento Marketplace. --> |
| Reauthentication required when saving        | Check whether the UI asks you to sign in again.                                         | Reauthenticate and re-enter the credential; the UI does not replay the secret. <!-- source: packages/ui/src/pages/sources.tsx:184 -->                                                                                                             |
| Metadata works, archive fails                | Check whether the archive host differs from the repository host.                        | Add only a vendor-confirmed hostname to Additional archive hosts; the source credential is sent there too. <!-- source: packages/ui/src/pages/sources/source-form.tsx:121 -->                                                                     |
| No packages after sync                       | Check the package selection, attachment and source state.                               | Select the exact package name, attach to the owner project, register names, enable and sync. <!-- source: packages/ui/src/pages/sources/source-form.tsx:123 --> <!-- source: packages/core/src/catalogue/visibility.ts:86 -->                     |

## Next

Use [Access model](../reference/access-model.md) to check roles and token scopes, [Composer](../clients/composer.md) for client setup, or return to [Troubleshoot credentials](#troubleshoot-credentials) for vendor credential failures.
