---
title: Troubleshooting Composer and npm installs
sidebar_position: 0
description: Match a Composer authentication error to its checks and fix, or find npm client setup.
---

Match the message from your install to a page below. These three Composer errors concern vendor authentication or local JSON syntax; a failure at the broker host needs a broker token check.

- [The 'https://repo.magento.com/packages.json' URL required authentication (HTTP 401).](magento-http-401.md) — Marketplace refused the request; check the failed host and credential placement.
- [Invalid credentials (HTTP 401) for 'https://repo.magento.com/packages.json', aborting.](magento-invalid-credentials.md) — Marketplace rejected supplied credentials; check key mapping and account access.
- [`"./auth.json" does not contain valid JSON`](invalid-auth-json.md) — Composer could not parse a local authentication file; the quoted path varies.

For broker token failures, follow [Composer authentication checks](../clients/composer.md#resolve-authentication-failures) or [npm, pnpm and Yarn setup](../clients/npm-pnpm-yarn.md).
