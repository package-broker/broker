import { describe, expect, it } from 'vitest';
import { DbError } from '../db/errors.js';
import {
  assertAuditLedgerEntry,
  normalizeAuditLedgerEntries,
  type AuditLedgerEntry,
} from './ledger.js';

const gap: AuditLedgerEntry = {
  id: '01K7R5V0000000000000000001',
  kind: 'gap',
  chainId: 'a'.repeat(32),
  epoch: 0,
  fromSeq: 1,
  toSeq: 2,
  count: 2,
  sinkId: null,
  reasonCode: 'capacity',
  policy: 'availability',
  modeGeneration: 0,
  actorType: 'system',
  actorId: null,
  createdAt: '2026-10-28T10:00:00.000Z',
};
const next: AuditLedgerEntry = {
  ...gap,
  id: '01K7R5V0000000000000000002',
  fromSeq: 3,
  toSeq: 5,
  count: 3,
};

describe('audit ledger gaps', () => {
  it.each(['01K7R5V0000000000000000003', '00112233-4455-6677-8899-aabbccddeeff'])(
    'accepts broker actor id %s',
    (actorId) => {
      expect(() => assertAuditLedgerEntry({ ...gap, actorId })).not.toThrow();
    },
  );

  it.each(['rebind', 'retire', 'unblock', 'skipped'] as const)('%s requires a sink', (kind) => {
    expect(() => assertAuditLedgerEntry({ ...gap, kind })).toThrow(
      new TypeError('invalid audit ledger entry'),
    );
    expect(() => assertAuditLedgerEntry({ ...gap, kind, sinkId: 'archive' })).not.toThrow();
  });

  it.each(['gap', 'skipped'] as const)('%s requires a positive count', (kind) => {
    expect(() => assertAuditLedgerEntry({ ...gap, kind, sinkId: 'archive', count: 0 })).toThrow(
      new TypeError('invalid audit ledger entry'),
    );
  });

  it('allows zero counts for control actions', () => {
    expect(() => assertAuditLedgerEntry({ ...gap, kind: 'export', count: 0 })).not.toThrow();
  });

  it.each([
    { id: 'secret@example.com' },
    { actorId: 'secret@example.com' },
    { sinkId: 'https://secret@example.com' },
    { reasonCode: 'Bearer secret' },
    { chainId: 'invalid' },
    { kind: 'unknown' },
    { epoch: -1 },
    { fromSeq: 0 },
    { toSeq: 0 },
    { count: -1 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    { modeGeneration: 0.5 },
    { actorType: 'unknown' },
    { policy: 'unknown' },
    { createdAt: '2026-02-30T10:00:00.000Z' },
    { createdAt: 'invalid' },
  ])('rejects malformed entries without echoing fields: %j', (change) => {
    expect(() => assertAuditLedgerEntry({ ...gap, ...change } as AuditLedgerEntry)).toThrow(
      new TypeError('invalid audit ledger entry'),
    );
    expect(() =>
      normalizeAuditLedgerEntries([gap, { ...next, ...change } as AuditLedgerEntry]),
    ).toThrow(new TypeError('invalid audit ledger entry'));
  });

  it('refuses a count larger than the range', () => {
    expect(() =>
      normalizeAuditLedgerEntries([{ ...gap, count: Number.MAX_SAFE_INTEGER }, next]),
    ).toThrow(new TypeError('invalid audit ledger entry'));
  });

  it('keeps every report in submission order without merging, leaving inputs unchanged', () => {
    const control = { ...gap, id: '01K7R5V0000000000000000003', kind: 'export' as const };
    const entries = [Object.freeze(next), Object.freeze(control), Object.freeze(gap)];
    expect(normalizeAuditLedgerEntries(entries)).toEqual([next, control, gap]);
    expect(normalizeAuditLedgerEntries([])).toEqual([]);
  });

  it('accepts the largest safe sequence', () => {
    const top = Number.MAX_SAFE_INTEGER;
    expect(
      normalizeAuditLedgerEntries([{ ...gap, fromSeq: top, toSeq: top, count: 1 }]),
    ).toHaveLength(1);
  });

  it('drops an identical repeated entry and refuses a changed entry under the same id', () => {
    expect(normalizeAuditLedgerEntries([gap, next, { ...gap }])).toEqual([gap, next]);
    const control = { ...gap, kind: 'export' as const };
    expect(normalizeAuditLedgerEntries([control, { ...control }])).toEqual([control]);
    for (const changed of [
      { ...gap, count: 1 },
      { ...gap, fromSeq: 9, toSeq: 9, count: 1 },
    ]) {
      expect(() => normalizeAuditLedgerEntries([gap, changed])).toThrow(
        new DbError('unique', 'audit ledger duplicate id', {
          constraint: 'audit_ledger.org_id, audit_ledger.id',
        }),
      );
    }
  });
});

it.each([
  { extra: true },
  { affectedSinkIdsOverflow: false },
  { affectedSinkIds: Array.from({ length: 1001 }, (_, i) => `sink-${String(i).padStart(4, '0')}`) },
])('rejects unknown or unbounded capacity metadata: %j', (change) => {
  const capacity = {
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    affectedSinkIds: [],
    ...change,
  };
  expect(() => assertAuditLedgerEntry({ ...gap, capacity } as AuditLedgerEntry)).toThrow(
    new TypeError('invalid audit ledger entry'),
  );
});

it.each([false, true])('compares capacity metadata canonically with overflow %s', (overflow) => {
  const capacity = {
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    affectedSinkIds: ['archive'],
    ...(overflow ? { affectedSinkIdsOverflow: true as const } : {}),
  };
  const entry = { ...gap, capacity };
  const reordered = {
    ...gap,
    capacity: {
      affectedSinkIdsOverflow: capacity.affectedSinkIdsOverflow,
      affectedSinkIds: capacity.affectedSinkIds,
      hash: capacity.hash,
      prevHash: capacity.prevHash,
    },
  } as AuditLedgerEntry;
  expect(normalizeAuditLedgerEntries([entry, reordered])).toEqual([entry]);
  expect(normalizeAuditLedgerEntries([reordered, entry])).toEqual([reordered]);
  for (const change of [
    { hash: 'b'.repeat(64) },
    { prevHash: 'b'.repeat(64) },
    { affectedSinkIds: ['other'] },
    { affectedSinkIdsOverflow: overflow ? undefined : true },
  ]) {
    expect(() =>
      normalizeAuditLedgerEntries([
        entry,
        { ...entry, capacity: { ...capacity, ...change } } as AuditLedgerEntry,
      ]),
    ).toThrow('audit ledger duplicate id');
  }
});
