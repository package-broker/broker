import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import { AUDIT_EVENTS, KERNEL_REASON_CODES } from '../kernel/obs-codes.js';
import {
  createObservability,
  type Observability,
  type ObsRecord,
} from '../platform/observability.js';
import type { Cache, CacheEnvelope } from '../platform/cache.js';
import { createFailureEvents, type FailureAttempt } from './failure-events.js';
import {
  auditEvent,
  LOGIN_FAILURE_METHODS,
  LOGIN_FAILURE_REASONS,
  type AuditEvent,
  type AuditEventInput,
} from './actions.js';
import { auditWireRecord } from './wire.js';

const ctx = orgContext('organization-a');
const at = new Date('2026-10-30T10:00:12.000Z');
function setup(observability?: Observability, dedicatedCache = false) {
  let time = at;
  const values = new Map<string, CacheEnvelope>();
  const cache: Cache = {
    async get(_org, key) {
      void _org;
      const entry = values.get(key.digest);
      return entry ? { entry, state: 'fresh' } : null;
    },
    async set(_org, key, entry) {
      void _org;
      values.set(key.digest, entry);
    },
    async delete() {},
  };
  const stage = vi
    .fn<(ctx: OrgContext, event: AuditEvent) => Promise<void>>()
    .mockResolvedValue(undefined);
  const log = vi.fn();
  const counter = vi.fn();
  const recorder = createFailureEvents({
    ...(dedicatedCache ? {} : { cache }),
    staging: { stage },
    observability: observability ?? { log, counter, histogram: vi.fn() },
    deploymentId: 'deployment',
    routeTemplates: new Set(['/', '/_pb/projects/:project/audit', '/_pb/audit']),
    now: () => time,
  });
  return {
    enqueue: recorder.record,
    drain: recorder.drain,
    recorder: {
      async record(ctx: OrgContext, attempt: FailureAttempt) {
        await recorder.record(ctx, attempt);
        await recorder.drain(ctx);
      },
    },
    stage,
    log,
    counter,
    values,
    cache,
    advance: () => {
      time = new Date(time.getTime() + 60_000);
    },
  };
}
function login(userId: string | null = null): FailureAttempt {
  return {
    action: 'session.login_failed',
    userId,
    method: 'local',
    reason: 'bad_credentials',
    context: {
      sourceIp: '203.0.113.7',
    },
  };
}

describe('failure event limiter', () => {
  it('stages only attempts 1, 10, 100 and 1000 in 10,000 processed attempts', async () => {
    const h = setup();
    for (let i = 0; i < 10_000; i++) await h.recorder.record(ctx, login());
    expect(h.stage).toHaveBeenCalledTimes(4);
    expect(
      h.stage.mock.calls.map((args) => JSON.parse(args[1].payloadJson).changes.count.new),
    ).toEqual([1, 10, 100, 1000]);
    expect(h.counter).toHaveBeenCalledTimes(9996);
    expect(h.counter).toHaveBeenCalledWith('pb.audit.failure_events_suppressed');
    const serialized = JSON.stringify(h.stage.mock.calls);
    for (const secret of ['submitted', 'example.invalid', 'Bearer', 'hidden'])
      expect(serialized).not.toContain(secret);
    expect(JSON.stringify([...h.values])).not.toContain('203.0.113.7');
  });

  it('bounds queued work and immediately drops overflow even when staging is blocked', async () => {
    const h = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.stage.mockImplementation(() => blocked);
    const admitted = Array.from({ length: 64 }, () => h.enqueue(ctx, login(ulid())));
    await Promise.all(admitted);
    await vi.waitFor(() => expect(h.stage).toHaveBeenCalledTimes(1));
    await Promise.all(Array.from({ length: 10_000 }, () => h.enqueue(ctx, login(ulid()))));
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.counter).toHaveBeenCalledTimes(10_000);
    // Another organization is independent of the blocked queue.
    h.stage.mockResolvedValue(undefined);
    await h.recorder.record(orgContext('organization-b'), login());
    expect(h.stage).toHaveBeenCalledTimes(2);
    release();
    await Promise.all(admitted);
    await h.drain(ctx);
    expect(h.stage).toHaveBeenCalledTimes(65);
    await h.recorder.record(ctx, login(ulid()));
    expect(h.stage).toHaveBeenCalledTimes(66);
  });

  it.each(['no_ip_key_saturated', 'org_cap_reached'] as const)(
    'emits %s through the production observability registry',
    async (reasonCode) => {
      const records: ObsRecord[] = [];
      const observability = createObservability(
        { emit: (record) => records.push(record) },
        { deploymentId: 'deployment', runtime: 'node', requestId: null },
        { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
      );
      const h = setup(observability);
      for (let i = 0; i < (reasonCode === 'org_cap_reached' ? 601 : 1000); i++) {
        const attempt = login(reasonCode === 'org_cap_reached' ? ulid() : null);
        await h.recorder.record(ctx, {
          ...attempt,
          context: { ...attempt.context, sourceIp: null },
        });
      }
      expect(records).toContainEqual({
        kind: 'log',
        record: expect.objectContaining({
          level: 'warn',
          event: 'audit.failure_events_cap',
          reason_code: reasonCode,
        }),
      });
      expect(records).not.toContainEqual(
        expect.objectContaining({ labels: { signal: 'unregistered' } }),
      );
    },
  );

  it('gives unknown accounts without an IP a separate key and alerts at saturation', async () => {
    const h = setup();
    const base = login();
    const attempt = { ...base, context: { ...base.context, sourceIp: null } };
    for (let i = 0; i < 1001; i++) await h.recorder.record(ctx, attempt);
    expect(
      h.stage.mock.calls.map((args) => JSON.parse(args[1].payloadJson).changes.count.new),
    ).toEqual([1, 10, 100, 1000]);
    expect(h.log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'audit.failure_events_cap',
      reason_code: 'no_ip_key_saturated',
    });
    expect(h.counter).toHaveBeenCalledTimes(997);
    await h.recorder.record(ctx, base);
    expect(h.stage).toHaveBeenCalledTimes(5);
    h.advance();
    for (let i = 0; i < 1000; i++) await h.recorder.record(ctx, attempt);
    expect(h.log).toHaveBeenCalledTimes(2);
  });

  it('counts attempts refused by the event sanitizer as suppressed', async () => {
    const h = setup();
    await h.recorder.record(ctx, login('invalid-principal'));
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.counter).toHaveBeenCalledExactlyOnceWith('pb.audit.failure_events_suppressed');
    expect(h.log).toHaveBeenCalledExactlyOnceWith({
      level: 'error',
      event: 'audit.failure_event_invalid',
    });
  });

  it('defaults to a dedicated bounded counter store independent of package metadata', async () => {
    const h = setup(undefined, true);
    const get = vi.spyOn(h.cache, 'get');
    const set = vi.spyOn(h.cache, 'set');
    for (let i = 0; i < 2050; i++) {
      await h.recorder.record(orgContext(`organization-${i}`), login());
    }
    expect(h.stage).toHaveBeenCalledTimes(2050);
    // Two entries per organization exceed the 4096-entry LRU bound.
    await h.recorder.record(orgContext('organization-0'), login());
    expect(h.stage).toHaveBeenCalledTimes(2051);
    await h.recorder.record(orgContext('organization-2049'), login());
    expect(h.stage).toHaveBeenCalledTimes(2051);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('isolates organizations and resets the minute window', async () => {
    const h = setup();
    await h.recorder.record(ctx, login());
    await h.recorder.record(ctx, login());
    await h.recorder.record(orgContext('organization-b'), login());
    h.advance();
    await h.recorder.record(ctx, login());
    expect(h.stage).toHaveBeenCalledTimes(3);
  });

  it('keys attempts by actor or source IP and method, without splitting on reason', async () => {
    const h = setup();
    const attempt = login();
    if (attempt.action !== 'session.login_failed') throw new Error('invalid fixture');
    await h.recorder.record(ctx, attempt);
    await h.recorder.record(ctx, { ...attempt, reason: 'unknown_account' });
    await h.recorder.record(ctx, { ...attempt, method: 'oidc' });
    await h.recorder.record(ctx, {
      ...attempt,
      context: { ...attempt.context, sourceIp: '203.0.113.8' },
    });
    const resolved = { ...attempt, userId: ulid() };
    await h.recorder.record(ctx, resolved);
    await h.recorder.record(ctx, {
      ...resolved,
      context: { ...attempt.context, sourceIp: '203.0.113.9' },
    });
    expect(h.stage).toHaveBeenCalledTimes(4);
  });

  it.each(['session.login_failed', 'access.denied'] as const)(
    'keeps %s readable by the wire sanitizer',
    async (action) => {
      const h = setup();
      await h.recorder.record(
        ctx,
        action === 'session.login_failed'
          ? login()
          : {
              action,
              actor: { type: 'user', id: ulid() },
              routeTemplate: '/',
              permission: 'org:audit:read',
              boundary: 'organization',
              context: login().context,
            },
      );
      const event = h.stage.mock.calls[0]![1];
      const orgId = ulid();
      const output = await auditWireRecord(
        { chainId: ulid(), epoch: 1, orgId },
        {
          id: event.id,
          org_id: orgId,
          seq: 1,
          prev_hash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          created_at: event.occurredAt,
          actor_type: event.actor.type,
          actor_id: event.actor.id,
          token_selector: event.tokenSelector,
          source_ip: event.sourceIp,
          action: event.action,
          target_type: event.target.type,
          target_id: event.target.id,
          project_id: event.projectId,
          payload_json: event.payloadJson,
        },
        'include',
      );
      expect(output.kind).toBe('event');
      if (output.kind === 'event') expect(output.payloadJson).toBe(event.payloadJson);
    },
  );

  it('caps distinct keys at 600 staged events per org and alerts once', async () => {
    const h = setup();
    for (let i = 0; i < 605; i++) await h.recorder.record(ctx, login(ulid()));
    expect(h.stage).toHaveBeenCalledTimes(600);
    expect(h.log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'audit.failure_events_cap',
      reason_code: 'org_cap_reached',
    });
    expect(h.counter).toHaveBeenCalledTimes(5);
    await h.recorder.record(orgContext('organization-b'), login());
    expect(h.stage).toHaveBeenCalledTimes(601);
    h.advance();
    await h.recorder.record(ctx, login());
    expect(h.stage).toHaveBeenCalledTimes(602);
  });

  it('records a principal and a registered route template, rejecting concrete paths', async () => {
    const h = setup();
    const attempt: FailureAttempt = {
      action: 'access.denied',
      actor: { type: 'user', id: ulid() },
      routeTemplate: '/_pb/projects/:project/audit',
      permission: 'project:audit:read',
      boundary: 'project',
      context: login().context,
    };
    await h.recorder.record(ctx, attempt);
    expect(h.stage.mock.calls[0]).toEqual([
      ctx,
      expect.objectContaining({
        actor: attempt.actor,
        target: { type: 'route', id: attempt.routeTemplate },
        tokenSelector: null,
      }),
    ]);
    await h.recorder.record(ctx, { ...attempt, routeTemplate: '/_pb/projects/private/audit' });
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.counter).toHaveBeenCalledExactlyOnceWith('pb.audit.failure_events_suppressed');
    expect(h.log).toHaveBeenCalledExactlyOnceWith({
      level: 'error',
      event: 'audit.failure_event_invalid',
    });
    await h.recorder.record(ctx, { ...attempt, routeTemplate: '/' });
    expect(h.stage).toHaveBeenCalledTimes(2);
  });

  it('separates route and permission keys and accepts each authenticated principal type', async () => {
    const h = setup();
    const actorId = ulid();
    const base = {
      action: 'access.denied',
      actor: { type: 'user', id: actorId },
      routeTemplate: '/_pb/audit',
      permission: 'org:audit:read',
      boundary: 'organization',
      context: login().context,
    } as const;
    await h.recorder.record(ctx, base);
    await h.recorder.record(ctx, base);
    await h.recorder.record(ctx, { ...base, permission: 'org:users:read' });
    await h.recorder.record(ctx, { ...base, routeTemplate: '/_pb/projects/:project/audit' });
    await h.recorder.record(ctx, { ...base, permission: 'org:invented:read' });
    expect(h.stage).toHaveBeenCalledTimes(3);
    for (const type of ['service_principal', 'customer'] as const) {
      await h.recorder.record(ctx, { ...base, actor: { type, id: ulid() } });
    }
    expect(h.stage).toHaveBeenCalledTimes(5);
  });

  it.each(['staging', 'cache', 'observability'])(
    '%s failure leaves the authentication response unchanged and leaks no error',
    async (failure) => {
      const h = setup();
      const error = new Error('secret@example.invalid Bearer credential');
      if (failure === 'staging') h.stage.mockRejectedValue(error);
      if (failure === 'cache')
        h.cache.get = async () => {
          throw error;
        };
      if (failure === 'observability') {
        h.stage.mockRejectedValue(error);
        h.log.mockImplementation(() => {
          throw error;
        });
      }
      const response = new Response('Unauthorized', { status: 401 });
      async function authenticate() {
        await h.recorder.record(ctx, login());
        return response;
      }
      expect(await authenticate()).toBe(response);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Unauthorized');
      expect(JSON.stringify(h.log.mock.calls)).not.toContain('secret');
      expect(h.counter).toHaveBeenCalledExactlyOnceWith('pb.audit.failure_events_suppressed');
      if (failure !== 'observability')
        expect(h.log).toHaveBeenCalledExactlyOnceWith({
          level: 'error',
          event: 'audit.failure_event_failed',
        });
    },
  );
});

describe('failure action validation', () => {
  function input(): AuditEventInput {
    const id = ulid();
    return {
      id,
      now: at.toISOString(),
      action: 'session.login_failed',
      actor: { type: 'system', id: null },
      context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
      target: { type: 'session', id: null },
      changes: {
        method: { new: 'local' },
        reason: { new: 'unknown_account' },
        count: { new: 1 },
        window_start: { new: '2026-10-30T10:00:00.000Z' },
      },
    };
  }
  it('accepts enumerated fields and refuses missing ones', () => {
    expect(auditEvent(input()).ok).toBe(true);
    expect(auditEvent({ ...input(), changes: {} }).ok).toBe(false);
    expect(auditEvent({ ...input(), changes: undefined } as unknown as AuditEventInput).ok).toBe(
      false,
    );
  });
  it.each([
    ['method', 'secret@example.invalid'],
    ['reason', 'Bearer credential'],
    ['count', 0],
    ['count', 1.5],
    ['window_start', 'yesterday'],
    ['identifier', 'person@example.invalid'],
  ])('refuses unsafe %s', (field, value) => {
    const event = input();
    expect(
      auditEvent({ ...event, changes: { ...event.changes, [field]: { new: value } } }).ok,
    ).toBe(false);
  });
  it.each(
    LOGIN_FAILURE_METHODS.flatMap((method) =>
      LOGIN_FAILURE_REASONS.map((reason) => [method, reason] as const),
    ),
  )('accepts login method %s and reason %s', (method, reason) => {
    const event = input();
    expect(
      auditEvent({
        ...event,
        changes: { ...event.changes, method: { new: method }, reason: { new: reason } },
      }).ok,
    ).toBe(true);
  });
  it.each(['permission', 'boundary', 'count', 'window_start'])(
    'rejects sensitive old and new values for denied %s',
    (field) => {
      const event: AuditEventInput = {
        ...input(),
        action: 'access.denied',
        actor: { type: 'user', id: ulid() },
        target: { type: 'route', id: '/_pb/projects/:project/audit' },
        changes: {
          permission: { new: 'project:audit:read' },
          boundary: { new: 'project' },
          count: { new: 1 },
          window_start: { new: at.toISOString() },
        },
      };
      expect(auditEvent(event).ok).toBe(true);
      expect(auditEvent({ ...event, changes: undefined } as unknown as AuditEventInput).ok).toBe(
        false,
      );
      expect(auditEvent({ ...event, target: { type: 'route', id: '/' } }).ok).toBe(true);
      for (const key of ['old', 'new']) {
        expect(
          auditEvent({
            ...event,
            changes: {
              ...event.changes,
              [field]: { new: event.changes![field]!.new!, [key]: 'person@example.invalid' },
            },
          }).ok,
        ).toBe(false);
      }
    },
  );
  it.each(['session.login_failed', 'access.denied'] as const)(
    'refuses all old values for %s, including otherwise valid values',
    (action) => {
      const event: AuditEventInput =
        action === 'session.login_failed'
          ? input()
          : {
              ...input(),
              action,
              actor: { type: 'user', id: ulid() },
              target: { type: 'route', id: '/' },
              changes: {
                permission: { new: 'org:audit:read' },
                boundary: { new: 'organization' },
                count: { new: 1 },
                window_start: { new: at.toISOString() },
              },
            };
      expect(auditEvent(event).ok).toBe(true);
      for (const [field, entry] of Object.entries(event.changes!)) {
        for (const old of [entry.new, undefined]) {
          expect(
            auditEvent({
              ...event,
              changes: { ...event.changes, [field]: { ...entry, old } },
            } as unknown as AuditEventInput),
          ).toEqual({ ok: false, reason: 'bad_value' });
        }
      }
    },
  );

  it('refuses malformed envelopes without throwing or exposing input', () => {
    for (const replacement of [
      { context: null },
      { actor: null },
      { target: null },
      { projectId: 'person@example.invalid' },
    ]) {
      expect(auditEvent({ ...input(), ...replacement } as unknown as AuditEventInput)).toEqual({
        ok: false,
        reason: 'projectId' in replacement ? 'credential_value' : 'bad_value',
      });
    }
  });
  it('refuses unresolved user actors and selectors', () => {
    expect(auditEvent({ ...input(), actor: { type: 'user', id: null } }).ok).toBe(false);
    const event = input();
    expect(
      auditEvent({ ...event, context: { ...event.context, tokenSelector: 'abcdefghijkl' } }).ok,
    ).toBe(false);
  });
});

it('binds staging, deployment, clock and observability to each queued application call', async () => {
  const recorder = createFailureEvents();
  const firstStage = vi.fn().mockResolvedValue(undefined);
  const secondStage = vi.fn().mockRejectedValue(new Error('staging unavailable'));
  const first = {
    staging: { stage: firstStage },
    observability: { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() },
    deploymentId: 'first',
    routeTemplates: new Set<string>(),
    now: () => at,
  };
  const second = {
    staging: { stage: secondStage },
    observability: { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() },
    deploymentId: 'second',
    routeTemplates: new Set<string>(),
    now: () => new Date(at.getTime() + 60_000),
  };
  await recorder.record(ctx, login(), first);
  await recorder.record(ctx, login(), second);
  await recorder.drain(ctx);
  expect(firstStage).toHaveBeenCalledOnce();
  expect(secondStage).toHaveBeenCalledOnce();
  expect(firstStage.mock.calls[0]![1].occurredAt).toBe(at.toISOString());
  expect(secondStage.mock.calls[0]![1].occurredAt).toBe(second.now().toISOString());
  expect(first.observability.log).not.toHaveBeenCalled();
  expect(second.observability.log).toHaveBeenCalledWith({
    level: 'error',
    event: 'audit.failure_event_failed',
  });
  // Same clock and actor still start a new counter for a different deployment.
  const third = {
    ...second,
    now: first.now,
    staging: { stage: vi.fn().mockResolvedValue(undefined) },
  };
  await recorder.record(ctx, login(), third);
  await recorder.drain(ctx);
  expect(third.staging.stage).toHaveBeenCalledOnce();
  await recorder.record(ctx, login(), third);
  await recorder.drain(ctx);
  expect(third.staging.stage).toHaveBeenCalledOnce();
  expect(second.observability.counter).toHaveBeenCalledWith('pb.audit.failure_events_suppressed');
  expect(first.observability.counter).not.toHaveBeenCalled();
});
