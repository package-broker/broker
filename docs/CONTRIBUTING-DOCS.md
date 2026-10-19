# Documentation

This folder is the source of the 2.0 documentation site at package.broker. The v1 site stays frozen under `/v1/` and is not built from here.

## Page tree

- Getting started
  - [Quickstart: Cloudflare](getting-started/quickstart-cloudflare.md)
  - [Quickstart: Node](getting-started/quickstart-node.md)
  - [Quickstart: Docker](getting-started/quickstart-docker.md)
- Clients
  - [Composer](clients/composer.md)
  - [npm, pnpm and yarn](clients/npm-pnpm-yarn.md)
- CI
  - [GitHub Actions](ci/github-actions.md)
  - [GitLab CI](ci/gitlab-ci.md)
- Guides
  - [Mirror vendor repositories](guides/mirror-vendor-repositories.md)
- Migration
  - [Migrate from Private Packagist](migration/from-private-packagist.md)
  - [Migrate from Satis](migration/from-satis.md)
  - [Migrate from Packeton](migration/from-packeton.md)
- Operations
  - [Upgrades and operations](operations/backup-and-upgrades.md)
- Reference
  - [Access model](reference/access-model.md)
  - [Plugin authoring](reference/plugin-authoring.md)
  - [API reference](reference/api.md)
  - [Authentication and sessions](reference/authentication.md)
  - [Configuration](reference/configuration.md)
  - [pb CLI](reference/cli.md)
- [Security and data residency](security-and-residency.md)
- [Architecture](architecture.md)
- [Decisions](decisions/)

## Writing rules

- One line per paragraph; do not hard-wrap.
- Name no client or customer.
- Every command must run as written.
- Document only what the current `main` does. A page for a feature that is not merged says "Planned for 2.0" and gives no instructions.

## Maintained separately

`architecture.md` and `decisions/` are maintained in their own changes.
