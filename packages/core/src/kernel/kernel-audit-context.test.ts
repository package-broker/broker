import { expect, it, vi } from 'vitest';
import type { AuditSinkContext, AuditSinkDefinition } from '../audit/plugin-api.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from './kernel.js';
import { collectRegistrations } from './registry.js';

it.each(['deployment-one', 'deployment-two', undefined])(
  'binds audit factory contexts to the kernel deployment identity %s',
  async (deploymentId) => {
    const create = vi.fn<AuditSinkDefinition['create']>(() => ({
      deliver: async () => ({ outcome: 'retry', code: 'network' }),
    }));
    const definition: AuditSinkDefinition = {
      id: 'archive',
      kind: 'webhook',
      destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL' },
      activation: 'env',
      custody: 'delivery',
      sourceIp: 'include',
      create,
    };
    const registration = {
      ...collectRegistrations([]),
      audit: { trail: null, sinks: [{ plugin: 'audit', definition }] },
    };
    const clock = fixedClock('2026-10-28T00:00:00Z');
    const kernel = await createKernel({
      plugins: [],
      registration,
      platform: 'node',
      ports: { organizations: { get: async () => null }, clock, ids: { ulid: () => 'id' } },
      resolveOrg: async () => orgContext('current'),
      health: async () => true,
      ...(deploymentId === undefined
        ? {}
        : { observability: { deploymentId, sink: { emit() {} } } }),
    });
    const context: AuditSinkContext = {
      deploymentId: 'caller-supplied',
      runtime: 'docker',
      clock,
      env: () => undefined,
      fetch: async () => ({
        status: 200,
        contentType: 'application/json',
        body: '{}',
        retryAfterMs: null,
      }),
    };
    kernel.registration.audit.sinks[0]!.definition.create(context);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toEqual({
      ...context,
      deploymentId: deploymentId ?? 'unconfigured',
    });
    expect(Object.isFrozen(create.mock.calls[0]![0])).toBe(true);
    expect(context.deploymentId).toBe('caller-supplied');
    expect(registration.audit.sinks[0]!.definition.create).toBe(create);
  },
);
