---
title: Runtime SSO providers
sidebar_position: 7
---

# Runtime SSO providers

A bundle built with `ssoOidc({ runtimeProviders: true })` reads single sign-on provider definitions from the `PB_IDP_PROVIDERS` environment variable when it starts, in addition to the providers compiled from `broker.config.ts`. The release `broker.config.ts`, and so the prebuilt distributions, turn this on. A bundle built with plain `ssoOidc()` ignores the variable. The fields of each provider are described in [Authentication and sessions](authentication.md#single-sign-on); this page covers how the variable is shaped, merged, deployed and recovered.

<!-- source: packages/plugin-sso-oidc/src/index.ts:86 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:114 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:117 -->
<!-- source: broker.config.ts:7 -->

## Shape and limits

The value is one JSON array. Each element is a provider object with the same fields as an entry of the `providers` list in `broker.config.ts`: the [common fields](authentication.md#common-fields) plus the fields of an [OIDC provider](authentication.md#oidc-provider) or a [Cloudflare Access provider](authentication.md#cloudflare-access-provider).

```json
[
  {
    "id": "corp",
    "kind": "oidc",
    "displayName": "Corporate SSO",
    "issuer": "https://idp.example.test",
    "clientId": "package-broker",
    "policy": { "verifiedDomains": ["example.test"], "autoJoin": true }
  },
  {
    "id": "access",
    "kind": "cloudflare-access",
    "teamDomain": "example.cloudflareaccess.com",
    "audience": "0000000000000000000000000000000000000000000000000000000000000000",
    "trustEmailVerification": true,
    "policy": { "verifiedDomains": ["example.test"], "autoJoin": false }
  }
]
```

<!-- source: packages/plugin-sso-oidc/src/runtime.ts:35 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:251 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:26 -->

Limits:

- At most 5120 bytes of UTF-8 text and at most 64 entries. The broker checks the raw value; `pb cloudflare deploy` first rewrites the file as compact JSON, so indentation and line breaks in the file do not count, and it refuses a file larger than 65536 bytes before parsing it.
- Two entries may not share an `id` or a trust anchor. Both entries are rejected.
- `pb cloudflare deploy` refuses a file in which one object repeats a member name. A value set by hand is parsed as plain JSON, where the last repeated member wins, so check such a value yourself.

<!-- source: packages/plugin-sso-oidc/src/runtime.ts:6 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:7 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:28 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:66 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:18 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:69 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:46 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:31 -->

Every OIDC entry needs its client secret in `PB_IDP_<ID>_CLIENT_SECRET`, where `<ID>` is the provider `id` in uppercase with `-` replaced by `_`. Cloudflare Access entries need no secret. The client secret never goes into `PB_IDP_PROVIDERS`.

<!-- source: packages/core/src/identity/secret-name.ts:3 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1738 -->

## Precedence

The broker merges the compiled providers and the run-time entries when it starts:

- A valid run-time entry with the `id` of a compiled provider replaces that provider. The environment wins.
- A valid run-time entry with the same trust anchor as a compiled provider under another `id` removes that compiled provider. This is removal, not a migration: users, grants and the callback URL of the removed `id` do not move to the new `id`.
- An invalid run-time entry is skipped. If it carries a valid `id`, a compiled provider with that `id` is switched off too, so a mistake in an override fails closed instead of falling back to the compiled definition.
- If the value as a whole cannot be used (not JSON, not an array, more than 5120 bytes or more than 64 entries), it is ignored and only the compiled providers apply.
- The merged list holds at most 64 providers. Compiled providers that survive the merge are counted first, then the run-time entries that replaced or removed a compiled provider, then the rest in array order. Entries over the limit are left out.

<!-- source: packages/plugin-sso-oidc/src/planner.ts:28 -->
<!-- source: packages/plugin-sso-oidc/src/planner.ts:34 -->
<!-- source: packages/plugin-sso-oidc/src/runtime.ts:41 -->
<!-- source: packages/plugin-sso-oidc/src/planner.ts:22 -->
<!-- source: packages/plugin-sso-oidc/src/planner.ts:45 -->

Each skipped entry, problem with the value, override, removal and left-out entry is logged as an `sso.runtime_providers` event with the provider `id` and rejection codes, never the values.

<!-- source: packages/plugin-sso-oidc/src/index.ts:123 -->

## When a change takes effect

The value is read once per process or Worker version:

- Workers: a change takes effect with a new deployment (`pb cloudflare deploy`).
- Node: a change takes effect at the next restart.

<!-- source: packages/runtime-node/src/startup.ts:781 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1721 -->
<!-- source: packages/core/src/identity/provider-anchors.ts:37 -->

No rebuild is needed.

## What each field changes

| Field                                                                           | Effect of a change                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                            | A new `id` is a new provider with its own callback URL (`/_pb/auth/sso/<id>/callback`), its own client secret name and no users yet. Users who signed in under the old `id` stay linked to the old `id`. |
| `issuer` (OIDC), `teamDomain` and `audience` (Cloudflare Access)                | These form the trust anchor. Once a user has signed in, a changed anchor under the same `id` refuses every sign-in through that provider until you [rebind it](#changing-the-trust-anchor).              |
| `clientId`, `scopes`, `trustedAudiences`, `trustedEndpointOrigins`              | Sign-ins that started before the change are refused at the callback, and the user starts the sign-in again. Later sign-ins use the new values.                                                           |
| `displayName`                                                                   | Only the label returned by `/_pb/auth/providers` changes.                                                                                                                                                |
| `policy.verifiedDomains`, `policy.autoJoin`, `policy.emailAuthoritativeDomains` | Checked at each sign-in. Existing users are not changed, but a user whose domain is no longer allowed cannot sign in through this provider again.                                                        |
| `trustEmailVerification`, `groups` (Cloudflare Access)                          | Checked at each sign-in.                                                                                                                                                                                 |

<!-- source: packages/core/src/auth/routes-sso.ts:299 -->
<!-- source: packages/core/src/identity/secret-name.ts:3 -->
<!-- source: packages/plugin-sso-oidc/src/presentation.ts:12 -->
<!-- source: packages/core/src/auth/routes-sso.ts:294 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:493 -->
<!-- source: packages/plugin-sso-oidc/src/oidc.ts:714 -->
<!-- source: packages/plugin-sso-oidc/src/presentation.ts:10 -->
<!-- source: packages/core/src/auth/identity-login.ts:221 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:87 -->
<!-- source: packages/plugin-sso-oidc/src/cloudflare-access.ts:228 -->

The provider policy is part of the definition and is set per deployment. The database keeps no copy of it, so keep the providers file under version control or in your own backup; the database backup described in [Backup and upgrades](../operations/backup-and-upgrades.md) does not contain it.

<!-- source: packages/plugin-sso-oidc/src/index.ts:117 -->

## Removing and restoring a provider

To remove a run-time provider, delete its entry from the file and deploy, or restart on Node. Sign-in through it then answers `404` with `Unknown provider`. The users, their links to the provider and the recorded trust anchor stay in the database.

<!-- source: packages/core/src/auth/routes-sso.ts:384 -->

Removing an entry that replaced or removed a compiled provider brings that compiled provider back.

<!-- source: packages/plugin-sso-oidc/src/planner.ts:28 -->

To restore a provider, put the same entry back with the same `id` and the same trust anchor, then deploy or restart. Users sign in as before; no rebind is needed. Restoring it with a different issuer, team domain or audience is a change of trust anchor.

<!-- source: packages/core/src/auth/routes-sso.ts:294 -->

`--providers none` on `pb cloudflare deploy` removes the variable, so only the compiled providers remain.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:109 -->

## Changing the trust anchor

The broker records each provider's trust anchor at the first successful sign-in and refuses sign-ins whose configured anchor differs from the recorded one, before it contacts the provider. To move a provider to a new issuer, team domain or audience under the same `id`:

1. Read the recorded anchor: `pnpm pb admin show-provider-binding --provider <id> --cloudflare --database-id <id>` (or `--sqlite <file>` on Node).
2. Change the entry in the providers file.
3. Record the new anchor: `pnpm pb admin rebind-provider --provider <id> --confirm <id> --expected-anchor <old anchor> --new-anchor <new anchor>`. An OIDC anchor is `oidc:<issuer>`; a Cloudflare Access anchor is `access:<team domain>/<audience>`.
4. Deploy the changed file with `--rollout 100`, or restart on Node.

<!-- source: packages/core/src/auth/routes-sso.ts:271 -->
<!-- source: packages/cli/src/commands/admin.ts:532 -->
<!-- source: packages/cli/src/commands/admin.ts:470 -->
<!-- source: packages/plugin-sso-oidc/src/presentation.ts:12 -->

Between steps 3 and 4 the old definition is still live and its anchor no longer matches, so sign-ins through that provider are refused. Keep that window short.

<!-- source: packages/core/src/auth/routes-sso.ts:294 -->

A rebind is a cut-over. It blocks the subjects seen under the old anchor, revokes the personal access tokens tied to them and deletes the provider's sessions, recorded groups and identities. The user accounts stay, and each user is linked again at the next sign-in only when the e-mail domain is in `policy.emailAuthoritativeDomains`. See [`pb admin rebind-provider`](cli.md#pb-admin-rebind-provider).

<!-- source: packages/db-sqlite/src/repositories/provider-binding.ts:49 -->
<!-- source: packages/core/src/auth/identity-login.ts:266 -->

### Recovery after a failed deploy

If the deploy in step 4 fails or is rolled back, the old definition stays live and sign-ins through the provider stay refused. Sign in with a local account (if no administrator can, issue a new setup token with [`pb admin reset-local`](cli.md#pb-admin-reset-local)) and deploy the changed file again. Rebinding back to the old anchor does not restore the deleted identities, sessions or groups, or the revoked tokens.

<!-- source: packages/core/src/auth/routes-sso.ts:294 -->
<!-- source: packages/db-sqlite/src/repositories/provider-binding.ts:49 -->

## Deploying on Cloudflare

`pb cloudflare setup` and `pb cloudflare deploy` take `--providers <file|none>`:

- `--providers <file>` validates the file with the same rules as the Worker, refuses it when any entry is invalid, and uploads the compact JSON as the plain-text variable `PB_IDP_PROVIDERS`.
- `--providers none` removes the variable. A file named `none` is passed as `./none`.
- Without `--providers`, deploy keeps the value of the live deployment. If the live value is not valid, deploy refuses and asks for `--providers <file>` or `--providers none`. If a split deployment serves two different values, deploy refuses.
- `pb cloudflare setup` passes `--providers` to its deploy step. It refuses a file that the artifact cannot use before it creates or changes any resource.

<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:68 -->
<!-- source: packages/cli/src/commands/cloudflare/providers-file.ts:71 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1721 -->
<!-- source: packages/cli/src/cli.ts:65 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:122 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1712 -->
<!-- source: packages/cli/src/commands/cloudflare/setup.ts:809 -->
<!-- source: pending T918s.md -->

Deploy refuses `--providers <file>` when the artifact was built without `runtimeProviders: true`, or when it is an older artifact without provider metadata in its build manifest. It also refuses while a Worker secret named `PB_IDP_PROVIDERS` exists (remove it with `wrangler secret delete PB_IDP_PROVIDERS`), and `--secret` cannot deliver that name.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:104 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:106 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1671 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:513 -->

### Client secrets

Before it uploads anything, deploy checks that every OIDC entry's `PB_IDP_<ID>_CLIENT_SECRET` is already a Worker secret or is delivered in the same run with `--secret <ENV_NAME>` or `--secrets <ENV_NAMES>` from the environment of the `pb` process. A missing secret refuses the deploy and names it.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1736 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1750 -->

### Variable limit and `--workers-paid`

Deploy counts the Worker's plain-text variables and secrets together and refuses when the count exceeds 64, or 128 with `--workers-paid`. Use `--workers-paid` when the account is on Workers Paid. The flag is not saved: pass it on every `setup` and `deploy` run that needs the higher limit.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1769 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1773 -->
<!-- source: packages/cli/src/cli.ts:66 -->
<!-- source: packages/cli/src/cli.ts:623 -->

### Partial rollouts

A partial rollout (`--rollout` below 100) is refused when the SSO configuration, meaning the artifact's provider metadata together with the `PB_IDP_PROVIDERS` value, differs from the last verified deployment. Two versions with different provider sets would otherwise answer sign-ins at the same time. The first partial rollout after upgrading to a `pb` release with this check is refused as well, because the earlier deployment has no recorded SSO configuration: deploy once with `--rollout 100`, then use partial rollouts again.

<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1716 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1858 -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts:1865 -->

### Dry run

`pb cloudflare deploy --dry-run --json` adds an `identity` section: the effective providers with `id`, `type` and `source` (`compiled` or `runtime`), the overridden ids, the removed ids with the reason, the SHA-256 digest of the `PB_IDP_PROVIDERS` value (`null` when there is none), the digest of the SSO configuration, and the checks that could not run, such as `anchor_preflight` on a fresh install without a database schema. It shows no secret, issuer URL or trust anchor. For an older artifact without provider metadata, `identity` is `null`.

<!-- source: pending T918l4.md -->

### Trust anchor check

Before it uploads, deploy reads the recorded trust anchors from the database and compares them with the effective providers. When a provider that already has users would get a different anchor, deploy refuses with `provider_anchor_changed` and names the provider and `pb admin rebind-provider`. A fresh install, or a provider without a recorded anchor, passes. If the database cannot be read, deploy refuses. The check runs in a dry run too. It is a convenience: the Worker refuses mismatched sign-ins on its own.

<!-- source: pending T918m.md -->
<!-- source: packages/core/src/auth/routes-sso.ts:294 -->

## Node

Set `PB_IDP_PROVIDERS` and each `PB_IDP_<ID>_CLIENT_SECRET` in the environment of the Node process and restart it. The `pb` deploy checks above do not run on Node; an invalid entry is logged at startup and handled as described under [Precedence](#precedence).

<!-- source: packages/runtime-node/src/startup.ts:265 -->
<!-- source: packages/plugin-sso-oidc/src/index.ts:124 -->
