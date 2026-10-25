import { describe, expect, it, vi } from 'vitest';
import { displayName, packageKey } from '../../catalogue/names.js';
import type { CatalogueReader } from '../../db/catalogue.js';
import { orgContext } from '../../db/port.js';
import type {
  AuthorizedNpmAudit,
  NpmAuditAuthorizer,
  NpmAuditTuple,
} from '../../db/vulnerability.js';
import { createPolicyFetch, UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import type { FetchLike } from '../../platform/tracing.js';
import { forwardNpmAudit, serializeNpmAudit, type NpmAuditEntries } from './audit.js';

const MIB = 1024 * 1024;
const ctx = orgContext('org-a');
const CONTROL: NpmAuditEntries = [['pub', ['1.0.0']]];
const ERROR = '{"error":"Upstream request failed","code":"upstream_error","requestId":"request"}';
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };
const SENTINEL = '@Private/Sentinel-T866e';
const advisory = {
  id: 1,
  title: 'Public advisory',
  severity: 'high',
  vulnerable_versions: '<2.0.0',
};

function grant(tuples: readonly NpmAuditTuple[], orgId = ctx.orgId): AuthorizedNpmAudit {
  return { orgId, tuples } as AuthorizedNpmAudit;
}

function setup(attached = true) {
  const classifyWinners = vi.fn<CatalogueReader['classifyWinners']>(async (_ctx, query) =>
    query.keys.map((key) => ({
      key,
      winner:
        key === packageKey(SENTINEL, { ecosystem: 'npm', legacyCase: true })
          ? { sourceId: 'private-source', sourceType: 'npm_registry' as const }
          : key === 'b-only'
            ? null
            : { sourceId: 'proxy', sourceType: 'npmjs_proxy' as const },
    })),
  );
  const hasAttachedProxy = vi.fn(async () => attached);
  const authorizeNpmAudit = vi.fn<NpmAuditAuthorizer['authorizeNpmAudit']>(async (_ctx, refs) =>
    grant(
      refs
        .filter(({ key, version }) => ['pub', '!legacy'].includes(key) && version === '1.0.0')
        .map(({ key, version }) => ({ name: displayName(key), version })),
    ),
  );
  const policyFetch = vi.fn<PolicyFetch>(async () => ({
    status: 200,
    headers: new Headers({
      'content-type': 'text/html',
      'set-cookie': 'upstream=secret',
      'x-upstream': SENTINEL,
    }),
    body: new Response(JSON.stringify({ pub: [advisory] })).body,
  }));
  const log = vi.fn();
  const send = (entries: NpmAuditEntries = CONTROL, signal?: AbortSignal) =>
    forwardNpmAudit(
      entries,
      new Request('https://broker.test/project/npm/-/npm/v1/security/advisories/bulk', {
        method: 'POST',
        body: 'unread request body',
        signal: signal ?? null,
        headers: Object.fromEntries(
          [
            'authorization',
            'cookie',
            'npm-session',
            'npm-command',
            'npm-auth-type',
            'referer',
            'user-agent',
            'x-forwarded-for',
            'traceparent',
            'baggage',
          ].map((name) => [name, SENTINEL]),
        ),
      }),
      ctx,
      'project',
      'request',
      { classifyWinners, hasAttachedProxy, authorizeNpmAudit, policyFetch, observability: { log } },
    );
  return { send, classifyWinners, hasAttachedProxy, authorizeNpmAudit, policyFetch, log };
}

function sentBody(s: ReturnType<typeof setup>) {
  return new TextDecoder().decode(s.policyFetch.mock.calls[0]![0].body);
}

function expectEvent(
  s: ReturnType<typeof setup>,
  reason: string,
  forwarded = 0,
  advisories = 0,
  requested = 1,
) {
  expect(s.log).toHaveBeenCalledTimes(1);
  expect(s.log.mock.calls[0]![0]).toEqual({
    level: 'info',
    event: 'registry.npm_audit',
    outcome:
      reason === 'ok' || reason === 'empty'
        ? 'success'
        : reason === 'aborted'
          ? 'aborted'
          : 'error',
    reason_code: reason,
    requested_names: requested,
    forwarded_names: forwarded,
    advisories,
    unexpected_keys: 0,
    dropped_advisories: 0,
  });
}

describe('npm audit forwarder', () => {
  it('oracle 1: forwards the exact public control body once from a fresh grant', async () => {
    const s = setup();
    const response = await s.send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pub: [advisory] });
    expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
    expect(s.classifyWinners).toHaveBeenCalledExactlyOnceWith(ctx, {
      projectId: 'project',
      ecosystem: 'npm',
      keys: ['pub'],
    });
    expect(s.hasAttachedProxy).toHaveBeenCalledExactlyOnceWith(ctx, 'project', 'npm');
    expect(s.authorizeNpmAudit).toHaveBeenCalledExactlyOnceWith(ctx, [
      { sourceId: 'proxy', key: 'pub', version: '1.0.0' },
    ]);
    expect(s.policyFetch).toHaveBeenCalledOnce();
    expect(sentBody(s)).toBe('{"pub":["1.0.0"]}');
    expect(s.policyFetch.mock.calls[0]![0]).toEqual({
      url: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      method: 'POST',
      purpose: 'api',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"pub":["1.0.0"]}'),
      destinations: ['https://registry.npmjs.org'],
      redirects: 'error',
      maxBytes: 4 * MIB,
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    });
    expectEvent(s, 'ok', 1, 1);
    await s.send();
    expect(s.authorizeNpmAudit).toHaveBeenCalledTimes(2);
    expect(s.policyFetch).toHaveBeenCalledTimes(2);
  });

  it('answers 501 unsupported without an attached proxy and never classifies or fetches', async () => {
    const s = setup(false);
    const response = await s.send();
    expect(response.status).toBe(501);
    expect(await response.text()).toBe(
      '{"error":"npm audit requires an npmjs.org proxy source in this project","code":"unsupported","requestId":"request"}',
    );
    expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
    expect(s.classifyWinners).not.toHaveBeenCalled();
    expect(s.authorizeNpmAudit).not.toHaveBeenCalled();
    expect(s.policyFetch).not.toHaveBeenCalled();
    expectEvent(s, 'unsupported');
  });

  it.each<{ label: string; entries: NpmAuditEntries }>([
    { label: 'empty', entries: [] },
    { label: 'invisible', entries: [['b-only', ['1.0.0']]] },
    { label: 'private winner', entries: [[SENTINEL, ['1.0.0']]] },
    { label: 'vetoed', entries: [['shadow', ['1.0.0']]] },
    { label: 'unstored version', entries: [['pub', ['9.9.9']]] },
    { label: 'unstored name', entries: [['nonexistent', ['1.0.0']]] },
    { label: 'quarantined', entries: [['pub', ['0.9.0']]] },
  ])('oracle 9: $label input answers locally', async ({ label, entries }) => {
    const s = setup();
    const response = await s.send(entries);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
    expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
    expect(s.authorizeNpmAudit).toHaveBeenCalledOnce();
    if (['empty', 'invisible', 'private winner'].includes(label)) {
      expect(s.authorizeNpmAudit).toHaveBeenCalledExactlyOnceWith(ctx, []);
    }
    expect(s.policyFetch).not.toHaveBeenCalled();
    expectEvent(s, 'empty', 0, 0, label === 'empty' ? 0 : 1);
  });

  it('oracle 5: request-only, unstored and quarantined pairs cannot enter the granted body', async () => {
    const s = setup();
    const response = await s.send([
      ['pub', ['1.0.0', '9.9.9', '0.9.0']],
      ['nonexistent', ['1.0.0']],
    ]);
    expect(response.status).toBe(200);
    expect(sentBody(s)).toBe('{"pub":["1.0.0"]}');
    expect(s.authorizeNpmAudit.mock.calls[0]![1]).toHaveLength(4);
  });

  it('merges duplicate legacy keys, drops invalid/overlong versions and re-keys the sanitized result', async () => {
    const s = setup();
    s.policyFetch.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({ Legacy: [advisory] })).body,
    });
    const response = await s.send([
      ['Legacy', ['1.0.0', '1.0.0', '^1.0.0', '1.0.0+build', '1.0.0-' + 'a'.repeat(200)]],
      ['Legacy', ['1.0.0']],
      ['legacy', ['1.0.0']],
    ]);
    expect(s.classifyWinners.mock.calls[0]![1].keys).toEqual(['!legacy', 'legacy']);
    expect(s.authorizeNpmAudit.mock.calls[0]![1]).toEqual([
      { sourceId: 'proxy', key: '!legacy', version: '1.0.0' },
      { sourceId: 'proxy', key: 'legacy', version: '1.0.0' },
    ]);
    expect(sentBody(s)).toBe('{"Legacy":["1.0.0"]}');
    expect(await response.json()).toEqual({ Legacy: [advisory] });
  });

  it('classifies 1000 names in batches of 200 and authorizes the combined refs once', async () => {
    const s = setup();
    await s.send(Array.from({ length: 1000 }, (_, i) => [`p${i}`, ['1.0.0']]));
    expect(s.classifyWinners).toHaveBeenCalledTimes(5);
    for (const [org, query] of s.classifyWinners.mock.calls) {
      expect(org).toBe(ctx);
      expect(query.keys).toHaveLength(200);
      expect(query.projectId).toBe('project');
    }
    expect(s.authorizeNpmAudit).toHaveBeenCalledOnce();
    expect(s.authorizeNpmAudit.mock.calls[0]![1]).toHaveLength(1000);
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it('does not authorize a partial set when a later classification batch fails', async () => {
    const s = setup();
    s.classifyWinners
      .mockResolvedValueOnce([
        { key: 'pub', winner: { sourceId: 'proxy', sourceType: 'npmjs_proxy' } },
      ])
      .mockRejectedValueOnce(new Error(SENTINEL));
    const response = await s.send([
      ...CONTROL,
      ...Array.from({ length: 200 }, (_, i) => [`p${i}`, ['1.0.0']] as const),
    ]);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(ERROR);
    expect(s.classifyWinners).toHaveBeenCalledTimes(2);
    expect(s.authorizeNpmAudit).not.toHaveBeenCalled();
    expect(s.policyFetch).not.toHaveBeenCalled();
    expectEvent(s, 'verify_failed', 0, 0, 201);
  });

  it('keeps a valid 200-byte version and silently drops a 201-byte version', async () => {
    const s = setup();
    const version = '1.0.0-' + 'a'.repeat(194);
    await s.send([['pub', [version, version + 'a']]]);
    expect(s.authorizeNpmAudit).toHaveBeenCalledExactlyOnceWith(ctx, [
      { sourceId: 'proxy', key: 'pub', version },
    ]);
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'enforces the 4 MiB streamed response boundary (overflow: %s)',
    async (overflow) => {
      const s = setup();
      const cancel = vi.fn();
      let pulls = 0;
      s.policyFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        body: new ReadableStream(
          {
            pull(controller) {
              pulls++;
              if (pulls === 1)
                controller.enqueue(new TextEncoder().encode('{}' + ' '.repeat(4 * MIB - 2)));
              else if (overflow && pulls === 2) controller.enqueue(new Uint8Array([32]));
              else controller.close();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      });
      const response = await s.send();
      expect(response.status).toBe(overflow ? 502 : 200);
      expect(await response.text()).toBe(overflow ? ERROR : '{}');
      expect(cancel).toHaveBeenCalledTimes(overflow ? 1 : 0);
      expect(pulls).toBeLessThanOrEqual(3);
      expectEvent(s, overflow ? 'upstream_protocol' : 'ok', 1);
    },
  );

  it('serializes only catalogue tuples, with sorted, deduplicated versions', () => {
    expect(
      serializeNpmAudit(
        grant([
          { name: 'pub', version: '2.0.0' },
          { name: 'pub', version: '1.0.0' },
          { name: 'pub', version: '2.0.0' },
        ]),
      ),
    ).toBe('{"pub":["1.0.0","2.0.0"]}');
  });

  it('oracle 17: serializer requires the branded grant at the type boundary', () => {
    // @ts-expect-error Raw tuples have not been authorized.
    const raw: (value: readonly NpmAuditTuple[]) => string = serializeNpmAudit;
    // @ts-expect-error A structural grant lacks the private brand.
    const forged: (value: { orgId: typeof ctx.orgId; tuples: readonly NpmAuditTuple[] }) => string =
      serializeNpmAudit;
    expect(raw).toBe(serializeNpmAudit);
    expect(forged).toBe(serializeNpmAudit);
  });

  it.each([
    ['attachment', 'db sentinel', 'verify_failed'],
    ['classification', 'db sentinel', 'verify_failed'],
    ['authorization', 'db sentinel', 'verify_failed'],
    ['authorization', 'vulnerability evidence unavailable', 'verify_overflow'],
    ['authorization', 'vulnerability snapshot malformed', 'verify_overflow'],
  ])('oracle 10: fails closed on %s / %s', async (stage, message, reason) => {
    const s = setup();
    const port =
      stage === 'attachment'
        ? s.hasAttachedProxy
        : stage === 'classification'
          ? s.classifyWinners
          : s.authorizeNpmAudit;
    port.mockRejectedValueOnce(new Error(message));
    const response = await s.send();
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(ERROR);
    expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
    expect(s.policyFetch).not.toHaveBeenCalled();
    expectEvent(s, reason);
  });

  it('refuses a grant from another organization', async () => {
    const s = setup();
    s.authorizeNpmAudit.mockResolvedValueOnce(
      grant([{ name: 'pub', version: '1.0.0' }], orgContext('org-b').orgId),
    );
    const response = await s.send();
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(ERROR);
    expect(s.policyFetch).not.toHaveBeenCalled();
    expectEvent(s, 'verify_failed');
  });

  it('oracle 11: drops unexpected names/fields and every upstream header', async () => {
    const s = setup();
    s.policyFetch.mockResolvedValueOnce({
      status: 201,
      headers: new Headers({
        'set-cookie': SENTINEL,
        'x-upstream': SENTINEL,
        etag: SENTINEL,
        'content-type': 'text/html',
      }),
      body: new Response(
        JSON.stringify({
          pub: [{ ...advisory, secret: SENTINEL }],
          [SENTINEL]: [{ id: SENTINEL }],
        }),
      ).body,
    });
    const response = await s.send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pub: [advisory] });
    expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
    expect(s.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'registry.npm_audit',
      outcome: 'success',
      reason_code: 'ok',
      requested_names: 1,
      forwarded_names: 1,
      advisories: 1,
      unexpected_keys: 1,
      dropped_advisories: 0,
    });
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(SENTINEL);
  });

  it.each([
    ['network', 'upstream_unavailable'],
    ['timeout', 'upstream_unavailable'],
    ['redirect', 'upstream_unavailable'],
    ['503', 'upstream_unavailable'],
    ['429', 'upstream_rate_limited'],
    ['404', 'upstream_status'],
    ['html', 'upstream_protocol'],
    ['json', 'upstream_protocol'],
    ['array', 'upstream_protocol'],
    ['size', 'upstream_protocol'],
    ['stream', 'upstream_protocol'],
    ['utf8', 'upstream_protocol'],
    ['advisory', 'upstream_protocol'],
    ['204', 'upstream_protocol'],
    ['205', 'upstream_protocol'],
  ])(
    'oracle 11: upstream %s returns identical error bytes without retry',
    async (failure, reason) => {
      const s = setup();
      s.policyFetch.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error(`${SENTINEL}?token=secret`);
        if (failure === 'timeout' || failure === 'redirect')
          throw new UpstreamError(
            failure === 'timeout' ? 'timeout' : 'refused',
            undefined,
            SENTINEL,
          );
        const text =
          failure === 'html'
            ? `<html>${SENTINEL}</html>`
            : failure === 'json'
              ? '{'
              : failure === 'array'
                ? '[]'
                : failure === 'size'
                  ? ' '.repeat(5 * MIB)
                  : failure === 'advisory'
                    ? '{"pub":[{"id":{}}]}'
                    : '{}';
        return {
          status: /^\d+$/.test(failure) ? Number(failure) : 200,
          headers: new Headers({ 'retry-after': '100', 'x-upstream': SENTINEL }),
          body:
            failure === '204' || failure === '205'
              ? null
              : failure === 'stream'
                ? new ReadableStream({
                    start(c) {
                      c.error(new Error(SENTINEL));
                    },
                  })
                : new Response(failure === 'utf8' ? new Uint8Array([255]) : text).body,
        };
      });
      const response = await s.send([...CONTROL, [SENTINEL, ['1.0.0']]]);
      expect(response.status).toBe(502);
      const diagnostics = await response.text();
      expect(diagnostics).toBe(ERROR);
      expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
      expect(s.policyFetch).toHaveBeenCalledOnce();
      expectEvent(s, reason, 1, 0, 2);
      const captured = JSON.stringify([s.log.mock.calls, diagnostics, [...response.headers]]);
      for (const sentinel of [
        SENTINEL,
        SENTINEL.toLowerCase(),
        encodeURIComponent(SENTINEL),
        JSON.stringify(SENTINEL).slice(1, -1),
      ])
        expect(captured).not.toContain(sentinel);
      expect(captured).not.toContain('https://registry.npmjs.org');
      expect(sentBody(s)).toBe('{"pub":["1.0.0"]}');
    },
  );

  it.each(['redirect', 'declared-size', 'network', '429', '503'])(
    'enforces the policy transport contract for %s',
    async (failure) => {
      const s = setup();
      const transport = vi.fn(async () => {
        if (failure === 'network') throw new Error(SENTINEL);
        if (failure === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://example.test/?token=secret' },
          });
        if (failure === 'declared-size')
          return new Response('{}', { headers: { 'content-length': String(4 * MIB + 1) } });
        return new Response(SENTINEL, {
          status: Number(failure),
          headers: { 'retry-after': '10' },
        });
      });
      s.policyFetch.mockImplementation(
        createPolicyFetch({
          policy: createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] }),
          userAgent: 'broker-default',
          fetchImpl: transport,
        }),
      );
      const response = await s.send();
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(ERROR);
      expect(Object.fromEntries(response.headers)).toEqual(HEADERS);
      expect(transport).toHaveBeenCalledOnce();
      expectEvent(
        s,
        failure === 'declared-size'
          ? 'upstream_protocol'
          : failure === '429'
            ? 'upstream_rate_limited'
            : 'upstream_unavailable',
        1,
      );
      expect(JSON.stringify(s.log.mock.calls)).not.toContain(SENTINEL);
    },
  );

  it('oracle 16: transport receives only content-type and the configured default user agent', async () => {
    const s = setup();
    const transport = vi.fn<FetchLike>(async () => Response.json({ pub: [advisory] }));
    s.policyFetch.mockImplementation(
      createPolicyFetch({
        policy: createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] }),
        userAgent: 'broker-default',
        fetchImpl: transport,
      }),
    );
    expect((await s.send()).status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      'content-type': 'application/json',
      'user-agent': 'broker-default',
    });
    expect(init?.method).toBe('POST');
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"pub":["1.0.0"]}');
    expect(init?.redirect).toBe('manual');
  });

  it.each(['before', 'verification', 'transport'])(
    'honors client abort %s without sending a response',
    async (stage) => {
      const s = setup();
      const controller = new AbortController();
      if (stage === 'before') controller.abort(SENTINEL);
      if (stage === 'verification')
        s.authorizeNpmAudit.mockImplementationOnce(async () => {
          controller.abort(SENTINEL);
          return grant([{ name: 'pub', version: '1.0.0' }]);
        });
      if (stage === 'transport')
        s.policyFetch.mockImplementationOnce(async ({ signal }) => {
          expect(signal?.aborted).toBe(false);
          controller.abort(SENTINEL);
          expect(signal?.aborted).toBe(true);
          throw new Error(SENTINEL);
        });
      await expect(s.send(CONTROL, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Audit request aborted',
      });
      expect(s.policyFetch).toHaveBeenCalledTimes(stage === 'transport' ? 1 : 0);
      expectEvent(s, 'aborted', stage === 'transport' ? 1 : 0);
      expect(JSON.stringify(s.log.mock.calls)).not.toContain(SENTINEL);
    },
  );
});
