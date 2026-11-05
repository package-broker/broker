---
title: npm trusted publishing
description: Publish a claimed npm package from a GitHub Actions workflow without a long-lived registry token.
---

Trusted publishing exchanges a GitHub Actions identity token for a broker workload token that expires after 15 minutes and can publish exactly one npm package. It uses the hosted source's publish approval and scanner policies.

## Configure a publisher

1. Create an active organization-level hosted npm source and claim the exact package name or its scope (`@scope/*`). The package need not have a published version yet.
2. Configure an organization-level GitHub source for the publishing repository, with a GitHub App installation or a GitHub token that can read that repository. The broker uses this authenticated connection to look up its numeric repository and owner IDs. A public repository still needs this connection; the broker does not trust an unauthenticated first exchange.
3. Open **Tokens**, then **Trusted publishers**. You need organization service identity management permission to see this section. Saving or disabling also requires organization package publishing permission.
4. Enter the exact npm package name, repository (`owner/name`) and workflow filename (for example `publish.yml`, without `.github/workflows/`). Set an environment when the workflow job uses one. Leave it blank only for a job without an environment.
5. Optionally restrict the full Git ref, for example `refs/tags/v*`. `*` crosses `/`, `?` matches one character, and matching is case-sensitive. Leave the ref pattern blank to allow any ref.
6. Save the publisher. The broker creates its service identity, publish permission and publisher binding atomically, with an audit entry.

Environment matching folds ASCII letters to lowercase, so `Prod` and `prod` are the same binding. Non-ASCII letters retain their case. Repository names are stored in lowercase. Workflow filenames are case-sensitive. Two bindings with the same package, numeric repository ID, workflow and folded environment are refused, even when one is disabled. Ref patterns do not make duplicate bindings distinct.

The publisher list and audit retain the full repository and workflow. Each binding has its own service identity. Its label is `trusted:<repository>:<workflow>~<h>`, where `<h>` is the first eight hexadecimal characters of SHA-256 over the JSON array `[repository, workflow, package, environment]`. Labels longer than 100 Unicode code points shorten the repository and workflow prefix to its first 90 code points followed by `…`, keeping the hash suffix. If the assembled label fails service identity name validation, the label is `trusted~<h>`. The label does not determine which workload is trusted.

## Publish from GitHub Actions

Give the publishing job `id-token: write`. Use npm 11.17.0 or a compatible npm CLI with trusted publishing support, and configure the broker project registry URL. Do not configure a broker PAT, service token or `_authToken` for this publish: npm needs to choose its OIDC exchange path.

```yaml
name: Publish
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm install --global npm@11.17.0
      - run: npm ci
      - run: npm publish --registry=https://packages.example.test/project/npm/ --provenance=false
```

Replace the registry URL and configure the publisher's environment as `production` for this example. Run any build your package needs before publishing. Provenance attachments are unsupported; use `--provenance=false`.

npm requests an identity token for `npm:<registry hostname>` and exchanges it at the host-root `/-/npm/v1/oidc/token/exchange/package/<escapedName>` endpoint. The reverse proxy must forward this endpoint as well as project registry paths. The audience uses only the hostname, without a port or path.

The broker matches GitHub's numeric repository and owner IDs, the caller's `workflow_ref`, environment and ref pattern. Reusable workflow identity in `job_workflow_ref` does not replace the caller workflow. Changing repository ownership or recreating a repository under the same name does not inherit the old trust. Edit the binding to resolve its current GitHub IDs and review the change.

## Edit or disable

Editing matching fields increments the publisher revision. An exchange that already read the previous revision cannot issue a token after that edit commits. Already issued workload tokens remain valid until expiry or disable.

**Disable publisher** stops exchanges and revokes its live workload tokens in the same transaction. Disabling retains the publisher, replay records and token bindings. It cannot be undone in this UI, and recreating the same binding is refused. Edit an enabled publisher before disabling when you only need to change its conditions.

## API

The management endpoints require a human session; writes require CSRF protection and both `org:packages:publish` and `org:service-principals:write`:

- `GET /_pb/trusted-publishers`: list organization bindings.
- `POST /_pb/trusted-publishers`: create a binding and its service identity.
- `PUT /_pb/trusted-publishers/:id`: replace matching fields; send `If-Match: "r<revision>"`.
- `DELETE /_pb/trusted-publishers/:id`: disable and revoke workload tokens; send `If-Match: "r<revision>"`. The row is retained.

Create and update accept `packageName`, `repository`, `workflow`, `environment` (empty string for no environment), and optional `refPattern`. GitHub numeric IDs cannot be supplied by the caller. Responses use `Cache-Control: no-store`. A duplicate folded binding returns `409 ambiguous_trusted_publisher`; a missing configured connection returns `409 github_credentials_required`; a failed GitHub lookup returns a fixed error without upstream response content. Reload and review after a revision conflict before saving again.
