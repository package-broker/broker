# @package-broker/dist

This package contains the prebuilt Package Broker Node runtime in `node/` and release metadata in `prebuilt.json`. The release process supplies these payload files; they are absent from the source checkout.

See the [quickstart](https://github.com/package-broker/broker/blob/main/docs/getting-started/quickstart-docker.md) for setup instructions.

Local password and TOTP sign-in is enabled by default. For SSO-only operation, set `PB_AUTH_LOCAL=disabled` in the Node environment and restart the process or container. Set `PB_AUTH_LOCAL=enabled` and restart to restore local sign-in. Only `enabled` and `disabled` are accepted. Disabling requires at least one successfully constructed SSO provider; otherwise startup refuses with `auth_no_sign_in_method`. Check provider secrets too: a constructed provider can still fail at sign-in.

Before disabling, configure a working SSO administrator with a verified, authoritative domain. Cloudflare Access bootstrap additionally requires trusted e-mail verification. Existing local and SSO sessions survive until logout, revocation or normal expiry (12 hours maximum, 1 hour idle). Local reauthentication stops; existing freshness lasts at most 10 minutes. Personal access tokens and service tokens remain independent of this setting.

Use matching CLI, runtime and prebuilt releases. Supporting runtimes declare `packageBroker.localAuth: 1` in package metadata; an artifact without the marker cannot safely disable local sign-in. For Cloudflare, `pb cloudflare setup` and `deploy` accept `--local-auth enabled|disabled`; re-enabling requires the explicit flag again on resume, reinstall from an old journal and a second deploy before smoke passes. SSO-only setup returns `login_url` ending in `/_pb/ui/#/login` and issues no setup token.

See [Authentication and sessions](https://github.com/package-broker/broker/blob/main/docs/reference/authentication.md#enable-or-disable-local-sign-in) for SSO bootstrap trust, errors, retained sessions, CLI warnings and deployment recovery, and the [Cloudflare quickstart](https://github.com/package-broker/broker/blob/main/docs/getting-started/quickstart-cloudflare.md#change-local-sign-in-policy) for Worker deployment steps.
