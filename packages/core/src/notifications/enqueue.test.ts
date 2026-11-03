import { describe, expect, it } from 'vitest';
import { ulid } from '../ids.js';
import {
  CAPTURE_STATEMENTS,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DISPATCH_JOB,
  NotificationPlanError,
  assertCaptureBudget,
  deliverIdempotencyKey,
  deliverJobRow,
  deliverPayload,
  dispatchJobRow,
  dispatchPayload,
  notificationCapturePlan,
  sourceOverflowAudit,
  type CaptureEventInput,
} from './enqueue.js';

const ORG = '01J00000000000000000000A0A';
const PROJECT = '01J0PR0JECT00000000000000P';
const OP = '01J0P0000000000000000000P1';
const DELIVERY = '0b1c2d3e-4f50-4a1b-9c2d-3e4f5a6b7c8d';
const NOW = '2026-11-01T12:00:00.000Z';

const published: CaptureEventInput = {
  type: 'npm.package.published',
  projectId: PROJECT,
  sourceId: 'source',
  packageKey: '@acme/!library',
  packageName: '@acme/Library',
  version: '1.0.0',
  data: {},
};

function plan(events: readonly CaptureEventInput[] = [published]) {
  return notificationCapturePlan({
    organizationId: ORG,
    operationId: OP,
    occurredAt: NOW,
    events,
    ulid: () => ulid(),
  });
}

describe('notification job payloads', () => {
  it('accept only the identifier they carry', () => {
    expect(dispatchPayload({ operationId: OP })).toEqual({ operationId: OP });
    expect(deliverPayload({ deliveryId: DELIVERY })).toEqual({ deliveryId: DELIVERY });
    for (const value of [
      { operationId: OP, url: 'https://hooks.example.com' },
      { operationId: OP, body: '{}' },
      { operationId: OP, credentialId: OP },
      { operationId: 'not-a-ulid' },
      { deliveryId: DELIVERY },
      Object.assign(Object.create({ inherited: 1 }) as object, { operationId: OP }),
      [OP],
      null,
    ])
      expect(() => dispatchPayload(value)).toThrow(NotificationPlanError);
    for (const value of [
      { deliveryId: DELIVERY, headers: {} },
      { deliveryId: DELIVERY.toUpperCase() },
      { deliveryId: OP },
      { deliveryId: DELIVERY, signingKey: 'k' },
    ])
      expect(() => deliverPayload(value)).toThrow(NotificationPlanError);
  });

  it('builds IDs-only job rows whose keys deduplicate per generation', () => {
    const a = dispatchJobRow({ jobId: ulid(), operationId: OP, generation: 1 });
    const b = dispatchJobRow({ jobId: ulid(), operationId: OP, generation: 1 });
    expect(a.type).toBe(NOTIFICATION_DISPATCH_JOB);
    expect(a.payloadJson).toBe(`{"operationId":"${OP}"}`);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(
      dispatchJobRow({ jobId: ulid(), operationId: OP, generation: 2 }).idempotencyKey,
    ).not.toBe(a.idempotencyKey);
    const deliver = deliverJobRow({
      jobId: ulid(),
      deliveryId: DELIVERY,
      endpointId: 'E1',
      generation: 3,
    });
    expect(deliver).toMatchObject({
      type: NOTIFICATION_DELIVER_JOB,
      payloadJson: `{"deliveryId":"${DELIVERY}"}`,
      resourceKey: 'notification:E1',
      idempotencyKey: deliverIdempotencyKey(DELIVERY, 3),
      projectId: null,
      initiatorTokenId: null,
    });
    expect(() =>
      deliverJobRow({ jobId: ulid(), deliveryId: DELIVERY, endpointId: 'E 1', generation: 1 }),
    ).toThrow(NotificationPlanError);
    expect(() => dispatchJobRow({ jobId: ulid(), operationId: OP, generation: 0 })).toThrow(
      NotificationPlanError,
    );
  });
});

describe('notificationCapturePlan', () => {
  it('captures nothing for an operation without events', () => {
    expect(plan([])).toBeNull();
  });

  it('keeps the stored key apart from the display name and orders events by ordinal', () => {
    const result = plan([
      published,
      {
        ...published,
        type: 'npm.package.dist_tag_changed',
        version: null,
        data: { tag: 'beta', previousVersion: '1.0.0', version: null, cause: 'unpublish' },
      },
    ])!;
    expect(result.events.map((event) => event.ordinal)).toEqual([0, 1]);
    expect(result.events[0]).toMatchObject({ packageKey: '@acme/!library', projectId: PROJECT });
    expect(JSON.parse(result.events[0]!.payloadJson)).toMatchObject({
      operationId: OP,
      organizationId: ORG,
      package: { name: '@acme/Library', version: '1.0.0' },
    });
    expect(new Set(result.events.map((event) => event.event.id)).size).toBe(2);
    expect(result.dispatch.payloadJson).toBe(`{"operationId":"${OP}"}`);
  });

  it('prepares one bounded overflow audit for the whole operation', () => {
    const result = plan([published, published, published])!;
    expect(result.overflow).toMatchObject({
      action: 'notification.overflow',
      actor: { type: 'system', id: null },
      projectId: PROJECT,
    });
    expect(JSON.parse(result.overflow.payloadJson)).toMatchObject({
      changes: {
        operation_id: { new: OP },
        event_type: { new: 'npm.package.published' },
        event_count: { new: 3 },
      },
    });
  });

  it('accepts every stored key the notification filter accepts, including encoded capitals', () => {
    const name = `${'A'.repeat(100)}${'b'.repeat(100)}`;
    const key = `${'!a'.repeat(100)}${'b'.repeat(100)}`;
    expect(plan([{ ...published, packageKey: key, packageName: name }])!.events[0]).toMatchObject({
      packageKey: key,
    });
  });

  it('refuses invalid envelopes and stored keys outside the filter alphabet', () => {
    expect(() => plan([{ ...published, packageKey: '@acme/Library' }])).toThrow(
      NotificationPlanError,
    );
    expect(() => plan([{ ...published, version: null }])).toThrow(NotificationPlanError);
    expect(() => plan([{ ...published, projectId: 'P1' }])).toThrow(NotificationPlanError);
    expect(() => plan([{ ...published, sourceId: '' }])).toThrow(NotificationPlanError);
    expect(() =>
      notificationCapturePlan({
        organizationId: ORG,
        operationId: 'op',
        occurredAt: NOW,
        events: [published],
        ulid: () => ulid(),
      }),
    ).toThrow(NotificationPlanError);
  });

  it('attributes a source overflow to the source, not to a project', () => {
    const audit = sourceOverflowAudit({
      operationId: OP,
      occurredAt: NOW,
      sourceId: 'source',
      eventType: 'npm.package.unpublished',
      eventCount: 20_000,
      ulid: () => ulid(),
    });
    expect(audit).toMatchObject({
      action: 'notification.overflow',
      actor: { type: 'system', id: null },
      target: { type: 'source', id: 'source' },
      projectId: null,
    });
    expect(JSON.parse(audit.payloadJson)).toMatchObject({
      changes: { event_count: { new: 10_000 } },
    });
  });

  it('enforces the 40-statement batch budget including capture', () => {
    expect(() => assertCaptureBudget(40 - CAPTURE_STATEMENTS)).not.toThrow();
    expect(() => assertCaptureBudget(40 - CAPTURE_STATEMENTS + 1)).toThrow(NotificationPlanError);
    expect(CAPTURE_STATEMENTS).toBe(6);
    expect(() => assertCaptureBudget(22, 3 * CAPTURE_STATEMENTS)).not.toThrow();
    expect(() => assertCaptureBudget(23, 3 * CAPTURE_STATEMENTS)).toThrow(NotificationPlanError);
    expect(() => assertCaptureBudget(10, 0)).toThrow(NotificationPlanError);
  });
});
