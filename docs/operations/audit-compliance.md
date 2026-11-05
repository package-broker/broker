---
title: Audit compliance profile
sidebar_position: 8
description: Configure audit evidence for control assessments and understand its limits.
---

This is a deployment profile to support an operator's assessment of PCI DSS requirement 10, SOC 2 CC7.2 and ISO/IEC 27001 A.8.15. It is not a certification, an attestation or a claim that installing the broker satisfies a control. Decide applicable editions, scope, retention and evidence-review procedures with your assessor. The table maps broker capabilities to those objectives; it does not reproduce the standards.

## Configuration profile

Use a custom build with an active local trail and an independently protected archive sink. Select `audit.policy: 'required'`, explicitly budget Node storage, configure an alert destination and qualify durable ACK semantics before asserting them. For example, retain your other configuration and add:

```ts
import { auditTrail } from '@package-broker/plugin-audit-trail';
import auditWebhook from '@package-broker/plugin-audit-webhook';

const auditPlugins = [auditTrail(), auditWebhook({ id: 'archive', durableAck: true })];
const audit = {
  policy: 'required' as const,
  capacity: { maxJournalBytes: 2 * 1024 * 1024 * 1024 },
  alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
};
```

Add `auditPlugins` to your plugin list and `audit` to `defineConfig`; configure `PB_AUDIT_WEBHOOK_URL`, `PB_AUDIT_WEBHOOK_HEADERS` and `AUDIT_ALERT_URL` in the deployment. The 2 GiB budget is an example, not a retention recommendation. Size it with [the measured method](audit.md#measured-sizing). Alert on both broker health and loss of monitoring. Keep archive administration credentials separate from the broker's append credential. A qualified OTLP collector is an alternative, using the [durability qualification recipe](audit.md#otlp-routing-and-durable-acknowledgement-qualification). <!-- source: packages/core/src/audit/config.ts:1 --> <!-- source: packages/core/src/audit/effective.ts:121 --> <!-- source: packages/plugin-audit-webhook/src/index.ts:157 -->

| Objective                                             | Broker evidence                                                                                                                                 | Operator work                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCI DSS 10: security activity evidence                | Actor/action/target/time, operation/request correlation, transactional mutation staging, hash-linked sealed records, loss/administration ledger | Set the required retention and review cadence; protect archive access and time synchronization; test restore, export and alert response. Check the event inventory against the assessed environment. |
| SOC 2 CC7.2: detect and investigate abnormal activity | Machine-readable health, fixed-code alert logs/counters, failed-login and authorization-denial signals, sink/backlog and integrity incidents    | Monitor continuously, correlate with identity provider and infrastructure logs, define thresholds and incident ownership, retain investigation/acknowledgement evidence.                             |
| ISO/IEC 27001 A.8.15: logging                         | Organization-scoped journal and exports, access-controlled trail, explicit verification scope and custody/disposition evidence                  | Establish the logging policy, retention, archive protection, access review, clock management and periodic verification/recovery exercises.                                                           |

The record schema and action catalogue are the coverage source. Failed-login and denial capture is rate-limited best effort, not one durable record per hostile request. Unresolved identities have no invented account id; denials use compiled route templates rather than concrete request paths. The rate limiter is best effort across isolates. Operational logs, identity-provider logs and platform deployment logs remain necessary, including to identify the person who changed an environment variable. <!-- source: packages/core/src/audit/actions.ts:1 --> <!-- source: packages/core/src/audit/failure-events.ts:89 --> <!-- source: packages/core/src/audit/plugin-api.ts:11 -->

## Guarantees per policy

| Policy / mode                        | Guarantee and limit                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required with trail                  | Keeps the local durable journal and refuses ordinary mutations under capacity backpressure. Security/control reserve actions can continue. Physical disk failure/exhaustion can still prevent writes. A trail alone is not an independent archive. |
| Required, export only                | Requires an active sink declared durable. Export progress and durable custody are distinct; lost/uncertain/withheld bodies are not equivalent to durable ACK coverage. A declaration cannot prove receiver durability.                             |
| Availability with trail and/or sinks | Favors continued service; a capacity eviction may remove a sealed prefix and records gaps/dispositions. A local trail does not promise unlimited retention. Delivery-only sinks do not establish durable custody.                                  |
| Availability, none                   | Requires explicit acceptance and remains degraded. Core still sanitizes/stages/seals events and retains control/loss state, but the operator accepts no durable future security history. Prior exports cover only their pinned range.              |

All modes retain core authorization and deny-only hooks. No policy permits hooks to grant access. Required is persisted as a ratchet; lowering needs direct administration and records a policy change. Fresh organization creation defaults to availability; the empty-chain initializer can set its first effective policy, including required, without a policy ledger entry or audit event. Later policy transitions are recorded. <!-- source: packages/core/src/audit/effective.ts:238 --> <!-- source: packages/core/src/audit/none.ts:77 --> <!-- source: packages/core/src/audit/sink-admin.ts:122 --> <!-- source: packages/db-sqlite/migrations/0011_audit.sql:1 --> <!-- source: packages/db-sqlite/src/repositories/audit-effective.ts:16 --> <!-- source: packages/core/src/plugin.ts:304 -->

## Evidence limits and operating procedure

Hash chaining detects inconsistencies against a trusted retained boundary/head. It does not provide non-repudiation: there are no independent signatures, a database administrator can rewrite local history and an unsigned export checksum cannot establish independent trust. Preserve independently observed heads, external archive copies and administrative records. The source IP is not part of the canonical hash; a withheld body cannot be recomputed, and verification of a retained suffix is not verification of a deleted prefix. Use the explicit `verification` range, body/withheld counts and retained boundary in evidence reviews. <!-- source: packages/core/src/audit/chain.ts:1 --> <!-- source: packages/core/src/audit/plugin-api.ts:115 --> <!-- source: packages/cli/src/commands/audit-artifact.ts:1 -->

External archive durability, access controls, retention locks, deletion protection, encryption, backups and separation of duties are the operator's responsibility. Broker transport credentials should append only. A webhook ACK must atomically commit bodies, deduplication and frontier; an OTLP ACK qualifies as custody only after the documented testing. Neither option proves the archive itself cannot be altered. <!-- source: packages/plugin-audit-webhook/src/index.ts:78 --> <!-- source: packages/plugin-audit-otlp/src/index.ts:137 -->

Before production, exercise receiver outage and recovery, permanent/partial rejection, capacity refusal, security reserve actions and a database restore. Record the chain/epoch, boundary, head and verification scope with each export. Review every gap, skip, uncertainty, withheld body, fork and policy change. Use replay only while bodies remain retained; resolve an incident only after durable ACK evidence. Acknowledging an alert records review of its revision and does not repair loss or clear an active condition. Keep these exercise results and operator decisions with the protected archive. <!-- source: packages/core/src/audit/sink-admin.ts:207 --> <!-- source: packages/core/src/audit/sink-admin.ts:296 --> <!-- source: packages/core/src/audit/health.ts:190 -->
