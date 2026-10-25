---
title: Access model
sidebar_position: 1
description: How projects, groups and tokens grant access.
---

import TokenKinds from './_token-kinds.md';

<!-- verify: docs-render — build the documentation site from this content revision; confirm the shared Markdown table renders in the reference and both client pages and the partial has no sidebar entry. -->

## Token kinds

Choose a token by its principal and project boundary. The client setup pages render this same table from the shared reference source.

<TokenKinds />

## Project access

A token's scope limits the principal's existing grants. For CI installs, choose a project service principal and a token with scope `read`; the project binding and the principal's permissions are checked when the token is used.

<!-- source: packages/core/src/authz/scope.ts:102 -->
<!-- source: packages/core/src/authz/service-token-service.ts:402 -->
<!-- source: packages/core/src/authz/engine.ts:346 -->

Continue with [Composer setup](../clients/composer.md), [npm, pnpm and yarn setup](../clients/npm-pnpm-yarn.md), [GitHub Actions](../ci/github-actions.md) or [GitLab CI](../ci/gitlab-ci.md).
