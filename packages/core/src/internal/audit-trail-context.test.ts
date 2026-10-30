import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { definePlugin, type AuditTrailContext, type AuditBatchV1 } from '../plugin.js';
import { resolveAuditDestination } from '../audit/sinks/transport.js';
import { createAuditTrailContext, type AuditTrailServices } from './audit-trail-context.js';

function services(): AuditTrailServices {
  return {
    journal: {
      list: vi.fn(async () => ({ items: [], next: null })),
      head: vi.fn(async (org) => ({
        chainId: `chain-${org.orgId}`,
        epoch: 1,
        headSeq: 0,
        headHash: '0'.repeat(64),
        boundarySeq: 0,
        boundaryPrevHash: '0'.repeat(64),
        pendingCount: 0,
        verification: null,
      })),
    },
    requestVerification: vi.fn(async () => {}),
  };
}

describe('organization-bound audit composition', () => {
  it('keeps reads and verification bound even when callers supply another context', async () => {
    const source = services();
    const current = orgContext('current');
    const other = orgContext('other');
    const context = createAuditTrailContext(current, true, source);
    const query = { projectId: null, limit: 10 };
    await context.journal.list(query);
    // @ts-expect-error JavaScript callers can supply ignored arguments, never authority.
    await context.journal.head(other);
    // @ts-expect-error Verification also ignores caller-supplied organizations.
    await context.requestVerification(other);
    expect(source.journal.list).toHaveBeenCalledWith(current, query);
    expect(source.journal.head).toHaveBeenCalledWith(current);
    expect(source.requestVerification).toHaveBeenCalledWith(current);
    expect(await createAuditTrailContext(other, true, source).journal.head()).toMatchObject({
      chainId: 'chain-other',
    });
    expect(await context.journal.head()).toMatchObject({ chainId: 'chain-current' });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.journal)).toBe(true);
  });

  it('copies only own query data into a frozen null-prototype snapshot', async () => {
    const source = services();
    const org = orgContext('current');
    const query = { projectId: null, actor: 'actor', action: 'action', afterSeq: 0, limit: 10 };
    await createAuditTrailContext(org, true, source).journal.list(query);
    const copy = vi.mocked(source.journal.list).mock.calls[0]![1];
    expect(copy).toEqual(query);
    expect(copy).not.toBe(query);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.isFrozen(copy)).toBe(true);
    query.limit = 20;
    expect(copy.limit).toBe(10);
  });

  it('rejects query getters without executing them', async () => {
    const source = services();
    const get = vi.fn(() => 10);
    const query = Object.defineProperty({ projectId: null }, 'limit', { get });
    await expect(
      createAuditTrailContext(orgContext('current'), true, source).journal.list(query as never),
    ).rejects.toThrow('Invalid audit journal query');
    expect(get).not.toHaveBeenCalled();
    expect(source.journal.list).not.toHaveBeenCalled();
  });

  it('returns a rejected promise instead of throwing synchronously', () => {
    const source = services();
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = createAuditTrailContext(orgContext('current'), true, source).journal.list(
        null as never,
      );
    }).not.toThrow();
    return expect(result).rejects.toThrow(TypeError);
  });

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)(
    'maps a %s Proxy trap error to the fixed TypeError',
    async (trap) => {
      const source = services();
      const secret = new Error('trap secret');
      const query = new Proxy(
        { projectId: null, limit: 10 },
        {
          [trap]: () => {
            throw secret;
          },
        },
      );
      const rejection = createAuditTrailContext(orgContext('current'), true, source).journal.list(
        query,
      );
      await expect(rejection).rejects.toThrow(new TypeError('Invalid audit journal query'));
      await expect(rejection).rejects.not.toBe(secret);
      expect(source.journal.list).not.toHaveBeenCalled();
    },
  );

  it('maps a revoked Proxy to the fixed TypeError', async () => {
    const source = services();
    const { proxy, revoke } = Proxy.revocable({ projectId: null, limit: 10 }, {});
    revoke();
    await expect(
      createAuditTrailContext(orgContext('current'), true, source).journal.list(proxy),
    ).rejects.toThrow(new TypeError('Invalid audit journal query'));
    expect(source.journal.list).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: null, limit: 10, orgId: 'other' },
    { projectId: null, limit: 10, [Symbol('extra')]: true },
    Object.create({ projectId: null, limit: 10 }) as unknown,
    Object.assign(Object.create({ orgId: 'other' }) as object, { projectId: null, limit: 10 }),
    { projectId: 1, limit: 10 },
    { projectId: null, limit: '10' },
    { projectId: null, limit: 10, actor: 1 },
    { projectId: null, limit: 10, action: null },
    { projectId: null, limit: 10, afterSeq: NaN },
    { projectId: null, limit: 10, afterSeq: -1 },
    { projectId: null, limit: 0 },
    { projectId: null },
    { limit: 10 },
    null,
  ])('rejects extra, inherited or ill-typed query fields (%#)', async (query) => {
    const source = services();
    await expect(
      createAuditTrailContext(orgContext('current'), true, source).journal.list(query as never),
    ).rejects.toThrow('Invalid audit journal query');
    expect(source.journal.list).not.toHaveBeenCalled();
  });

  it('registers trail and sink, binds the journal and delivers using a core-resolved transport', async () => {
    vi.resetModules();
    vi.doMock('../kernel/registry-audit.js', async (original) => ({
      ...(await original<typeof import('../kernel/registry-audit.js')>()),
      AUDIT_PLUGINS_AVAILABLE: true,
    }));
    try {
      const { collectRegistrations } = await import('../kernel/registry.js');
      let trailContext: AuditTrailContext | undefined;
      const registration = collectRegistrations([
        definePlugin({
          id: 'audit',
          package: '@test/audit',
          platforms: ['node'],
          apiVersion: 4,
          binds: ['audit-trail'],
          auditTrail: {
            create: (ctx) => {
              trailContext = ctx;
              return {};
            },
          },
          auditSinks: [
            {
              id: 'archive',
              kind: 'webhook',
              activation: 'env',
              custody: 'durable',
              sourceIp: 'omit',
              destination: { protocol: 'https-json', urlEnv: 'PB_AUDIT_WEBHOOK_URL' },
              create: (ctx) => ({
                deliver: async (batch, signal) => {
                  const response = await ctx.fetch({
                    body: JSON.stringify(batch),
                    contentType: 'application/json',
                    signal,
                  });
                  expect(response.status).toBe(200);
                  return {
                    outcome: 'accepted',
                    chainId: batch.chainId,
                    epoch: batch.epoch,
                    throughSeq: batch.throughSeq,
                    throughHash: batch.throughHash,
                  };
                },
              }),
            },
          ],
        }),
      ]);
      const org = orgContext('current');
      const source = services();
      registration.audit.trail!.definition.create(createAuditTrailContext(org, true, source));
      const head = await trailContext!.journal.head();
      await trailContext!.journal.list({ projectId: null, limit: 10 });
      await trailContext!.requestVerification();
      expect(source.journal.head).toHaveBeenCalledWith(org);
      expect(source.requestVerification).toHaveBeenCalledWith(org);
      const definition = registration.audit.sinks[0]!.definition;
      const values: Record<string, string> = {
        PB_AUDIT_WEBHOOK_URL: 'https://receiver.example/audit',
        PB_AUDIT_WEBHOOK_HEADERS: 'authorization=Bearer%20test',
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
      const transport = await resolveAuditDestination({
        ...definition,
        runtime: 'docker',
        env: (name) => values[name],
        fetchImpl,
      });
      expect(transport).not.toBeNull();
      const sink = definition.create({
        deploymentId: 'test-deployment',
        runtime: 'docker',
        fetch: transport!.fetch,
        env: () => undefined,
        clock: fixedClock('2026-10-28T00:00:00Z'),
      });
      const batch: AuditBatchV1 = {
        v: 1,
        orgId: org.orgId,
        chainId: head.chainId,
        epoch: head.epoch,
        records: [],
        throughSeq: head.headSeq,
        throughHash: head.headHash,
      };
      expect(await sink.deliver(batch, new AbortController().signal)).toMatchObject({
        outcome: 'accepted',
        chainId: 'chain-current',
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(values.PB_AUDIT_WEBHOOK_URL);
      expect(request?.headers).toMatchObject({ authorization: 'Bearer test' });
    } finally {
      vi.doUnmock('../kernel/registry-audit.js');
      vi.resetModules();
    }
  });
});
