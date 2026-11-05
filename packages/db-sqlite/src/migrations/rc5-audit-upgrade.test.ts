import { expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import {
  AUDIT_GENESIS_HASH,
  hashRow,
  verifyChain,
  type AuditRow,
} from '@package-broker/core/audit/chain';
import { auditVerifyJob } from '@package-broker/core/audit/verify';
import { exportAuditBatch } from '@package-broker/core/audit/export';
import type { AuditBatchV1, AuditJournalItemV1 } from '@package-broker/core/audit/plugin-api';
import { noopObservability } from '@package-broker/core/platform/observability';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { createAuditJournalReader } from '../repositories/audit-query.js';
import { createAuditVerifyReader } from '../repositories/audit-verify.js';
import { createAuditExportRepository } from '../repositories/audit-export.js';
import { migrate } from './runner.js';

it('upgrades a populated rc.5 chain through 0011, exports withheld hashes and pages beyond old payloads', async () => {
  const opened = openNodeSqliteExecutor();
  try {
    const executor = opened.executor;
    const sources = await discoveredMigrations();
    await migrate(
      executor,
      sources.filter((s) => s.sequence <= 10),
      { holder: 'rc5' },
    );
    const org = orgContext(ulid()),
      id = ulid(),
      now = '2026-11-01T00:00:00.000Z';
    const seed = (sql: string, params: readonly (string | number | null)[] = []) =>
      executor.batch([{ sql, params }]);
    await seed('INSERT INTO organization(id,slug,name) VALUES(?,?,?)', [
      org.orgId,
      'rc5',
      'Upgrade',
    ]);
    // rc.5 stored free text in these fields; 0011 must preserve every byte and chain endpoint.
    const corpus: readonly [string, Record<string, unknown>][] = [
      [
        'package.publish',
        { package: '@acme/library', version: '1.0.0', authority: 'organization' },
      ],
      [
        'package.deprecate',
        { version: '1.0.0', deprecated: 'Use the supported release', deprecated_encoding: 'plain' },
      ],
      ['package.dist_tag', { tag: '_next', version: '1.0.0' }],
      ['package.unpublish', { versions: ['1.0.0'], removed_version_count: 1 }],
      [
        'package.access_update',
        { visible_to_new_projects: false, new_project_access_mode: 'request' },
      ],
      [
        'package.access_request',
        { package: 'vendor/package', project_id: id, reason: 'Required for release builds' },
      ],
      [
        'package.access_decide',
        {
          package: 'vendor/package',
          project_id: id,
          state: 'rejected',
          reason: 'Unsupported release',
        },
      ],
      ['publish.approve', { package: '@acme/library', version: '1.0.0' }],
      [
        'publish.reject',
        { package: '@acme/library', version: '1.0.0', reason: 'Unsupported release' },
      ],
      ['publish.expire', { package: '@acme/library', version: '1.0.0' }],
      ['publish.scan', { plugin: 'scanner', verdict: 'deny', reason: 'Untrusted archive' }],
      [
        'trusted_publisher.create',
        {
          package: '@acme/library',
          repository_id: '123',
          repository_owner_id: '456',
          workflow: 'publish.yml',
          environment: 'prod',
        },
      ],
      ['trusted_publisher.update', { environment: 'release' }],
      ['trusted_publisher.disable', { environment: 'release' }],
      [
        'token.workload_issue',
        {
          trusted_publisher_id: id,
          repository_id: '123',
          repository_owner_id: '456',
          workflow: 'publish.yml',
          ref: 'refs/tags/v1',
        },
      ],
      ['registered_name.update', { pattern: '@acme/*' }],
      ...['create', 'update', 'delete', 'run_requested', 'run_started', 'run_finished'].map(
        (action) => [`discovery_rule.${action}`, {}] as [string, Record<string, unknown>],
      ),
      ...['create', 'update', 'disable', 'release', 'members_replace', 'expire'].map(
        (action) =>
          [
            `registry_policy.${action}`,
            action === 'expire'
              ? { kind: 'block', expires_at: now, revision: 1 }
              : action === 'members_replace'
                ? {
                    kind: 'block',
                    revision: 2,
                    member_count: 1,
                    members_added: 1,
                    members_removed: 0,
                  }
                : action === 'disable' || action === 'release'
                  ? { kind: 'block', override_reason: 'false_positive' }
                  : { kind: 'block', ecosystem: 'npm', package_key: '@acme/library', revision: 1 },
          ] as [string, Record<string, unknown>],
      ),
      [
        'policy.read_denied',
        { read_kind: 'version', package_key: '@acme/library', reasons: [`rule:${id}:1:blocked`] },
      ],
      ['policy.inspect', { package_key: '@acme/library', result_count: 1 }],
      [
        'notification.create',
        { revision: 1, method: 'POST', events: ['npm.package.released'], pattern: '@acme/*' },
      ],
      ['notification.update', { revision: 2, pattern: '@acme/*' }],
      ['notification.enable', { revision: 3 }],
      ['notification.disable', { revision: 4, reason: 'manual' }],
      ['notification.delete', { revision: 5, reason: 'deleted' }],
      ['notification.credential_set', { revision: 3, changed: ['destination'] }],
      ['notification.auto_disable', { revision: 4, reason: 'credentials' }],
      [
        'notification.overflow',
        { event_type: 'npm.package.released', event_count: 1, operation_id: id },
      ],
      [
        'notification.delivery_started',
        { endpoint_id: id, event_id: id, delivery_id: id, attempt: 1 },
      ],
      [
        'notification.delivery_finished',
        {
          endpoint_id: id,
          event_id: id,
          delivery_id: id,
          attempt: 1,
          outcome: 'delivered',
          reason: 'ok',
        },
      ],
      [
        'notification.delivery_cancelled',
        { endpoint_id: id, event_id: id, delivery_id: id, reason: 'disabled' },
      ],
      ['session.logout', {}],
    ];
    expect(corpus).toHaveLength(42);
    expect(new Set(corpus.map(([action]) => action)).size).toBe(42);
    expect(corpus.every(([action]) => (AUDIT_ACTIONS as readonly string[]).includes(action))).toBe(
      true,
    );
    const stored: AuditRow[] = [];
    let prev = AUDIT_GENESIS_HASH;
    for (const [action, changes] of corpus) {
      const row: AuditRow = {
        id: ulid(),
        org_id: org.orgId,
        seq: stored.length + 1,
        prev_hash: prev,
        hash: '',
        created_at: now,
        actor_type: 'system',
        actor_id: null,
        token_selector: null,
        source_ip: null,
        action,
        target_type: 'package',
        target_id: id,
        project_id: null,
        payload_json: JSON.stringify({
          op_id: id,
          request_id: id,
          ...(Object.keys(changes).length === 0
            ? {}
            : {
                changes: Object.fromEntries(
                  Object.entries(changes).map(([k, v]) => [k, { new: v }]),
                ),
              }),
        }),
      };
      row.hash = await hashRow(prev, row);
      prev = row.hash;
      stored.push(row);
      const columns = Object.keys(row) as (keyof AuditRow)[];
      await seed(
        `INSERT INTO audit_event(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        columns.map((c) => row[c]),
      );
    }
    expect((await migrate(executor, sources, { holder: 'rc5-upgrade' })).applied).toEqual([
      'core:0011_audit',
    ]);
    expect(
      await executor.all({ sql: 'SELECT * FROM audit_event ORDER BY seq', params: [] }),
    ).toEqual(stored);
    expect(await verifyChain(stored)).toBeNull();
    const journal = createAuditJournalReader(executor, org);
    const head = await journal.head();
    expect(head).toMatchObject({ headSeq: 42, headHash: prev });
    const trail: AuditJournalItemV1[] = [];
    let cursor: number | undefined;
    do {
      const page = await journal.list({
        projectId: null,
        limit: 3,
        ...(cursor === undefined ? {} : { afterSeq: cursor }),
      });
      trail.push(...page.items);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    expect(trail.map((r) => ('seq' in r ? r.seq : 0))).toEqual(stored.map((r) => r.seq));
    const incompatible = [
      'package.deprecate',
      'package.access_request',
      'package.access_decide',
      'publish.reject',
      'publish.scan',
    ];
    expect(
      trail
        .filter((r) => r.kind === 'withheld')
        .map((r) => ('action' in r ? r.action : null))
        .sort(),
    ).toEqual([...incompatible].sort());
    for (const action of incompatible)
      expect(trail.find((r) => 'action' in r && r.action === action)).toMatchObject({
        kind: 'withheld',
      });
    expect(trail.at(-1)).toMatchObject({ kind: 'event', seq: 42, action: 'session.logout' });
    await auditVerifyJob(createAuditVerifyReader(executor)).handler({}, {
      org,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date(now) } },
      observability: noopObservability,
    } as never);
    expect((await journal.head()).verification).toMatchObject({
      throughSeq: 42,
      withheld: trail.filter((r) => r.kind === 'withheld').length,
    });
    await seed(
      "INSERT INTO audit_sink(org_id,sink_id,plugin_id,kind,generation,receiver_fingerprint,durable_ack,activation_source,state,progress_seq,progress_hash,custody_seq,inflight_repr) VALUES(?,'archive','audit','webhook',1,'fingerprint',1,'ARCHIVE_URL','active',0,?,0,?)",
      [org.orgId, AUDIT_GENESIS_HASH, '{"custodyFromSeq":1}'],
    );
    await seed(
      "INSERT INTO job(id,org_id,type,resource_key,state,lease_owner,fence,lease_until) VALUES('export',?,'audit-export-archive','audit-export:archive','running','worker',1,'2999-01-01T00:00:00.000Z')",
      [org.orgId],
    );
    const delivered: AuditBatchV1[] = [];
    for (let n = 0; n < 30; n++) {
      await exportAuditBatch(
        createAuditExportRepository(executor),
        org,
        systemMutationFence('audit-export', { id: 'export', owner: 'worker', fence: 1 }, {}),
        {
          id: 'archive',
          generation: 1,
          pluginVersion: '1.0',
          sourceIp: 'omit',
          now: () => new Date(now),
          random: () => 0,
          maxBatchEvents: 3,
          rejectionRetries: 'terminal',
          sink: {
            deliver: async (batch) => {
              delivered.push(batch);
              return {
                outcome: 'accepted',
                chainId: batch.chainId,
                epoch: batch.epoch,
                throughSeq: batch.throughSeq,
                throughHash: batch.throughHash,
              };
            },
          },
        },
        new AbortController().signal,
      );
      if (delivered.at(-1)?.throughSeq === 42) break;
    }
    const events = delivered
      .flatMap((b) => b.records)
      .filter((r) => r.kind === 'event' || r.kind === 'withheld');
    expect(events).toHaveLength(42);
    expect(events.map((r) => ({ seq: r.seq, prevHash: r.prevHash, hash: r.hash }))).toEqual(
      stored.map((r) => ({ seq: r.seq, prevHash: r.prev_hash, hash: r.hash })),
    );
    for (const action of incompatible)
      expect(events.find((r) => 'action' in r && r.action === action)?.kind).toBe('withheld');
    expect(JSON.stringify(delivered)).not.toMatch(
      /Required for release builds|Unsupported release|Untrusted archive|Use the supported release/,
    );
  } finally {
    await opened.close();
  }
});
