---
title: Package Broker documentation
slug: /
sidebar_position: 0
description: Choose a runtime, connect Composer and npm clients, add sources and operate Package Broker.
---

Package Broker is a self-hosted, open-source (AGPL-3.0-only) private Composer and npm registry with role-based access control per project.

It runs on Cloudflare Workers or your own Node host with Docker.

## Choose a runtime

Both quickstarts build from the repository and walk through a private Composer install. You need Git, Node.js 24 or later and pnpm 12.5.1 on your workstation; see each quickstart for credentials and client prerequisites.

| Runtime               | What you need                                                                                                                             | Start here                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cloudflare Workers    | A Cloudflare account with Workers Paid, Queues, R2 and Analytics Engine enabled, a registered Workers subdomain and an account API token. | [Cloudflare quickstart](getting-started/quickstart-cloudflare.md) |
| Node host with Docker | Docker Engine or Docker Desktop with Linux container support; an HTTPS endpoint for shared hosting.                                       | [Docker quickstart](getting-started/quickstart-docker.md)         |

## Development status

Package Broker 2.0 is in development, with no tagged release. Magento Marketplace sources are built, in final verification. The container image is not published; the Docker quickstart builds it locally.

## Find your task

- Install: [Cloudflare Workers](getting-started/quickstart-cloudflare.md) or [Docker](getting-started/quickstart-docker.md).
- Connect clients: [Composer](clients/composer.md) or [npm, pnpm and Yarn](clients/npm-pnpm-yarn.md).
- Configure CI: [GitHub Actions](ci/github-actions.md) or [GitLab CI](ci/gitlab-ci.md).
- Add sources: [Magento Marketplace keys per client project](guides/mirror-vendor-repositories.md) or [Packagist and npmjs proxy sources](guides/public-registry-proxy.md).
- Migrate: [Private Packagist](migration/from-private-packagist.md), [Satis](migration/from-satis.md) or [Packeton](migration/from-packeton.md).
- Operate: [Backup and upgrades](operations/backup-and-upgrades.md), [observability](operations/observability.md) or [security and data residency](security-and-residency.md).
- Look up reference material: [Access model](reference/access-model.md), [plugin authoring](reference/plugin-authoring.md) or [API reference](reference/api.md).
- Fix an install: [Troubleshooting Composer and npm installs](troubleshooting/index.md).
- Understand the design: [Architecture](architecture.md) or [decisions](decisions/README.md).

For contribution rules, see [How the docs are maintained](CONTRIBUTING-DOCS.md).
