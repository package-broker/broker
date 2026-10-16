# Governance

## Current model

Package Broker has a single maintainer, who owns the copyright of the core and has the final say on every decision. Other people contribute through pull requests and issues. This model is deliberate for the pre-release phase and will change as a reviewer and maintainer group forms, following the steps below.

## How decisions are made and recorded

Small changes are decided in the pull request that proposes them. A change that affects the architecture, the plugin API, the security model, the licence or the contribution terms needs a decision record first.

Decision records live under `docs/decisions/`. Each record states the context, the decision, its consequences and its status, and is changed only by a later record that supersedes it. Discussion happens in the issue or pull request that proposes the record. The maintainer decides when the discussion has run its course, and the merged record is the outcome.

## Becoming a reviewer

A reviewer is a contributor trusted to review pull requests and to triage issues. The maintainers may invite a contributor who has:

- had several non-trivial pull requests merged over a sustained period,
- given review comments that were accurate and constructive,
- shown that they follow the project's design decisions and the Code of Conduct.

Reviewers can approve pull requests, but they do not merge them and do not change repository settings.

## Becoming a maintainer

A maintainer can merge pull requests, cut releases and take part in decisions. The existing maintainers invite a reviewer who has:

- reviewed other people's changes regularly over a sustained period,
- shown sound judgement on design, security and compatibility, including the cases where the right answer was to say no,
- made clear they can commit the time the role needs.

Invitations are made by the maintainers.

## Stepping down

A maintainer can step down at any time by telling the other maintainers. Their repository access is then removed and their open work is reassigned.

## Contribution terms

The terms under which contributions are accepted are in [CONTRIBUTING.md](CONTRIBUTING.md). This document does not restate them.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues are reported as described in [SECURITY.md](SECURITY.md).
