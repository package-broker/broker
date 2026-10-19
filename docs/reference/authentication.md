---
title: Authentication and sessions
sidebar_position: 4
description: Local accounts, single sign-on, sessions and the auth HTTP routes.
---

People sign in to Package Broker with a local account (password and TOTP) or through a single sign-on provider from the `sso-oidc` plugin. A successful sign-in creates a browser session held in cookies.

Personal access tokens, service tokens and role assignment are not available yet. See [Access model](access-model.md).

## Routes

| Method and path                         | Purpose                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /_pb/auth/local/setup/start`      | Start setting up a local account with a setup token.                                      |
| `POST /_pb/auth/local/setup/finish`     | Set the password and confirm the TOTP secret. Signs the user in.                          |
| `POST /_pb/auth/local/login`            | Sign in with e-mail, password and TOTP code.                                              |
| `POST /_pb/auth/local/reauth`           | Confirm password and TOTP code again inside a session.                                    |
| `GET /_pb/auth/providers`               | List the configured single sign-on providers and whether local sign-in is available.      |
| `POST /_pb/auth/sso/{provider}/start`   | Start a single sign-on login or re-authentication.                                        |
| `GET /_pb/auth/sso/{provider}/callback` | Return address for OIDC providers.                                                        |
| `POST /_pb/auth/logout`                 | End the session.                                                                          |
| `GET /_pb/session`                      | The signed-in user and session expiry.                                                    |
| `GET /health/live`, `GET /health/ready` | Liveness, and readiness (database reachable and organization present). No authentication. |

Errors use one JSON shape: `{"error":{"code":"...","message":"...","requestId":"..."}}`. Failed local sign-ins return `401` with the code `invalid_credentials`, and refused single sign-on logins return `401` with `login_failed`. Neither says which check failed.

| Status | Code                  | When                                                                                                |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`         | A local auth route got a body that is not `application/json`, not valid JSON, or larger than 8 KiB. |
| 400    | `invalid_request`     | `sso/{provider}/start` got a body without a valid `purpose`.                                        |
| 401    | `invalid_credentials` | Wrong password, TOTP code or setup token, an expired setup token, or a locked account.              |
| 401    | `login_failed`        | A single sign-on login was refused.                                                                 |
| 401    | `unauthorized`        | No valid session (`/_pb/session`, `logout`, `local/reauth`).                                        |
| 403    | `forbidden`           | The origin check or the CSRF token check failed.                                                    |
| 404    | `not_found`           | Unknown route, or an unknown provider ID in `sso/{provider}/start`.                                 |

### Request rules

- Request bodies are JSON (`content-type: application/json`), at most 8 KiB.
- Every `POST` must come from the broker's own origin. It must carry an `Origin` header, a `Sec-Fetch-Site` header, or both, and each one present must pass: `Origin` equal to `PB_PUBLIC_URL`, `Sec-Fetch-Site` equal to `same-origin` or `none`. Otherwise the answer is `403 forbidden`. Command-line clients such as `curl` must send the `Origin` header themselves.
- Requests made inside a session (`reauth`, `logout`, and `sso/{provider}/start` with `"purpose":"reauth"`) also need an `X-CSRF-Token` header with the value of the `__Host-pb_csrf` cookie.

## Local accounts

A local account is created by `pb admin bootstrap` (an administrator) and repaired by `pb admin reset-local`. Both issue a setup token that is valid for 24 hours. See the [pb CLI reference](cli.md#pb-admin-bootstrap).

1. `POST /_pb/auth/local/setup/start` with `{"token":"..."}` returns `{"provisioningUri":"otpauth://...","secret":"..."}`. Add the URI to an authenticator app.
2. `POST /_pb/auth/local/setup/finish` with `{"token":"...","password":"...","code":"123456"}` sets the password, confirms the TOTP secret and answers `204` with session cookies.
3. Afterwards, `POST /_pb/auth/local/login` with `{"email":"...","password":"...","code":"123456"}` answers `204` with session cookies.

Passwords are 12 to 128 characters and must not equal the e-mail address. A weak password at `setup/finish` returns `400` with the code `weak_password` and a `problems` list, for example `["too_short"]`.

TOTP codes are six digits with a 30-second period. The broker accepts the previous, current and next code, but never a code from a time step at or before the last one it accepted for that account. In practice each code works once.

Every fifth failed attempt in a row at `local/login` or `setup/finish` locks the account for 15 minutes. During the lock every attempt answers `401 invalid_credentials`, as a wrong password would. `pb admin reset-local` clears the lock.

[Quickstart: Node](../getting-started/quickstart-node.md#5-set-the-password-and-totp) shows the requests with `curl`.

## Sessions

A session is two cookies, both `Secure`, `Path=/` and with the `__Host-` prefix:

- `__Host-pb_session`: `HttpOnly`, `SameSite=Lax`. The session itself.
- `__Host-pb_csrf`: readable by scripts, `SameSite=Strict`. Its value goes in the `X-CSRF-Token` header.

A session ends 12 hours after sign-in, or after 1 hour without requests, whichever comes first. `GET /_pb/session` returns:

```json
{
  "user": { "id": "...", "email": "admin@example.test", "displayName": null },
  "reauthFresh": false,
  "expiresAt": "2026-10-19T20:10:32.519Z"
}
```

While a single sign-on login is in progress, a third cookie, `__Host-pb_login` (`HttpOnly`, `SameSite=Lax`), holds the login state for at most 10 minutes; the callback clears it.

`reauthFresh` is `true` for 10 minutes after a re-authentication through `POST /_pb/auth/local/reauth` (body `{"password":"...","code":"..."}`) or through an OIDC provider.

`POST /_pb/auth/logout` ends the session and answers `204`. Without a valid session it answers `401` and clears the cookies.

## Single sign-on

Single sign-on comes from the `@package-broker/plugin-sso-oidc` plugin. It supports two provider kinds: a generic OpenID Connect provider (`oidc`) and Cloudflare Access (`cloudflare-access`). Providers are part of the build: list them in `broker.config.ts` and run `pb build` again after any change.

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

`ssoOidc()` without providers adds no provider; the root `broker.config.ts` uses it that way.

### Common fields

| Field                    | Meaning                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | 1 to 64 lowercase letters, digits and inner hyphens. `local` is reserved. Unique within the list.                                                                                                                                                                                  |
| `kind`                   | `'oidc'` or `'cloudflare-access'`.                                                                                                                                                                                                                                                 |
| `displayName`            | Optional label returned by `/_pb/auth/providers`.                                                                                                                                                                                                                                  |
| `policy.verifiedDomains` | Required, 1 to 32 lowercase domains without wildcards. Only users whose e-mail domain is listed can sign in.                                                                                                                                                                       |
| `policy.autoJoin`        | Required boolean. `true` creates a user at the first sign-in. `false` admits users who already signed in through this provider, plus users invited by an organization or project grant that names their e-mail or one of their provider groups. Such grants cannot be created yet. |

If a user with the same e-mail already exists, for example the administrator created by `pb admin bootstrap`, the sign-in through a provider is refused. Linking an existing user to a provider is not available yet.

The OIDC provider reads the `groups` claim from the ID token and stores the user's groups at each sign-in. Nothing grants access by group yet. A `groups` key in the provider configuration or its `policy` is not supported and fails the build.

### OIDC provider

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                 | `https` URL (or `http` on `localhost`, a `127.x.x.x` address or `[::1]`) without trailing slash, query, fragment or credentials, in canonical form: lowercase host, no explicit default port (`:443`, `:80`), no `//` or unnecessary percent-escapes in the path. The broker reads `<issuer>/.well-known/openid-configuration`. |
| `clientId`               | The client ID registered at the provider.                                                                                                                                                                                                                                                                                       |
| `scopes`                 | Optional. Default `openid email profile groups`. `offline_access` is not allowed.                                                                                                                                                                                                                                               |
| `trustedAudiences`       | Optional. Extra `aud` values accepted in the ID token besides `clientId`.                                                                                                                                                                                                                                                       |
| `trustedEndpointOrigins` | Optional. Origins other than the issuer's that the discovery document may point to for the authorization, token and JWKS endpoints.                                                                                                                                                                                             |

The client secret is read from the environment, never from the config: `PB_IDP_<ID>_CLIENT_SECRET`, where `<ID>` is the provider ID in uppercase with `-` replaced by `_`. For the example above that is `PB_IDP_CORP_CLIENT_SECRET`. On Workers, set it as a secret.

Register this redirect URI at the provider: `<PB_PUBLIC_URL>/_pb/auth/sso/<id>/callback`. The broker uses the authorization code flow with PKCE (`S256`) and sends the client secret with HTTP Basic authentication. The provider must mark the e-mail as verified.

To sign in, a page on the broker's origin posts `{"purpose":"login","returnTo":"/"}` to `/_pb/auth/sso/<id>/start`. The answer is a `303` redirect to the provider, or `{"location":"..."}` when the request sends `Accept: application/json`. After the callback the browser is sent to `returnTo`, which must be a path on the broker; anything else becomes `/`.

### Cloudflare Access provider

| Field                    | Meaning                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teamDomain`             | `<team>.cloudflareaccess.com`, lowercase, no scheme or path.                                                                                                                   |
| `audience`               | The Access application's audience tag, 64 lowercase hex characters.                                                                                                            |
| `trustEmailVerification` | Required boolean. Access tokens carry no e-mail verification claim; the broker treats the e-mail as verified only when this is `true`. With `false`, every sign-in is refused. |

The broker reads the `Cf-Access-Jwt-Assertion` header that Access adds to requests that pass through it, so `sso/<id>/start` signs the user in without a redirect to Cloudflare. It answers with a `303` redirect to `returnTo`, or `{"location":"..."}` when the request sends `Accept: application/json`. Access providers do not support re-authentication.

### Changing a provider

The broker records each provider's trust anchor (`oidc:<issuer>` or `access:<teamDomain>/<audience>`) at the first successful sign-in. If you later change the issuer, team domain or audience under the same `id`, sign-ins through that provider are refused. `pb admin rebind-provider` records the new anchor, but it also removes every existing link to the provider, so users who signed in through it before cannot sign in through it again until linking is available. See the [pb CLI reference](cli.md#pb-admin-rebind-provider).
