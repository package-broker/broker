import { describe, expect, it } from 'vitest';
import { assertAuditLedgerEntry, mergeAuditLedgerGaps, type AuditLedgerEntry } from './ledger.js';

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
  it('merges repeated adjacent gaps, preserving counts and leaving inputs unchanged', () => {
    const first = Object.freeze({ ...gap, count: 1 });
    expect(
      mergeAuditLedgerGaps([
        first,
        Object.freeze(next),
        { ...next, fromSeq: 6, toSeq: 6, count: 1 },
      ]),
    ).toEqual([{ ...first, toSeq: 6, count: 5 }]);
    expect(first.toSeq).toBe(2);
    expect(next.fromSeq).toBe(3);
    expect(mergeAuditLedgerGaps([])).toEqual([]);
  });

  it.each([
    { chainId: 'b'.repeat(32) },
    { epoch: 1 },
    { sinkId: 'archive' },
    { reasonCode: 'other' },
    { fromSeq: 5, toSeq: 7 },
  ] as const)('keeps independent or non-adjacent gaps separate: %j', (change) => {
    expect(mergeAuditLedgerGaps([gap, { ...next, ...change }])).toHaveLength(2);
  });

  it('sorts gaps and merges across control actions', () => {
    const control = { ...next, kind: 'mode_change' as const };
    expect(mergeAuditLedgerGaps([gap, control, next])).toEqual([
      { ...gap, toSeq: 5, count: 5 },
      control,
    ]);
  });

  it('sorts interleaved gaps by sequence and merges overlapping ranges with summed counts', () => {
    expect(
      mergeAuditLedgerGaps([
        { ...next, fromSeq: 2, count: 1 },
        { ...gap, reasonCode: 'other', count: 1 },
        { ...gap, count: 1 },
      ]),
    ).toEqual([
      { ...gap, reasonCode: 'other', count: 1 },
      { ...gap, toSeq: 5, count: 2 },
    ]);
  });

  it('merges the later incident after a non-adjacent gap of the same key', () => {
    const second = { ...next, fromSeq: 5, toSeq: 6, count: 2 };
    const third = { ...next, fromSeq: 7, toSeq: 8, count: 2 };
    expect(mergeAuditLedgerGaps([third, gap, second])).toEqual([
      gap,
      { ...second, toSeq: 8, count: 4 },
    ]);
  });

  it('sorts interleaved chain, epoch and sink groups before merging', () => {
    const groups = [
      gap,
      { ...gap, chainId: 'b'.repeat(32) },
      { ...gap, epoch: 1 },
      { ...gap, sinkId: 'archive' },
    ];
    const entries = groups.flatMap((first) => [first, { ...first, fromSeq: 3, toSeq: 4 }]);
    expect(mergeAuditLedgerGaps(entries.reverse())).toEqual([
      { ...gap, toSeq: 4, count: 4 },
      { ...gap, sinkId: 'archive', toSeq: 4, count: 4 },
      { ...gap, epoch: 1, toSeq: 4, count: 4 },
      { ...gap, chainId: 'b'.repeat(32), toSeq: 4, count: 4 },
    ]);
  });

  it('merges by incident key even when policy, generation or actor changes', () => {
    expect(
      mergeAuditLedgerGaps([
        next,
        {
          ...gap,
          policy: 'required',
          modeGeneration: 1,
          actorType: 'user',
          actorId: '00112233-4455-6677-8899-aabbccddeeff',
        },
      ]),
    ).toEqual([
      {
        ...gap,
        policy: 'required',
        modeGeneration: 1,
        actorType: 'user',
        actorId: '00112233-4455-6677-8899-aabbccddeeff',
        toSeq: 5,
        count: 5,
      },
    ]);
  });

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
    expect(() => mergeAuditLedgerGaps([gap, { ...next, ...change } as AuditLedgerEntry])).toThrow(
      new TypeError('invalid audit ledger entry'),
    );
  });

  it('refuses a count larger than the range', () => {
    expect(() => mergeAuditLedgerGaps([{ ...gap, count: Number.MAX_SAFE_INTEGER }, next])).toThrow(
      new TypeError('invalid audit ledger entry'),
    );
  });
});
