import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { assertRestoreReplay, RestoreReceiver } from './audit-restore.spec.js';
import { infrastructureOperations, snapshotLocalDatabase } from './local.js';

const chainId = 'a'.repeat(32);
const hash = 'b'.repeat(64);
const envelope = (records: Record<string, unknown>[], epoch = 0) => ({
  chain_id: chainId,
  org_id: 'restore-org',
  epoch,
  records: records.map((record) => ({
    chain_id: chainId,
    epoch,
    ...(record['kind'] === 'event' ? { org_id: 'restore-org' } : {}),
    ...record,
  })),
});

describe('restore receiver evidence', () => {
  it('keeps an independent frontier and acknowledges the fork common point before a new epoch', () => {
    const receiver = new RestoreReceiver();
    receiver.pin('restore-org');
    const probe = { chain_id: chainId, org_id: 'restore-org', probe: 'frontier' };
    expect(receiver.receive('/audit', probe)).toEqual({ frontier: null });
    receiver.receive('/audit', envelope([{ kind: 'event', seq: 8, hash }]));
    expect(receiver.receive('/audit', probe)).toEqual({
      frontier: { chain_id: chainId, epoch: 0, seq: 8, hash },
    });
    expect(
      receiver.receive(
        '/audit',
        envelope([{ kind: 'fork', last_common_seq: 4, last_common_hash: hash }], 1),
      ),
    ).toEqual({ acked: { chain_id: chainId, epoch: 1, seq: 4, hash } });
    receiver.receive('/audit', envelope([{ kind: 'event', seq: 5, hash }], 1));
    expect(receiver.frontier?.epoch).toBe(1);
    expect(receiver.frontier?.seq).toBe(5);
    expect(receiver.deliveries).toHaveLength(3);
    expect(receiver.probes).toBe(2);
    expect(() => receiver.receive('/otlp', { resourceLogs: [] })).toThrow('InvalidOtlpResources');
    expect(receiver.otlpDeliveries).toBe(0);
  });

  it('decodes OTLP fork and replay records independently of webhook state', () => {
    const receiver = new RestoreReceiver();
    receiver.pin('restore-org');
    const attributes = (fields: Record<string, unknown>) =>
      Object.entries(fields).map(([key, value]) => ({
        key: `pb.audit.${key}`,
        value: { stringValue: String(value) },
      }));
    const body = (org = 'restore-org', recordOrg = org, epoch = 1) => ({
      resourceLogs: [
        {
          resource: {
            attributes: attributes({
              chain_id: chainId,
              epoch,
              org_id: org,
              through_seq: 5,
              through_hash: hash,
            }),
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: attributes({
                    kind: 'fork',
                    chain_id: chainId,
                    epoch,
                    marker_id: 'marker',
                    last_common_seq: 4,
                    last_common_hash: hash,
                  }),
                },
                {
                  attributes: attributes({
                    kind: 'event',
                    chain_id: chainId,
                    epoch,
                    org_id: recordOrg,
                    seq: 5,
                    hash,
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(receiver.receive('/otlp', body())).toEqual({});
    expect(
      receiver.otlp[0]?.records.map((record) => [
        record['kind'],
        record['last_common_seq'] ?? record['seq'],
      ]),
    ).toEqual([
      ['fork', 4],
      ['event', 5],
    ]);
    expect(receiver.otlp[0]?.epoch).toBe(1);
    expect(receiver.deliveries).toHaveLength(0);
    expect(receiver.frontier).toBeNull();
    expect(() => receiver.receive('/otlp', body('foreign'))).toThrow('ForeignReceiverOrganization');
    expect(() => receiver.receive('/otlp', body('restore-org', 'foreign'))).toThrow(
      'ForeignReceiverRecordOrganization',
    );
    expect(receiver.otlpDeliveries).toBe(1);
  });

  it('refuses foreign organizations and malformed evidence with fixed errors', () => {
    const receiver = new RestoreReceiver();
    receiver.pin('restore-org');
    receiver.receive('/audit', envelope([{ kind: 'event', seq: 1, hash }]));
    expect(() => receiver.receive('/audit', { ...envelope([]), org_id: 'foreign' })).toThrow(
      'ForeignReceiverOrganization',
    );
    expect(() => receiver.receive('/audit', envelope([]))).toThrow('EmptyReceiverBatch');
    expect(() =>
      receiver.receive('/audit', envelope([{ kind: 'event', seq: 2, hash: 'invalid' }])),
    ).toThrow('InvalidReceiverPosition');
    expect(() => receiver.receive('/unexpected', envelope([]))).toThrow('UnexpectedReceiverPath');
    expect(receiver.deliveries).toHaveLength(1);
  });
});

describe('restore replay suffix oracle', () => {
  const retained = {
    id: 'retained',
    seq: 5,
    hash: 'a'.repeat(64),
    prev_hash: hash,
    action: 'project.create',
    target_id: 'old-project',
  };
  const confirmation = {
    id: 'confirmation',
    seq: 6,
    hash: 'b'.repeat(64),
    prev_hash: retained.hash,
    action: 'audit.sink_admin',
  };
  const created = {
    id: 'new-event',
    seq: 7,
    hash: 'c'.repeat(64),
    prev_hash: confirmation.hash,
    action: 'project.create',
    target_id: 'restore-resumed-id',
  };
  const expected = [retained, confirmation, created];
  it.each(['webhook', 'otlp'])(
    '%s requires the exact new event and the entire ordered replay suffix',
    (sink) => {
      const received = (records: Record<string, unknown>[]) => {
        const receiver = new RestoreReceiver();
        receiver.pin('restore-org');
        const value = envelope(
          records.map((record) => ({ kind: 'event', ...record })),
          1,
        );
        if (sink === 'webhook') receiver.receive('/audit', value);
        else {
          const attributes = (fields: Record<string, unknown>) =>
            Object.entries(fields).map(([key, value]) => ({
              key: `pb.audit.${key}`,
              value: { stringValue: String(value) },
            }));
          receiver.receive('/otlp', {
            resourceLogs: [
              {
                resource: {
                  attributes: attributes({
                    chain_id: chainId,
                    org_id: 'restore-org',
                    epoch: 1,
                    through_seq: created.seq,
                    through_hash: created.hash,
                  }),
                },
                scopeLogs: [
                  {
                    logRecords: value.records.map((record) => ({ attributes: attributes(record) })),
                  },
                ],
              },
            ],
          });
        }
        return (sink === 'webhook' ? receiver.deliveries : receiver.otlp).flatMap(
          (batch) => batch.records,
        );
      };
      const check = (records: Record<string, unknown>[]) =>
        assertRestoreReplay(received(records), expected, created);
      expect(() => check(expected)).not.toThrow();
      expect(() => check([retained, confirmation])).toThrow('MissingNewRestoreEvent');
      for (const mutation of [
        { id: retained.id },
        { seq: 8 },
        { hash },
        { target_id: retained.target_id },
      ]) {
        expect(() => check([retained, confirmation, { ...created, ...mutation }])).toThrow(
          'MissingNewRestoreEvent',
        );
      }
      expect(() => check([confirmation, created])).toThrow('RestoreReplaySuffixMismatch');
      expect(() => check([confirmation, retained, created])).toThrow('RestoreReplaySuffixMismatch');
      expect(() => check([...expected, created])).toThrow('RestoreReplaySuffixMismatch');
    },
  );
});

describe('audit export dispatch', () => {
  it('pins each real export job to its sink resource lease and organization', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE job (id TEXT, org_id TEXT, type TEXT, resource_key TEXT)');
      const { jobs } = infrastructureOperations(
        {
          async run(sql, params) {
            db.prepare(sql).run(...params);
          },
          async all() {
            return [];
          },
        },
        'pinned-org',
      );
      await jobs.enqueue('core:audit-export-webhook:v1');
      await jobs.enqueue('core:audit-export-otlp:v1');
      expect(db.prepare('SELECT org_id, type, resource_key FROM job ORDER BY type').all()).toEqual([
        {
          org_id: 'pinned-org',
          type: 'core:audit-export-otlp:v1',
          resource_key: 'audit-export:otlp',
        },
        {
          org_id: 'pinned-org',
          type: 'core:audit-export-webhook:v1',
          resource_key: 'audit-export:webhook',
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('full restore snapshot', () => {
  it('captures committed WAL data and loads rows before organization and append-only triggers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-audit-restore-'));
    const source = new DatabaseSync(join(directory, 'source.sqlite'));
    const target = new DatabaseSync(':memory:');
    try {
      source.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE organization (id TEXT PRIMARY KEY);
        CREATE TABLE audit_chain (org_id TEXT PRIMARY KEY, head_seq INTEGER);
        CREATE TABLE audit_sink (org_id TEXT, progress_seq INTEGER, body BLOB);
        INSERT INTO organization VALUES ('org');
        INSERT INTO audit_chain VALUES ('org', 4);
        INSERT INTO audit_sink VALUES ('org', 4, x'0001ff');
        CREATE TRIGGER org_chain AFTER INSERT ON organization BEGIN
          INSERT INTO audit_chain VALUES (new.id, 0);
        END;
        CREATE TRIGGER chain_append_only BEFORE DELETE ON audit_chain BEGIN
          SELECT RAISE(ABORT, 'AppendOnly');
        END;`);
      const snapshot = snapshotLocalDatabase(join(directory, 'source.sqlite'));
      source.exec('UPDATE audit_chain SET head_seq = 9; UPDATE audit_sink SET progress_seq = 9');
      target.exec('BEGIN');
      for (const { sql, params } of snapshot)
        target
          .prepare(sql)
          .run(
            ...params.map((value) =>
              value !== null && typeof value === 'object' ? Buffer.from(value.hex, 'hex') : value,
            ),
          );
      target.exec('COMMIT');
      const head = target.prepare('SELECT head_seq FROM audit_chain WHERE org_id = ?').get('org');
      const sink = target
        .prepare('SELECT progress_seq, hex(body) AS body FROM audit_sink WHERE org_id = ?')
        .get('org');
      assert(
        head?.['head_seq'] === 4 && sink?.['progress_seq'] === 4 && sink?.['body'] === '0001FF',
        'SnapshotDidNotRollBackBoth',
      );
      expect(() => target.exec("DELETE FROM audit_chain WHERE org_id = 'org'")).toThrow(
        'AppendOnly',
      );
      target.exec("INSERT INTO organization VALUES ('second')");
      expect(
        target.prepare('SELECT head_seq FROM audit_chain WHERE org_id = ?').get('second')?.[
          'head_seq'
        ],
      ).toBe(0);
    } finally {
      source.close();
      target.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
