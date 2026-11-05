import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_ATTEMPT_CODES,
  NOTIFICATION_DELIVERY_CODES,
  NOTIFICATION_DISABLED_REASONS,
  NOTIFICATION_EVENT_TYPES,
} from '../db/notifications.js';
import { AUDIT_FIELDS, auditEvent, validateAuditEvent, type AuditAction } from './actions.js';

const ENDPOINT = '01J0NEND000000000000000000';
const EVENT = '01J0NEVT000000000000000000';
const DELIVERY = '01J0NDDV000000000000000000';
const OPERATION = '01J0NQPS000000000000000000';

function build(action: AuditAction, changes: Record<string, unknown>, system = false) {
  return auditEvent({
    id: '01J0AUDIT000000000000000A',
    now: '2026-11-01T12:00:00.000Z',
    action,
    actor: system
      ? { type: 'system', id: null }
      : { type: 'user', id: '01J0USER000000000000000000' },
    context: {
      opId: OPERATION,
      requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      sourceIp: null,
      tokenSelector: null,
    },
    target: { type: 'notification_endpoint', id: ENDPOINT },
    projectId: '01J0PROJ000000000000000000',
    changes: Object.fromEntries(
      Object.entries(changes).map(([field, value]) => [field, { new: value }]),
    ) as never,
  });
}

const SAFE: readonly [AuditAction, Record<string, unknown>][] = [
  [
    'notification.create',
    {
      revision: 1,
      method: 'POST',
      events: ['npm.package.published', 'npm.package.released'],
      pattern: '@acme/*',
      changed: ['name', 'destination', 'signing_key'],
      headers_configured: true,
      template_configured: false,
    },
  ],
  ['notification.update', { revision: 2, method: 'PUT', changed: ['events', 'package_pattern'] }],
  ['notification.credential_set', { revision: 3, changed: ['headers', 'template'] }],
  ['notification.enable', { revision: 4 }],
  ['notification.disable', { revision: 5, reason: 'manual' }],
  ['notification.delete', { revision: 6 }],
  ['notification.delete', { revision: 6, reason: 'deleted' }],
  ['notification.auto_disable', { revision: 7, reason: 'failures', failure_streak: 10 }],
  [
    'notification.delivery_started',
    { endpoint_id: ENDPOINT, event_id: EVENT, delivery_id: DELIVERY, attempt: 1 },
  ],
  [
    'notification.delivery_finished',
    {
      endpoint_id: ENDPOINT,
      event_id: EVENT,
      delivery_id: DELIVERY,
      attempt: 8,
      outcome: 'retry',
      reason: 'http_retry',
      status: 503,
      duration_ms: 10_000,
      delivery_state: 'pending',
    },
  ],
  [
    'notification.delivery_cancelled',
    { endpoint_id: ENDPOINT, event_id: EVENT, delivery_id: DELIVERY, reason: 'superseded' },
  ],
  [
    'notification.overflow',
    { operation_id: OPERATION, event_type: 'npm.package.unpublished', event_count: 1 },
  ],
];

const UNSAFE: readonly [string, AuditAction, Record<string, unknown>][] = [
  [
    'a destination URL as a pattern',
    'notification.create',
    { pattern: 'https://hooks.example.test/x' },
  ],
  [
    'a header value as a change name',
    'notification.update',
    { changed: ['Authorization: Bearer x'] },
  ],
  ['a template as a change name', 'notification.update', { changed: ['{"a":"{{package.name}}"}'] }],
  ['an account e-mail as a reason', 'notification.disable', { reason: 'admin@example.test' }],
  [
    'receiver failure text',
    'notification.delivery_finished',
    { reason: 'upstream said: token expired' },
  ],
  [
    'a free-text outcome',
    'notification.delivery_finished',
    { outcome: 'connection reset by peer' },
  ],
  ['a URL as an endpoint id', 'notification.delivery_started', { endpoint_id: 'https://x.test' }],
  ['a ninth attempt', 'notification.delivery_started', { attempt: 9 }],
  ['a fractional duration', 'notification.delivery_finished', { duration_ms: 1.5 }],
  ['a status outside HTTP', 'notification.delivery_finished', { status: 700 }],
  ['an unknown method', 'notification.create', { method: 'GET' }],
  ['an unknown event', 'notification.create', { events: ['npm.package.fetched'] }],
  ['an empty event selection', 'notification.create', { events: [] }],
  ['a duplicated change name', 'notification.update', { changed: ['name', 'name'] }],
  ['a stringly boolean', 'notification.create', { headers_configured: 'true' }],
  ['a zero revision', 'notification.enable', { revision: 0 }],
  ['a free-text event type', 'notification.overflow', { event_type: 'publish of secret-pkg' }],
  ['a zero overflow count', 'notification.overflow', { event_count: 0 }],
  ['a delivery code as a disable reason', 'notification.disable', { reason: 'http_retry' }],
  ['a cancellation code as a disable reason', 'notification.disable', { reason: 'superseded' }],
  ['a manual reason for an automatic disable', 'notification.auto_disable', { reason: 'manual' }],
  ['a reason for enabling', 'notification.enable', { reason: 'manual' }],
  ['a disable reason for a deletion', 'notification.delete', { reason: 'manual' }],
  [
    'a disable reason for a finished delivery',
    'notification.delivery_finished',
    { reason: 'manual' },
  ],
  [
    'a cancellation code for a finished delivery',
    'notification.delivery_finished',
    { reason: 'superseded' },
  ],
  ['an attempt code for a cancelled delivery', 'notification.delivery_cancelled', { reason: 'ok' }],
  [
    'a disable reason for a cancelled delivery',
    'notification.delivery_cancelled',
    { reason: 'failures' },
  ],
];

describe('notification audit fields', () => {
  it.each(SAFE)('accepts the fixed safe fields of %s', (action, changes) => {
    const result = build(action, changes, action.includes('delivery'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(validateAuditEvent(result.event)).toEqual(result.event);
  });

  it.each(UNSAFE)('refuses %s', (_label, action, changes) => {
    expect(build(action, changes)).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each([
    ['notification.create', 'url'],
    ['notification.update', 'headers'],
    ['notification.credential_set', 'signing_key'],
    ['notification.update', 'template'],
    ['notification.update', 'name'],
    ['notification.delivery_finished', 'body'],
    ['notification.delivery_finished', 'error'],
    ['notification.disable', 'email'],
  ] as const)('%s has no %s field', (action, field) => {
    expect(build(action, { [field]: 'x' })).toEqual({ ok: false, reason: 'unknown_field' });
  });

  it('keeps its fixed vocabularies equal to the notification port', () => {
    const fields = Object.entries(AUDIT_FIELDS).filter(([action]) =>
      action.startsWith('notification.'),
    );
    expect(fields).toHaveLength(11);
    expect(build('notification.create', { events: [...NOTIFICATION_EVENT_TYPES] }).ok).toBe(true);
    for (const reason of NOTIFICATION_DISABLED_REASONS)
      expect(build('notification.disable', { reason }).ok, reason).toBe(true);
    for (const reason of ['failures', 'credentials', 'policy', 'gone'])
      expect(build('notification.auto_disable', { reason }, true).ok, reason).toBe(true);
    const finished = [...NOTIFICATION_ATTEMPT_CODES, 'expired', 'attempt_limit'];
    for (const reason of finished)
      expect(build('notification.delivery_finished', { reason }, true).ok, reason).toBe(true);
    for (const reason of NOTIFICATION_DELIVERY_CODES.filter((code) => !finished.includes(code)))
      expect(build('notification.delivery_cancelled', { reason }, true).ok, reason).toBe(true);
    for (const type of NOTIFICATION_EVENT_TYPES)
      expect(
        build('notification.overflow', {
          event_type: type,
          operation_id: OPERATION,
          event_count: 1,
        }).ok,
      ).toBe(true);
  });
});
