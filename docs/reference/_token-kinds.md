<!-- Shared by the access-model reference and client setup pages. Edit this table once. -->
<!-- source: packages/core/src/secrets/token-format.ts:3 -->
<!-- source: packages/core/src/secrets/token-format.ts:59 -->
<!-- source: packages/core/src/authz/pat-service.ts:228 -->
<!-- source: packages/core/src/authz/service-token-service.ts:375 -->
<!-- source: packages/db-sqlite/migrations/0001_init.sql:38 -->
<!-- source: packages/core/src/authz/token-lifetime.ts:15 -->
<!-- source: packages/core/src/authz/token-use.ts:100 -->

| Kind                                   | Use and project boundary                                                                                    | Expiry when omitted                                                                | Revocation                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Personal access token (PAT), `pb_pat_` | A person installing packages; all granted projects or a selected set, limited by token scope                | Organization default: initially 90 days, capped by the configured personal maximum | Rejected on subsequent requests after revocation; also rejected if expired or the principal is inactive |
| Service token, `pb_svc_`               | Automation using a service principal; use a principal bound to one project and scope `read` for CI installs | Organization default: initially 90 days, capped by the configured service maximum  | Rejected on subsequent requests after revocation; also rejected if expired or the principal is inactive |
| Customer token, `pb_cst_`              | Reserved format; rejected by token authentication in this version                                           | Not issued                                                                         | Not applicable                                                                                          |

<!-- source: packages/core/src/authz/pat-service.ts:235 -->
<!-- source: packages/core/src/authz/scope.ts:71 -->
<!-- source: packages/core/src/authz/service-token-service.ts:397 -->

A token cannot grant more access than its principal has. `read` permits project and package reads; `write` adds package-write permission; `full` includes other token-eligible permissions. A service token can also belong to an organization service principal; use a project service principal for these client and CI recipes. The configured maximum lifetime defaults to 365 days for both PATs and service tokens; this maximum is distinct from the default expiry above.

<!-- source: packages/core/src/authz/token-lifetime.ts:47 -->
<!-- source: packages/core/src/authz/scope.ts:102 -->
