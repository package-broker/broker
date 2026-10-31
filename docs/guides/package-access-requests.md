---
title: Request package access
description: Request an organization package for a project and decide the request.
---

A package marked **Require approval** for new projects can be requested by a project owner or another user holding `project:packages:manage`. The package's active source must already be attached to that project. Requests do not attach sources or grant organization administration. See the [access model](../reference/access-model.md#new-project-access) for the three access modes. <!-- source: packages/core/src/api/routes/package-access-requests-schemas.ts --> <!-- source: packages/db-sqlite/src/repositories/package-access-requests.ts -->

In the project's Packages page, choose **Request access** for a requestable package and optionally give a reason. The broker creates one pending request per project and package; a duplicate pending request returns a conflict. Requests expire after 30 days. <!-- source: packages/ui/src/pages/packages/npm-workflow.tsx --> <!-- source: packages/core/src/api/routes/package-access-requests.ts --> <!-- source: packages/db-sqlite/src/repositories/package-access-requests.ts -->

An organization administrator, or a user holding `org:packages:manage`, decides the request in the organization Packages page. Approval adds the project's explicit package membership; rejection requires a reason. Both decisions require a human session and the current revision, so a concurrent decision cannot silently overwrite another. The broker rechecks whether the package and source are still eligible before granting access. <!-- source: packages/core/src/api/routes/package-access-requests-schemas.ts --> <!-- source: packages/core/src/api/routes/package-access-requests.ts --> <!-- source: packages/db-sqlite/src/repositories/package-access-requests.ts --> <!-- source: packages/ui/src/pages/packages/npm-workflow.tsx -->

Access approval permits the project's authorized readers to install the package. Publish approval is a separate decision about releasing a held version; approving an access request does not release one. <!-- source: packages/db-sqlite/src/repositories/package-access-requests.ts --> <!-- source: packages/core/src/catalogue/package-access.ts --> <!-- source: packages/core/src/api/routes/publishes.ts -->
