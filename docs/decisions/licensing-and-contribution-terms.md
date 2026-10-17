# Licensing and contribution terms

Decisions on the rewrite, the licence and the terms under which contributions are accepted.

## ADR-001: Package Broker 2.0 is a backwards-incompatible open-source rewrite, built rather than bought

Status: Accepted, 2026-10-15; the CLA bullet is superseded by [ADR-026](#adr-026-contributor-terms-are-the-developer-certificate-of-origin-enforced-in-ci-in-place-of-a-cla), 2026-10-16

### Context

No evaluated registry product passes the MVP access scenario (per-project package subsets, scoped tokens, licence freeze, vendor API); an evaluation of Nexus CE and of Artifactory and Cloudsmith confirms it. The project builds rather than buys, is open source, and starts clean without a v1 importer.

### Decision

- Build Package Broker 2.0 as a new codebase. It is not compatible with v1 data, configuration or API; no v1 importer is built (Nice to have).
- Publish the core under AGPL-3.0.
- Require a CLA for outside contributions from the first external contribution onwards (superseded by [ADR-026](#adr-026-contributor-terms-are-the-developer-certificate-of-origin-enforced-in-ci-in-place-of-a-cla)).
- Do not grant a third-party plugin exception until counsel has settled the wording and before the plugin API is documented for third parties.
- Vendors (Private Packagist, Artifactory, Cloudsmith, Nexus, Packeton) are design references, and a total-cost model precedes any purchase.

### Consequences

- Positive: one coherent architecture designed around the MVP scenario; the project owner holds the copyright of the whole core; AGPL keeps the project open source for adoption by agencies.
- Negative: the whole product has to be built and maintained; some companies ban AGPL dependencies; v1 users start from an empty deployment.
- Follow-ups: counsel questions on plugin composition and on the scope of the network clause for Composer and npm clients; CLA form under Polish law (superseded by [ADR-026](#adr-026-contributor-terms-are-the-developer-certificate-of-origin-enforced-in-ci-in-place-of-a-cla)).

## ADR-026: Contributor terms are the Developer Certificate of Origin, enforced in CI, in place of a CLA

Status: Accepted, 2026-10-16

### Context

[ADR-001](#adr-001-package-broker-20-is-a-backwards-incompatible-open-source-rewrite-built-rather-than-bought) required a CLA for outside contributions, with its form under Polish law left to counsel, and `CLA.md` stayed a placeholder. The repository became public on 2026-10-16 (free GitHub Actions minutes), so the terms under which a pull request can be accepted have to exist before the first outside pull request, not after. A review of comparable projects found that a legal document to sign is the largest fixed cost for the small first fix a contributor to a project of this size makes, that GitLab and ownCloud retired their CLAs for a DCO for that reason, and that the AGPL-3.0-only licence plus the DCO is the common pair among comparable projects. The project owner holds the copyright of everything written so far and remains free to license it.

### Decision

- Every commit in a pull request carries a `Signed-off-by:` trailer attesting the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (`git commit -s`). A CI job (`dco` in `ci.yml`) checks the trailer on the pull request's commits and is part of the commit gate.
- `CLA.md` is removed; `CONTRIBUTING.md` states the DCO rule and links the certificate text.
- Contributions are accepted under AGPL-3.0-only, the licence of the repository. No copyright assignment and no separate licence grant are collected.
- The CLA bullet of [ADR-001](#adr-001-package-broker-20-is-a-backwards-incompatible-open-source-rewrite-built-rather-than-bought) is superseded by this record; the rest of [ADR-001](#adr-001-package-broker-20-is-a-backwards-incompatible-open-source-rewrite-built-rather-than-bought) (AGPL-3.0-only core, plugin exception pending counsel) stands.

### Consequences

- Positive: a first pull request needs one flag on `git commit` and nothing to sign; the rule is mechanical and visible in CI.
- Negative: without a licence grant from contributors, code that contains outside contributions can be relicensed or dual-licensed only with each contributor's consent.
- Follow-ups: squash merges keep the pull request's sign-off evidence in the pull request, not in the squashed commit, so the merge commit is not where the attestation lives.
