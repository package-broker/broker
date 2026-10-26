---
title: Migrate from Private Packagist
sidebar_position: 1
description: Import a Private Packagist snapshot, map teams and release dates, rehearse Composer installs and cut over with a rollback plan.
---

Move one application's package access to Package Broker while keeping Private Packagist available for rollback. Fetch an inventory, review an offline import plan, apply it to a broker project and rehearse installs before changing production. Repeat the rehearsal for every application.

## What moves and what does not

| Private Packagist input                                  | Package Broker destination or operator action                                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suborganizations                                         | Projects, with explicit slug mappings or references to existing projects.                                                                                                                 |
| Private VCS packages                                     | Organization-owned sources, registered names and project attachments. Versions and archives must still be obtainable from the original repositories; the snapshot does not copy archives. |
| Public packages and private mirrors                      | A Packagist proxy or Composer repository sources with package selections. Review mirror order and selection; mirroring behavior is reported rather than reproduced.                       |
| Source credentials                                       | References to newly supplied credentials. Secret values are not exported; retrieve or replace them separately.                                                                            |
| Tokens                                                   | Inventory only. Issue new broker developer and CI tokens and distribute them separately.                                                                                                  |
| Teams and permissions                                    | Explicit mappings to identity-provider groups and project grants. Configure the identity provider and its membership separately; review the resulting roles before approval.              |
| Release dates                                            | A separate dates manifest for private VCS versions with `releasedAt`, applied after those versions exist in the broker. Missing dates are counted and skipped.                            |
| Webhooks, synchronizations, monitoring and collaborators | Recreate the required configuration by hand. Synchronization inventory does not configure broker scheduling or webhook delivery.                                                          |
| Artifact packages, customers and vendor bundles          | Not migrated by this workflow. Preserve the original service until every required package has a supported serving path.                                                                   |

<!-- source: packages/cli/src/import/private-packagist/plan.ts:380 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:515 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:538 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:760 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:889 -->
<!-- source: packages/cli/src/import/private-packagist/dates.ts:168 -->

Imported sources are organization-owned and may serve attached projects. For credentials that must belong to only one project, create a project-owned source manually instead of approving the shared source. See the [access model](../reference/access-model.md#project-package-visibility-and-source-credentials).

<!-- source: packages/cli/src/import/private-packagist/plan.ts:432 -->
<!-- source: packages/core/src/catalogue/visibility.ts:71 -->

## Before you start

Have Composer 2, the `pb` CLI containing the snapshot, plan and dates commands, a running broker, and an organization admin session at `https://<broker-host>/_pb/ui`. Keep protected copies of the application's original `composer.json`, `composer.lock`, authentication configuration and CI secrets. Record all repository and archive hosts that must eventually be retired, along with the locked versions and source references. Keep Private Packagist and the original package repositories available throughout the rehearsal.

<!-- source: packages/cli/src/cli.ts:51 -->
<!-- source: packages/core/src/registry/composer/routes.ts:81 -->
<!-- source: packages/core/src/kernel/ui-routes.ts:9 -->

Choose a runtime with the source providers you need. Use `--runtime node` below for a Node deployment. For Workers, replace it with `--runtime workers` and map GitHub owners to installed GitHub App installation IDs in `github.installations`; confirm the required provider is composed into the broker. An SSH source requires Node unless a GitHub installation mapping converts it to a GitHub source. A planner accepting a URL is not proof that the deployed runtime can serve it.

<!-- source: packages/cli/src/import/private-packagist/plan.ts:575 -->
<!-- source: packages/core/src/sources/config.ts:70 -->

Obtain a Private Packagist API key and secret authorized to read the intended organization's inventory. In a private local editor, save their raw values separately as `pp-api-key` and `pp-api-secret` in the working directory; do not use JSON wrappers. Each credential value file must contain one line of 8 to 4096 bytes. Both files must be regular files owned by your current user, mode `0600` or stricter, without symlinks. Use a machine with POSIX user IDs and an accurate clock. The CLI reads the API at `https://packagist.com`; it does not accept an arbitrary export URL.

<!-- source: packages/cli/src/commands/import-private-packagist.ts:34 -->
<!-- source: packages/cli/src/import/private-packagist/api.ts:3 -->

Replace `example-org` with the Private Packagist organization short name. Run in a private working directory, with shell tracing disabled. Use unused output paths: fetch refuses an existing `--snapshot` destination with `output_exists`, and planning commands refuse to overwrite files.

<!-- source: packages/cli/src/cli.ts:51 -->
<!-- source: packages/cli/src/import/private-packagist/snapshot.ts:432 -->

```sh
set +x
umask 077
pb import private-packagist fetch --org example-org \
  --api-key-file ./pp-api-key --api-secret-file ./pp-api-secret \
  --snapshot ./pp-snapshot.json --versions --require-org-match
```

Require exit code `0`. `--versions` includes private-package version details needed for release dates. `--require-org-match` refuses an inventory whose organization cannot be verified from repository evidence; investigate `org_unverified` or `org_mismatch` before continuing. Review any dropped-row notices against your package inventory. Treat the snapshot as confidential even though credential values and account e-mail fields are excluded; do not commit it or place it in CI artifacts. Keep its mode `0600` and do not edit its contents or per-object hashes.

<!-- source: packages/cli/src/import/private-packagist/snapshot.ts:418 -->
<!-- source: packages/cli/src/import/private-packagist/snapshot.ts:408 -->
<!-- source: packages/cli/src/commands/import-private-packagist.ts:121 -->
<!-- source: packages/cli/src/import/private-packagist/snapshot.test.ts:189 -->

## Map projects, teams and credentials

Create `pp-map.json` using the snapshot's suborganization short names, team names, mirror IDs and repository hosts. This example assumes suborganization `application`, an organization team `Application developers`, one mirror with ID `20`, and Git and mirror hosts that use HTTP Basic authentication. Replace those values with your inventory; remove the mirror ID if no mirror is used. The team mapping names the provider identifier and exact group value supplied by your configured identity provider.

<!-- source: packages/cli/src/import/private-packagist/map.ts:22 -->
<!-- source: packages/cli/src/import/private-packagist/map.ts:64 -->

```json
{
  "version": 1,
  "projects": {
    "application": { "slug": "migration-private-packagist" }
  },
  "teams": {
    "Application developers": {
      "group": { "provider": "oidc", "value": "application-developers" },
      "projects": ["migration-private-packagist"]
    }
  },
  "mirrorOrder": [20],
  "credentials": [
    {
      "match": { "host": "git.example.com" },
      "kind": "http_basic",
      "ref": "file:./git-credential.json"
    },
    {
      "match": { "host": "composer.example.com" },
      "kind": "http_basic",
      "ref": "file:./mirror-credential.json"
    }
  ]
}
```

For an existing broker project, replace `{"slug":"migration-private-packagist"}` with `{"existing":"migration-private-packagist"}`. Each snapshot suborganization otherwise creates a project with its original short name; the map is not a project filter. Check the entire plan even when rehearsing only one application. List used mirror IDs in the intended priority order. The default plan keeps exact package selections; do not enable selection compaction just to bypass a limit without reviewing its warnings about additional package visibility.

<!-- source: packages/cli/src/import/private-packagist/plan.ts:380 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:677 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:760 -->

Configure identity-provider groups and membership by hand before granting access. Unlisted teams are skipped. Organization `view` and `edit` teams require explicit target projects; suborganization teams target their mapped project. The `projects` field in each `teams` mapping applies only to organization teams. The planner maps `view` to Project Developer, which includes package-write permission, and `owner` to Project Owner. Review this deliberately: for install-only users, omit that team from the import map and create a narrower project grant manually. Built-in teams are skipped, and organization admin grants require a separate explicit opt-in; this example does not enable it. Group membership must be evidenced through the matching provider, not merely share a name. See the [access model](../reference/access-model.md) for roles, group evidence and project visibility.

<!-- source: packages/cli/src/import/private-packagist/plan.ts:1025 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:1070 -->
<!-- source: packages/core/src/authz/permissions.ts:139 -->
<!-- source: packages/db-sqlite/src/repositories/access.ts:252 -->

Credential references identify local secret material, not the old Private Packagist credential values. Create `git-credential.json` and `mirror-credential.json` privately with the appropriate credentials for each original repository. For `http_basic`, each file must be strict JSON with exactly the keys `username` and `password`, for example `{"username":"<repository-user>","password":"<repository-password>"}`. A host rule covers all matching sources; use a package-specific rule when credentials differ. For a reviewed public source, use an explicit matching rule with `"ref": null`. Do not put secrets or credential-bearing URLs in the map or manifest. If archives require another host, review `distHosts` explicitly: source credentials can be sent to those hosts.

<!-- source: packages/cli/src/commands/import.ts:63 -->
<!-- source: packages/core/src/sources/credentials.ts:150 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:228 -->
<!-- source: packages/cli/src/import/private-packagist/map.ts:180 -->

## Plan and import into a project

Generate the structure manifest and credential-binding map offline. Require exit code `0`, then review both output files and all `create`, `existing`, `warning`, `needs-input` and `unsupported` entries. Resolve missing credentials, skipped artifacts and access differences before treating the import as complete. `--quiet` keeps detailed inventory out of the terminal; it does not replace reviewing the files. Retain the exact structure manifest as the baseline for dates and later additive planning.

<!-- source: packages/cli/src/commands/import-private-packagist.ts:183 -->

```sh
pb import private-packagist plan --snapshot ./pp-snapshot.json \
  --map ./pp-map.json --runtime node --out ./pp-structure.json \
  --credentials-out ./pp-credentials.json --quiet
```

Supply `PB_IMPORT_TOKEN` through your protected operator environment, using an all-project, `full` token with `org:import:write` authority. This is a migration credential, separate from the read-only tokens used by Composer. Set `BROKER` to the broker HTTPS origin without a project path, then submit. The principal label is a non-secret local receipt label.

<!-- source: packages/core/src/api/routes/import.schemas.ts:28 -->
<!-- source: packages/core/src/authz/scope.ts:102 -->
<!-- source: packages/cli/src/commands/import.ts:206 -->

```sh
BROKER='https://<broker-host>'
pb import submit --manifest ./pp-structure.json --receipt ./pp-structure-receipt.json \
  --principal migration-operator --broker "$BROKER"
```

Record the printed run ID as `RUN`. Submission only creates a planned run. In the UI's **Import** page, select that run, review its plan hash in the UI and the widening entries in the manifest, use **Review approval** and **Approve run**, then **Apply**. These actions require an authorized user session with `org:import:approve` and any requested reauthentication. If submission loses its response, retry the same command with `--resume`, the same manifest, receipt, token and principal label; do not submit a new run blindly. Reconcile an unknown outcome in the UI if replay is refused.

<!-- source: packages/ui/src/pages/import.tsx:300 -->
<!-- source: packages/core/src/import/apply.ts:298 -->
<!-- source: packages/ui/src/pages/import.tsx:429 -->
<!-- source: packages/core/src/api/routes/import.ts:272 -->
<!-- source: packages/cli/src/commands/import.ts:235 -->

Upload credentials only after apply opens the credential window shown by status. Set `RUN` to the actual run ID before these commands. Repeating the upload skips already bound entries; a closed window must be reconciled in the UI.

<!-- source: packages/cli/src/commands/import.ts:338 -->
<!-- source: packages/cli/src/commands/import.test.ts:1204 -->

```sh
pb import status "${RUN:?}" --broker "$BROKER" --wait-seconds 300
pb import credentials "$RUN" --manifest ./pp-structure.json \
  --credentials ./pp-credentials.json --broker "$BROKER"
```

In **Sources**, review registered names, project attachments, package selections and source order. Imported sources start paused; explicitly **Enable** and **Sync now** for each required source. Wait for successful sync and compare all required versions and revisions in **Packages**. If a sync refuses removals, inspect the proposed loss before accepting it; removal acceptance is not a migration prerequisite. Recreate webhooks, monitoring and required synchronization settings separately.

<!-- source: packages/core/src/import/apply.ts:175 -->
<!-- source: packages/ui/src/pages/sources.tsx:962 -->
<!-- source: packages/cli/src/commands/source.ts:11 -->

## Preserve release dates

After the VCS sources are enabled and synced, plan a separate dates run with the same snapshot, map and complete structure baseline. Require exit code `0`; review `version_override` and `releasedAt_missing` counts. Missing dates are skipped, not invented. The server refuses overrides for versions that do not exist, so resolve absent historical tags or versions before submission.

<!-- source: packages/cli/src/commands/import-private-packagist.ts:250 -->
<!-- source: packages/cli/src/import/private-packagist/dates.ts:100 -->

```sh
pb import private-packagist dates --snapshot ./pp-snapshot.json \
  --map ./pp-map.json --baseline ./pp-structure.json --out ./pp-dates.json --quiet
pb import submit --manifest ./pp-dates.json --receipt ./pp-dates-receipt.json \
  --principal migration-operator --broker "$BROKER"
```

Skip submission if the dates manifest has no items. Otherwise, review, approve and apply this second run in the UI. Keep its run ID separate from `RUN`. For a plan exceeding a single-run limit, generate separate dates manifests with repeated `--package <name>` selectors for each batch, using a new output and receipt path for each run. Dates cover private VCS package releases; mirror and proxy versions are excluded.

<!-- source: packages/cli/src/import/private-packagist/dates.ts:129 -->
<!-- source: packages/cli/src/import/private-packagist/dates.ts:148 -->
<!-- source: packages/cli/src/commands/import.ts:219 -->

Request verification for each applied run, using its actual ID. Require the state `verified`, then, after the install rehearsal below, have an authorized operator accept each run through the session-authenticated `POST /_pb/import-runs/:id/accept` API operation with `org:import:approve`, the broker Origin header and the session's CSRF token. `pb import accept` only observes acceptance and directs the operator to the UI; it does not approve or accept a run itself.

<!-- source: packages/cli/src/commands/import.ts:406 -->
<!-- source: packages/core/src/api/routes/import.schemas.ts:80 -->
<!-- source: packages/ui/src/pages/import.tsx:22 -->

```sh
pb import verify "${RUN:?}" --broker "$BROKER" --wait-seconds 300
```

**Not available yet:** the Import UI has no acceptance button, even though the CLI directs acceptance there; use the authenticated API operation above. This workflow does not transfer historical archives, upload artifact packages, reproduce inline custom package JSON, migrate customer/vendor-bundle configuration, copy tokens or configure SSO and webhooks automatically. Override-mode replacement and destructive baseline deltas are refused. Keep affected packages on their existing serving path until an alternative has been tested.

<!-- source: packages/cli/src/import/private-packagist/plan.ts:332 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:503 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:889 -->
<!-- source: packages/cli/src/import/private-packagist/plan.ts:940 -->

## Switch Composer clients and CI

Use a disposable copy of the application first. Replace `<broker-host>` with the HTTPS host, including any nondefault port, and use your mapped project slug. Add the broker repository and place it before the existing Private Packagist entry in `composer.json`. Keep the original entry and files available for rollback. Follow [Composer setup](../clients/composer.md) for repository priority and any decision to disable direct Packagist access.

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:561 -->

```sh
composer config repositories.broker composer 'https://<broker-host>/migration-private-packagist'
```

Issue a broker PAT for developers or a project-bound service token for CI, with scope `read` and package-reading authority. For local installs, put the following in the application's ignored `auth.json`, substituting the actual host and token privately. Preserve existing authentication entries while both services run. Private Packagist tokens do not authenticate to the broker.

<!-- source: packages/core/src/auth/client-matrix.test.ts:70 -->
<!-- source: packages/core/src/authz/scope.ts:71 -->

```json
{
  "http-basic": {
    "<broker-host>": { "username": "token", "password": "<broker-token>" }
  }
}
```

For CI, create a project-bound service principal with `project:read` and `project:packages:read`, issue a `read` service token and store its authentication JSON as the consuming repository's `COMPOSER_AUTH` secret. Follow [GitHub Actions](../ci/github-actions.md) for issuance, secret handling and cache isolation. Do not reuse `PB_IMPORT_TOKEN` for installs or commit `auth.json`.

<!-- source: packages/core/src/api/routes/service-principals-schemas.ts:18 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->

## Run side by side and cut over

Keep production on Private Packagist while testing the broker copy with the intended developer and CI identities. Re-resolve the packages being moved; changing the repository URL alone leaves old archive URLs in `composer.lock`. Replace `example/library` below with each package being migrated. The update can change selected packages and dependencies within application constraints, so review the whole lock-file diff, versions and source references before accepting it.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->
<!-- source: packages/core/src/registry/composer/render.ts:94 -->

```sh
composer update 'example/library' --no-plugins --no-scripts
```

Check that distribution URLs for the migrated packages point to the broker. Search the entire lock file for every retiring host, including source, distribution and notification URLs. Set `OLD_HOST` to the actual host from your original inventory; repeat for other retiring hosts. A zero count is required before retirement; grep exits `1` when there are no matches.

```sh
grep -cF "${OLD_HOST:?}" composer.lock
```

Remove the installed packages from the disposable copy's configured vendor directory and install the reviewed lock file with an empty cache. Require exit status `0` and archive downloads from the broker, without source-clone fallback for the migrated packages. Run the application's usual checks; review required plugins and scripts before enabling them.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->

```sh
rm -rf -- "$(composer config vendor-dir)"
cutover_cache=$(mktemp -d)
install_status=0
COMPOSER_CACHE_DIR="$cutover_cache" composer install -v --no-plugins --no-scripts || install_status=$?
rm -rf "$cutover_cache"
test "$install_status" -eq 0
```

Apply the reviewed `composer.json` and `composer.lock` to one application, supply its new credential separately and repeat the empty-cache install in CI. Rehearse rollback before accepting the import runs through the API and retiring any service. Remove the old repository entry only after confirming the broker serves every required package; verify another fresh install after removal. Keep Private Packagist credentials and archives available until all applications have passed this check.

<!-- verify: Maintainer or application CI: fetch a live snapshot, review the complete structure and dates plans, apply and sync, compare versions/references/dates, check intended access and denied access, then retain credential-redacted empty-cache archive-install and rollback results. This live migration has not been run in the offline documentation environment. -->

## Roll back

Restore the original `composer.json` and `composer.lock` together, including the recorded Private Packagist repository entry and any Packagist settings. Restore the original local authentication and CI secret configuration from protected storage. Remove the broker entry if it was absent originally. Restoring only the repository URL can leave the lock file pointing at broker archives.

<!-- source: packages/core/src/registry/composer/render.ts:94 -->

In the disposable copy, verify the original lock file installs with the normal application command and an empty cache while Private Packagist remains available. Keep the application's normal install flags if it requires them.

<!-- source: packages/runtime-node/src/registry-clients.test.ts:525 -->

```sh
rm -rf -- "$(composer config vendor-dir)"
rollback_cache=$(mktemp -d)
install_status=0
COMPOSER_CACHE_DIR="$rollback_cache" composer install || install_status=$?
rm -rf "$rollback_cache"
test "$install_status" -eq 0
```

Client rollback does not require undoing broker configuration. If you also need to undo an import, inspect **Rollback** in the Import page while its before-images are retained; availability depends on run state and retention. Revoke unneeded broker tokens separately. After acceptance and the rollback retention decision, delete the confidential snapshot and local credential material according to your retention policy, preserving only the protected records you still need.

<!-- source: packages/ui/src/pages/import.tsx:50 -->
<!-- source: packages/core/src/authz/token-revoke.ts:84 -->
<!-- source: packages/cli/src/commands/import-private-packagist.ts:78 -->
