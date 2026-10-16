export type PublishedAtBasis =
  'broker' | 'build_date' | 'release_date' | 'source_time' | 'packagist_added' | 'import_time';

export type HistoryBasis = Exclude<PublishedAtBasis, 'broker'>;

export type VersionStatus = 'active' | 'removed_upstream' | 'quarantined' | 'tombstoned' | 'yanked';

export type StatusReason =
  | 'listing_absent'
  | 'listing_present'
  | 'digest_mismatch'
  | 'upstream_absent'
  | 'manifest_conflict'
  | 'admin_quarantine'
  | 'admin_release'
  | 'admin_tombstone';

export class VersionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionRuleError';
  }
}

const HISTORY_BASES: ReadonlySet<string> = new Set<HistoryBasis>([
  'build_date',
  'release_date',
  'source_time',
  'packagist_added',
  'import_time',
]);
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalTimestamp(value: string): boolean {
  if (!CANONICAL_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export interface HistoryDateInput {
  basis: PublishedAtBasis;
  at: string;
  noOtherDate?: boolean;
}

export interface HistoryDate {
  basis: HistoryBasis;
  at: string;
}

export function parseHistoryDate(input: HistoryDateInput): HistoryDate {
  const { basis, at } = input;
  if (!HISTORY_BASES.has(basis)) {
    throw new VersionRuleError('history date needs a non-broker basis');
  }
  if (!isCanonicalTimestamp(at)) {
    throw new VersionRuleError('history date must be canonical YYYY-MM-DDTHH:MM:SS.sssZ');
  }
  if (basis === 'import_time' && input.noOtherDate !== true) {
    throw new VersionRuleError('import_time is allowed only when no other date exists');
  }
  if (basis !== 'import_time' && input.noOtherDate === true) {
    throw new VersionRuleError('noOtherDate applies to the import_time basis only');
  }
  return { basis: basis as HistoryBasis, at };
}

const TRANSITIONS: Readonly<Record<string, readonly StatusReason[]>> = {
  'active>removed_upstream': ['listing_absent', 'upstream_absent'],
  'removed_upstream>active': ['listing_present'],
  'active>quarantined': ['digest_mismatch', 'manifest_conflict', 'admin_quarantine'],
  'removed_upstream>quarantined': ['digest_mismatch', 'manifest_conflict', 'admin_quarantine'],
  'quarantined>active': ['admin_release'],
  'active>tombstoned': ['admin_tombstone'],
  'removed_upstream>tombstoned': ['admin_tombstone'],
  'quarantined>tombstoned': ['admin_tombstone'],
};

export function versionTransition(
  from: VersionStatus,
  to: VersionStatus,
  reason: StatusReason,
): boolean {
  return TRANSITIONS[`${from}>${to}`]?.includes(reason) ?? false;
}

export function statusRevisionReason(
  from: VersionStatus,
  to: VersionStatus,
  reason: StatusReason,
): string {
  if (!versionTransition(from, to, reason)) {
    throw new VersionRuleError(`illegal status transition ${from}>${to} (${reason})`);
  }
  return `status:${from}>${to}:${reason}`;
}

const STATUS_VALUES: ReadonlySet<string> = new Set<VersionStatus>([
  'active',
  'removed_upstream',
  'quarantined',
  'tombstoned',
  'yanked',
]);
const REASON_VALUES: ReadonlySet<string> = new Set<StatusReason>([
  'listing_absent',
  'listing_present',
  'digest_mismatch',
  'upstream_absent',
  'manifest_conflict',
  'admin_quarantine',
  'admin_release',
  'admin_tombstone',
]);
const REVISION_REASON = /^status:([a-z_]+)>([a-z_]+):([a-z_]+)$/;

export function parseStatusRevisionReason(value: string): {
  from: VersionStatus;
  to: VersionStatus;
  reason: StatusReason;
} {
  const match = REVISION_REASON.exec(value);
  const [, from, to, reason] = match ?? [];
  if (
    from === undefined ||
    to === undefined ||
    reason === undefined ||
    !STATUS_VALUES.has(from) ||
    !STATUS_VALUES.has(to) ||
    !REASON_VALUES.has(reason)
  ) {
    throw new VersionRuleError('not a status revision reason');
  }
  const parsed = {
    from: from as VersionStatus,
    to: to as VersionStatus,
    reason: reason as StatusReason,
  };
  if (!versionTransition(parsed.from, parsed.to, parsed.reason)) {
    throw new VersionRuleError('not a status revision reason');
  }
  return parsed;
}

declare const sourceListingBrand: unique symbol;
declare const versionListingBrand: unique symbol;

export interface CompleteSourceListing {
  readonly [sourceListingBrand]: true;
  readonly sourceId: string;
  readonly stamp: string;
  readonly count: number;
}

export interface CompleteVersionListing {
  readonly [versionListingBrand]: true;
  readonly packageId: string;
  readonly stamp: string;
  readonly count: number;
}

const minted = new WeakSet<object>();

export function isCompleteListing(
  value: unknown,
): value is CompleteSourceListing | CompleteVersionListing {
  return typeof value === 'object' && value !== null && minted.has(value);
}

function mint<T extends object>(proof: T): T {
  minted.add(proof);
  return Object.freeze(proof);
}

function requireListing(scope: string, stamp: string, count: number): void {
  if (scope === '') {
    throw new VersionRuleError('a complete listing needs a scope');
  }
  if (!isCanonicalTimestamp(stamp)) {
    throw new VersionRuleError('listing stamp must be canonical YYYY-MM-DDTHH:MM:SS.sssZ');
  }
  if (!Number.isInteger(count)) {
    throw new VersionRuleError('listing count must be a finite integer');
  }
  if (count < 1) {
    throw new VersionRuleError('an empty listing cannot be completed');
  }
}

export function completeSourceListing(input: {
  sourceId: string;
  stamp: string;
  count: number;
}): CompleteSourceListing {
  requireListing(input.sourceId, input.stamp, input.count);
  return mint({
    sourceId: input.sourceId,
    stamp: input.stamp,
    count: input.count,
  } as CompleteSourceListing);
}

export function completeVersionListing(input: {
  packageId: string;
  stamp: string;
  count: number;
}): CompleteVersionListing {
  requireListing(input.packageId, input.stamp, input.count);
  return mint({
    packageId: input.packageId,
    stamp: input.stamp,
    count: input.count,
  } as CompleteVersionListing);
}
