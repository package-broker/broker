---
title: 'Quickstart: Docker'
sidebar_position: 2
description: Build and run Package Broker with Docker, create your first project and source, and install a private Composer package.
---

Run a single broker container on your workstation, then install one private Composer package through it. This evaluation uses loopback HTTP; shared hosting needs an HTTPS endpoint.

## What you need

- Git, Node.js 24 or later and pnpm 12.5.1 for the repository CLI and build. `.nvmrc` selects Node.js 24.

  <!-- source: package.json:5 -->
  <!-- source: .nvmrc:1 -->

- Docker Engine or Docker Desktop with a running daemon and Linux container support.

  <!-- source: Dockerfile:1 -->

- PHP compatible with your package and Composer 2 on your workstation. Composer 1 is refused.

  <!-- source: packages/core/src/registry/composer/routes.ts:81 -->

- A private Composer vendor repository containing a package you can install, its credentials, your administrator e-mail address, an authenticator app and a secret manager for the broker master key.

## Get the code

Run these commands on your trusted workstation:

```sh
git clone https://github.com/package-broker/broker.git
cd broker
pnpm install --frozen-lockfile
pnpm build
```

<!-- source: package.json:5 -->
<!-- source: package.json:10 -->
<!-- source: Dockerfile:7 -->
<!-- source: packages/cli/package.json:30 -->

## Build and run the container

Build the repository Dockerfile with its default `broker.config.ts`, which includes the UI and Node platform ports.

```sh
docker build --tag package-broker:local .
```

<!-- source: Dockerfile:10 -->
<!-- source: broker.config.ts:5 -->
<!-- source: scripts/docker-smoke.mjs:1092 -->

Create the data volume and generate the master key directly into `/data/master.key`. The helper container runs as the image's default UID/GID `1000:1000`; `umask 077` creates the key with mode `0600`. The shell refuses to overwrite an existing key. This creates one persistent copy without putting its value in an environment file, container configuration (`docker inspect`) or shell history. Stop if generation fails.

```sh
docker volume create broker-data
docker run --rm \
  --mount type=volume,source=broker-data,target=/data \
  --entrypoint /bin/sh package-broker:local -c \
  'umask 077; set -C; pb secrets generate-master-key > /data/master.key'
```

<!-- source: Dockerfile:83 -->
<!-- source: Dockerfile:90 -->
<!-- source: Dockerfile:99 -->
<!-- source: packages/cli/src/commands/admin.ts:68 -->
<!-- source: packages/runtime-node/src/startup.ts:171 -->

Keep the same volume and key when recreating the container. Store a backup copy of the key in your secret manager or an encrypted backup outside this volume and host before adding vendor credentials. The [backup and upgrades guide](../operations/backup-and-upgrades.md#back-up-docker) copies the whole volume, including this key; protect that backup as secret material. Losing the key prevents recovery of encrypted credentials.

<!-- source: docs/operations/backup-and-upgrades.md:56 -->
<!-- source: packages/runtime-node/src/startup.ts:192 -->

Create a private directory outside the checkout for the runtime settings. Replace `<private-directory>` with its absolute path and keep this shell open for the remaining commands:

```sh
umask 077
broker_private='<private-directory>'
mkdir -p "$broker_private"
cat > "$broker_private/broker.env" <<'ENV'
PB_MASTER_KEY_FILE=/data/master.key
PB_PUBLIC_URL=http://localhost:8787
PB_ORG_SLUG=agency
PB_ORG_NAME=Agency evaluation
ENV
```

<!-- source: packages/runtime-node/src/startup.ts:192 -->
<!-- source: packages/runtime-node/src/startup.ts:737 -->
<!-- source: packages/runtime-node/src/startup.ts:759 -->

Start one container with a named data volume and a port bound only to your workstation:

```sh
docker run --detach --name broker \
  --publish 127.0.0.1:8787:8787 \
  --mount type=volume,source=broker-data,target=/data \
  --env-file "$broker_private/broker.env" \
  package-broker:local
docker inspect --format '{{.State.Health.Status}}' broker
```

<!-- source: Dockerfile:92 -->
<!-- source: Dockerfile:102 -->
<!-- source: scripts/docker-smoke.mjs:1014 -->
<!-- source: scripts/docker-smoke.mjs:489 -->

Repeat the last command until it prints `healthy`. Startup applies migrations and creates the organization from the two `PB_ORG_*` variables. The image runs as UID/GID `1000:1000` and stores SQLite at `/data/broker.sqlite` and archives at `/data/blobs`; `/data` must remain writable by that user. Keep the volume across container replacement and run a single replica for this evaluation.

<!-- source: Dockerfile:83 -->
<!-- source: Dockerfile:92 -->
<!-- source: packages/runtime-node/src/startup.ts:751 -->

Use `http://localhost:8787` in the browser, matching `PB_PUBLIC_URL` exactly. The application issues Secure cookies, so use a browser that accepts them on localhost. For a shared deployment, terminate TLS at your reverse proxy, set `PB_PUBLIC_URL` to `https://<broker-host>`, and keep the container port private. TLS termination is provided outside this image.

<!-- source: packages/core/src/auth/cookies.ts:36 -->
<!-- source: packages/core/src/kernel/public-origin.ts:15 -->
<!-- source: packages/runtime-node/src/startup.ts:240 -->
<!-- source: Dockerfile:111 -->

## First administrator

Once the container is healthy, replace `<admin-email>` and run bootstrap in an interactive terminal. It prints a one-time setup token; treat it as a password. Open `http://localhost:8787/_pb/ui/setup` and follow [Set up the first administrator](../workers-install.md) to spend the token in the browser or with curl, enroll your password and authenticator, then return here signed in. No identity provider is required.

```sh
docker exec -it broker pb admin bootstrap \
  --sqlite /data/broker.sqlite --email '<admin-email>'
```

<!-- source: Dockerfile:90 -->
<!-- source: packages/cli/src/cli.ts:46 -->
<!-- source: packages/cli/src/commands/admin.ts:351 -->
<!-- source: scripts/docker-smoke.mjs:567 -->

## First project, source and token

Use `http://localhost:8787` as `<broker-origin>`. Open `<broker-origin>/_pb/ui` and sign in as the administrator. Use the scope selector to choose the organization, then open **Projects**. Under **New project**, enter a name and a lowercase slug such as `evaluation`, leave the token policy defaults, and choose **Create project**. Copy the project ID for token creation; `<project>` below means the slug.

<!-- source: packages/ui/src/app.tsx:159 -->
<!-- source: packages/ui/src/pages/projects.tsx:505 -->

1. In organization scope, open **Sources** and create a source with **Add source**, ecosystem **composer**, source type **Composer repository**, a source name and the vendor repository's HTTPS URL, for example `https://vendor.example.com`. Enter the exact private package name in **Package names (one per line)** and set **Sync interval (seconds)**, for example `300`. Leave additional archive hosts empty unless the vendor serves archives from a separate host you trust with its credentials.

   <!-- source: packages/ui/src/pages/sources/source-form.tsx:49 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:65 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:118 -->
   <!-- source: packages/ui/src/pages/sources/source-form.tsx:842 -->

2. Save the source. In **Set credential**, choose `http_basic`, enter the vendor's username and password, and choose **Save credential**. For a vendor that uses bearer authentication, choose `bearer` and enter its token instead. Store vendor credentials here, separately from the broker token Composer will use.

   <!-- source: packages/ui/src/pages/sources.tsx:57 -->
   <!-- source: packages/ui/src/pages/sources.tsx:320 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1313 -->

3. Open **More** and choose **Registered names**. In the **Registered names** dialog, add the same exact package name with **Add name**, then close the dialog. Open **More** and choose **Enable** on the source. The package selection and registered names are separate settings; complete both.

   <!-- source: packages/ui/src/pages/sources.tsx:968 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1015 -->
   <!-- source: packages/ui/src/pages/sources.tsx:1400 -->

4. Still in organization scope, choose **Sync now**, then **Refresh sources** until the source reports a successful sync. Select your project in the scope selector, open **Sources**, find the organization source and choose **Attach**. Open **Packages** in project scope and check for the private package and a version you can install before continuing.

   <!-- source: packages/ui/src/pages/sources.tsx:835 -->
   <!-- source: packages/ui/src/pages/sources.tsx:905 -->
   <!-- source: packages/ui/src/pages/sources.tsx:949 -->

5. Open **Tokens**, select **My personal tokens**, and expand **Issue token**. Enter a name, choose **Read**, choose a lifetime, select **Selected projects**, and paste the project ID into **Selected project IDs (space separated; re-enter when renewing)**. Choose **Issue token**, complete reauthentication if requested, and confirm issuance. Save the complete `pb_pat_` value when it appears; it is shown once. If asked for another authenticator code immediately after setup, wait for the next code.

   <!-- source: packages/ui/src/pages/tokens.tsx:815 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:851 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:920 -->
   <!-- source: packages/ui/src/pages/tokens.tsx:973 -->
   <!-- source: scripts/docker-smoke.mjs:724 -->

## Install a private package

If you do not have an application yet, create an empty directory outside the broker checkout, open a terminal there, and use a local editor to create `composer.json` containing:

```json
{
  "name": "evaluation/application"
}
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:553 -->

In your application's directory containing `composer.json`, replace `<broker-host>` with the broker host, including any port, `<project>` with your project slug, and `<vendor>/<package>` and `<version>` with the package and version you just checked. Vendor repositories must also supply any private dependencies you need; Packagist remains available for public packages.

For this local evaluation, `<broker-origin>` is `http://localhost:8787` and `<broker-host>` in `auth.json` is `localhost:8787`. Allow HTTP only in this disposable evaluation application; for shared hosting, use `https://<broker-host>/<project>` and keep Composer's default HTTPS requirement. `composer config secure-http false` applies to every repository of this application project; remove it with `composer config --unset secure-http` when the broker moves to HTTPS.

```sh
composer config repositories.broker composer 'http://localhost:8787/<project>'
composer config secure-http false
```

<!-- source: packages/ui/src/pages/tokens/client-config.ts:5 -->
<!-- source: packages/core/src/registry/composer/routes.ts:75 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:553 -->

Add `auth.json` to your application's `.gitignore`. With a private local editor, create `auth.json` beside `composer.json`, replacing `<personal-token>` with the complete `pb_pat_` token. Use the literal username `token` and key credentials by host and port, without the project path. Keep the file private and out of version control.

```json
{
  "http-basic": {
    "<broker-host>": {
      "username": "token",
      "password": "<personal-token>"
    }
  }
}
```

<!-- source: packages/core/src/auth/client-matrix.test.ts:70 -->

Add the package, then verify an install from the resulting lock file:

```sh
composer require '<vendor>/<package>:<version>' --no-plugins --no-scripts
composer install --no-plugins --no-scripts
```

<!-- source: packages/runtime-node/src/registry-clients.test.ts:570 -->
<!-- source: packages/runtime-node/src/registry-clients.test.ts:596 -->

Check that `composer.lock` contains the private package and a distribution URL on your broker. These commands suppress package plugins and scripts; review your application's requirements before enabling them. For existing lock files and repository priority, follow the [Composer guide](../clients/composer.md). For JavaScript packages, see [npm, pnpm and yarn](../clients/npm-pnpm-yarn.md); for automated installs, use [GitHub Actions service tokens](../ci/github-actions.md).

<!-- source: packages/core/src/registry/composer/render.ts:94 -->

## Sign-in for a team

Team sign-in uses Cloudflare Access or an OpenID Connect provider such as Dex; grants to the provider's groups give users project access. Evaluating alone needs no identity provider: use the local administrator login. See the [access model](../reference/access-model.md) for group grants and token boundaries.

<!-- source: packages/core/src/identity/port.ts:131 -->
<!-- source: packages/core/src/identity/providers.test.ts:26 -->
<!-- source: docs/reference/access-model.md:31 -->

## Next steps

Plan [backups and upgrades](../operations/backup-and-upgrades.md), review [security and data residency](../security-and-residency.md), or migrate from [Private Packagist](../migration/from-private-packagist.md), [Satis](../migration/from-satis.md) or [Packeton](../migration/from-packeton.md).
