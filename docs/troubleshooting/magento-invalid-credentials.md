---
title: "Invalid credentials (HTTP 401) for 'https://repo.magento.com/packages.json', aborting."
sidebar_position: 2
description: Resolve rejected Magento Marketplace Composer credentials, including reports described as could not authenticate.
---

## Cause

Composer tried credentials for `repo.magento.com` and the request was refused. This title appears only in interactive runs, from the authentication handler after a repeated HTTP 401 with credentials already present. Noninteractive runs print [URL required authentication](magento-http-401.md). The URL varies with the requested metadata or archive.

<!-- verify: composer-invalid-credentials — maintainer / Composer CI: capture the full interactive CLI failure using synthetic credentials against a disposable HTTP fixture, then confirm Marketplace behavior. Offline evidence invokes Composer 2.10.3 AuthHelper with an existing synthetic credential, retry count 1 and simulated 401. -->

A search for “could not authenticate” may refer to another Composer version or source host. Use the actual failed host and HTTP status before choosing a fix; do not assume that phrase is the literal Marketplace error in your version.

## Check

In an interactive terminal, repeat the failure in the application's directory with the same protected credential environment. Scripts and plugins are disabled, but this command can download packages and change installed files. Keep its output private and record only the host, status and message without credentials. If Composer prompts for credentials, stop: credentials are missing from this check. Composer may offer to save credentials to `auth.json` in plain text; answer no.

<!-- source: scripts/bench-install.mjs:16 -->
<!-- verify: composer-invalid-credentials — maintainer / Composer CI: confirm CLI output, interactive/noninteractive differences and host using the installed Composer version. -->

```sh
composer install --no-scripts --no-plugins --prefer-dist --no-progress
```

If the broker's source reports `Authorization failed`, inspect that source's sync state instead. Vendor HTTP 401 and 403 have the same broker label, so that label alone does not distinguish rejected authentication from a vendor entitlement refusal.

<!-- source: packages/core/src/ingest/source-sync-job.ts:184 -->
<!-- source: packages/ui/src/pages/sources.tsx:880 -->

## Fix

Check that the credential belongs to the intended purchasing account and can access the required package. For Marketplace HTTP Basic authentication, use the public key as the HTTP Basic username and the private key as the password. Check for wrong, expired or revoked keys before replacing the credential. Supply replacement values through a protected file, secret environment or the broker's source credential form; keep them out of command arguments and shared output. Do not widen another project's access to test a purchased package.

<!-- verify: marketplace-entitlement — maintainer with the owner of a disposable purchasing account: confirm public-key username/private-key password mapping, rejected-key behavior and entitlement checks. Marketplace entitlement cannot be established from this checkout. -->

For broker-managed installs, update the credential on the correct project source, reauthenticate if prompted, and enter it again. The UI deliberately discards credential input across reauthentication. Sync the source and retry the application install after the sync succeeds.

<!-- source: packages/ui/src/pages/sources.tsx:184 -->
<!-- source: packages/ui/src/pages/sources.tsx:624 -->

Follow [Vendor repositories as sources](../guides/mirror-vendor-repositories.md) for source ownership and credential entry, and [Composer client setup](../clients/composer.md) for the separate broker install token. Select its kind and scope using the [access model token table](../reference/access-model.md).

If the failed host is the broker, use the status checks in [Composer authentication failures](../clients/composer.md#resolve-authentication-failures). Changing Marketplace keys does not repair an expired or revoked broker token.

<!-- source: packages/core/src/authz/token-use.ts:114 -->
