---
title: Authentication and sessions
sidebar_position: 4
description: Local accounts, single sign-on, sessions and the auth HTTP routes.
---

People sign in to Package Broker with a local account (password and TOTP) or through a single sign-on provider from the `sso-oidc` plugin. A successful sign-in creates a browser session held in cookies. Tokens, roles and grants are described in the [Access model](access-model.md).

## Routes

| Method and path                         | Purpose                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /_pb/auth/local/setup/start`      | Start setting up a local account with a setup token.                                                        |
| `POST /_pb/auth/local/setup/finish`     | Set the password and confirm the TOTP secret. Signs the user in.                                            |
| `POST /_pb/auth/local/login`            | Sign in with e-mail, password and TOTP code.                                                                |
| `POST /_pb/auth/local/reauth`           | Confirm password and TOTP code again inside a session.                                                      |
| `GET /_pb/auth/providers`               | List the configured single sign-on providers and whether local sign-in is available. Needs no organization. |
| `POST /_pb/auth/sso/{provider}/start`   | Start a single sign-on login or re-authentication.                                                          |
| `GET /_pb/auth/sso/{provider}/callback` | Return address for OIDC providers.                                                                          |
| `POST /_pb/auth/logout`                 | End the session.                                                                                            |
| `GET /_pb/session`                      | The signed-in user and session expiry.                                                                      |

<!-- source: packages/core/src/auth/module.ts:77 -->
<!-- source: packages/core/src/auth/routes-sso.ts:622 -->

Errors use one JSON shape: `{"error":{"code":"...","message":"...","requestId":"..."}}`; validation errors add a `details` list. Failed local sign-ins return `401` with the code `invalid_credentials`, and refused single sign-on logins return `401` with `login_failed`. Neither says which check failed.

<!-- source: packages/core/src/envelope.ts:12 -->
<!-- source: packages/core/src/auth/routes-local.ts:119 -->
<!-- source: packages/core/src/auth/routes-sso.ts:251 -->

| Status | Code                           | When                                                                                                                                                                      |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`                  | A local auth route got a body that is not `application/json`, not valid JSON, or larger than 8 KiB.                                                                       |
| 400    | `invalid_request`              | A local auth route got unknown, missing or over-long fields, or `sso/{provider}/start` got a body that is not valid JSON, is larger than 8 KiB or has no valid `purpose`. |
| 400    | `weak_password`                | `setup/finish` got a password that breaks the rules below.                                                                                                                |
| 400    | `reauth_unsupported`           | `sso/{provider}/start` asked for re-authentication from a provider that does not support it.                                                                              |
| 401    | `invalid_credentials`          | Wrong password, TOTP code or setup token, an expired setup token, or a locked account.                                                                                    |
| 401    | `login_failed`                 | A single sign-on login was refused, or a single sign-on re-authentication was started without a valid session.                                                            |
| 401    | `unauthorized`                 | No valid session (`/_pb/session`, `logout`, `local/reauth`).                                                                                                              |
| 403    | `forbidden`                    | The origin check or the CSRF token check failed.                                                                                                                          |
| 404    | `not_found`                    | Unknown route, or an unknown provider ID in `sso/{provider}/start` or `callback`.                                                                                         |
| 502    | `provider_error`               | The provider could not be used, for example its client secret is missing or discovery failed.                                                                             |
| 503    | `provider_binding_unavailable` | The provider's recorded trust anchor could not be read.                                                                                                                   |

<!-- source: packages/core/src/auth/routes-local.ts:70 -->
<!-- source: packages/core/src/auth/routes-local.ts:79 -->
<!-- source: packages/core/src/auth/routes-local.ts:184 -->
<!-- source: packages/core/src/auth/routes-sso.ts:387 -->
<!-- source: packages/core/src/auth/routes-sso.ts:402 -->
<!-- source: packages/core/src/auth/routes-sso.ts:412 -->
<!-- source: packages/core/src/auth/routes-sso.ts:471 -->
<!-- source: packages/core/src/auth/routes-sso.ts:479 -->
<!-- source: packages/core/src/auth/routes-sso.ts:271 -->

### Request rules

- Request bodies are JSON (`content-type: application/json`), at most 8 KiB.
- Every `POST` must come from the broker's own origin. It must carry an `Origin` header, a `Sec-Fetch-Site` header, or both, and each one present must pass: `Origin` equal to `PB_PUBLIC_URL`, `Sec-Fetch-Site` equal to `same-origin` or `none`. Otherwise the answer is `403 forbidden`. Command-line clients such as `curl` must send the `Origin` header themselves.
- Requests made inside a session (`reauth`, `logout`, and `sso/{provider}/start` with `"purpose":"reauth"`) also need an `X-CSRF-Token` header with the value of the `__Host-pb_csrf` cookie. The same origin and CSRF checks apply to every other `POST`, `PUT`, `PATCH` and `DELETE` API call made with a session.

<!-- source: packages/core/src/auth/routes-local.ts:20 -->
<!-- source: packages/core/src/auth/routes-sso.ts:67 -->
<!-- source: packages/core/src/auth/csrf.ts:28 -->
<!-- source: packages/core/src/auth/routes-local.ts:239 -->
<!-- source: packages/core/src/authz/engine.ts:270 -->

## Local accounts

A local account is created by `pb admin bootstrap` (an administrator) and repaired by `pb admin reset-local`. Both issue a setup token that is valid for 24 hours. See the [pb CLI reference](cli.md#pb-admin-bootstrap).

<!-- source: packages/cli/src/commands/admin.ts:51 -->

1. `POST /_pb/auth/local/setup/start` with `{"token":"..."}` returns `{"provisioningUri":"otpauth://...","secret":"..."}`. Add the URI to an authenticator app.
2. `POST /_pb/auth/local/setup/finish` with `{"token":"...","password":"...","code":"123456"}` sets the password, confirms the TOTP secret and answers `204` with session cookies.
3. Afterwards, `POST /_pb/auth/local/login` with `{"email":"...","password":"...","code":"123456"}` answers `204` with session cookies.

<!-- source: packages/core/src/auth/routes-local.ts:148 -->
<!-- source: packages/core/src/auth/routes-local.ts:174 -->
<!-- source: packages/core/src/auth/routes-local.ts:212 -->

Local sign-in works only for an active user who can hold organization administration.

<!-- source: packages/core/src/auth/local-login.ts:73 -->

Passwords are 12 to 128 characters and must not equal the e-mail address. A weak password at `setup/finish` returns `400` with the code `weak_password` and a `problems` list with one or more of `too_short`, `too_long`, `equals_email` and `not_well_formed`.

<!-- source: packages/core/src/auth/password.ts:10 -->

TOTP codes are six digits with a 30-second period. The broker accepts the previous, current and next code, but never a code from a time step at or before the last one it accepted for that account. In practice each code works once.

<!-- source: packages/core/src/auth/totp.ts:3 -->
<!-- source: packages/core/src/auth/totp.ts:13 -->
<!-- source: packages/core/src/auth/totp.ts:108 -->

Every fifth failed attempt in a row at `local/login`, `local/reauth` or `setup/finish` locks the account for 15 minutes. During the lock every attempt answers `401 invalid_credentials`, as a wrong password would. A successful sign-in resets the count, and `pb admin reset-local` clears the lock.

<!-- source: packages/db-sqlite/src/repositories/local-login.ts:14 -->
<!-- source: packages/core/src/auth/local-login.ts:56 -->
<!-- source: packages/core/src/auth/local-setup.ts:52 -->

[Quickstart: Docker](../getting-started/quickstart-docker.md#first-administrator) shows the first sign-in.

## Sessions

A session is two cookies, both `Secure`, `Path=/` and with the `__Host-` prefix:

- `__Host-pb_session`: `HttpOnly`, `SameSite=Lax`. The session itself.
- `__Host-pb_csrf`: readable by scripts, `SameSite=Strict`. Its value goes in the `X-CSRF-Token` header.

<!-- source: packages/core/src/auth/cookies.ts:1 -->
<!-- source: packages/core/src/auth/session.ts:58 -->

A session ends 12 hours after sign-in, or after 1 hour without requests, whichever comes first. `GET /_pb/session` returns:

<!-- source: packages/core/src/auth/session.ts:17 -->

```json
{
  "user": { "id": "...", "email": "admin@example.test", "displayName": null },
  "reauthFresh": false,
  "expiresAt": "2026-10-19T20:10:32.519Z"
}
```

While a single sign-on login is in progress, a third cookie, `__Host-pb_login` (`HttpOnly`, `SameSite=Lax`), holds the login state for at most 10 minutes; the callback clears it.

<!-- source: packages/core/src/auth/login-state.ts:6 -->

`reauthFresh` is `true` for 10 minutes after a re-authentication through `POST /_pb/auth/local/reauth` (body `{"password":"...","code":"..."}`) or through an OIDC provider. A session started through single sign-on cannot re-authenticate with `local/reauth`.

<!-- source: packages/core/src/auth/session.ts:20 -->
<!-- source: packages/core/src/auth/local-login.ts:281 -->

`POST /_pb/auth/logout` ends the session and answers `204`. Without a valid session it answers `401` and clears the cookies.

<!-- source: packages/core/src/auth/routes-sso.ts:577 -->

## Single sign-on

Single sign-on comes from the `@package-broker/plugin-sso-oidc` plugin. It supports two provider kinds: a generic OpenID Connect provider (`oidc`) and Cloudflare Access (`cloudflare-access`). Providers come from two places: the `providers` list in `broker.config.ts`, which is part of the build, and, when the plugin is enabled with `runtimeProviders: true`, the `PB_IDP_PROVIDERS` environment variable read at run time.

```ts
import { defineConfig } from '@package-broker/core/config';
import ssoOidc from '@package-broker/plugin-sso-oidc';

export default defineConfig({
  platform: 'node',
  plugins: [
    ssoOidc({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          displayName: 'Corporate SSO',
          issuer: 'https://idp.example.test',
          clientId: 'package-broker',
          policy: { verifiedDomains: ['example.test'], autoJoin: true },
        },
      ],
    }),
  ],
});
```

`ssoOidc()` without providers and without `runtimeProviders` adds no provider. A list holds at most 64 providers, and two providers may not share an `id` or a trust anchor. An invalid entry in `broker.config.ts` fails the build.

<!-- source: packages/plugin-sso-oidc/src/index.ts:85 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:88 -->
<!-- source: packages/plugin-sso-oidc/src/definitions.ts:195 -->

### Providers at run time

The root `broker.config.ts` enables `ssoOidc({ runtimeProviders: true })`. The plugin then reads `PB_IDP_PROVIDERS`, a JSON array of provider objects with the same fields as the `providers` list, at most 5120 bytes and 64 entries. Changing it needs a restart or a new deployment, not a new build. On Workers, set it as a variable or secret of the Worker.

For limits, deployment with `pb cloudflare deploy --providers`, removal and recovery, see [Runtime SSO providers](runtime-sso-providers.md).

<!-- source: broker.config.ts:7 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:5 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:100 -->

The two sources are merged:

- A run-time entry with the same `id` or the same trust anchor as a compiled provider replaces it.
- A run-time entry that is invalid is skipped and logged as `sso.runtime_providers` with value-free rejection codes. If it carries a valid `id`, a compiled provider with that `id` is removed too, so a broken override never falls back to the old definition.
- If the whole value cannot be used (not JSON, not an array, too large or too many entries), it is ignored, the problem is logged and only the compiled providers apply.

<!-- source: packages/plugin-sso-oidc/src/runtime.ts:25 -->
<!-- source: packages/plugin-sso-oidc/src/planner.ts:13 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:48 -->

### Common fields

| Field                              | Meaning                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                               | 1 to 64 lowercase letters, digits and inner hyphens. `local` is reserved.                                                                                                                                                                              |
| `kind`                             | `'oidc'` or `'cloudflare-access'`.                                                                                                                                                                                                                     |
| `displayName`                      | Optional label returned by `/_pb/auth/providers`.                                                                                                                                                                                                      |
| `policy.verifiedDomains`           | Required, 1 to 32 lowercase domains without wildcards. Only users whose e-mail domain is listed can sign in.                                                                                                                                           |
| `policy.autoJoin`                  | Required boolean. `true` creates a user at the first sign-in. `false` admits users who already signed in through this provider, plus users invited by an active organization or project grant that names their e-mail or one of their provider groups. |
| `policy.emailAuthoritativeDomains` | Optional, up to 32 domains, each also listed in `verifiedDomains`. See below.                                                                                                                                                                          |

<!-- source: packages/core/src/identity/port.ts:3 -->
<!-- source: packages/core/src/identity/policy.ts:41 -->
<!-- source: packages/core/src/identity/policy.ts:60 -->
<!-- source: packages/core/src/identity/policy.ts:93 -->
<!-- source: packages/db-sqlite/src/repositories/user.ts:165 -->

If a user with the same e-mail already exists, for example the administrator created by `pb admin bootstrap`, a first sign-in through a provider links to that user only when the e-mail domain is in `policy.emailAuthoritativeDomains`. Otherwise the sign-in is refused. Grants that invite by e-mail or group are described in the [Access model](access-model.md#roles-and-grants).

<!-- source: packages/core/src/auth/identity-login.ts:266 -->

### OIDC provider

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                 | `https` URL (or `http` on `localhost`, a `127.x.x.x` address or `[::1]`) without trailing slash, query, fragment or credentials, in canonical form: lowercase host, no explicit default port (`:443`, `:80`), no `//` or unnecessary percent-escapes in the path. The broker reads `<issuer>/.well-known/openid-configuration`. |
| `clientId`               | The client ID registered at the provider.                                                                                                                                                                                                                                                                                       |
| `scopes`                 | Optional. Default `openid email profile groups`. `offline_access` is not allowed.                                                                                                                                                                                                                                               |
| `trustedAudiences`       | Optional. Extra `aud` values accepted in the ID token besides `clientId`.                                                                                                                                                                                                                                                       |
| `trustedEndpointOrigins` | Optional. Origins other than the issuer's that the discovery document may point to for the authorization endpoint and the JWKS. The token endpoint must be on the issuer's origin.                                                                                                                                              |

<!-- source: packages/plugin-sso-oidc/src/oidc.ts:77 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:222 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:286 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:367 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:617 -->

The client secret is read from the environment, never from the config: `PB_IDP_<ID>_CLIENT_SECRET`, where `<ID>` is the provider ID in uppercase with `-` replaced by `_`. For the example above that is `PB_IDP_CORP_CLIENT_SECRET`. On Workers, set it as a secret.

<!-- source: packages/core/src/identity/secret-name.ts:3 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:489 -->

Register this redirect URI at the provider: `<PB_PUBLIC_URL>/_pb/auth/sso/<id>/callback`. The broker uses the authorization code flow with PKCE (`S256`) and sends the client secret with HTTP Basic authentication. The provider must mark the e-mail as verified (`email_verified` is `true`).

<!-- source: packages/core/src/auth/routes-sso.ts:299 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:698 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:401 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:649 -->

The OIDC provider reads the `groups` claim from the ID token and stores the user's groups at each sign-in; grants can name such a group. A `groups` key in the OIDC provider configuration or its `policy` is not supported and fails the build.

<!-- source: packages/plugin-sso-oidc/src/oidc.ts:433 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:246 -->

To sign in, a page on the broker's origin posts `{"purpose":"login","returnTo":"/"}` to `/_pb/auth/sso/<id>/start`. The answer is a `303` redirect to the provider, or `{"location":"..."}` when the request sends `Accept: application/json`. After the callback the browser is sent to `returnTo`, which must be a path on the broker; anything else becomes `/`.

<!-- source: packages/core/src/auth/routes-sso.ts:117 -->
<!-- source: packages/core/src/auth/login-state.ts:41 -->

### Cloudflare Access provider

| Field                    | Meaning                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamDomain`             | `<team>.cloudflareaccess.com`, lowercase, no scheme or path.                                                                                                                                                   |
| `audience`               | The Access application's audience tag, 64 lowercase hex characters.                                                                                                                                            |
| `trustEmailVerification` | Required boolean. Access tokens carry no e-mail verification claim; the broker treats the e-mail as verified only when this is `true`. With `false`, every sign-in is refused.                                 |
| `groups`                 | Optional. `'none'` (default) or `'get-identity'`. With `'get-identity'` the broker reads the user's groups from the team domain's `/cdn-cgi/access/get-identity` endpoint using the `CF_Authorization` cookie. |

<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:26 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:87 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:95 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:228 -->

The broker reads the `Cf-Access-Jwt-Assertion` header that Access adds to requests that pass through it, so `sso/<id>/start` signs the user in without a redirect to Cloudflare. It answers with a `303` redirect to `returnTo`, or `{"location":"..."}` when the request sends `Accept: application/json`. Access providers do not support re-authentication.

<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:209 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:275 -->
<!-- source: packages/core/src/auth/routes-sso.ts:437 -->

### Changing a provider

The broker records each provider's trust anchor (`oidc:<issuer>` or `access:<teamDomain>/<audience>`) at the first successful sign-in. If you later change the issuer, team domain or audience under the same `id`, sign-ins through that provider are refused before the broker contacts the provider, so a re-pointed issuer never receives the client secret or the authorization code. An OIDC callback that belongs to a login started under a different provider definition is refused as well. `pb admin rebind-provider` records the new anchor, but it also removes every existing link to the provider: users who signed in through it before sign in again as if their e-mail already existed, so they are linked only when their domain is in `policy.emailAuthoritativeDomains`. See the [pb CLI reference](cli.md#pb-admin-rebind-provider).

<!-- source: packages/plugin-sso-oidc/src/presentation.ts:13 -->
<!-- source: packages/core/src/auth/routes-sso.ts:271 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:713 -->
<!-- source: packages/core/src/auth/identity-login.ts:252 -->
<!-- source: packages/db-sqlite/src/repositories/provider-binding.ts:49 -->
