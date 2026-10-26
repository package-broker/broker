---
title: Migrate from Satis
sidebar_position: 2
description: Recreate Satis sources, rehearse a Composer install, switch one project and roll back.
---

Move one application's packages to Package Broker while keeping its Satis repository available for rollback. This how-to uses manual source creation: two Git repositories and one Composer repository. Repeat the rehearsal for each application before changing its production configuration.

## Before you start

Have Composer 2, a running broker, an organization admin session, the application's `composer.json` and `composer.lock`, and access to the original package repositories. Use the broker UI at `https://<broker-host>/_pb/ui`; replace `<broker-host>` with your broker's HTTPS host, including a nondefault port. An organization admin can create the project, register package names and enable sources.

<!-- source: packages/core/src/registry/composer/routes.ts:81 -->
<!-- source: packages/core/src/kernel/ui-routes.ts:9 -->
<!-- source: packages/ui/src/app.tsx:93 -->
<!-- source: packages/core/src/authz/permissions.ts:101 -->
<!-- source: packages/core/src/sources/source-service.ts:960 -->

For the Git over HTTP(S) example below, use Node and confirm that **Repository provider** offers **Git over HTTP(S)**. Workers serves GitHub sources instead; select **GitHub** and supply its repository and authentication settings if both packages live there. For an SSH (`git@`) URL, use an HTTPS clone URL with an origin credential on Node, or a **GitHub** source on Workers. Git over SSH is not served as installable distributions. The provider list also depends on the providers composed into your broker build.

<!-- source: packages/core/src/sources/config.ts:70 -->
<!-- source: packages/core/src/sources/config.ts:85 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:26 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:667 -->

Keep Satis metadata, archives, its existing credentials and your pre-migration application files until rollback has been rehearsed. Record the package versions, source commit references and archive URLs in the original lock file. Source creation does not transfer historical archives that are no longer available from the original repositories.

<!-- source: packages/core/src/sources/config.ts:18 -->
<!-- source: packages/core/src/sources/config.ts:26 -->
<!-- verify: Maintainer: rehearse with the original repositories reachable and confirm every locked version and archive is still available. -->

## Map the configuration

Compare your configuration with the [Satis configuration documentation](https://composer.github.io/satis/config.html). The table maps selection and storage settings; it does not promise identical package sets or version filtering.

<!-- verify: Maintainer: check the Satis configuration documentation link and each Satis key's meaning for the installed Satis version; record the checked date in the migration log. -->

| Satis input                              | Package Broker destination                                                                            | What to review                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories` with `type: vcs` or `git` | One Composer **Git repository** source for each repository.                                           | Select a served provider and the tags or branches to import. <!-- source: packages/ui/src/pages/sources/source-form.tsx:49 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:628 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:769 -->                                                |
| `repositories` with `type: composer`     | A **Composer repository** source with an explicit package selection.                                  | Use the original repository URL, rather than the Satis output URL, when retiring Satis. <!-- source: packages/ui/src/pages/sources/source-form.tsx:610 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:721 -->                                                                                       |
| `require`                                | Package names or patterns for a Composer repository source; tag and branch selection for Git sources. | No equivalent for Satis version constraints in source selection. Keep application version constraints in `composer.json` and compare resolved versions. <!-- source: packages/core/src/sources/config.ts:18 --> <!-- source: packages/core/src/sources/config.ts:26 -->                                             |
| `require-all`                            | No equivalent switch across all sources.                                                              | Enumerate the packages or reviewed patterns for each Composer source; an empty selection selects no packages. Git sources select tags and named branches. <!-- source: packages/ui/src/pages/sources/source-form.tsx:124 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:769 -->                     |
| `archive`                                | No equivalent Satis archive configuration object.                                                     | Broker archive storage and source retention are configured separately; existing Satis archives are not copied by these steps. <!-- source: packages/core/src/api/routes/sources-schemas.ts:51 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:119 -->                                                |
| `config`                                 | No equivalent bulk configuration object.                                                              | Review each Composer setting. Put source credentials in **Set credential** and application settings in the application's `composer.json`; do not paste Satis configuration into a source. <!-- source: packages/core/src/api/routes/sources-schemas.ts:26 --> <!-- source: packages/ui/src/pages/sources.tsx:55 --> |
| `repositories` with `type: path`         | No equivalent local-directory source.                                                                 | Make the package available through a served Git or Composer repository source before migrating. <!-- source: packages/core/src/sources/config.ts:5 -->                                                                                                                                                              |
| `repositories` with `type: artifact`     | No equivalent archive-directory source.                                                               | Publish the required versions through a served source; this procedure does not import a directory of archives. <!-- source: packages/core/src/sources/config.ts:5 -->                                                                                                                                               |
| `repositories` with `type: package`      | No equivalent inline package-definition source.                                                       | Provide the metadata and archives through a Composer repository source, or use a served Git source. <!-- source: packages/core/src/sources/config.ts:5 -->                                                                                                                                                          |
| `require-dependencies`                   | No equivalent dependency-expansion switch.                                                            | Inventory transitive dependencies in the whole application lock file and explicitly select any packages the broker must serve. <!-- source: packages/core/src/sources/config.ts:26 -->                                                                                                                              |

For example, start with this inventory in `satis.json`. Replace the example URLs and package names with repositories you control. The two Git repositories must contain the corresponding Composer package names and the tags required by your application; the Composer repository must serve `example/dependency`. All three packages must already be dependencies in the rehearsal application and present in its lock file. Replace these example package names in every command below.

<!-- verify: Maintainer: validate this sample against the installed Satis version and provide two tagged VCS packages plus one Composer repository package for the rehearsal. -->

```json
{
  "name": "Migration rehearsal",
  "homepage": "https://satis.example.com",
  "repositories": [
    { "type": "vcs", "url": "https://git.example.com/example/library-a.git" },
    { "type": "vcs", "url": "https://git.example.com/example/library-b.git" },
    { "type": "composer", "url": "https://composer.example.com" }
  ],
  "require": {
    "example/library-a": "*",
    "example/library-b": "*",
    "example/dependency": "*"
  },
  "require-all": false
}
```

## Recreate the sources

1. In **Projects**, expand **New project**, set **Project name** to `Satis migration` and **Slug** to `migration-satis`, and leave **Maximum token scope** at `read`. Choose **Create project** and leave the application's production repository configuration unchanged.
2. Switch the UI scope to **Organization**, open **Sources** and choose **Add source**. Set **Ecosystem** to Composer and **Source type** to **Git repository**. Name the first source `migration-library-a`, select **Git over HTTP(S)**, and enter the first Git URL from the inventory. Under **Advanced settings**, keep **Import tags** selected; leave **Branches to import** empty if your application uses only tags. Repeat for `migration-library-b` and the second Git URL.
3. Add `migration-dependency` with ecosystem Composer, source type **Composer repository**, repository URL `https://composer.example.com`, and `example/dependency` in **Package names (one per line)**. Leave package patterns empty for this rehearsal.
4. For each private source, choose **More → Set credential**, select the credential kind supported by that origin, and type the origin credential into the write-only **Set credential** dialog. Choose **Save credential**. Reauthenticate if requested. Use URLs without embedded credentials. If archives use another host, review **Additional archive hosts** before adding it: the source credential is also sent to those hosts.
5. In organization scope, open **More → Registered names** on each source. Use **Add name** to register only `example/library-a`, `example/library-b` or `example/dependency` on its corresponding source. Choose **Enable**, then **Sync now**. Wait for a successful sync; a queued request alone does not prove the versions were imported.
6. Switch to project `migration-satis`, open **Sources**, and **Attach** these three organization sources. Review **Source order** if another source supplies the same package name, then **Save source order**. Open **Packages** and compare the required versions and revisions with your inventory.

<!-- source: packages/ui/src/pages/projects.tsx:501 -->
<!-- source: packages/ui/src/pages/projects.tsx:364 -->
<!-- source: packages/ui/src/pages/projects.tsx:520 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:49 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:628 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:721 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:769 -->
<!-- source: packages/ui/src/pages/sources.tsx:55 -->
<!-- source: packages/ui/src/pages/sources.tsx:184 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:94 -->
<!-- source: packages/ui/src/pages/sources/source-form.tsx:122 -->
<!-- source: packages/ui/src/pages/sources.tsx:946 -->
<!-- source: packages/ui/src/pages/sources.tsx:998 -->
<!-- source: packages/ui/src/pages/sources.tsx:1287 -->
<!-- source: packages/ui/src/pages/sources.tsx:1381 -->
<!-- source: packages/ui/src/pages/sources.tsx:1450 -->
<!-- verify: Maintainer: complete source creation, credential entry, name registration, enablement, sync and attachment in the deployed UI; compare all three packages with the Satis inventory. -->

## Recreate access and credentials

Select project `migration-satis` in the UI scope, open **Access**, and review the intended consumers. For a read-only consumer, the recommended built-in role is **Project Auditor**, the narrowest built-in project role without write access. It reads packages, sources, grants (including e-mail addresses), project tokens and the audit log. If the consumer should only read packages, an organization admin can create a narrower custom project role with only `project:read` and `project:packages:read` under **Organization → Access → Roles → New role**, and use its ID for the grant instead. To find the chosen role's raw ID, switch to **Organization → Access → Roles** and copy the ID displayed beneath its name in the **Role** column. Return to the project scope, open **Access → New grant**, paste that ID into **Role ID**, enter the subject, and choose **Create grant**. For a group subject, enter the identity provider as well. Add only the grants needed for this project and test with the consumer's identity.

<!-- source: packages/ui/src/pages/access.tsx:348 -->
<!-- source: packages/ui/src/pages/access.tsx:558 -->
<!-- source: packages/ui/src/pages/access.tsx:581 -->
<!-- source: packages/core/src/authz/permissions.ts:146 -->
<!-- source: packages/core/src/api/routes/project-access-schemas.ts:78 -->
<!-- source: packages/core/src/api/routes/project-access-schemas.ts:103 -->
<!-- source: packages/ui/src/pages/access.tsx:434 -->
<!-- verify: Maintainer: recreate the intended grants, verify an intended consumer can read the sample packages and an identity without a grant cannot read them, and record the results without identity e-mail addresses. -->

Each consumer or CI environment needs its own broker identity and token, or its own service-principal project token. This is the broker counterpart of a per-customer Satis token. Grant each consumer identity access before it issues its personal token; do not distribute the administrator's personal token to consumers. See the [token table in the access model](../reference/access-model.md) for token selection.

<!-- source: packages/ui/src/pages/tokens.tsx:824 -->
<!-- source: packages/ui/src/pages/tokens.tsx:835 -->
<!-- source: packages/ui/src/pages/tokens.tsx:984 -->

For a personal token, sign in as that consumer, open **Tokens**, choose **My personal tokens** under **Token list**, and expand **Issue token**. Set **Scope** to **Read**, choose **Selected projects** under **Projects**, and enter only this project's ID in **Selected project IDs**. Find it in the **Project ID** column of **Projects**; use the ID, not the slug `migration-satis`. For CI using a service principal, you need an existing principal for this project and a project-scoped token. An administrator can create the principal under **Tokens → Service principals**, supplying this project's ID and the required permissions. In project scope, choose **Project tokens** under **Token list**, expand **Issue token**, select **Read** and that principal under **Service principal**, and issue the token. Follow [Composer credentials](../clients/composer.md#set-credentials) to supply the token through an uncommitted `auth.json` file or a secret `COMPOSER_AUTH` environment variable. Retain the original Satis authentication for rollback. Keep tokens out of repository URLs and shell command literals.

<!-- source: packages/ui/src/pages/projects.tsx:437 -->
<!-- source: packages/ui/src/pages/tokens.tsx:824 -->
<!-- source: packages/ui/src/pages/tokens.tsx:918 -->
<!-- source: packages/ui/src/pages/tokens.tsx:935 -->
<!-- source: packages/ui/src/pages/tokens.tsx:961 -->
<!-- source: packages/ui/src/pages/tokens.tsx:984 -->
<!-- source: packages/ui/src/pages/tokens.tsx:1042 -->
<!-- source: packages/core/src/auth/client-matrix.test.ts:93 -->

## Rehearse the switch

Use a disposable copy of the application, including its lock file. Keep its original files separately for rollback. In this sample, the existing Satis entry is the first repository and looks like this; preserve any other entries and their order in your own application.

<!-- verify: Maintainer: confirm the application's current Satis repository entry and canonical priority with its installed Composer version. -->

```json
{
  "repositories": [
    {
      "name": "satis",
      "type": "composer",
      "url": "https://satis.example.com"
    }
  ]
}
```

Replace that entry in the rehearsal copy with the following. Use your broker host; keep this entry ahead of other repositories that could supply the same private package names. Do not leave a direct Git or Satis entry ahead of it.

<!-- source: packages/core/src/registry/composer/routes.ts:77 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->
<!-- verify: Maintainer: confirm Composer resolves the sample packages through the broker with this repository ordering. -->

```json
{
  "repositories": [
    {
      "name": "broker",
      "type": "composer",
      "url": "https://<broker-host>/migration-satis"
    }
  ]
}
```

Run a resolution dry run from the rehearsal application's directory, naming all three packages. It may fetch metadata but should not change the lock file or install packages. Review the proposed versions against the original lock file. Stop if a required version is missing or an unexpected package changes.

<!-- verify: Maintainer: run this Composer dry run against the three synced sources; confirm no application files changed and retain a credential-redacted log. -->

```sh
composer update 'example/library-a' 'example/library-b' 'example/dependency' --dry-run --no-plugins --no-scripts
```

## Switch one application

In the rehearsal copy, resolve the same package set and install it. A targeted update can change the named packages and dependencies within your constraints; inspect the entire lock-file diff before accepting it. Changing the repository URL alone leaves existing lock-file distribution URLs intact.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->
<!-- source: packages/core/src/registry/composer/render.ts:91 -->
<!-- verify: Maintainer: run the targeted update, inspect versions and broker distribution URLs, then install in a fresh copy without vendor or a populated Composer cache. Record exit codes and the credential-redacted log; this live migration has not been run offline. -->

```sh
composer update 'example/library-a' 'example/library-b' 'example/dependency' --no-plugins --no-scripts
```

Require exit code `0` from the update. Check that the three packages' distribution URLs in `composer.lock` point to your broker and that their references match the reviewed versions. Search the whole lock file for the old Satis host, including source, distribution and notification URLs. Replace `satis.example.com` below with the old host from your inventory; repeat for any other host you plan to retire.

```sh
grep -cF 'satis.example.com' composer.lock
```

The count must be `0` (grep exits `1` for zero matches). Any match blocks retirement: migrate the remaining packages or URLs and repeat the check. Do not retire Satis while any application's lock file still refers to it.

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

Apply the reviewed repository entry and lock file to just this application. Supply broker credentials separately in developer and CI environments, and perform the same fresh install there. Keep Satis running until that application and its CI pass. Follow the [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md) recipe for CI credential handling.

<!-- verify: Maintainer or application CI: record a successful install and application checks after the single-application cutover, before retiring any Satis data or credentials. -->

## Roll back

Restore the pre-migration `composer.json` and `composer.lock` together. For the sample, the exact repository change is to replace the `broker` object above with this original object, in the same position; replace `https://satis.example.com` with the original Satis URL you recorded. Remove the broker entry if you added it separately. Restore any other repository and Packagist settings changed during the rehearsal.

<!-- verify: Maintainer: verify rollback with the recorded original Satis URL, metadata, archives and credentials, including an empty-cache install. -->

```json
{
  "name": "satis",
  "type": "composer",
  "url": "https://satis.example.com"
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

Require `install_status` to be `0` and confirm the old versions install from Satis before revoking the broker token issued for this migration. Restoring only the Satis URL while retaining the broker lock file is insufficient: that lock file can still point at broker archives.
