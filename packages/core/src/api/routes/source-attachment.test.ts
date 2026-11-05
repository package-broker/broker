import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import { orgContext } from '../../db/port.js';
import type { SourceRecord } from '../../db/source.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { defineApi } from '../route.js';
import { SOURCE_ATTACHMENT_API_SPECS } from './source-attachment-schemas.js';
import type { ProxyClaimDeps } from '../../sources/proxy-claims.js';
import { sourceAttachmentRoutes } from './source-attachment.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const SOURCE = '01JA0000000000000000000003';
const SESSION = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const clock = fixedClock('2026-10-22T00:00:00.000Z');
const path = `/_pb/projects/demo/sources/${SOURCE}/attachment`;

async function fixture(
  options: {
    permissions?: readonly string[];
    projectState?: 'absent' | 'archived' | 'invisible';
    sourceState?: 'absent' | 'foreign' | 'own';
    attached?: boolean;
    proxyClaims?: ProxyClaimDeps;
    organizationPermissions?: readonly string[];
  } = {},
) {
  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const log = vi.fn();
  const visible = options.projectState === undefined;
  const projects = {
    get: vi.fn(async () =>
      options.projectState === 'absent' || options.projectState === 'invisible'
        ? null
        : {
            status:
              options.projectState === 'archived' ? ('archived' as const) : ('active' as const),
          },
    ),
  };
  const row = (projectId: string | null) =>
    ({ id: SOURCE, projectId, name: 'shared', ecosystem: 'composer' }) as SourceRecord;
  const sources = {
    get: vi.fn(async () =>
      options.sourceState === 'absent'
        ? null
        : row(
            options.sourceState === 'foreign'
              ? OTHER_PROJECT
              : options.sourceState === 'own'
                ? PROJECT
                : null,
          ),
    ),
  };
  const visibility = {
    attachSource: vi.fn().mockResolvedValue({ ok: true, opId: SOURCE }),
    detachSource: vi.fn().mockResolvedValue({ ok: true, opId: SOURCE }),
  };
  const projectSources = {
    list: vi.fn(async () => (options.attached === false ? [] : [{ sourceId: SOURCE }])),
  };
  const permissions = options.permissions ?? ['project:read', 'project:sources:write'];
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: sourceAttachmentRoutes({
      sources,
      ...(options.proxyClaims === undefined ? {} : { proxyClaims: options.proxyClaims }),
      visibility,
      projectSources,
      projects,
      ids,
      clock,
      clientIp: () => '203.0.113.7',
    }),
    ports: { organizations: { get: async () => null }, ids, clock },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: false,
          project: input.boundary === 'project' && visible ? { id: PROJECT } : null,
          organizationPermissions: options.organizationPermissions ?? [],
          projectPermissions: options.projectState === 'invisible' ? [] : permissions,
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (method: string, target = path, body?: unknown) =>
    app.fetch(
      new Request(ORIGIN + target, {
        method,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${SESSION}`,
          'x-csrf-token': CSRF,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, visibility, projectSources, sources, projects };
}

async function normalized(response: Response) {
  const text = await response.text();
  const body = (text === '' ? null : JSON.parse(text)) as { error?: { requestId?: string } } | null;
  if (body?.error) delete body.error.requestId;
  return {
    status: response.status,
    body,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
  };
}

it('declares two strict API specs', () => {
  expect(SOURCE_ATTACHMENT_API_SPECS).toHaveLength(2);
  for (const spec of SOURCE_ATTACHMENT_API_SPECS) expect(() => defineApi(spec)).not.toThrow();
});

it('attaches a source with the audit call and no precedence by default', async () => {
  const f = await fixture();
  const response = await f.request('PUT', path, {});
  expect(response.status).toBe(204);
  expect(f.visibility.attachSource).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    { projectId: PROJECT, sourceId: SOURCE },
    expect.objectContaining({ audit: expect.objectContaining({ sourceIp: '203.0.113.7' }) }),
  );
});

it('passes an explicit precedence to the service', async () => {
  const f = await fixture();
  expect((await f.request('PUT', path, { precedence: 5 })).status).toBe(204);
  expect(f.visibility.attachSource).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.anything(),
    { projectId: PROJECT, sourceId: SOURCE, precedence: 5 },
    expect.anything(),
  );
});

it('attaches a project-owned source of the same project', async () => {
  const f = await fixture({ sourceState: 'own' });
  expect((await f.request('PUT', path, {})).status).toBe(204);
});

it.each([{ precedence: -1 }, { precedence: 1.5 }, { precedence: 10001 }, { extra: 1 }])(
  'rejects the invalid attach body %j',
  async (body) => {
    const f = await fixture();
    expect((await f.request('PUT', path, body)).status).toBe(400);
    expect(f.visibility.attachSource).not.toHaveBeenCalled();
  },
);

it('answers 204 again when the store reports an idempotent re-attach', async () => {
  const f = await fixture();
  expect((await f.request('PUT', path, {})).status).toBe(204);
  expect((await f.request('PUT', path, {})).status).toBe(204);
  expect(f.visibility.attachSource).toHaveBeenCalledTimes(2);
});

it('detaches an attached source', async () => {
  const f = await fixture();
  const response = await f.request('DELETE');
  expect(response.status).toBe(204);
  expect(f.projectSources.list).toHaveBeenCalledWith(orgContext('org-1'), { projectId: PROJECT });
  expect(f.visibility.detachSource).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1' }),
    { projectId: PROJECT, sourceId: SOURCE },
    expect.objectContaining({ audit: expect.objectContaining({ sourceIp: '203.0.113.7' }) }),
  );
});

it.each([
  ['PUT', {}],
  ['DELETE', undefined],
] as const)('denies %s without project source write', async (method, body) => {
  const f = await fixture({ permissions: ['project:read', 'project:sources:read'] });
  expect((await f.request(method, path, body)).status).toBe(403);
  expect(f.visibility.attachSource).not.toHaveBeenCalled();
  expect(f.visibility.detachSource).not.toHaveBeenCalled();
});

it.each([
  ['PUT', {}],
  ['DELETE', undefined],
] as const)('uniformly hides absent, foreign and archived targets on %s', async (method, body) => {
  const absent = await normalized(
    await (await fixture({ sourceState: 'absent' })).request(method, path, body),
  );
  expect(absent.status).toBe(404);
  for (const options of [
    { sourceState: 'foreign' },
    { projectState: 'archived' },
    { projectState: 'absent' },
  ] as const) {
    const f = await fixture(options);
    expect(await normalized(await f.request(method, path, body))).toEqual(absent);
    expect(f.visibility.attachSource).not.toHaveBeenCalled();
    expect(f.visibility.detachSource).not.toHaveBeenCalled();
  }
});

it('answers detach of an unattached source with the uniform 404', async () => {
  const absent = await normalized(
    await (await fixture({ sourceState: 'absent' })).request('DELETE'),
  );
  const f = await fixture({ attached: false });
  expect(await normalized(await f.request('DELETE'))).toEqual(absent);
  expect(f.visibility.detachSource).not.toHaveBeenCalled();
});

it('maps a store not_found at the batch to the uniform 404', async () => {
  const absent = await normalized(
    await (await fixture({ sourceState: 'absent' })).request('PUT', path, {}),
  );
  const f = await fixture();
  f.visibility.attachSource.mockResolvedValue({ ok: false, error: 'not_found' });
  expect(await normalized(await f.request('PUT', path, {}))).toEqual(absent);
});

it('maps a store authority refusal to 403', async () => {
  const f = await fixture();
  f.visibility.attachSource.mockResolvedValue({ ok: false, error: 'forbidden' });
  expect((await f.request('PUT', path, {})).status).toBe(403);
});

it.each(['found', 'unavailable', 'not_found'] as const)(
  'checks exact hosted claims before proxy attachment: %s',
  async (answer) => {
    const probe = vi.fn().mockResolvedValue(answer);
    const f = await fixture({
      organizationPermissions: ['org:sources:write'],
      proxyClaims: {
        sources: {
          list: vi.fn().mockResolvedValue([{ id: 'host', type: 'hosted', ecosystem: 'npm' }]),
        },
        registeredNames: {
          list: vi.fn().mockResolvedValue({ items: [{ pattern: 'widget' }], next: null }),
        },
        claimProbe: probe,
      },
    });
    f.sources.get.mockResolvedValue({
      id: SOURCE,
      projectId: null,
      ecosystem: 'npm',
      type: 'npmjs_proxy',
    } as SourceRecord);
    const result = await f.request('PUT', path, {});
    expect(result.status).toBe(answer === 'not_found' ? 204 : 409);
    if (answer !== 'not_found')
      expect(await result.json()).toMatchObject({ conflictingClaims: ['widget'] });
    expect(f.visibility.attachSource).toHaveBeenCalledTimes(answer === 'not_found' ? 1 : 0);
  },
);

it.each(['found', 'not_found'] as const)(
  'allows project writers to preflight an organization proxy: %s',
  async (answer) => {
    const probe = vi.fn().mockResolvedValue(answer);
    const f = await fixture({
      proxyClaims: {
        sources: {
          list: vi.fn().mockResolvedValue([{ id: 'host', type: 'hosted', ecosystem: 'npm' }]),
        },
        registeredNames: {
          list: vi.fn().mockResolvedValue({ items: [{ pattern: 'private-name' }], next: null }),
        },
        claimProbe: probe,
      },
    });
    f.sources.get.mockResolvedValue({
      id: SOURCE,
      projectId: null,
      ecosystem: 'npm',
      type: 'npmjs_proxy',
    } as SourceRecord);
    const response = await f.request('PUT', path, {});
    expect(response.status).toBe(answer === 'found' ? 409 : 204);
    if (answer === 'found') {
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('conflict');
      expect(JSON.stringify(body)).not.toContain('private-name');
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(f.sources.get).toHaveBeenCalledTimes(1);
    expect(f.visibility.attachSource).toHaveBeenCalledTimes(answer === 'found' ? 0 : 1);
  },
);

it('keeps organization claim names opaque when attaching a project-owned proxy', async () => {
  const f = await fixture({
    proxyClaims: {
      sources: {
        list: vi.fn().mockResolvedValue([{ id: 'host', type: 'hosted', ecosystem: 'npm' }]),
      },
      registeredNames: {
        list: vi.fn().mockResolvedValue({ items: [{ pattern: 'private-name' }], next: null }),
      },
      claimProbe: vi.fn().mockResolvedValue('found'),
    },
  });
  f.sources.get.mockResolvedValue({
    id: SOURCE,
    projectId: PROJECT,
    ecosystem: 'npm',
    type: 'npmjs_proxy',
  } as SourceRecord);
  const response = await f.request('PUT', path, {});
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain('private-name');
  expect(f.visibility.attachSource).not.toHaveBeenCalled();
});
