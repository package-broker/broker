---
title: "The 'https://repo.magento.com/packages.json' URL required authentication (HTTP 401)."
sidebar_position: 1
description: Check a Magento Composer HTTP 401 and distinguish direct Marketplace access from broker source authentication.
---

## Cause

Composer received HTTP 401 from the Marketplace metadata URL in a noninteractive run. This can mean credentials are missing, wrong, expired or revoked; the message does not distinguish them. The next line is `You must be using the interactive console to authenticate`. A different requested path changes the URL in the message.

<!-- verify: composer-marketplace-401 — maintainer / Composer CI: reproduce a real CLI HTTP 401 with a disposable repository fixture and then Marketplace; retain sanitized output. Offline evidence invokes the installed Composer 2.10.3 AuthHelper with a simulated 401, not a live HTTP exchange. -->

If the failed URL is `repo.magento.com`, Composer is contacting the vendor directly. If it is the broker's project URL, check the broker token instead. A broker source sync maps vendor HTTP 401 and 403 to `unauthorized`, displayed as `Authorization failed`; the broker does not forward the vendor's authentication challenge to Composer.

<!-- source: packages/core/src/ingest/source-sync-job.ts:172 -->
<!-- source: packages/ui/src/pages/sources.tsx:880 -->

## Check

From the application's directory, repeat the install with scripts and plugins disabled. This still downloads packages and may write installed files. Run in a private terminal; keep output private because client failures can contain repository addresses.

<!-- source: scripts/bench-install.mjs:16 -->
<!-- verify: composer-marketplace-401 — maintainer / Composer CI: run this command on the failing fixture and confirm the requested host without publishing credentials or auth-file contents. -->

```sh
composer install --no-interaction --no-scripts --no-plugins --prefer-dist --no-progress
```

Read the host in the failure. Check repository entries and the existing lock file privately: previously locked download URLs may still point directly to the vendor after changing repository configuration. Do not delete the lock file to bypass an authentication failure.

<!-- source: scripts/bench-install.mjs:705 -->

## Fix

For an application intended to install through the broker, follow [Composer client setup](../clients/composer.md) to set the project repository URL and broker token, and review the lock-file URLs. For a direct Marketplace install, supply the Marketplace credential through a protected `auth.json` file or `COMPOSER_AUTH` in the job's secret environment; do not use a broker token as the vendor credential. If keys are already supplied, follow the [key-mapping and account-access fix](magento-invalid-credentials.md#fix) to check their placement and validity.

<!-- source: scripts/bench-install.mjs:251 -->
<!-- verify: marketplace-key-mapping — maintainer with a disposable Marketplace credential: confirm public key as HTTP Basic username and private key as password against repo.magento.com; do not copy their values into logs. -->

For `Authorization failed` in broker Sources, fix the credential on the correct project-owned source using [Vendor repositories as sources](../guides/mirror-vendor-repositories.md), then sync again. Keep the project's purchased-package credential on that project's source. Replacing a developer's broker token cannot repair a failed vendor login.

<!-- source: packages/core/src/sources/source-service.ts:894 -->
<!-- source: packages/ui/src/pages/sources.tsx:624 -->

See also [Invalid credentials from Marketplace](magento-invalid-credentials.md) and [Invalid auth.json](invalid-auth-json.md).
