import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { fenceKind, tokenMutationFence, type AuthenticatedTokenActor } from '../../authz/fence.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import {
  createImportCredentialService,
  type CredentialTarget,
  type ImportCredentialStore,
} from '../../import/credentials.js';
import { MAX_MANIFEST_BYTES } from '../../import/manifest.js';
import {
  createImportRunService,
  type ImportRun,
  type ImportRunStore,
} from '../../import/run-service.js';
import { createKernel } from '../../kernel/kernel.js';
import type { CredentialStore } from '../../secrets/credential-store.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { importRoutes } from './import.js';

const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000001';
const USER = '01JA0000000000000000000002';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const SENTINEL = 'S3CR3T-SENTINEL';
const HASH = 'a'.repeat(64);
const ROOT = '/_pb/import-runs';
const clock = fixedClock('2026-10-21T10:00:00.000Z');
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
});
afterEach(() => {
  vi.restoreAllMocks();
});
const manifest = { version: 1, source_system: 'test', items: [], widening: [] };
const source = {
  type: 'source',
  external_ref: 'source',
  name: 'private',
  ecosystem: 'composer',
  source_type: 'composer_repository',
  project: { existing: 'demo' },
  url: 'https://packages.example.test/',
  credential_ref: 'env:REGISTRY_TOKEN',
  config: {
    selection: { packages: [], patterns: [], expandPatterns: false },
    distHosts: [],
    mirrorsFallback: false,
  },
};
const upload = { kind: 'bearer', material: JSON.stringify({ token: SENTINEL }) };
const actions = ['verify', 'approve', 'apply', 'rollback', 'accept', 'cancel'] as const;

async function fixture(
  options: {
    permissions?: readonly string[];
    hidden?: 'absent' | 'foreign' | 'archived' | 'invisible';
    approved?: boolean;
    appliedSource?: boolean;
    reauth?: boolean;
    liveAuthority?: boolean;
  } = {},
) {
  let run: ImportRun = {
    id: ID,
    orgId: orgContext('org-1').orgId,
    state: 'planned',
    planHash: HASH,
    approvedAt: options.approved === false ? null : clock.now().toISOString(),
    approvedByUserId: USER,
    acceptedAt: null,
    beforeImageExpiresAt: null,
  };
  const visible = () => (options.hidden === undefined ? run : null);
  const write = () => vi.fn(async () => ({ ok: true as const, results: [] }));
  const store: ImportRunStore = {
    get: vi.fn(async () =>
      options.hidden === 'foreign' ? { ...run, orgId: orgContext('org-2').orgId } : visible(),
    ),
    list: vi.fn(async () => [
      { ...run, before_image_json: SENTINEL, manifest: SENTINEL, credential_ref: SENTINEL },
    ]),
    inspect: vi.fn(async () => ({
      run: visible(),
      allowed: options.liveAuthority !== false,
      reauthFresh: options.reauth !== false,
    })),
    createRun: write(),
    approveRun: write(),
    requestApply: write(),
    requestVerify: write(),
    cancelRun: write(),
    acceptRun: write(),
    requestRollback: write(),
  };
  const service = createImportRunService({ store, clock, ids: { ulid: () => ID } });
  const credentialTarget: CredentialTarget = {
    approvedAt: run.approvedAt,
    credentialWindowUntil: '2026-10-21T11:00:00.000Z',
    manifest: JSON.stringify({ ...manifest, items: [source] }),
    source:
      options.appliedSource === false ? null : { id: ID, projectId: null, credentialId: null },
  };
  let target = credentialTarget;
  let storedMaterial: string | null = null;
  let prepared: string | null = null;
  const credentialStore: ImportCredentialStore = {
    inspect: vi.fn(async () => ({
      target: options.hidden === undefined ? target : null,
      allowed: options.liveAuthority !== false,
    })),
    setCredential: vi.fn(async () => {
      storedMaterial = prepared;
      target = { ...target, source: { ...target.source!, credentialId: ID } };
      return { ok: true as const, results: [] };
    }),
  };
  const prepare = vi.fn<CredentialStore['prepare']>(async (_org, input) => {
    prepared = new TextDecoder().decode(input.plaintext);
    return { id: ID, statement: { sql: 'sealed', params: [] } };
  });
  const auditStatement = vi.fn(() => ({ sql: 'audit', params: [] }));
  const credentials = createImportCredentialService({
    store: credentialStore,
    credentials: { prepare },
    runtime: 'node',
    ids: { ulid: () => ID },
    auditStatement,
  });
  const permissions = options.permissions ?? ['org:import:write', 'org:import:approve'];
  const logged: unknown[] = [];
  const routes = importRoutes({
    service,
    credentials,
    clock,
    ids: { ulid: () => ID },
    clientIp: () => null,
    auditStatement,
    tokenFence: async () =>
      tokenMutationFence(
        { tokenId: 'token-1', tokenKind: 'pat', principalId: USER } as AuthenticatedTokenActor,
        'org:import:write',
        {},
      ),
  }).map((route) => ({ ...route, handler: vi.fn(route.handler) }));
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    ports: { organizations: { get: async () => null }, clock, ids: { ulid: () => ID } },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: (entry) => logged.push(entry),
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: USER },
          identity: null,
          protectedHolder: false,
          project: null,
          organizationPermissions: permissions,
          projectPermissions: [],
        }),
        lookupToken: async () =>
          Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: USER,
                servicePrincipalId: null,
                bindingOk: true,
                boundProjectIds: [],
                projectMode: 'all',
                scope: { level: 'full', readOnly: false },
              },
              principalStatus: 'active',
              protectedHolder: false,
              projectReadInherited: false,
              projectVisible: true,
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: null,
              organizationPermissions: permissions,
              projectPermissions: [],
            },
            'verifier',
            { value: { secretHash: await hashToken(keyring, 1, bearer), pepperVersion: 1 } },
          ) as unknown as EngineTokenAccess,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring,
        nowMs: () => clock.now().getTime(),
        dispatch: (task) => {
          void task();
        },
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    method: string,
    path = ROOT,
    input: {
      auth?: 'session' | 'token' | 'none' | 'malformed' | 'wrong';
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'x-request-id': ID, ...input.headers });
    if (input.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else if (input.auth === 'malformed') headers.set('authorization', 'Bearer broken');
    else if (input.auth === 'wrong')
      headers.set(
        'authorization',
        `Bearer ${formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(8))}`,
      );
    else if (input.auth !== 'none') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
    const body = input.raw ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.fetch(
      new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body }) }),
    );
  };
  return {
    request,
    handlers: routes.map((route) => route.handler),
    service,
    store,
    credentials,
    credentialStore,
    prepare,
    auditStatement,
    logged,
    storedMaterial: () => storedMaterial,
    setRun: (patch: Partial<ImportRun>) => {
      run = { ...run, ...patch };
    },
  };
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
  };
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(text).not.toContain(SENTINEL);
  expect(JSON.parse(text)).toMatchObject({ error: { code } });
  return text;
}

describe('import run routes', () => {
  it.each(['none', 'malformed', 'wrong'] as const)(
    'uses the same 401 for %s authentication',
    async (auth) => {
      const f = await fixture();
      const response = await snapshot(await f.request('GET', ROOT, { auth }));
      expect(response.status).toBe(401);
      expect(response).toEqual(await snapshot(await f.request('GET', ROOT, { auth: 'none' })));
      expect(f.store.list).not.toHaveBeenCalled();
    },
  );

  it.each(['token', 'session'] as const)(
    'uses a generic 403 for an unauthorized %s',
    async (auth) => {
      const f = await fixture({ permissions: ['org:import:write'] });
      const denied = await snapshot(
        await f.request('POST', `${ROOT}/${ID}/approve`, { auth, body: { planHash: HASH } }),
      );
      expect(denied.status).toBe(403);
      expect(denied.body).not.toContain('org:import');
      expect(denied).toEqual(
        await snapshot(
          await f.request('POST', `${ROOT}/${ID}/approve`, {
            auth: 'token',
            body: { planHash: HASH },
          }),
        ),
      );
      expect(f.store.approveRun).not.toHaveBeenCalled();
    },
  );

  it.each(['create', ...actions, 'credentials'] as const)(
    'matches the kernel denial when live authority is revoked after authorization on %s',
    async (action) => {
      const f = await fixture({ liveAuthority: false });
      const kernelDenied = await fixture({ permissions: [] });
      const method = action === 'credentials' ? 'PUT' : 'POST';
      const path =
        action === 'create'
          ? ROOT
          : `${ROOT}/${ID}/${action === 'credentials' ? 'credentials/source' : action}`;
      const input =
        action === 'create'
          ? { body: manifest }
          : action === 'approve'
            ? { body: { planHash: HASH } }
            : action === 'credentials'
              ? { body: upload }
              : {};
      const response = await f.request(method, path, input);
      const expected = await kernelDenied.request(method, path, input);
      expect(response.status).toBe(403);
      expect(response.status).toBe(expected.status);
      expect([...response.headers]).toEqual([...expected.headers]);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array(await expected.arrayBuffer()),
      );
      expect(f.handlers.filter((handler) => handler.mock.calls.length > 0)).toHaveLength(1);
      expect(
        action === 'credentials' ? f.credentialStore.inspect : f.store.inspect,
      ).toHaveBeenCalledTimes(1);
      for (const handler of kernelDenied.handlers) expect(handler).not.toHaveBeenCalled();
      for (const write of [
        f.store.createRun,
        f.store.approveRun,
        f.store.requestApply,
        f.store.requestVerify,
        f.store.requestRollback,
        f.store.acceptRun,
        f.store.cancelRun,
        f.credentialStore.setCredential,
        f.prepare,
      ])
        expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', ...actions] as const)(
    'hides absent, foreign, archived and invisible targets for %s',
    async (action) => {
      const answers = [];
      for (const hidden of ['absent', 'foreign', 'archived', 'invisible'] as const) {
        const f = await fixture({ hidden });
        answers.push(
          await snapshot(
            await f.request(
              action === 'GET' ? 'GET' : 'POST',
              `${ROOT}/${ID}${action === 'GET' ? '' : `/${action}`}`,
              action === 'approve' ? { body: { planHash: HASH } } : {},
            ),
          ),
        );
      }
      expect(answers[0]!.status).toBe(404);
      for (const answer of answers) expect(answer).toEqual(answers[0]);
    },
  );

  it.each(['absent', 'foreign', 'archived', 'invisible'] as const)(
    'uses the same 403 for existing and %s runs when the authenticated caller lacks permission',
    async (hidden) => {
      const existing = await fixture({ permissions: [] });
      const f = await fixture({ hidden, permissions: [] });
      const existingResponse = await existing.request('GET', `${ROOT}/${ID}`);
      const hiddenResponse = await f.request('GET', `${ROOT}/${ID}`);
      expect([...hiddenResponse.headers]).toEqual([...existingResponse.headers]);
      const denied = await snapshot(hiddenResponse);
      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body)).toMatchObject({ error: { code: 'forbidden' } });
      expect(denied.body).not.toContain('org:import');
      expect(denied).toEqual(await snapshot(existingResponse));
      for (const target of [existing, f]) {
        for (const handler of target.handlers) expect(handler).not.toHaveBeenCalled();
        expect(target.store.get).not.toHaveBeenCalled();
        expect(target.store.inspect).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['unknown property', { ...manifest, [SENTINEL]: SENTINEL }],
    ['wrong type', { ...manifest, items: SENTINEL }],
    ['over-long string', { ...manifest, source_system: SENTINEL.repeat(10) }],
  ])('redacts validation details for %s', async (_name, body) => {
    const f = await fixture();
    const text = await error(await f.request('POST', ROOT, { body }), 400, 'invalid_request');
    const result = JSON.parse(text) as { error: { details: Record<string, unknown>[] } };
    expect(result.error.details.length).toBeGreaterThan(0);
    for (const detail of result.error.details)
      expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
    expect(f.store.createRun).not.toHaveBeenCalled();
  });

  it('creates a manifest with a token and returns only the summary', async () => {
    const f = await fixture();
    const response = await f.request('POST', ROOT, { auth: 'token', body: manifest });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: ID,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: 'planned',
    });
    const call = vi.mocked(f.store.createRun).mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(fenceKind(call[1])).toBe('token');
  });

  it('rejects an over-limit raw manifest before parsing', async () => {
    const f = await fixture();
    await error(
      await f.request('POST', ROOT, { raw: '{'.padEnd(MAX_MANIFEST_BYTES + 1, ' ') }),
      413,
      'payload_too_large',
    );
    expect(f.store.createRun).not.toHaveBeenCalled();
  });

  it('accepts a 64 KiB plus one byte raw manifest', async () => {
    const f = await fixture();
    expect(
      (await f.request('POST', ROOT, { raw: JSON.stringify(manifest).padEnd(65537, ' ') })).status,
    ).toBe(201);
  });

  it('accepts a manifest at the raw byte limit', async () => {
    const f = await fixture();
    expect(
      (
        await f.request('POST', ROOT, {
          raw: JSON.stringify(manifest).padEnd(MAX_MANIFEST_BYTES, ' '),
        })
      ).status,
    ).toBe(201);
  });

  it.each(['approve', 'apply', 'rollback', 'accept', 'cancel'] as const)(
    'refuses a token on %s',
    async (action) => {
      const f = await fixture();
      await error(
        await f.request('POST', `${ROOT}/${ID}/${action}`, {
          auth: 'token',
          ...(action === 'approve' ? { body: { planHash: HASH } } : {}),
        }),
        403,
        'forbidden',
      );
      expect(f.store.inspect).not.toHaveBeenCalled();
    },
  );

  it('allows a token to verify and carries its fence', async () => {
    const f = await fixture();
    f.setRun({ state: 'applied' });
    expect((await f.request('POST', `${ROOT}/${ID}/verify`, { auth: 'token' })).status).toBe(204);
    expect(fenceKind(vi.mocked(f.store.requestVerify).mock.calls[0]![1])).toBe('token');
  });

  it.each([
    ['missing', {}],
    ['stale', { planHash: 'b'.repeat(64) }],
  ])('refuses a %s approval hash', async (_name, body) => {
    const f = await fixture({ approved: false });
    await error(await f.request('POST', `${ROOT}/${ID}/approve`, { body }), 409, 'conflict');
    expect(f.store.approveRun).not.toHaveBeenCalled();
  });

  it('answers not_approved when apply precedes approval', async () => {
    const f = await fixture({ approved: false });
    await error(await f.request('POST', `${ROOT}/${ID}/apply`), 409, 'not_approved');
    expect(f.store.requestApply).not.toHaveBeenCalled();
  });

  it.each(['approve', 'apply', 'rollback', 'accept', 'cancel'] as const)(
    'requires live reauthentication for %s',
    async (action) => {
      const f = await fixture({ reauth: false });
      await error(
        await f.request(
          'POST',
          `${ROOT}/${ID}/${action}`,
          action === 'approve' ? { body: { planHash: HASH } } : {},
        ),
        403,
        'reauth_required',
      );
    },
  );

  it.each(['GET', 'list', 'create', ...actions] as const)(
    'never exposes private run fields for %s',
    async (action) => {
      const f = await fixture({ approved: action !== 'approve' });
      f.setRun({
        ...({
          before_image_json: SENTINEL,
          manifest: SENTINEL,
          credential_ref: SENTINEL,
          refs: [{ before_image_json: SENTINEL }],
        } as Partial<ImportRun>),
        state:
          action === 'accept'
            ? 'verified'
            : action === 'verify' || action === 'rollback'
              ? 'applied'
              : 'planned',
      });
      const response =
        action === 'list' || action === 'GET'
          ? await f.request('GET', action === 'list' ? ROOT : `${ROOT}/${ID}`)
          : await f.request(
              'POST',
              action === 'create' ? ROOT : `${ROOT}/${ID}/${action}`,
              action === 'create'
                ? { body: manifest }
                : action === 'approve'
                  ? { body: { planHash: HASH } }
                  : {},
            );
      expect(response.status).toBeLessThan(300);
      const text = await response.text();
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('before_image_json');
      expect(text).not.toContain('credential_ref');
      expect(JSON.stringify(f.logged)).not.toContain(SENTINEL);
    },
  );

  it('passes organization, cursor and limit to list and returns items and next', async () => {
    const f = await fixture();
    const list = vi
      .spyOn(f.service, 'list')
      .mockResolvedValue({ ok: true, value: { items: [], next: 'next-cursor' } });
    const response = await f.request('GET', `${ROOT}?cursor=opaque&limit=2`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], next: 'next-cursor' });
    expect(list).toHaveBeenCalledWith(orgContext('org-1'), { cursor: 'opaque', limit: 2 });
  });

  it.each([true, false])('sets no-store and no CORS headers on success=%s', async (success) => {
    const f = await fixture();
    const response = await f.request('GET', ROOT, success ? {} : { auth: 'none' });
    expect(response.status).toBe(success ? 200 : 401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...response.headers.keys()].some((key) => key.startsWith('access-control-'))).toBe(
      false,
    );
  });
});

describe('import credential PUT', () => {
  const path = `${ROOT}/${ID}/credentials/source`;
  it('accepts a token upload once, responds empty, and never echoes material', async () => {
    const f = await fixture();
    const response = await f.request('PUT', path, { auth: 'token', body: upload });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(f.storedMaterial()).toBe(upload.material);
    const call = vi.mocked(f.credentialStore.setCredential).mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(fenceKind(call[1])).toBe('token');
    expect(JSON.stringify(f.logged)).not.toContain(SENTINEL);
  });
  it('refuses a repeat upload with conflict and leaves the bound material unchanged', async () => {
    const f = await fixture();
    expect((await f.request('PUT', path, { body: upload })).status).toBe(204);
    await error(
      await f.request('PUT', path, {
        body: { ...upload, material: JSON.stringify({ token: 'replacement-material' }) },
      }),
      409,
      'conflict',
    );
    expect(f.storedMaterial()).toBe(upload.material);
    expect(f.credentialStore.setCredential).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('refuses upload before approval without preparing or writing', async () => {
    const f = await fixture({ approved: false });
    await error(await f.request('PUT', path, { body: upload }), 409, 'conflict');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.credentialStore.setCredential).not.toHaveBeenCalled();
    expect(f.storedMaterial()).toBeNull();
  });
  it('refuses a source not created by apply without preparing or writing', async () => {
    const f = await fixture({ appliedSource: false });
    await error(await f.request('PUT', path, { body: upload }), 409, 'conflict');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.credentialStore.setCredential).not.toHaveBeenCalled();
    expect(f.storedMaterial()).toBeNull();
  });
});
