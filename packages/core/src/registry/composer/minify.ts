type Version = Record<string, unknown>;

export interface ExpansionLimits {
  maxVersions: number;
  maxVersionBytes?: number;
  maxTotalBytes?: number;
  maxKeysPerVersion?: number;
}

export type ExpansionLimitReason = 'versions' | 'version_bytes' | 'total' | 'keys';

export class ExpansionLimitError extends Error {
  constructor(
    readonly reason: ExpansionLimitReason,
    readonly atIndex: number | null,
    readonly count: number | null = null,
  ) {
    super(
      reason === 'versions'
        ? `composer metadata expansion limit exceeded: ${count} versions`
        : `composer metadata expansion limit exceeded: ${reason} at index ${atIndex}`,
    );
    this.name = 'ExpansionLimitError';
  }
}

export class MalformedVersionError extends Error {
  constructor(readonly atIndex: number) {
    super(`composer metadata entry ${atIndex} is not a plain object`);
    this.name = 'MalformedVersionError';
  }
}

const DEFAULT_MAX_VERSION_BYTES = 262_144;
const DEFAULT_MAX_TOTAL_BYTES = 33_554_432;
const DEFAULT_MAX_KEYS_PER_VERSION = 512;
const UNSET = '__unset';
const encoder = new TextEncoder();

function setOwn(target: Version, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasOwn(target: Version, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isset(target: Version, key: string): boolean {
  return hasOwn(target, key) && target[key] !== null && target[key] !== undefined;
}

function isEmpty(target: Version): boolean {
  for (const key in target) if (hasOwn(target, key)) return false;
  return true;
}

function assertVersion(value: unknown, index: number): asserts value is Version {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new MalformedVersionError(index);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new MalformedVersionError(index);
}

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').length;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export function minifyVersions(versions: readonly Version[]): Version[] {
  const out: Version[] = [];
  let last: Version = {};
  for (let index = 0; index < versions.length; index++) {
    const version: unknown = versions[index];
    assertVersion(version, index);
    if (isEmpty(last)) {
      last = { ...version };
      out.push({ ...version });
      continue;
    }
    const diff: Version = {};
    for (const key of Object.keys(version)) {
      const value = version[key];
      if (!isset(last, key) || JSON.stringify(last[key]) !== JSON.stringify(value)) {
        setOwn(diff, key, value);
        setOwn(last, key, value);
      }
    }
    for (const key of Object.keys(last)) {
      if (!isset(version, key)) {
        setOwn(diff, key, UNSET);
        delete last[key];
      }
    }
    out.push(diff);
  }
  return out;
}

export function expandVersions(minified: readonly Version[], limits: ExpansionLimits): Version[] {
  const maxVersions = positiveInteger('maxVersions', limits.maxVersions);
  const maxVersionBytes = positiveInteger(
    'maxVersionBytes',
    limits.maxVersionBytes ?? DEFAULT_MAX_VERSION_BYTES,
  );
  const maxTotalBytes = positiveInteger(
    'maxTotalBytes',
    limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  );
  const maxKeys = positiveInteger(
    'maxKeysPerVersion',
    limits.maxKeysPerVersion ?? DEFAULT_MAX_KEYS_PER_VERSION,
  );
  if (minified.length > maxVersions)
    throw new ExpansionLimitError('versions', null, minified.length);

  const out: Version[] = [];
  const entryBytes = new Map<string, number>();
  let entrySum = 0;
  let total = 0;
  let current: Version = {};

  for (let index = 0; index < minified.length; index++) {
    const diff: unknown = minified[index];
    assertVersion(diff, index);
    const keys = Object.keys(diff);
    let next: Version;
    if (isEmpty(current)) {
      if (keys.length > maxKeys) throw new ExpansionLimitError('keys', index);
      next = {};
      entryBytes.clear();
      entrySum = 0;
      for (const key of keys) {
        setOwn(next, key, diff[key]);
        const size = jsonBytes(key) + 1 + jsonBytes(diff[key]);
        entryBytes.set(key, size);
        entrySum += size;
      }
    } else {
      next = { ...current };
      for (const key of keys) {
        const value = diff[key];
        const previous = entryBytes.get(key);
        if (value === UNSET) {
          if (previous !== undefined) {
            delete next[key];
            entryBytes.delete(key);
            entrySum -= previous;
          }
          continue;
        }
        if (previous === undefined && entryBytes.size >= maxKeys)
          throw new ExpansionLimitError('keys', index);
        const size = jsonBytes(key) + 1 + jsonBytes(value);
        entryBytes.set(key, size);
        entrySum += size - (previous ?? 0);
        setOwn(next, key, value);
        if (entrySum > maxVersionBytes) throw new ExpansionLimitError('version_bytes', index);
      }
    }
    const serialized = 2 + entrySum + Math.max(entryBytes.size - 1, 0);
    if (serialized > maxVersionBytes) throw new ExpansionLimitError('version_bytes', index);
    total += serialized;
    if (total > maxTotalBytes) throw new ExpansionLimitError('total', index);
    current = next;
    out.push(next);
  }
  return out;
}
