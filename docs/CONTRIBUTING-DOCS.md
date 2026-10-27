# How the docs are maintained

This folder is the source of the 2.0 documentation site at package.broker.

## Page tree

- [Package Broker documentation](index.md)
- Getting started
  - [Quickstart: Cloudflare](getting-started/quickstart-cloudflare.md)
  - [Quickstart: Docker](getting-started/quickstart-docker.md)
  - [Set up the first administrator](workers-install.md)
- Clients
  - [Composer](clients/composer.md)
  - [npm, pnpm and yarn](clients/npm-pnpm-yarn.md)
- CI
  - [GitHub Actions](ci/github-actions.md)
  - [GitLab CI](ci/gitlab-ci.md)
- Guides
  - [Magento Marketplace keys per client project (repo.magento.com)](guides/mirror-vendor-repositories.md)
  - [Packagist and npmjs proxy sources](guides/public-registry-proxy.md)
- Migration
  - [Migrate from Private Packagist](migration/from-private-packagist.md)
  - [Migrate from Satis](migration/from-satis.md)
  - [Migrate from Packeton](migration/from-packeton.md)
- Operations
  - [Backup and upgrades](operations/backup-and-upgrades.md)
  - [Observability](operations/observability.md)
  - [Restore rehearsal](operations/restore-rehearsal.md)
- Reference
  - [Access model](reference/access-model.md)
  - [Plugin authoring](reference/plugin-authoring.md)
  - [API reference](reference/api.md)
  - [Install speed](reference/install-speed.md)
  - [Workers fill limits and self-origin aliases](reference/workers-fill-limits.md)
  - [Authentication and sessions](reference/authentication.md)
  - [Configuration](reference/configuration.md)
  - [pb CLI](reference/cli.md)
  - [Runtime SSO providers](reference/runtime-sso-providers.md)
- [Troubleshooting Composer and npm installs](troubleshooting/index.md)
  - [The 'https://repo.magento.com/packages.json' URL required authentication (HTTP 401).](troubleshooting/magento-http-401.md)
  - [Invalid credentials (HTTP 401) for 'https://repo.magento.com/packages.json', aborting.](troubleshooting/magento-invalid-credentials.md)
  - [auth.json does not contain valid JSON](troubleshooting/invalid-auth-json.md)
- [Security and data residency](security-and-residency.md)
- [Architecture overview](architecture.md)
- [Architecture decisions](decisions/README.md)

## Writing rules

- One line per paragraph; do not hard-wrap.
- Name no client or customer.
- Every command must run as written.

## Maintained separately

`architecture.md` and `decisions/` are maintained in their own changes.
