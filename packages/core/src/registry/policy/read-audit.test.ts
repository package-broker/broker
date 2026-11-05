import { DbError } from '../../db/errors.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/actions.js';
import { orgContext } from '../../db/port.js';
import { fixedClock, ulid } from '../../ids.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import {
  MAX_REASONS_PER_EVENT,
  createDirectDenialAudit,
  type DirectDenial,
  type PolicyEvidence,
  type PolicyReadAuditSink,
} from './read-audit.js';

const ctx = orgContext('org-a');
const REQUEST = ulid();

function sink(fail = false) {
  const events: AuditEvent[] = [];
  const record = vi.fn<PolicyReadAuditSink['record']>(async (_ctx, batch) => {
    if (fail) throw new Error('disk full: /var/lib/secret');
    events.push(...batch);
  });
  return { events, record, sink: { record } };
}

function audit(target: PolicyReadAuditSink) {
  return createDirectDenialAudit({
    sink: target,
    ids: { ulid },
    clock: fixedClock('2026-11-01T00:00:00.000Z'),
    ctx,
    requestId: REQUEST,
    projectId: 'P',
    principal: { kind: 'service', id: 'svc-1' },
  });
}

const rule = (n: number, reason: PolicyEvidence['reason'] = 'blocked'): PolicyEvidence => ({
  kind: 'rule',
  ruleId: `01J0P00000000000000000R${String(n).padStart(3, '0')}`,
  ruleRevision: 2,
  reason,
});

function denial(evidence: PolicyEvidence[], overrides: Partial<DirectDenial> = {}): DirectDenial {
  return {
    readKind: 'dist',
    ecosystem: 'npm',
    packageKey: 'left-pad',
    versionId: 'V1',
    revision: 3,
    evidence,
    ...overrides,
  };
}

const payload = (event: AuditEvent) =>
  JSON.parse(event.payloadJson) as {
    request_id: string;
    changes: Record<string, { new: unknown }>;
  };

describe('direct-denial audit writer', () => {
  it('persists one bounded policy.read_denied event with identifiers and fixed reasons only', async () => {
    const target = sink();
    await audit(target.sink).record(
      denial([
        rule(1),
        rule(2, 'min_age'),
        { kind: 'plugin', plugin: 'acme-policy', reason: 'restricted' },
      ]),
    );
    expect(target.record).toHaveBeenCalledTimes(1);
    expect(target.record.mock.calls[0]![0]).toBe(ctx);
    const [event] = target.events;
    expect(event).toMatchObject({
      action: 'policy.read_denied',
      actor: { type: 'service_principal', id: 'svc-1' },
      tokenSelector: null,
      sourceIp: null,
      target: { type: 'version', id: 'V1' },
      projectId: 'P',
    });
    expect(payload(event!).request_id).toBe(REQUEST);
    expect(payload(event!).changes).toEqual({
      read_kind: { new: 'dist' },
      ecosystem: { new: 'npm' },
      package_key: { new: 'left-pad' },
      version_id: { new: 'V1' },
      version_revision: { new: 3 },
      reasons: {
        new: [
          'rule:01J0P00000000000000000R001:2:blocked',
          'rule:01J0P00000000000000000R002:2:min_age',
          'plugin:acme-policy:restricted',
        ],
      },
    });
  });

  it('splits more than 32 reasons into chunks without dropping any', async () => {
    const target = sink();
    const evidence = Array.from({ length: 70 }, (_, n) => rule(n));
    await audit(target.sink).record(denial(evidence));
    expect(target.record).toHaveBeenCalledTimes(1);
    const chunks = target.events.map((event) => payload(event).changes.reasons!.new as string[]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32, 32, 6]);
    expect(chunks.flat()).toEqual(
      evidence.map((e) => `rule:${(e as { ruleId: string }).ruleId}:2:blocked`),
    );
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(MAX_REASONS_PER_EVENT);
    for (const event of target.events) {
      expect(new TextEncoder().encode(event.payloadJson).length).toBeLessThan(4096);
    }
    expect(new Set(target.events.map((event) => event.id)).size).toBe(3);
    expect(new Set(target.events.map((event) => JSON.parse(event.payloadJson).op_id)).size).toBe(1);
  });

  it('deduplicates repeated evidence and records each version revision once per request', async () => {
    const target = sink();
    const writer = audit(target.sink);
    await writer.record(denial([rule(1), rule(1)]));
    await writer.record(denial([rule(1)], { readKind: 'tag' }));
    await writer.record(denial([rule(1)], { revision: 4 }));
    expect(target.events).toHaveLength(2);
    expect(payload(target.events[0]!).changes.reasons).toEqual({
      new: ['rule:01J0P00000000000000000R001:2:blocked'],
    });
  });

  it('a persistence failure is the fixed 503 and leaves the denial unrecorded for a retry', async () => {
    const failing = sink(true);
    const writer = audit(failing.sink);
    const error = await writer.record(denial([rule(1)])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryPolicyUnavailableError);
    expect((error as Error).message).toBe('Package policy is unavailable');
    await expect(writer.record(denial([rule(1)]))).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
    expect(failing.record).toHaveBeenCalledTimes(2);
  });

  it('refuses evidence that would not validate instead of writing a weaker event', async () => {
    const target = sink();
    const writer = audit(target.sink);
    for (const bad of [
      denial([]),
      denial([{ kind: 'plugin', plugin: 'Bad Plugin <x>', reason: 'restricted' }]),
      denial([rule(1)], { versionId: 'v1 user@example.com' }),
      denial([rule(1)], { packageKey: 'Not A Key' }),
    ]) {
      await expect(writer.record(bad)).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    }
    expect(target.record).not.toHaveBeenCalled();
  });
});

it('preserves audit backlog refusal for direct denial and retries the unrecorded denial', async () => {
  const target = sink();
  const error = new DbError('backlog_full', 'Audit backlog is full');
  target.record.mockRejectedValueOnce(error);
  const writer = audit(target.sink);
  await expect(writer.record(denial([rule(1)]))).rejects.toBe(error);
  await writer.record(denial([rule(1)]));
  expect(target.record).toHaveBeenCalledTimes(2);
  expect(target.events).toHaveLength(1);
});
