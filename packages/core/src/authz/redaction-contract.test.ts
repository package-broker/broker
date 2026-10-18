import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../auth/primitives.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { Organization } from '../db/organization.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { ObsRecord } from '../platform/observability.js';
import {
  SUPPORTED_PLUGIN_API,
  type AccessCheckResult,
  type PluginDefinition,
  type PluginPorts,
  type RouteDefinition,
} from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken, parseToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { ActorContext } from './administration.js';
import { createAuthorizationEngine, patValidationGate } from './engine.js';
import type { EngineSessionAccess, EngineTokenAccess } from './engine.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import { createPersonalTokenService } from './pat-service.js';
import type { PersonalTokenIssueOutcome } from './pat-service.js';
import type { ServicePrincipalRecord } from './service-principal-service.js';
import { createServiceTokenService } from './service-token-service.js';
import type { TokenListItem } from './token-read.js';

const ORIGIN = 'https://broker.test';
const ORG = 'org-1';
const NOW = '2026-10-16T12:00:00.000Z';
const DAY = 86_400_000;
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);
const PAT_SELECTOR = 'abcdefghijkl';
const SVC_SELECTOR = 'mnopqrstuvwx';
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5);
const SESSION_SECRET = 'S'.repeat(43);
const PAT = formatToken('pat', PAT_SELECTOR, SECRET_BYTES);
const SVC = formatToken('svc', SVC_SELECTOR, SECRET_BYTES);
const SECRET = parseToken(PAT).ok ? (parseToken(PAT) as { secret: string }).secret : '';
const HOOK_SECRET = `hook-secret-${PAT}`;

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock(NOW),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

interface Rig {
  hook: (() => AccessCheckResult | Promise<AccessCheckResult>) | null;
  storeFailure: Error | null;
  touchFailure: Error | null;
}

const issued: { plaintext: string; selector: string; hash: string }[] = [];

function tokenEnvelope(): Promise<EngineTokenAccess> {
  const envelope = {
    token: {
      id: 'tok-1',
      kind: 'pat' as const,
      expired: false,
      revoked: false,
      lastUsedAt: null,
      userId: 'user-1',
      servicePrincipalId: null,
    },
    principalStatus: 'active',
    validation: { kind: 'local' as const, identityId: null, fresh: true, evidenceAt: null },
    project: { id: 'proj-1' },
    organizationPermissions: [],
    projectPermissions: ['project:read'],
  };
  return hashToken(keyring, 1, PAT).then(
    (secretHash) =>
      Object.defineProperty(envelope, 'verifier', {
        value: { secretHash, pepperVersion: 1 },
        enumerable: false,
      }) as unknown as EngineTokenAccess,
  );
}

function engine(rig: Rig, logs: unknown[][], dispatched: (() => Promise<void>)[]) {
  return createAuthorizationEngine({
    access: {
      lookupSession: async (_ctx, input) => {
        if (input.secretHash !== (await sha256Hex(SESSION_SECRET))) return null;
        const found: EngineSessionAccess = {
          session: { id: 'sess-1', csrfHash: await sha256Hex('c') },
          user: { id: 'user-1' },
          project: input.projectSlug === 'demo' ? { id: 'proj-1' } : null,
          organizationPermissions: [],
          projectPermissions: ['project:read'],
          protectedHolder: false,
        };
        return found;
      },
      touchSession: () => Promise.resolve(true),
      touchToken: () =>
        rig.touchFailure === null ? Promise.resolve(true) : Promise.reject(rig.touchFailure),
      lookupToken: (_ctx, input) =>
        input.selector === PAT_SELECTOR && input.projectSlug === 'demo'
          ? tokenEnvelope()
          : Promise.resolve(null),
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse(NOW),
      dispatch: (run) => dispatched.push(run),
      log: (...args) => logs.push(args),
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: () => Promise.resolve([]),
  });
}

function organization(): Organization {
  return {
    id: orgContext(ORG).orgId,
    slug: 'a',
    name: 'A',
    settings: {
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: 90,
      tokenCiReadonlyExpiryDays: 365,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function authenticated(): AuthenticatedSession {
  return {
    session: {
      id: 'session-1',
      userId: 'user-1',
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + DAY).toISOString(),
      lastSeenAt: NOW,
      reauthAt: NOW,
      user: { id: 'user-1', email: 'u@example.test', displayName: null },
    },
    principal: { kind: 'user', id: 'user-1' },
  } as unknown as AuthenticatedSession;
}

function fence() {
  return mutationFence(
    { userId: 'user-1', sessionId: 'session-1' } as unknown as AuthenticatedActor,
    {},
  );
}

const inDays = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString();

const serviceLogs: Record<string, unknown>[] = [];

function personalService(rig: Rig, outcome?: PersonalTokenIssueOutcome) {
  return createPersonalTokenService({
    tokens: {
      async issuePersonal(_ctx, _fence, input, mint) {
        const pair = await mint();
        issued.push({ plaintext: pair.plaintext, selector: pair.selector, hash: pair.hash });
        if (rig.storeFailure !== null) {
          throw new Error(`${rig.storeFailure.message} ${pair.plaintext} ${pair.hash}`);
        }
        return outcome ?? { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    sessions: { isReauthFresh: () => true },
    organizations: { get: () => Promise.resolve(organization()) },
    providers: { anchors: () => Promise.resolve([]) },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-1' },
    log: (entry) => serviceLogs.push({ ...entry }),
  });
}

const principal: ServicePrincipalRecord = {
  id: 'sp-1',
  name: 'ci',
  projectId: 'proj-1',
  createdByUserId: 'user-9',
  status: 'active',
  revision: 1,
  permissions: ['project:read', 'project:packages:read'],
};

const actor: ActorContext = {
  kind: 'organization',
  userId: 'user-1',
  permissions: new Set(),
  isOrganizationAdmin: false,
};

function serviceTokenService() {
  return createServiceTokenService({
    tokens: {
      async issueService(_ctx, _fence, input, mint) {
        const pair = await mint();
        issued.push({ plaintext: pair.plaintext, selector: pair.selector, hash: pair.hash });
        return { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    principals: { get: (_ctx, id) => Promise.resolve(id === 'sp-1' ? principal : null) },
    authority: {
      livePermissions: () =>
        Promise.resolve(
          new Set(['project:read', 'project:packages:read', 'project:tokens:create']),
        ),
    },
    sessions: { isReauthFresh: () => true },
    organizations: { get: () => Promise.resolve(organization()) },
    providers: { anchors: () => Promise.resolve([]) },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-2' },
    log: (entry) => serviceLogs.push({ ...entry }),
  });
}

type ListKeys = keyof TokenListItem;
type Leaky = Extract<
  ListKeys,
  'hash' | 'selector' | 'secret' | 'secretHash' | 'plaintext' | 'token' | 'verifier'
>;
const NO_LEAKY_LIST_KEY: [Leaky] extends [never] ? true : false = true;

function routes(rig: Rig): RouteDefinition[] {
  const base = { permission: 'project:read', boundary: 'project' } as const;
  return [
    {
      ...base,
      method: 'GET',
      path: '/_pb/projects/:project',
      handler: () => Response.json({ ok: true }),
    },
    {
      ...base,
      method: 'GET',
      path: '/_pb/projects/:project/boom',
      handler: () => {
        throw new Error(`handler failed for ${PAT} ${SVC} ${SECRET} ${PAT_SELECTOR}`);
      },
    },
    {
      ...base,
      method: 'GET',
      path: '/_pb/projects/:project/named',
      handler: () => {
        const error = new Error('named');
        error.name = `${PAT}`;
        throw error;
      },
    },
    {
      ...base,
      method: 'POST',
      path: '/_pb/projects/:project/tokens',
      handler: async () => {
        const result = await personalService(rig).issue(orgContext(ORG), authenticated(), fence(), {
          name: 'laptop',
          scope: 'write',
          expiresAt: inDays(7),
          projectMode: 'selected',
          projectIds: ['proj-1'],
        });
        return Response.json(result, {
          status: result.ok ? 201 : 400,
          headers: { 'cache-control': 'no-store' },
        });
      },
    },
    {
      ...base,
      method: 'POST',
      path: '/_pb/projects/:project/service-tokens',
      handler: async () => {
        const result = await serviceTokenService().issue(
          orgContext(ORG),
          authenticated(),
          actor,
          fence(),
          { servicePrincipalId: 'sp-1', name: 'ci', scope: 'read', expiresAt: inDays(30) },
        );
        return Response.json(result, {
          status: result.ok ? 201 : 400,
          headers: { 'cache-control': 'no-store' },
        });
      },
    },
  ];
}

function plugin(rig: Rig): PluginDefinition {
  return {
    id: 'guard',
    package: '@test/guard',
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    register(registry) {
      registry.hook('access.check', () => (rig.hook === null ? undefined : rig.hook()));
    },
  };
}

interface Captured {
  readonly status: number;
  readonly body: string;
  readonly headers: string;
  readonly records: string;
}

async function run(
  rig: Rig,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<Captured> {
  const records: ObsRecord[] = [];
  const legacy: Record<string, unknown>[] = [];
  const engineLogs: unknown[][] = [];
  const dispatched: (() => Promise<void>)[] = [];
  const kernel = await createKernel({
    platform: 'node',
    plugins: [plugin(rig)],
    ports,
    resolveOrg: () => Promise.resolve(orgContext(ORG)),
    health: () => Promise.resolve(true),
    log: (entry) => legacy.push({ ...entry }),
    coreRoutes: routes(rig),
    authorization: engine(rig, engineLogs, dispatched),
    observability: {
      sink: { emit: (record) => records.push(record) },
      deploymentId: 'test',
      trustInboundTraceparent: true,
    },
  });
  const response = await kernel.fetch(new Request(`${ORIGIN}${path}`, { method, headers }));
  for (const callback of dispatched) await callback();
  return {
    status: response.status,
    body: await response.text(),
    headers: JSON.stringify([...response.headers.entries()]),
    records: JSON.stringify({ records, legacy, serviceLogs, engineLogs }),
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const basic = (user: string, password: string) => ({
  authorization: `Basic ${btoa(`${user}:${password}`)}`,
});
const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

async function forbidden(): Promise<string[]> {
  return [
    PAT,
    SVC,
    SECRET,
    PAT_SELECTOR,
    SVC_SELECTOR,
    SESSION_SECRET,
    HOOK_SECRET,
    await hashToken(keyring, 1, PAT),
    await hashToken(keyring, 1, SVC),
    ...issued.flatMap((entry) => {
      const parsed = parseToken(entry.plaintext);
      if (!parsed.ok) throw new Error('invalid issued token fixture');
      return [entry.plaintext, entry.selector, parsed.secret, entry.hash];
    }),
  ];
}

async function expectClean(captured: Captured): Promise<void> {
  const haystack = `${captured.body}\n${captured.headers}\n${captured.records}`;
  for (const needle of await forbidden()) expect(haystack).not.toContain(needle);
}

const fresh = (): Rig => ({ hook: null, storeFailure: null, touchFailure: null });

describe('the token never leaves through a log, envelope, list, trace or report', () => {
  it('the token-list item type has no field that could carry a credential', () => {
    expect(NO_LEAKY_LIST_KEY).toBe(true);
  });

  it('a valid Bearer request serves without echoing the credential anywhere', async () => {
    const captured = await run(fresh(), '/_pb/projects/demo', {
      ...bearer(PAT),
      traceparent: TRACEPARENT,
    });
    expect(captured.status).toBe(200);
    expect(captured.records).toContain('a'.repeat(32));
    await expectClean(captured);
  });

  it.each([
    ['Basic username', basic(PAT, 'x')],
    ['Basic password', basic('token', PAT)],
    ['Basic with the token in both fields', basic(PAT, PAT)],
  ])('%s authenticates and leaves no trace of the token', async (_name, headers) => {
    const captured = await run(fresh(), '/_pb/projects/demo', headers);
    expect(captured.status).toBe(200);
    await expectClean(captured);
  });

  it.each([
    ['unknown selector', bearer(formatToken('pat', 'zzzzzzzzzzzz', SECRET_BYTES))],
    ['altered secret', bearer(`${PAT.slice(0, -1)}${PAT.endsWith('A') ? 'B' : 'A'}`)],
    ['malformed token', bearer(`${PAT}extra`)],
    ['unsupported scheme', { authorization: `Token ${PAT}` }],
    ['reserved cst kind', bearer(formatToken('cst', PAT_SELECTOR, SECRET_BYTES))],
    ['two different tokens in Basic', basic(PAT, SVC)],
  ])('a refused credential (%s) is not reflected', async (_name, headers) => {
    const captured = await run(fresh(), '/_pb/projects/demo', headers);
    expect([401, 404]).toContain(captured.status);
    await expectClean(captured);
  });

  it('a token placed in the query string, a path segment or trace headers is not reflected', async () => {
    for (const path of [
      `/_pb/projects/demo?access_token=${PAT}`,
      `/_pb/projects/${PAT}`,
      `/_pb/${SVC}`,
    ]) {
      const captured = await run(fresh(), path, {
        ...bearer(PAT),
        traceparent: TRACEPARENT,
        tracestate: `pb=${PAT}`,
        baggage: `token=${PAT}`,
        'x-request-id': PAT,
      });
      await expectClean(captured);
    }
  });

  it('an exception message carrying the token yields the generic 500 envelope and a clean log', async () => {
    const captured = await run(fresh(), '/_pb/projects/demo/boom', bearer(PAT));
    expect(captured.status).toBe(500);
    expect(JSON.parse(captured.body)).toMatchObject({ error: { code: 'internal' } });
    expect(captured.records).toContain('http.error');
    await expectClean(captured);
  });

  it('an exception whose name is the token is reported under the approved name only', async () => {
    const captured = await run(fresh(), '/_pb/projects/demo/named', bearer(PAT));
    expect(captured.status).toBe(500);
    expect(captured.records).toContain('"error_name":"Error"');
    await expectClean(captured);
  });

  it('a hook denial reason carrying a secret is not surfaced', async () => {
    const rig = fresh();
    rig.hook = () => ({ deny: true, reason: HOOK_SECRET });
    const captured = await run(rig, '/_pb/projects/demo', bearer(PAT));
    expect([401, 403, 404]).toContain(captured.status);
    await expectClean(captured);
  });

  it('a hook exception message carrying a secret is not surfaced', async () => {
    const rig = fresh();
    rig.hook = () => {
      throw new Error(HOOK_SECRET);
    };
    const captured = await run(rig, '/_pb/projects/demo', bearer(PAT));
    expect([401, 403, 404, 500]).toContain(captured.status);
    await expectClean(captured);
  });

  it('a hook rejection and an allow-shaped result with a secret are not surfaced', async () => {
    for (const hook of [
      () => Promise.reject(new Error(HOOK_SECRET)),
      () => ({ allow: true, reason: HOOK_SECRET }) as never,
    ]) {
      const rig = fresh();
      rig.hook = hook;
      const captured = await run(rig, '/_pb/projects/demo', bearer(PAT));
      expect(captured.status).not.toBe(200);
      await expectClean(captured);
    }
  });

  it('a dispatched token-touch failure carrying a secret leaves every sink clean', async () => {
    const rig = fresh();
    rig.touchFailure = new Error(`${HOOK_SECRET} ${await hashToken(keyring, 1, PAT)}`);
    const captured = await run(rig, '/_pb/projects/demo', bearer(PAT));
    expect(captured.status).toBe(200);
    const { engineLogs } = JSON.parse(captured.records) as { engineLogs: unknown[][] };
    expect(engineLogs).toContainEqual(['token_touch_failed']);
    await expectClean(captured);
  });
});

describe('the show-once value is the sole response with plaintext', () => {
  it('a personal issuance returns the plaintext once, with no-store, and nothing else carries it', async () => {
    issued.length = 0;
    serviceLogs.length = 0;
    const first = await run(fresh(), '/_pb/projects/demo/tokens', bearer(PAT), 'POST');
    expect(first.status).toBe(201);
    expect(first.headers).toContain('no-store');
    const entry = issued[0];
    expect(entry).toBeDefined();
    const body = JSON.parse(first.body) as { ok: boolean; value: { plaintext: string } };
    expect(body.value.plaintext).toBe(entry?.plaintext);
    const remainder = structuredClone(body);
    Reflect.deleteProperty(remainder.value, 'plaintext');
    await expectClean({ ...first, body: JSON.stringify(remainder) });
  });

  it('a service issuance returns the plaintext once and logs only metadata', async () => {
    issued.length = 0;
    serviceLogs.length = 0;
    const first = await run(fresh(), '/_pb/projects/demo/service-tokens', bearer(PAT), 'POST');
    expect(first.status).toBe(201);
    const entry = issued[0];
    expect(entry).toBeDefined();
    expect(first.headers).toContain('no-store');
    const body = JSON.parse(first.body) as { ok: boolean; value: { plaintext: string } };
    expect(body.ok).toBe(true);
    expect(body.value.plaintext).toBe(entry?.plaintext);
    expect(serviceLogs.length).toBeGreaterThan(0);
    const remainder = structuredClone(body);
    Reflect.deleteProperty(remainder.value, 'plaintext');
    await expectClean({ ...first, body: JSON.stringify(remainder) });
  });

  it('a refused issuance carries a fixed error code and no plaintext', async () => {
    issued.length = 0;
    const service = personalService(fresh(), { status: 'refused', reason: 'authority' });
    const result = await service.issue(orgContext(ORG), authenticated(), fence(), {
      name: 'laptop',
      scope: 'write',
      expiresAt: inDays(7),
      projectMode: 'selected',
      projectIds: ['proj-1'],
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    const entry = issued[0];
    expect(JSON.stringify([result, serviceLogs])).not.toContain(entry?.plaintext);
    expect(JSON.stringify([result, serviceLogs])).not.toContain(entry?.hash);
  });

  it('a store failure whose message carries the plaintext does not reach the response', async () => {
    issued.length = 0;
    const rig = fresh();
    rig.storeFailure = new Error('insert failed');
    const captured = await run(rig, '/_pb/projects/demo/tokens', bearer(PAT), 'POST');
    expect(captured.status).toBe(500);
    const entry = issued[0];
    expect(entry).toBeDefined();
    for (const needle of [entry?.plaintext, entry?.selector, entry?.hash, 'insert failed']) {
      expect(captured.body).not.toContain(needle);
      expect(captured.records).not.toContain(needle);
    }
  });
});
