---
title: Migrate from Packeton
sidebar_position: 3
description: Recreate Packeton package sources and access, rehearse an install, switch one project and roll back.
---

Move one application's Composer packages from Packeton to Package Broker by recreating its sources and access. This how-to covers two packages backed by Git repositories. Keep Packeton available until the application, CI and rollback rehearsal pass. Repman migration is not covered.

## Before you start

You need Composer 2, a running broker, an organization admin session, the application's original `composer.json` and `composer.lock`, and access to the two original Git repositories. Use `https://<broker-host>/_pb/ui`, replacing `<broker-host>` with your broker's HTTPS host, including a nondefault port. An organization admin can create projects, register package names, enable sources and recreate grants.

<!-- source: packages/core/src/registry/composer/routes.ts:81 -->
<!-- source: packages/core/src/kernel/ui-routes.ts:9 -->
<!-- source: packages/ui/src/app.tsx:93 -->
<!-- source: packages/core/src/authz/permissions.ts:101 -->
<!-- source: packages/core/src/sources/source-service.ts:960 -->

The sample uses Node with **Git over HTTP(S)** sources. Confirm this provider appears in the source form. Workers serves GitHub sources instead; if both repositories live on GitHub, choose that provider and enter its repository and authentication settings. Git over SSH is not served as installable distributions. Only providers composed into the build and served by the runtime appear in the provider list.

<!-- source: packages/core/src/sources/config.ts:70 -->
<!-- source: packages/core/src/sources/config.ts:85 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:26 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:667 -->

Record package names, required versions, commit references, source URLs, current access assignments and the application's Packeton repository URL. Keep the original credentials and any historical archives available for rollback. Recreating a Git source cannot recover a version whose commit or tag is no longer reachable.

<!-- source: packages/core/src/sources/config.ts:18 -->
<!-- verify: Maintainer: inventory the installed Packeton deployment and confirm both Git repositories still contain every version required by the application's lock file. -->

## Map packages and access

Use the [Packeton documentation](https://docs.packeton.org/) alongside the inventory from your deployment. Review access separately from package discovery; do not assume a similarly named object grants the same rights.

<!-- verify: Maintainer: check the Packeton documentation links and all Packeton object descriptions below against the installed version, including whether its access grouping is called teams or groups; record the checked date and exact documentation pages in the migration log. -->

| Packeton object                                                                            | Package Broker destination                                                                     | Manual work                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages and their repository URLs (no dedicated documentation page)                       | One Composer **Git repository** source for each original Git repository.                       | Preserve package names and required references; select tags and any branches the application needs. <!-- source: packages/ui/src/pages/sources/source-form.tsx:49 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:628 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:769 -->                        |
| [Teams or groups and their package access](https://docs.packeton.org/usage/customers.html) | A project containing the intended package set, with reviewed grants to broker users or groups. | No automatic team-to-project conversion. Map the intended people or identity-provider groups to project grants; verify membership at the provider. <!-- source: packages/core/src/api/routes/access-schemas.ts:18 --> <!-- source: packages/core/src/api/routes/project-access-schemas.ts:24 -->                                   |
| API tokens (no dedicated documentation page)                                               | Newly issued broker tokens with access to the intended project.                                | No equivalent credential value: do not reuse a Packeton token as a broker token. Update consumers after issuing the replacement. See the [token table in the access model](../reference/access-model.md). <!-- source: packages/core/src/api/routes/tokens-schemas.ts:22 --> <!-- source: packages/ui/src/pages/tokens.tsx:918 --> |
| [Repository credentials](https://docs.packeton.org/usage/credential.html)                  | The credential of each broker source.                                                          | Enter the origin credential separately; credentials are write-only in the broker UI. <!-- source: packages/ui/src/pages/sources.tsx:55 --> <!-- source: packages/ui/src/pages/sources.tsx:1069 -->                                                                                                                                 |
| Stored package archives (no dedicated documentation page)                                  | No archive-history transfer in this procedure.                                                 | Sync reachable Git references and test fresh downloads. Retain Packeton for versions that cannot be recreated. <!-- source: packages/core/src/sources/config.ts:18 -->                                                                                                                                                             |

## Recreate two package sources

The sample uses `example/library-a` and `example/library-b` from `https://git.example.com/example/library-a.git` and `https://git.example.com/example/library-b.git`. Replace these names and URLs with two packages from your inventory. Each repository must have a `composer.json` with the intended name and the tags or branches referenced by the application. Both packages must already be dependencies in the rehearsal application and present in its lock file. Replace the example package names in every command below.

<!-- verify: Maintainer: supply two reachable, tagged VCS packages from the Packeton inventory for the rehearsal. -->

1. In **Projects**, expand **New project**, set **Project name** to `Packeton migration` and **Slug** to `migration-packeton`, and leave **Maximum token scope** at `read`. Choose **Create project**. Keep it separate from production consumers while rehearsing.
2. In **Organization** scope, open **Sources → Add source**. Set **Ecosystem** to Composer, **Source type** to **Git repository**, source name to `migration-library-a`, and **Repository provider** to **Git over HTTP(S)**. Enter the first Git URL. In **Advanced settings**, keep **Import tags** selected. Add any required branches under **Branches to import**; leaving it empty imports no branches. Repeat for `migration-library-b` with the second Git URL.
3. For private repositories, choose **More → Set credential**, select the credential kind the origin accepts, and type the origin credential into the write-only **Set credential** dialog. Choose **Save credential**. Reauthenticate if requested. Use Git URLs without embedded credentials; the Packeton install token is not a substitute for access to the original Git origin.
4. In organization scope, open **More → Registered names** and **Add name** for `example/library-a` on the first source and `example/library-b` on the second. Choose **Enable**, then **Sync now** for each. Wait for a successful sync and check the imported versions; a queued request alone is not completion.
5. Switch to project `migration-packeton`, open **Sources**, and **Attach** the two organization sources. If another attached source provides the same names, review **Source order** and **Save source order**. Open **Packages** and compare the required versions and revisions with the inventory.

<!-- source: packages/ui/src/pages/projects.tsx:501 -->
<!-- source: packages/ui/src/pages/projects.tsx:364 -->
<!-- source: packages/ui/src/pages/projects.tsx:520 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:49 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:628 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:769 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:128 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:94 -->
<!-- source: packages/ui/src/pages/sources.tsx:55 -->
<!-- source: packages/ui/src/pages/sources.tsx:184 -->
<!-- source: packages/ui/src/pages/sources.tsx:946 -->
<!-- source: packages/ui/src/pages/sources.tsx:998 -->
<!-- source: packages/ui/src/pages/sources.tsx:1287 -->
<!-- source: packages/ui/src/pages/sources.tsx:1381 -->
<!-- source: packages/ui/src/pages/sources.tsx:1450 -->
<!-- verify: Maintainer: create, register, enable, sync and attach both sources in the deployed UI, then compare every required version and revision. -->

## Recreate access and credentials

Select project `migration-packeton` in the UI scope, open **Access**, and review the intended consumers. For a read-only consumer, the recommended built-in role is **Project Auditor**, the narrowest built-in project role without write access. It reads packages, sources, grants (including e-mail addresses), project tokens and the audit log. If the consumer should only read packages, an organization admin can create a narrower custom project role with only `project:read` and `project:packages:read` under **Organization → Access → Roles → New role**, and use its ID for the grant instead. To find the chosen role's raw ID, switch to **Organization → Access → Roles** and copy the ID displayed beneath its name in the **Role** column. Return to the project scope, open **Access → New grant**, paste that ID into **Role ID**, enter the subject, and choose **Create grant**. For a group subject, enter the identity provider as well. Add only the grants needed for this project and test with the consumer's identity.

<!-- source: packages/ui/src/pages/access.tsx:348 -->
<!-- source: packages/ui/src/pages/access.tsx:558 -->
<!-- source: packages/ui/src/pages/access.tsx:581 -->
<!-- source: packages/core/src/authz/permissions.ts:146 -->
<!-- source: packages/core/src/api/routes/project-access-schemas.ts:78 -->
<!-- source: packages/core/src/api/routes/project-access-schemas.ts:103 -->
<!-- source: packages/ui/src/pages/access.tsx:434 -->
<!-- verify: Maintainer: recreate the intended grants, verify an intended consumer can read the sample packages and an identity without a grant cannot read them, and record the results without identity e-mail addresses. -->

Each consumer or CI environment needs its own broker identity and token, or its own service-principal project token. This is the broker counterpart of a per-customer Packeton token. Grant each consumer identity access before it issues its personal token; do not distribute the administrator's personal token to consumers. See the [token table in the access model](../reference/access-model.md) for token selection.

<!-- source: packages/ui/src/pages/tokens.tsx:824 -->
<!-- source: packages/ui/src/pages/tokens.tsx:835 -->
<!-- source: packages/ui/src/pages/tokens.tsx:984 -->

For a personal token, sign in as that consumer, open **Tokens**, choose **My personal tokens** under **Token list**, and expand **Issue token**. Set **Scope** to **Read**, choose **Selected projects** under **Projects**, and enter only this project's ID in **Selected project IDs**. Find it in the **Project ID** column of **Projects**; use the ID, not the slug `migration-packeton`. For CI using a service principal, you need an existing principal for this project and a project-scoped token. An administrator can create the principal under **Tokens → Service principals**, supplying this project's ID and the required permissions. In project scope, choose **Project tokens** under **Token list**, expand **Issue token**, select **Read** and that principal under **Service principal**, and issue the token. Follow [Composer credentials](../clients/composer.md#set-credentials) to supply the token through an uncommitted `auth.json` file or a secret `COMPOSER_AUTH` environment variable. Retain the original Packeton authentication for rollback. Keep tokens out of repository URLs and shell command literals.

<!-- source: packages/ui/src/pages/projects.tsx:437 -->
<!-- source: packages/ui/src/pages/tokens.tsx:824 -->
<!-- source: packages/ui/src/pages/tokens.tsx:918 -->
<!-- source: packages/ui/src/pages/tokens.tsx:935 -->
<!-- source: packages/ui/src/pages/tokens.tsx:961 -->
<!-- source: packages/ui/src/pages/tokens.tsx:984 -->
<!-- source: packages/ui/src/pages/tokens.tsx:1042 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->

## Dry run in an application copy

Make a disposable copy of the application including its lock file, and keep its original files separately. For the sample, the first repository entry initially looks like this. Replace the sample Packeton URL with your recorded original URL. Preserve all unrelated repository entries and their order.

<!-- verify: Maintainer: confirm the application's Packeton URL and repository priority for its installed Composer version. -->

```json
{
  "repositories": [
    {
      "name": "packeton",
      "type": "composer",
      "url": "https://packeton.example.com"
    }
  ]
}
```

Replace that entry with the broker project URL. Keep it ahead of other entries that can supply the same private package names; remove a direct Git or Packeton entry ahead of it in the rehearsal copy.

<!-- source: packages/core/src/registry/composer/routes.ts:77 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->
<!-- verify: Maintainer: confirm Composer resolves both sample packages through the broker with this repository ordering. -->

```json
{
  "repositories": [
    {
      "name": "broker",
      "type": "composer",
      "url": "https://<broker-host>/migration-packeton"
    }
  ]
}
```

From that application's directory, run a targeted resolution dry run. It may fetch metadata, but should not install packages or change the lock file. Compare proposed versions with the original lock file and stop if a required version is missing or another package changes unexpectedly.

<!-- verify: Maintainer: run the dry run against both synced sources, confirm no application files changed, and retain a credential-redacted log. -->

```sh
composer update 'example/library-a' 'example/library-b' --dry-run --no-plugins --no-scripts
```

## Switch one application

Still in the rehearsal copy, resolve the two packages and install the resulting lock file. A targeted update can change these packages and their dependencies within your application constraints. Review the full lock-file diff before accepting it; changing only `composer.json` does not replace the previous distribution URLs in the lock file.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->
<!-- source: packages/core/src/registry/composer/render.ts:91 -->
<!-- verify: Maintainer: run the targeted update, inspect versions and broker distribution URLs, then install in a fresh copy without vendor or a populated Composer cache. Record exit codes and a credential-redacted log; this live migration has not been run offline. -->

```sh
composer update 'example/library-a' 'example/library-b' --no-plugins --no-scripts
```

Require exit code `0` from the update. Check that the two packages' distribution URLs in `composer.lock` point to your broker and that their references match the reviewed versions. Search the whole lock file for the old Packeton host, including source, distribution and notification URLs. Replace `packeton.example.com` below with the old host from your inventory; repeat for any other host you plan to retire.

```sh
grep -cF 'packeton.example.com' composer.lock
```

The count must be `0` (grep exits `1` for zero matches). Any match blocks retirement: migrate the remaining packages or URLs and repeat the check. Do not retire Packeton while any application's lock file still refers to it.

Now remove the installed packages from the configured `vendor-dir` (which may differ from `vendor`) and use a new empty Composer cache before installing the reviewed lock file. Remove the temporary cache after the install, preserving its exit status:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->

```sh
rm -rf -- "$(composer config vendor-dir)"
cutover_cache=$(mktemp -d)
install_status=0
COMPOSER_CACHE_DIR="$cutover_cache" composer install -v --no-plugins --no-scripts || install_status=$?
rm -rf "$cutover_cache"
test "$install_status" -eq 0
```

Require `install_status` to be `0`. In the `composer install -v` output, look for `Downloading` and `Extracting archive` for each sample package, and confirm its distribution URL in the reviewed lock file points to the broker. There must be no `Cloning` or `Now trying to download from source` line for those packages; an install from source does not verify broker archive serving. Run your application's usual checks. Review any required Composer plugins or scripts before enabling them.

<!-- verify: Maintainer or application CI: check the entire lock file for every retiring host with zero matches, run the vendor removal and empty-cache install above, and retain exit codes and a credential-redacted archive-download log. -->

Apply the reviewed repository entry and lock file to only this application. Supply the new broker credential separately in developer and CI environments. Run the same fresh install there, using the intended consumer identity. Follow the [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md) recipe. Keep Packeton and its credentials available until the rollback rehearsal and application checks pass.

<!-- verify: Maintainer or application CI: record a successful install and application checks for the single-application cutover; check access with the intended consumer before retiring Packeton. -->

## Roll back

Restore the original `composer.json` and `composer.lock` together. For the sample, replace the `broker` repository object above with this original object in the same position. Use your recorded Packeton URL in place of the example. Remove any separate broker entry, and restore other repository or Packagist settings that you changed.

<!-- verify: Maintainer: restore the recorded Packeton URL, original lock file and original credentials; verify an empty-cache install while Packeton metadata and archives remain available. -->

```json
{
  "name": "packeton",
  "type": "composer",
  "url": "https://packeton.example.com"
}
```

Restore the original Composer authentication from its protected environment or file, then install the original lock file with the application's normal install command, with plugins and scripts enabled. The example uses `composer install`; keep any flags your application normally requires and the empty-cache environment setting. Remove the configured `vendor-dir`, then clean up the temporary cache after the install while preserving its exit status:

<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->

```sh
rm -rf -- "$(composer config vendor-dir)"
rollback_cache=$(mktemp -d)
install_status=0
COMPOSER_CACHE_DIR="$rollback_cache" composer install || install_status=$?
rm -rf "$rollback_cache"
test "$install_status" -eq 0
```

Confirm the original versions install from Packeton, then revoke the migration's broker token if it is no longer needed. Restoring the repository URL without the original lock file can leave installs pointing at broker archives.
