import { describe, expect, it } from 'vitest';
import { brokerNotificationsProblems, notificationsEnabled, type BrokerConfig } from '../config.js';
import {
  MAX_ENVELOPE_BYTES,
  NotificationEventError,
  encodeNotificationEvent,
  notificationEvent,
  notificationWork,
  parseNotificationEvent,
} from './events.js';

const ids = {
  id: '01J0EVENT00000000000000EV1',
  operationId: '01J0P0000000000000000000P1',
  organizationId: '01J00000000000000000000A0A',
  projectId: '01J0PR0JECT00000000000000P',
};
const pkg = (version: string | null) => ({
  ecosystem: 'npm',
  name: '@example/Library',
  version,
});
const event = (type: string, version: string | null, data: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: ids.id,
  type,
  occurredAt: '2026-11-01T12:00:00.000Z',
  operationId: ids.operationId,
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  package: pkg(version),
  data,
});

const samples = {
  published: event('npm.package.published', '1.2.3', {}),
  released: event('npm.package.released', '1.2.3', { releaseCause: 'approval_and_scan' }),
  unpublishedVersion: event('npm.package.unpublished', '1.2.3', {
    removalScope: 'version',
    removalKind: 'window',
  }),
  unpublishedPackage: event('npm.package.unpublished', null, {
    removalScope: 'package',
    removalKind: 'tombstone',
  }),
  deprecation: event('npm.package.deprecation_changed', '1.2.3', { deprecated: false }),
  distTag: event('npm.package.dist_tag_changed', null, {
    tag: 'latest',
    previousVersion: '1.2.3',
    version: null,
    cause: 'unpublish',
  }),
};

const config = (notifications?: unknown): BrokerConfig =>
  ({ platform: 'node', plugins: [], notifications }) as unknown as BrokerConfig;

function rejects(value: unknown): void {
  expect(() => notificationEvent(value)).toThrow(NotificationEventError);
}

describe('notifications flag', () => {
  it.each([undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: true, extra: 1 }])(
    'emits no work for %j',
    (value) => {
      expect(notificationsEnabled(config(value))).toBe(false);
      expect(notificationWork(config(value), [samples.published])).toEqual([]);
    },
  );
  it('emits work only when enabled is exactly true', () => {
    expect(notificationWork(config({ enabled: true }), [samples.published])).toEqual([
      samples.published,
    ]);
  });
  it('names fixed configuration problems without echoing values', () => {
    expect(brokerNotificationsProblems(config({ enabled: 'secret@example.test', x: 1 }))).toEqual([
      'notifications.enabled: must be a boolean',
      'notifications: contains an unknown key',
    ]);
    expect(brokerNotificationsProblems(config([]))).toEqual(['notifications: must be an object']);
  });
});

describe('notification event contract', () => {
  it.each(Object.entries(samples))('accepts the %s event in canonical form', (_name, sample) => {
    expect(notificationEvent(sample)).toEqual(sample);
    const bytes = encodeNotificationEvent(notificationEvent(sample));
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(sample));
  });

  it('serializes in the fixed envelope key order whatever the input order', () => {
    const shuffled = Object.fromEntries(Object.entries(samples.released).reverse());
    expect(Object.keys(notificationEvent(shuffled))).toEqual([
      'schemaVersion',
      'id',
      'type',
      'occurredAt',
      'operationId',
      'organizationId',
      'projectId',
      'package',
      'data',
    ]);
  });

  it.each([
    ['envelope', { ...samples.published, extra: 1 }],
    ['package', { ...samples.published, package: { ...pkg('1.2.3'), tarball: 'x' } }],
    ['data', { ...samples.published, data: { readme: 'x' } }],
    ['actor', { ...samples.released, actor: { id: ids.id } }],
    ['e-mail', { ...samples.released, data: { releaseCause: 'scan', email: 'a@example.test' } }],
    [
      'deprecation text',
      { ...samples.deprecation, data: { deprecated: true, message: 'use v2 instead' } },
    ],
    ['description', { ...samples.published, package: { ...pkg('1.2.3'), description: 'x' } }],
    ['token selector', { ...samples.published, tokenSelector: 'abcdefghijkl' }],
  ])('rejects an extra %s field', (_name, value) => rejects(value));

  it.each([
    ['schema version 2', { ...samples.published, schemaVersion: 2 }],
    ['unknown type', { ...samples.published, type: 'npm.package.downloaded' }],
    [
      'non-npm ecosystem',
      { ...samples.published, package: { ...pkg('1.0.0'), ecosystem: 'composer' } },
    ],
    ['invalid name', { ...samples.published, package: { ...pkg('1.0.0'), name: 'bad name' } }],
    [
      'oversized name',
      { ...samples.published, package: { ...pkg('1.0.0'), name: 'a'.repeat(215) } },
    ],
    ['oversized version', { ...samples.published, package: pkg('1'.repeat(257)) }],
    ['non-ULID id', { ...samples.published, id: 'event-1' }],
    ['non-canonical time', { ...samples.published, occurredAt: '2026-11-01T12:00:00Z' }],
    ['missing published version', { ...samples.published, package: pkg(null) }],
    ['package removal with version', { ...samples.unpublishedPackage, package: pkg('1.0.0') }],
    ['version removal without version', { ...samples.unpublishedVersion, package: pkg(null) }],
    [
      'unknown removal kind',
      { ...samples.unpublishedVersion, data: { removalScope: 'version', removalKind: 'gc' } },
    ],
    ['unknown release cause', { ...samples.released, data: { releaseCause: 'manual' } }],
    [
      'identical tag assignment',
      {
        ...samples.distTag,
        package: pkg('1.2.3'),
        data: { tag: 'latest', previousVersion: '1.2.3', version: '1.2.3', cause: 'explicit' },
      },
    ],
    [
      'tag version differing from package version',
      {
        ...samples.distTag,
        package: pkg('2.0.0'),
        data: { tag: 'latest', previousVersion: null, version: '1.0.0', cause: 'explicit' },
      },
    ],
    [
      'invalid tag',
      {
        ...samples.distTag,
        data: { tag: '1.2.3', previousVersion: '1.2.3', version: null, cause: 'unpublish' },
      },
    ],
    [
      'unknown tag cause',
      {
        ...samples.distTag,
        data: { tag: 'latest', previousVersion: '1.2.3', version: null, cause: 'refresh' },
      },
    ],
    ['non-boolean deprecation', { ...samples.deprecation, data: { deprecated: 'yes' } }],
    ['array', [samples.published]],
  ])('rejects %s', (_name, value) => rejects(value));

  it('refuses stored text over the envelope limit before parsing', () => {
    const text = JSON.stringify(samples.released);
    expect(parseNotificationEvent(text)).toEqual(samples.released);
    const padded = text.replace('{', `{${' '.repeat(MAX_ENVELOPE_BYTES)}`);
    expect(JSON.parse(padded)).toEqual(samples.released);
    expect(() => parseNotificationEvent(padded)).toThrow(NotificationEventError);
    expect(() => parseNotificationEvent('{')).toThrow(NotificationEventError);
  });

  it('uses a fixed error message', () => {
    try {
      notificationEvent({ ...samples.published, id: 'secret-marker' });
    } catch (error) {
      expect((error as Error).message).toBe('Invalid notification event');
      expect(String(error)).not.toContain('secret-marker');
    }
  });
});
