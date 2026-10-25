---
title: 'Quickstart: Docker'
sidebar_position: 2
description: Run Package Broker with Docker and install a Composer package.
---

Build a broker image, keep its data in a volume, create an administrator and a project, then install `composer/semver` through that project's Packagist proxy. This tutorial uses a local image tag because the README currently identifies 2.0 as a pre-release with no tagged release. <!-- source: README.md:5 -->

## Prerequisites

- The repository's build prerequisites are Node 24 and pnpm (`corepack enable`; the version is pinned in `package.json`). The Dockerfile supplies Node and pnpm inside the build container. <!-- source: README.md:9 --> <!-- source: Dockerfile:1 -->
- A checkout of this repository and a running Docker daemon. The image build downloads the pinned base image, system packages and package dependencies. <!-- source: Dockerfile:1 --> <!-- source: Dockerfile:7 --> <!-- source: Dockerfile:80 -->
- A POSIX shell, a browser, and an authenticator app. Use a private terminal with shell tracing disabled for credential setup. <!-- source: packages/ui/src/setup.tsx:406 -->
- Composer 2 and PHP on the host for the final install. <!-- source: scripts/docker-smoke.mjs:811 --> <!-- verified 2026-10-25 on Node 24 / Docker: Docker 29.9.2, Composer 2.10.3, PHP 8.5.12; composer/semver 3.4.3 installed without extra PHP extensions. -->

The README's Workers Paid plan and `nodejs_compat` prerequisites apply to the [Cloudflare quickstart](quickstart-cloudflare.md). This tutorial uses the Node runtime in Docker. <!-- source: README.md:10 --> <!-- source: Dockerfile:11 -->

Review [what you operate](#what-you-operate). Run steps 1–4 from the repository root in the same shell. This tutorial binds the broker to your machine's loopback interface and uses `http://localhost:8787`. Node permits HTTP on loopback; deployments on other hosts require an HTTPS public origin. <!-- source: packages/core/src/kernel/public-origin.ts:15 --> <!-- source: packages/runtime-node/src/startup.ts:230 -->

Session cookies always carry `Secure`. The local browser must accept them on `localhost` for administrator setup and management to work. <!-- source: packages/core/src/auth/cookies.ts:35 --> <!-- verify: owner (Cloudflare and local Mac browser): Confirm setup, retained session, management writes and project/source/token form clicks in the target Mac browser over http://localhost:8787; if cookies are refused, document and retest a local HTTPS setup before publication. -->

## 1. Build the image

Use the repository's default build configuration. `pb:tutorial` below is a local tag for the image you build, not a published registry tag.

<!-- source: Dockerfile:6 -->
<!-- source: Dockerfile:10 -->
<!-- source: scripts/docker-smoke.mjs:1090 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Image built; native SQLite loading passed. -->

```sh
docker build --tag pb:tutorial .
```

Expected result: the build completes and the local image is tagged `pb:tutorial`. The build checks that its native SQLite driver loads on the target platform. <!-- source: Dockerfile:99 -->

The final BuildKit lines name the tag. Excerpt (earlier output and progress prefixes vary by build cache and platform):

```text
naming to docker.io/library/pb:tutorial done
```

## 2. Create persistent storage and the master key

The image runs as UID **1000**, GID **1000**. Its volume is `/data`: the database is `/data/broker.sqlite` and the archive store is `/data/blobs`. A bind mount would need to be writable by that user; this tutorial uses a new named volume. <!-- source: Dockerfile:83 --> <!-- source: Dockerfile:92 --> <!-- source: Dockerfile:98 -->

Generate the key once inside the volume. The key is written to a private file, not printed. The recipe generates into a temporary file and moves it into place only on success, without overwriting an existing key; if the file already exists, keep it and continue with the same volume.

<!-- source: packages/cli/src/cli.ts:39 -->
<!-- source: packages/cli/src/commands/admin.ts:68 -->
<!-- source: Dockerfile:90 -->
<!-- source: scripts/docker-smoke.mjs:1023 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Original key recipe: UID/GID 1000:1000, mode 600, 52 bytes; repeat refused overwrite. Temporary-file recipe checked offline; live rerun pending. -->

```sh
set +x
umask 077
docker volume create pb-tutorial-data
docker run --rm --volume pb-tutorial-data:/data --entrypoint sh pb:tutorial \
  -c 'set -e; umask 077
    if test -e /data/master.key; then
      echo "Master key already exists; keeping the existing file and skipping generation."
      exit 0
    fi
    key_tmp=$(mktemp /data/master.key.XXXXXX)
    trap "rm -f \"$key_tmp\"" 0
    pb secrets generate-master-key > "$key_tmp"
    test -s "$key_tmp"
    mv -n "$key_tmp" /data/master.key
    if test -e "$key_tmp"; then
      echo "Master key already exists; keeping the existing file and discarding the temporary key."
    fi'
```

Expected result: the volume name is printed; the key-generation command exits successfully without displaying the key. If the key file already exists, the recipe prints a message that it is keeping the existing key and exits successfully. When generating a key, it also prints a storage notice to stderr: `store this key in a secret manager and set PB_MASTER_KEY; it is not shown again`.

```text
pb-tutorial-data
```

Keep this volume and key across container replacement. This tutorial puts both in one volume, so losing the volume also loses the key; make a private recovery backup. Regenerating a different master key does not recover the existing encrypted credentials or token hashes. <!-- source: packages/runtime-node/src/startup.ts:213 --> <!-- source: README.md:71 -->

## 3. Start the broker and verify readiness

The runtime reads the master key from a file. Set the public origin and create the organization on startup. Migrations run before organization bootstrap. <!-- source: packages/runtime-node/src/startup.ts:192 --> <!-- source: packages/runtime-node/src/startup.ts:750 -->

<!-- source: Dockerfile:92 -->
<!-- source: scripts/docker-smoke.mjs:1023 -->
<!-- source: scripts/docker-smoke.mjs:1029 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Container bound to 127.0.0.1:8787; readiness returned HTTP 200. -->

```sh
docker run --detach --name pb-tutorial \
  --publish 127.0.0.1:8787:8787 \
  --volume pb-tutorial-data:/data \
  --env PB_MASTER_KEY_FILE=/data/master.key \
  --env PB_PUBLIC_URL=http://localhost:8787 \
  --env PB_ORG_SLUG=tutorial \
  --env PB_ORG_NAME=Tutorial \
  pb:tutorial
```

Expected output:

```text
<container-id>
```

Wait for startup, then check the readiness route. A 503 means the broker is not ready; do not continue until this returns 200.

<!-- source: Dockerfile:107 -->
<!-- source: packages/core/src/kernel/health.ts:26 -->
<!-- source: packages/core/src/kernel/health.ts:68 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Readiness returned HTTP 200 and {"status":"ready"}. -->

```sh
curl --silent --show-error --fail http://localhost:8787/health/ready
```

Expected output:

```text
{"status":"ready"}
```

Container replacement preserves data only when you mount the same volume again and retain the matching master key. Data in the container's writable layer is not the persistence mechanism. Never delete `pb-tutorial-data` when replacing the container. <!-- source: Dockerfile:95 --> <!-- source: Dockerfile:102 -->

## 4. Create the administrator

Create a private host directory for delivery of the one-time setup token. Replace `<administrator-email>` with your address. The bootstrap command grants the organization admin role; `--token-file` prevents it from printing the token. <!-- source: packages/cli/src/commands/admin.ts:345 --> <!-- source: packages/cli/src/commands/admin.ts:360 -->

<!-- source: Dockerfile:90 -->
<!-- source: packages/cli/src/cli.ts:40 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Original /data token delivery passed; host copy mode 600 and token absent from logs. The recipe below uses /tmp and adds cleanup; live rerun pending. -->

```sh
private_dir="$HOME/.package-broker-quickstart-docker"
mkdir -p "$private_dir"
chmod 700 "$private_dir"
docker exec pb-tutorial pb admin bootstrap --sqlite /data/broker.sqlite \
  --email '<administrator-email>' --token-file /tmp/admin-setup.token
docker cp pb-tutorial:/tmp/admin-setup.token "$private_dir/admin-setup.token"
chmod 600 "$private_dir/admin-setup.token"
```

Expected bootstrap output, selected fields only. A notice on stderr says the command does not check for existing administrators:

<!-- source: packages/cli/src/commands/admin.ts:360 -->

```json
{ "setupToken": null, "tokenFile": "/tmp/admin-setup.token" }
```

Open `http://localhost:8787/_pb/ui/setup`. Read the host token file in a private local editor, paste the token into the form, scan the QR code with your authenticator, choose and confirm a password, and enter the current six digit code. Select **Open Package Broker**. The token expires after 24 h and its delivery file must not already exist when bootstrap issues it. <!-- source: packages/cli/src/commands/admin.ts:51 --> <!-- source: packages/cli/src/commands/admin.ts:145 --> <!-- source: packages/cli/src/commands/admin.ts:61 --> <!-- source: packages/ui/src/setup.tsx:416 --> <!-- source: packages/ui/src/setup.tsx:379 --> <!-- source: packages/ui/src/setup.tsx:505 -->

Expected browser result:

<!-- source: packages/ui/src/setup.tsx:513 -->

```text
Setup complete
Your administrator account is ready and you are signed in.
```

After successful enrollment, remove both delivery files. These commands produce no output on success.

```sh
docker exec pb-tutorial rm /tmp/admin-setup.token
rm "$private_dir/admin-setup.token"
```

If enrollment has not completed and the token expires, remove these delivery files before repeating step 4 to issue a replacement. For browser or curl enrollment recovery (shared by both runtimes), see [Set up the first administrator](../workers-install.md#in-the-browser). <!-- source: packages/cli/src/commands/admin.ts:145 -->

## 5. Create a project and attach a Packagist proxy

In **Projects**, expand **New project**. Enter project name `Tutorial` and slug `quickstart`, keep **Maximum token scope** at `read`, and select **Create project**. Copy the project ID from the project list. <!-- source: packages/ui/src/pages/projects.tsx:364 --> <!-- source: packages/ui/src/pages/projects.tsx:498 --> <!-- source: packages/ui/src/pages/projects.tsx:437 -->

Choose the `quickstart` project in the top scope selector and open **Sources**. Select **Add source**, keep ecosystem **Composer**, choose **Packagist proxy**, and name it `Packagist`. Keep the other defaults and select **Add source**. Select **Attach** on its row if it is not attached. The proxy reads public packages on demand without a source credential. <!-- source: packages/ui/src/app.tsx:168 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:40 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:56 --> <!-- source: packages/ui/src/pages/sources/source-form.tsx:839 --> <!-- source: packages/ui/src/pages/sources.tsx:1288 -->

Expected result in the source list:

<!-- source: packages/ui/src/pages/sources.tsx:1238 -->

```text
Packagist
Composer · Packagist proxy
Attached to this project
```

## 6. Issue a read token

In **Tokens**, select **My personal tokens**, expand **Issue token**, and enter name `tutorial-install`. Choose **Read**, keep the offered default lifetime, choose **Selected projects**, and enter the project ID copied in step 5. Select **Issue token**, complete reauthentication if requested, and select **Confirm token issue** if that confirmation appears. Copy the token into a private local editor; you cannot see it again after closing the secret panel. <!-- source: packages/ui/src/pages/tokens.tsx:807 --> <!-- source: packages/ui/src/pages/tokens.tsx:918 --> <!-- source: packages/ui/src/pages/tokens.tsx:1013 --> <!-- source: packages/ui/src/pages/tokens.tsx:200 --> <!-- source: packages/ui/src/pages/tokens.tsx:842 -->

Expected browser result (the secret value is omitted):

<!-- source: packages/ui/src/pages/tokens.tsx:867 -->

```text
Copy token
Close secret panel
```

## 7. Install the test package

Create an empty directory outside the broker checkout and save this as `composer.json`. The default Packagist repository is disabled so that the install uses your new project. The `secure-http` exception is only for this loopback tutorial; use HTTPS when deploying for other machines. <!-- source: scripts/docker-smoke.mjs:788 --> <!-- source: packages/core/src/kernel/public-origin.ts:28 -->

<!-- source: packages/ui/src/pages/tokens/client-config.ts:3 -->
<!-- source: packages/core/src/sources/git/fixtures/github-semver-41-refs.json:6 -->
<!-- source: packages/core/src/sources/git/fixtures/github-semver-41-refs.json:153 -->

```json
{
  "name": "tutorial/install",
  "require": { "composer/semver": "3.4.3" },
  "repositories": [
    { "type": "composer", "url": "http://localhost:8787/quickstart" },
    { "packagist.org": false }
  ],
  "config": { "secure-http": false }
}
```

Create `auth.json` in that directory with your private editor, replacing `<read-token>` with the token from step 6. Keep it out of version control and run logs. The credential key includes both hostname and port, matching the repository URL; never put a token in that URL. <!-- source: packages/ui/src/pages/tokens/client-config.ts:5 --> <!-- verified 2026-10-25 on Node 24 / Docker. -->

```json
{ "bearer": { "localhost:8787": "<read-token>" } }
```

Run in the install directory:

<!-- source: packages/e2e/src/registry.spec.ts:930 -->
<!-- source: scripts/docker-smoke.mjs:837 -->
<!-- verified 2026-10-25 on Node 24 / Docker: Bearer auth and composer/semver 3.4.3 installation passed; lock dist URL used the broker. -->

```sh
chmod 600 auth.json
composer install
```

Expected success excerpt; progress formatting varies by Composer version. Composer also prints `Warning: Accessing localhost over http which is an insecure protocol` for this loopback tutorial:

```text
Installing composer/semver (3.4.3): Extracting archive
Generating autoload files
```

Confirm that `composer.lock` and `vendor/composer/semver/` exist. If an initial metadata fill returns 503, wait for the response's `Retry-After` interval and rerun the install; do not add a direct Packagist fallback. <!-- source: packages/core/src/registry/composer/routes.ts:65 -->

## What you operate

You own the Docker host, image builds and upgrades, storage capacity, `/data` volume, matching master key, configuration, backups and restore checks. The container runs as UID/GID `1000:1000`; preserve ownership when restoring the volume. For access from other machines, provide HTTPS and configure the broker's public origin to match. <!-- source: Dockerfile:98 --> <!-- source: Dockerfile:102 --> <!-- source: packages/core/src/kernel/public-origin.ts:28 -->

Keep the database, archive store and master key in your recovery plan. See [Restore rehearsal](../operations/restore-rehearsal.md) for recovery checks, [Composer client setup](../clients/composer.md) for client configuration, or the [Cloudflare quickstart](quickstart-cloudflare.md) for Workers.
