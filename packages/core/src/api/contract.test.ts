import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import { runApiContract } from './contract.js';
import { generateOpenApi } from './openapi.js';
import { apiRoute, defineApi } from './route.js';
import { AUTH_API } from './auth-schemas.js';

const sentinel = 'PRIVATE-SAMPLE-SENTINEL';
const result = z.strictObject({ ok: z.boolean() });
const specs = [
  defineApi({
    method: 'GET',
    path: '/_pb/status',
    permission: null,
    api: {
      operationId: 'status',
      summary: 'Status',
      tags: ['fixture'],
      responses: { 200: result },
    },
  }),
  defineApi({
    method: 'PUT',
    path: '/_pb/items/:id',
    permission: null,
    api: {
      operationId: 'update',
      summary: 'Update',
      tags: ['fixture'],
      params: z.strictObject({ id: z.string() }),
      query: z.strictObject({ mode: z.string() }),
      body: z.strictObject({ name: z.string(), enabled: z.boolean(), note: z.string().optional() }),
      responses: { 200: result },
    },
  }),
  defineApi({
    method: 'DELETE',
    path: '/_pb/items/:id',
    permission: null,
    api: { operationId: 'remove', summary: 'Remove', tags: ['fixture'], responses: { 204: null } },
  }),
];
const samples = {
  status: {},
  update: {
    params: { id: sentinel },
    query: { mode: 'all' },
    body: { name: sentinel, enabled: true },
    headers: { 'x-fixture': 'yes' },
  },
  remove: { params: { id: sentinel } },
};
function document() {
  return generateOpenApi(specs, { title: 'Test', version: '1' });
}
async function kernelCall() {
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    resolveOrg: () => Promise.resolve(orgContext('org-fixture')),
    health: () => Promise.resolve(true),
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-15T00:00:00.000Z'),
      ids: { ulid: () => 'fixture' },
    },
    coreRoutes: specs.map((spec) =>
      apiRoute(spec, () =>
        Promise.resolve(
          spec.method === 'DELETE' ? { status: 204 } : { status: 200, body: { ok: true } },
        ),
      ),
    ),
    log: () => undefined,
  });
  return (request: Request) => kernel.fetch(request);
}
const finding = (check: string, operationId = 'update') =>
  expect.objectContaining({ check, operationId });

describe('runApiContract', () => {
  it('accepts three routes on an in-memory kernel and preserves samples', async () => {
    const before = JSON.stringify(samples);
    const call = vi.fn(await kernelCall());
    expect(await runApiContract({ specs, document: document(), samples, call })).toEqual([]);
    expect(call).toHaveBeenCalledTimes(6);
    const request = call.mock.calls.find(([r]) => r.method === 'PUT')![0];
    expect(new URL(request.url).pathname).toBe(`/_pb/items/${sentinel}`);
    expect(new URL(request.url).searchParams.get('mode')).toBe('all');
    expect(request.headers.get('x-fixture')).toBe('yes');
    expect(JSON.stringify(samples)).toBe(before);
  });

  it('detects a removed operation', async () => {
    const doc = document();
    delete doc.paths['/_pb/status']!.get;
    expect(
      await runApiContract({ specs, document: doc, samples, call: await kernelCall() }),
    ).toContainEqual(finding('missing_operation', 'status'));
  });
  it('detects an operation at the wrong method', async () => {
    const doc = document();
    const path = doc.paths['/_pb/status']!;
    path.post = path.get!;
    delete path.get;
    expect(
      await runApiContract({ specs, document: doc, samples, call: await kernelCall() }),
    ).toContainEqual(finding('missing_operation', 'status'));
  });
  it('detects an operation at the wrong path', async () => {
    const doc = document();
    doc.paths['/_pb/elsewhere'] = doc.paths['/_pb/status']!;
    delete doc.paths['/_pb/status'];
    expect(
      await runApiContract({ specs, document: doc, samples, call: await kernelCall() }),
    ).toContainEqual(finding('missing_operation', 'status'));
  });
  it('detects a changed operationId', async () => {
    const doc = document();
    doc.paths['/_pb/status']!.get!.operationId = 'other';
    expect(
      await runApiContract({ specs, document: doc, samples, call: await kernelCall() }),
    ).toContainEqual(finding('missing_operation', 'status'));
  });
  it('detects acceptance of unknown properties', async () => {
    const real = await kernelCall();
    const call = async (request: Request) => {
      if (request.method === 'PUT') {
        const body = (await request.clone().json()) as Record<string, unknown>;
        if ('name' in body && 'enabled' in body) return Response.json({ ok: true });
      }
      return real(request);
    };
    expect(await runApiContract({ specs, document: document(), samples, call })).toContainEqual(
      finding('unknown_property_accepted'),
    );
  });
  it('detects acceptance of each missing required field', async () => {
    const real = await kernelCall();
    const call = (request: Request) =>
      request.method === 'PUT' ? Promise.resolve(Response.json({ ok: true })) : real(request);
    const findings = await runApiContract({ specs, document: document(), samples, call });
    expect(findings.filter((f) => f.check === 'required_accepted')).toEqual([
      { check: 'required_accepted', operationId: 'update', location: '/body/name' },
      { check: 'required_accepted', operationId: 'update', location: '/body/enabled' },
    ]);
  });
  it.each([
    [
      'finite-key record',
      z.record(z.enum(['name', 'tag']), z.string()),
      { name: sentinel, tag: 'tag' },
      ['name', 'tag'],
    ],
    [
      'discriminated union',
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('named'), name: z.string(), note: z.string().optional() }),
        z.strictObject({ kind: z.literal('other'), count: z.number() }),
      ]),
      { kind: 'named', name: sentinel },
      ['kind', 'name'],
    ],
    [
      'intersection',
      z.intersection(
        z.strictObject({ kind: z.literal('named'), name: z.string(), tag: z.string().optional() }),
        z.strictObject({ kind: z.literal('named'), name: z.string().optional(), tag: z.string() }),
      ),
      { kind: 'named', name: sentinel, tag: 'tag' },
      ['kind', 'name', 'tag'],
    ],
    [
      'nullable object',
      z.strictObject({ name: z.string() }).nullable(),
      { name: sentinel },
      ['name'],
    ],
  ] as const)('detects missing required fields in a %s body', async (_, body, sample, fields) => {
    const spec = defineApi({
      method: 'POST',
      path: '/_pb/composed',
      permission: null,
      api: {
        operationId: 'composed',
        summary: 'Composed',
        tags: ['fixture'],
        body,
        responses: { 200: result },
      },
    });
    const findings = await runApiContract({
      specs: [spec],
      document: generateOpenApi([spec], { title: 'T', version: '1' }),
      samples: { composed: { body: sample } },
      call: async (request) => {
        const value = (await request.json()) as Record<string, unknown>;
        return Object.hasOwn(value, '__contract_unknown')
          ? new Response(null, { status: 400 })
          : Response.json({ ok: true });
      },
    });
    expect(findings).toEqual(
      fields.map((field) => ({
        check: 'required_accepted',
        operationId: 'composed',
        location: `/body/${field}`,
      })),
    );
  });

  it('does not report required fields accepted by an overlapping union', async () => {
    const body = z.union([
      z.strictObject({ name: z.string(), tag: z.string().optional() }),
      z.strictObject({ name: z.string().optional(), tag: z.string() }),
    ]);
    const spec = defineApi({
      method: 'POST',
      path: '/_pb/overlapping',
      permission: null,
      api: {
        operationId: 'overlapping',
        summary: 'Overlapping',
        tags: ['fixture'],
        body,
        responses: { 200: result },
      },
    });
    const sample = { name: sentinel, tag: 'tag' };
    expect(body.safeParse(sample).success).toBe(true);
    expect(body.safeParse({ name: sentinel }).success).toBe(true);
    expect(body.safeParse({ tag: 'tag' }).success).toBe(true);
    expect(
      await runApiContract({
        specs: [spec],
        document: generateOpenApi([spec], { title: 'T', version: '1' }),
        samples: { overlapping: { body: sample } },
        call: async (request) =>
          body.safeParse(await request.json()).success
            ? Response.json({ ok: true })
            : new Response(null, { status: 400 }),
      }),
    ).toEqual([]);
  });

  it.each([false, true])(
    'checks unknown probes against the complete union schema (record branch: %s)',
    async (withRecord) => {
      const branches = [
        z.strictObject({ name: z.string() }),
        z.strictObject({ name: z.string(), __contract_unknown: z.boolean() }),
      ] as const;
      const body = withRecord
        ? z.union([...branches, z.record(z.string(), z.boolean())])
        : z.union(branches);
      const spec = defineApi({
        method: 'POST',
        path: '/_pb/unknown-union',
        permission: null,
        api: {
          operationId: 'unknownUnion',
          summary: 'Unknown union',
          tags: ['fixture'],
          body,
          responses: { 200: result },
        },
      });
      const seen: unknown[] = [];
      expect(
        await runApiContract({
          specs: [spec],
          document: generateOpenApi([spec], { title: 'T', version: '1' }),
          samples: { unknownUnion: { body: { name: sentinel } } },
          call: async (request) => {
            const value: unknown = await request.json();
            seen.push(value);
            return body.safeParse(value).success
              ? Response.json({ ok: true })
              : new Response(null, { status: 400 });
          },
        }),
      ).toEqual([]);
      expect(seen).toEqual([
        ...(withRecord ? [] : [{}]),
        { name: sentinel, __contract_unknown_: true },
        { name: sentinel },
      ]);
    },
  );

  it('does not send an unknown-property probe accepted by the body schema', async () => {
    const body = z.record(z.string(), z.boolean());
    const spec = defineApi({
      method: 'POST',
      path: '/_pb/record',
      permission: null,
      api: {
        operationId: 'record',
        summary: 'Record',
        tags: ['fixture'],
        body,
        responses: { 200: result },
      },
    });
    const call = vi.fn(async (request: Request) =>
      body.safeParse(await request.json()).success
        ? Response.json({ ok: true })
        : new Response(null, { status: 400 }),
    );
    expect(
      await runApiContract({
        specs: [spec],
        document: generateOpenApi([spec], { title: 'T', version: '1' }),
        samples: { record: { body: {} } },
        call,
      }),
    ).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([z.null(), z.strictObject({ name: z.string() }).nullable()])(
    'probes an unknown property for a valid null body without throwing (%#)',
    async (body) => {
      const spec = defineApi({
        method: 'POST',
        path: '/_pb/nullable',
        permission: null,
        api: {
          operationId: 'nullable',
          summary: 'Nullable',
          tags: ['fixture'],
          body,
          responses: { 200: result },
        },
      });
      const seen: unknown[] = [];
      const input = {
        specs: [spec],
        document: generateOpenApi([spec], { title: 'T', version: '1' }),
        samples: { nullable: { body: null } },
      };
      expect(
        await runApiContract({
          ...input,
          call: async (request) => {
            const value: unknown = await request.json();
            seen.push(value);
            return body.safeParse(value).success
              ? Response.json({ ok: true })
              : new Response(null, { status: 400 });
          },
        }),
      ).toEqual([]);
      expect(seen).toEqual([{ __contract_unknown: true }, null]);
      expect(
        await runApiContract({
          ...input,
          call: () => Promise.resolve(Response.json({ ok: true })),
        }),
      ).toEqual([
        { check: 'unknown_property_accepted', operationId: 'nullable', location: '/body' },
      ]);
    },
  );

  const envelope = { error: { code: 'conflict', message: 'Conflict', requestId: 'fixture' } };
  async function errorFindings(value: unknown, empty = false) {
    const spec = defineApi({
      ...specs[0]!,
      api: { ...specs[0]!.api, responses: { 200: result, 409: null } },
    });
    return runApiContract({
      specs: [spec],
      document: generateOpenApi([spec], { title: 'T', version: '1' }),
      samples,
      call: () =>
        Promise.resolve(
          empty ? new Response(null, { status: 409 }) : Response.json(value, { status: 409 }),
        ),
    });
  }
  it('accepts a declared error envelope', async () => {
    expect(await errorFindings(envelope)).toEqual([]);
  });
  it('rejects an empty declared error response', async () => {
    expect(await errorFindings(undefined, true)).toEqual([finding('response_mismatch', 'status')]);
  });
  it.each([
    {},
    { error: { code: 'conflict', message: 'Conflict' } },
    { error: { ...envelope.error, requestId: 42 } },
    { error: { ...envelope.error, extra: true } },
    { error: { ...envelope.error, problems: ['too_short'] } },
    { ...envelope, extra: true },
    { error: { ...envelope.error, details: [{ path: '/body', code: 'unknown' }] } },
    {
      error: {
        ...envelope.error,
        details: Array.from({ length: 21 }, () => ({ path: '/body', code: 'invalid' })),
      },
    },
  ])('rejects an invalid declared error envelope (%#)', async (value) => {
    expect(await errorFindings(value)).toEqual([finding('response_mismatch', 'status')]);
  });
  it.each([
    [['too_short'], true],
    [['too_short', 'too_long', 'equals_email', 'not_well_formed'], true],
    [[], false],
    [['unknown'], false],
    ['too_short', false],
    [[42], false],
  ])('checks weak-password problem codes (%#)', async (problems, valid) => {
    const spec = defineApi({
      method: 'POST',
      path: '/_pb/auth/local/setup/finish',
      permission: null,
      api: AUTH_API['POST /_pb/auth/local/setup/finish']!,
    });
    const findings = await runApiContract({
      specs: [spec],
      document: generateOpenApi([spec], { title: 'T', version: '1' }),
      samples: {
        finishLocalSetup: { body: { token: 'fixture', password: 'short', code: '123456' } },
      },
      call: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'weak_password',
                message: 'Password does not meet the requirements',
                requestId: 'fixture',
                problems,
              },
            },
            { status: 400 },
          ),
        ),
    });
    expect(findings).toEqual(valid ? [] : [finding('response_mismatch', 'finishLocalSetup')]);
  });
  it('accepts validation details in a declared error envelope', async () => {
    expect(
      await errorFindings({
        error: {
          ...envelope.error,
          details: [{ path: '/body', code: 'invalid_json', location: 'body' }],
        },
      }),
    ).toEqual([]);
  });
  it('detects a response schema violation', async () => {
    const real = await kernelCall();
    const call = (r: Request) =>
      r.method === 'GET' ? Promise.resolve(Response.json({ ok: sentinel })) : real(r);
    expect(await runApiContract({ specs, document: document(), samples, call })).toContainEqual(
      finding('response_mismatch', 'status'),
    );
  });
  it('detects an undeclared status', async () => {
    const real = await kernelCall();
    const call = (r: Request) =>
      r.method === 'GET' ? Promise.resolve(Response.json({ ok: true }, { status: 202 })) : real(r);
    expect(await runApiContract({ specs, document: document(), samples, call })).toContainEqual(
      finding('response_mismatch', 'status'),
    );
  });
  it('detects malformed JSON', async () => {
    const real = await kernelCall();
    const call = (r: Request) =>
      r.method === 'GET' ? Promise.resolve(new Response('invalid')) : real(r);
    expect(await runApiContract({ specs, document: document(), samples, call })).toContainEqual(
      finding('response_mismatch', 'status'),
    );
  });
  it('detects content for a null response schema', async () => {
    const real = await kernelCall();
    const changed = [{ ...specs[0]!, api: { ...specs[0]!.api, responses: { 200: null } } }];
    expect(
      await runApiContract({
        specs: changed,
        document: generateOpenApi(changed, { title: 'T', version: '1' }),
        samples,
        call: real,
      }),
    ).toContainEqual(finding('response_mismatch', 'status'));
  });
  it('reports a missing sample without calling that operation', async () => {
    const call = vi.fn(await kernelCall());
    expect(
      await runApiContract({
        specs,
        document: document(),
        samples: { update: samples.update, remove: samples.remove },
        call,
      }),
    ).toEqual([{ check: 'no_sample', operationId: 'status' }]);
    expect(call.mock.calls.every(([r]) => r.method !== 'GET')).toBe(true);
  });
  it('skips exempt routes', async () => {
    const call = vi.fn(await kernelCall());
    expect(
      await runApiContract({
        specs: [
          { method: 'GET', path: '/_pb/exempt', permission: null, api: { exempt: 'stream' } },
        ],
        document: document(),
        samples: {},
        call,
      }),
    ).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
  it('never includes sample values in findings', async () => {
    const call = () => Promise.resolve(Response.json({ value: sentinel }));
    const findings = await runApiContract({ specs, document: document(), samples, call });
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(sentinel);
  });
});
