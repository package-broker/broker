import { notificationsEnabled, type BrokerConfig } from '../config.js';
import { displayName, packageKey } from '../catalogue/names.js';
import { isUlid } from '../ids.js';
import { validDistTag } from '../registry/npm/dist-tags.js';

export const NOTIFICATION_EVENT_TYPES = [
  'npm.package.published',
  'npm.package.released',
  'npm.package.unpublished',
  'npm.package.deprecation_changed',
  'npm.package.dist_tag_changed',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_SCHEMA_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 16_384;

export type ReleaseCause = 'approval' | 'scan' | 'approval_and_scan';
export type RemovalScope = 'version' | 'package';
export type RemovalKind = 'window' | 'tombstone';
export type DistTagCause = 'explicit' | 'unpublish';

export interface NotificationEventData {
  readonly 'npm.package.published': Readonly<Record<string, never>>;
  readonly 'npm.package.released': { readonly releaseCause: ReleaseCause };
  readonly 'npm.package.unpublished': {
    readonly removalScope: RemovalScope;
    readonly removalKind: RemovalKind;
  };
  readonly 'npm.package.deprecation_changed': { readonly deprecated: boolean };
  readonly 'npm.package.dist_tag_changed': {
    readonly tag: string;
    readonly previousVersion: string | null;
    readonly version: string | null;
    readonly cause: DistTagCause;
  };
}

export interface NotificationPackage {
  readonly ecosystem: 'npm';
  readonly name: string;
  readonly version: string | null;
}

interface Envelope<T extends NotificationEventType> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: T;
  readonly occurredAt: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly package: NotificationPackage;
  readonly data: NotificationEventData[T];
}

export type NotificationEvent = {
  [T in NotificationEventType]: Envelope<T>;
}[NotificationEventType];

export class NotificationEventError extends Error {
  constructor() {
    super('Invalid notification event');
    this.name = 'NotificationEventError';
  }
}

const ENVELOPE_KEYS = [
  'schemaVersion',
  'id',
  'type',
  'occurredAt',
  'operationId',
  'organizationId',
  'projectId',
  'package',
  'data',
] as const;
const PACKAGE_KEYS = ['ecosystem', 'name', 'version'] as const;
const DATA_KEYS: { readonly [T in NotificationEventType]: readonly string[] } = {
  'npm.package.published': [],
  'npm.package.released': ['releaseCause'],
  'npm.package.unpublished': ['removalScope', 'removalKind'],
  'npm.package.deprecation_changed': ['deprecated'],
  'npm.package.dist_tag_changed': ['tag', 'previousVersion', 'version', 'cause'],
};
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,255}$/;

function fail(): never {
  throw new NotificationEventError();
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  return typeof value === 'string' && isUlid(value) ? value : fail();
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') fail();
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value ? value : fail();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fail();
}

function version(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  return typeof value === 'string' && VERSION.test(value) ? value : fail();
}

function npmName(value: unknown): string {
  if (typeof value !== 'string') fail();
  try {
    if (displayName(packageKey(value, { ecosystem: 'npm', legacyCase: true })) === value)
      return value;
  } catch {
    fail();
  }
  return fail();
}

function data(
  type: NotificationEventType,
  value: unknown,
  packageVersion: unknown,
): { data: NotificationEventData[NotificationEventType]; version: string | null } {
  const raw = record(value, DATA_KEYS[type]);
  switch (type) {
    case 'npm.package.published':
      return { data: {}, version: version(packageVersion, false) };
    case 'npm.package.released':
      return {
        data: { releaseCause: oneOf(raw.releaseCause, ['approval', 'scan', 'approval_and_scan']) },
        version: version(packageVersion, false),
      };
    case 'npm.package.unpublished': {
      const removalScope = oneOf(raw.removalScope, ['version', 'package'] as const);
      const removalKind = oneOf(raw.removalKind, ['window', 'tombstone'] as const);
      const removed =
        removalScope === 'package'
          ? packageVersion === null
            ? null
            : fail()
          : version(packageVersion, false);
      return { data: { removalScope, removalKind }, version: removed };
    }
    case 'npm.package.deprecation_changed':
      if (typeof raw.deprecated !== 'boolean') fail();
      return { data: { deprecated: raw.deprecated }, version: version(packageVersion, false) };
    case 'npm.package.dist_tag_changed': {
      if (typeof raw.tag !== 'string' || !validDistTag(raw.tag)) fail();
      const previous = version(raw.previousVersion, true);
      const next = version(raw.version, true);
      if (previous === next || packageVersion !== next) fail();
      return {
        data: {
          tag: raw.tag,
          previousVersion: previous,
          version: next,
          cause: oneOf(raw.cause, ['explicit', 'unpublish'] as const),
        },
        version: next,
      };
    }
  }
}

/** Rebuilds the event in canonical key order; throws NotificationEventError on any deviation. */
export function notificationEvent(value: unknown): NotificationEvent {
  const raw = record(value, ENVELOPE_KEYS);
  if (raw.schemaVersion !== NOTIFICATION_SCHEMA_VERSION) fail();
  const type = oneOf(raw.type, NOTIFICATION_EVENT_TYPES);
  const pkg = record(raw.package, PACKAGE_KEYS);
  if (pkg.ecosystem !== 'npm') fail();
  const name = npmName(pkg.name);
  const typed = data(type, raw.data, pkg.version);
  const event = {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    id: id(raw.id),
    type,
    occurredAt: timestamp(raw.occurredAt),
    operationId: id(raw.operationId),
    organizationId: id(raw.organizationId),
    projectId: id(raw.projectId),
    package: { ecosystem: 'npm', name, version: typed.version },
    data: typed.data,
  } as NotificationEvent;
  if (encodedLength(event) > MAX_ENVELOPE_BYTES) fail();
  return event;
}

function encodedLength(event: NotificationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

/** The canonical envelope bytes, the default delivery body. */
export function encodeNotificationEvent(event: NotificationEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(notificationEvent(event)));
}

/** Parses stored envelope text, refusing it before parsing when it exceeds the envelope limit. */
export function parseNotificationEvent(text: string): NotificationEvent {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_ENVELOPE_BYTES)
    fail();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }
  return notificationEvent(value);
}

/** Mutation paths call this; with the flag off they emit no notification work. */
export function notificationWork<T>(config: BrokerConfig, events: readonly T[]): readonly T[] {
  return notificationsEnabled(config) ? events : [];
}
