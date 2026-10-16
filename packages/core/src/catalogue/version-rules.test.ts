import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  VersionRuleError,
  completeSourceListing,
  completeVersionListing,
  isCompleteListing,
  parseHistoryDate,
  parseStatusRevisionReason,
  statusRevisionReason,
  versionTransition,
  type CompleteSourceListing,
  type CompleteVersionListing,
  type StatusReason,
  type VersionStatus,
} from './version-rules.js';

const STAMP = '2024-05-06T07:08:09.123Z';
const AT = '2024-05-06T07:08:09.123Z';

describe('parseHistoryDate', () => {
  it.each(['build_date', 'release_date', 'source_time', 'packagist_added'] as const)(
    'accepts %s',
    (basis) => {
      expect(parseHistoryDate({ basis, at: AT })).toEqual({ basis, at: AT });
    },
  );

  it('refuses the broker basis', () => {
    expect(() => parseHistoryDate({ basis: 'broker', at: AT })).toThrow(VersionRuleError);
  });

  it('refuses an unknown basis', () => {
    expect(() => parseHistoryDate({ basis: 'made_up' as never, at: AT })).toThrow(VersionRuleError);
  });

  it.each([
    '2024-05-06',
    '2024-05-06T07:08:09Z',
    '2024-05-06T07:08:09.12Z',
    '2024-05-06T07:08:09.123+00:00',
    '2024-05-06 07:08:09.123Z',
    '2024-02-30T07:08:09.123Z',
    '2024-13-06T07:08:09.123Z',
    '2024-05-06T25:08:09.123Z',
    '',
  ])('refuses non-canonical timestamp %j', (at) => {
    expect(() => parseHistoryDate({ basis: 'release_date', at })).toThrow(VersionRuleError);
  });

  it('refuses noOtherDate with a non-import_time basis', () => {
    expect(() => parseHistoryDate({ basis: 'release_date', at: AT, noOtherDate: true })).toThrow(
      VersionRuleError,
    );
  });

  it('requires noOtherDate for import_time', () => {
    expect(() => parseHistoryDate({ basis: 'import_time', at: AT })).toThrow(VersionRuleError);
    expect(() => parseHistoryDate({ basis: 'import_time', at: AT, noOtherDate: false })).toThrow(
      VersionRuleError,
    );
    expect(parseHistoryDate({ basis: 'import_time', at: AT, noOtherDate: true })).toEqual({
      basis: 'import_time',
      at: AT,
    });
  });
});

const STATUSES: VersionStatus[] = [
  'active',
  'removed_upstream',
  'quarantined',
  'tombstoned',
  'yanked',
];
const REASONS: StatusReason[] = [
  'listing_absent',
  'listing_present',
  'digest_mismatch',
  'upstream_absent',
  'manifest_conflict',
  'admin_quarantine',
  'admin_release',
  'admin_tombstone',
];

const LEGAL: Record<string, StatusReason[]> = {
  'active>removed_upstream': ['listing_absent', 'upstream_absent'],
  'removed_upstream>active': ['listing_present'],
  'active>quarantined': ['digest_mismatch', 'manifest_conflict', 'admin_quarantine'],
  'removed_upstream>quarantined': ['digest_mismatch', 'manifest_conflict', 'admin_quarantine'],
  'quarantined>active': ['admin_release'],
  'active>tombstoned': ['admin_tombstone'],
  'removed_upstream>tombstoned': ['admin_tombstone'],
  'quarantined>tombstoned': ['admin_tombstone'],
};

describe('versionTransition matrix', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const reason of REASONS) {
        const expected = LEGAL[`${from}>${to}`]?.includes(reason) ?? false;
        it(`${from} > ${to} (${reason}) is ${expected ? 'legal' : 'refused'}`, () => {
          expect(versionTransition(from, to, reason)).toBe(expected);
          if (expected) {
            expect(statusRevisionReason(from, to, reason)).toBe(`status:${from}>${to}:${reason}`);
          } else {
            expect(() => statusRevisionReason(from, to, reason)).toThrow(VersionRuleError);
          }
        });
      }
    }
  }

  it('tombstoned is terminal', () => {
    for (const to of STATUSES) {
      for (const reason of REASONS) {
        expect(versionTransition('tombstoned', to, reason)).toBe(false);
      }
    }
  });

  it('refuses yanked in either direction', () => {
    for (const other of STATUSES) {
      for (const reason of REASONS) {
        expect(versionTransition('yanked', other, reason)).toBe(false);
        expect(versionTransition(other, 'yanked', reason)).toBe(false);
      }
    }
  });

  it('releases quarantine only with admin_release', () => {
    expect(versionTransition('quarantined', 'active', 'listing_present')).toBe(false);
    expect(versionTransition('quarantined', 'active', 'admin_release')).toBe(true);
  });

  it('keeps quarantine sticky', () => {
    for (const reason of REASONS) {
      expect(versionTransition('quarantined', 'removed_upstream', reason)).toBe(false);
    }
  });

  it('produces the documented example', () => {
    expect(statusRevisionReason('active', 'quarantined', 'digest_mismatch')).toBe(
      'status:active>quarantined:digest_mismatch',
    );
  });
});

describe('complete listings', () => {
  it('mints a source listing', () => {
    const listing = completeSourceListing({ sourceId: 's1', stamp: STAMP, count: 3 });
    expect(listing).toMatchObject({ sourceId: 's1', stamp: STAMP, count: 3 });
  });

  it('mints a version listing', () => {
    const listing = completeVersionListing({ packageId: 'p1', stamp: STAMP, count: 1 });
    expect(listing).toMatchObject({ packageId: 'p1', stamp: STAMP, count: 1 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses count %s', (count) => {
    expect(() => completeSourceListing({ sourceId: 's1', stamp: STAMP, count })).toThrow(
      VersionRuleError,
    );
    expect(() => completeVersionListing({ packageId: 'p1', stamp: STAMP, count })).toThrow(
      VersionRuleError,
    );
  });

  it.each(['2024-05-06T07:08:09Z', 'zz', '', '2024-02-30T07:08:09.123Z'])(
    'refuses non-canonical stamp %j',
    (stamp) => {
      expect(() => completeSourceListing({ sourceId: 's1', stamp, count: 1 })).toThrow(
        VersionRuleError,
      );
      expect(() => completeVersionListing({ packageId: 'p1', stamp, count: 1 })).toThrow(
        VersionRuleError,
      );
    },
  );

  it('freezes minted proofs and recognises only minted ones', () => {
    const source = completeSourceListing({ sourceId: 's1', stamp: STAMP, count: 1 });
    const version = completeVersionListing({ packageId: 'p1', stamp: STAMP, count: 1 });
    expect(Object.isFrozen(source)).toBe(true);
    expect(isCompleteListing(source)).toBe(true);
    expect(isCompleteListing(version)).toBe(true);
    const forged = { sourceId: 's1', stamp: STAMP, count: 1 } as unknown as CompleteSourceListing;
    expect(isCompleteListing(forged)).toBe(false);
    expect(isCompleteListing({ ...source })).toBe(false);
    expect(isCompleteListing(null)).toBe(false);
    expect(isCompleteListing('x')).toBe(false);
  });

  it('refuses an empty scope', () => {
    expect(() => completeSourceListing({ sourceId: '', stamp: STAMP, count: 1 })).toThrow(
      VersionRuleError,
    );
    expect(() => completeVersionListing({ packageId: 'p1', stamp: '', count: 1 })).toThrow(
      VersionRuleError,
    );
  });

  it('does not accept plain objects', () => {
    const plainSource = { sourceId: 's1', stamp: STAMP, count: 1 };
    const plainVersion = { packageId: 'p1', stamp: STAMP, count: 1 };
    expectTypeOf(plainSource).not.toExtend<CompleteSourceListing>();
    expectTypeOf(plainVersion).not.toExtend<CompleteVersionListing>();
    const take = (listing: CompleteSourceListing): number => listing.count;
    // @ts-expect-error a plain object is not a CompleteSourceListing
    take(plainSource);
    const takeVersion = (listing: CompleteVersionListing): number => listing.count;
    // @ts-expect-error a plain object is not a CompleteVersionListing
    takeVersion(plainVersion);
  });

  it('keeps the two listing types distinct', () => {
    const source = completeSourceListing({ sourceId: 's1', stamp: STAMP, count: 1 });
    expectTypeOf(source).not.toExtend<CompleteVersionListing>();
  });
});

describe('parseStatusRevisionReason', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const reason of REASONS) {
        if (LEGAL[`${from}>${to}`]?.includes(reason)) {
          it(`round-trips ${from} > ${to} (${reason})`, () => {
            expect(parseStatusRevisionReason(statusRevisionReason(from, to, reason))).toEqual({
              from,
              to,
              reason,
            });
          });
        }
      }
    }
  }

  it.each([
    '',
    'status:active>quarantined',
    'status:active>quarantined:bogus',
    'status:active>nowhere:admin_quarantine',
    'status:quarantined>active:listing_present',
    'status:tombstoned>active:admin_release',
    'status:active>quarantined:admin_quarantine:extra',
    ' status:active>quarantined:admin_quarantine',
    'status:active>quarantined:admin_quarantine\n',
    'Status:active>quarantined:admin_quarantine',
  ])('refuses %j', (value) => {
    expect(() => parseStatusRevisionReason(value)).toThrow(VersionRuleError);
  });
});
