import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../auth/primitives.js';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { DENIAL_MESSAGE } from '../kernel/denial-page.js';
import { createKernel } from '../kernel/kernel.js';
import {
  SUPPORTED_PLUGIN_API,
  type AccessCheckResult,
  type PluginDefinition,
  type PluginPorts,
  type RouteDefinition,
} from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { createAuthorizationEngine, patValidationGate } from './engine.js';
import type { EngineSessionAccess, EngineTokenAccess } from './engine.js';

const ORIGIN = 'https://broker.test';
const ORG = 'org-1';
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5);
const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const PAT_SELECTOR = 'abcdefghijkl';
const SVC_SELECTOR = 'mnopqrstuvwx';
const UNKNOWN_SELECTOR = 'zzzzzzzzzzzz';
const PAT = formatToken('pat', PAT_SELECTOR, SECRET);
const SVC = formatToken('svc', SVC_SELECTOR, SECRET);
const SESSION_SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const EMAIL = 'alice@example.test';
const GROUP = 'acme-engineering-admins';

interface Project {
  readonly id: string;
  readonly org: string;
  readonly archived: boolean;
}

const PROJECTS: Readonly<Record<string, Project>> = {
  demo: { id: 'proj-1', org: ORG, archived: false },
  other: { id: 'proj-2', org: ORG, archived: false },
  hidden: { id: 'proj-3', org: ORG, archived: false },
  old: { id: 'proj-4', org: ORG, archived: true },
  foreign: { id: 'proj-9', org: 'org-2', archived: false },
};

interface TokenState {
  kind: 'pat' | 'svc';
  expired: boolean;
  revoked: boolean;
  principalStatus: string;
  fresh: boolean;
  boundTo: string;
  projectPermissions: string[];
}

interface State {
  sessionRevoked: boolean;
  sessionGrants: Readonly<Record<string, readonly string[]>>;
  token: TokenState;
  hook: (() => AccessCheckResult | Promise<AccessCheckResult>) | null;
}

function freshState(): State {
  return {
    sessionRevoked: false,
    sessionGrants: {
      'proj-1': ['project:read'],
      'proj-2': ['project:read'],
      'proj-4': ['project:read'],
      'proj-9': ['project:read'],
    },
    token: {
      kind: 'pat',
      expired: false,
      revoked: false,
      principalStatus: 'active',
      fresh: true,
      boundTo: 'proj-1',
      projectPermissions: ['project:read'],
    },
    hook: null,
  };
}

function visible(ctx: OrgContext, slug: string | null): Project | null {
  if (slug === null) return null;
  const project = PROJECTS[slug];
  if (project === undefined || project.archived || project.org !== ctx.orgId) return null;
  return project;
}

async function tokenEnvelope(
  state: State,
  ctx: OrgContext,
  slug: string | null,
  selector: string,
): Promise<EngineTokenAccess> {
  const t = state.token;
  const project = visible(ctx, slug);
  const bound = project !== null && project.id === t.boundTo ? project : null;
  const envelope = {
    token: {
      id: 'tok-1',
      kind: t.kind,
      expired: t.expired,
      revoked: t.revoked,
      lastUsedAt: null,
      userId: t.kind === 'pat' ? 'user-1' : null,
      servicePrincipalId: t.kind === 'svc' ? 'svc-1' : null,
    },
    principalStatus: t.principalStatus,
    validation:
      t.kind === 'svc'
        ? null
        : { kind: 'local' as const, identityId: null, fresh: t.fresh, evidenceAt: null },
    project: bound === null ? null : { id: bound.id },
    organizationPermissions: [],
    projectPermissions: bound === null ? [] : t.projectPermissions,
  };
  const canonical =
    t.kind === 'svc' ? formatToken('svc', selector, SECRET) : formatToken('pat', selector, SECRET);
  return Object.defineProperty(envelope, 'verifier', {
    value: { secretHash: await hashToken(keyring, 1, canonical), pepperVersion: 1 },
    enumerable: false,
  }) as unknown as EngineTokenAccess;
}

function engine(state: State) {
  return createAuthorizationEngine({
    access: {
      lookupSession: async (ctx, input) => {
        if (state.sessionRevoked || input.secretHash !== (await sha256Hex(SESSION_SECRET))) {
          return null;
        }
        const project = visible(ctx, input.projectSlug);
        const granted = project === null ? [] : (state.sessionGrants[project.id] ?? []);
        const found: EngineSessionAccess = {
          session: { id: 'sess-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          project: project === null ? null : { id: project.id },
          organizationPermissions: [],
          projectPermissions: granted,
          protectedHolder: false,
        };
        return found;
      },
      touchSession: () => Promise.resolve(true),
      touchToken: () => Promise.resolve(true),
      lookupToken: async (ctx, input) => {
        if (input.selector !== PAT_SELECTOR && input.selector !== SVC_SELECTOR) return null;
        return tokenEnvelope(state, ctx, input.projectSlug, input.selector);
      },
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
      dispatch: () => undefined,
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: () => Promise.resolve([]),
  });
}

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-16T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

function projectRoute(method: RouteDefinition['method'], permission: string): RouteDefinition {
  return {
    method,
    path: '/_pb/projects/:project',
    permission,
    boundary: 'project',
    handler: () => Response.json({ ok: true }),
  };
}

const settingsRoute: RouteDefinition = {
  ...projectRoute('GET', 'project:settings:write'),
  path: '/_pb/projects/:project/settings',
};

function guardPlugin(state: State): PluginDefinition {
  return {
    id: 'guard',
    package: '@test/guard',
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    register(registry) {
      registry.hook('access.check', () => (state.hook === null ? undefined : state.hook()));
    },
  };
}

async function kernelFor(state: State) {
  return createKernel({
    platform: 'node',
    plugins: [guardPlugin(state)],
    ports,
    resolveOrg: () => Promise.resolve(orgContext(ORG)),
    health: () => Promise.resolve(true),
    log: () => undefined,
    coreRoutes: [
      projectRoute('GET', 'project:read'),
      projectRoute('POST', 'project:read'),
      settingsRoute,
    ],
    authorization: engine(state),
  });
}

interface Call {
  readonly path?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

interface Normalized {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly headers: string;
  readonly raw: string;
}

async function call(state: State, init: Call = {}): Promise<Normalized> {
  const kernel = await kernelFor(state);
  const response = await kernel.fetch(
    new Request(`${ORIGIN}${init.path ?? '/_pb/projects/demo'}`, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
    }),
  );
  const raw = await response.text();
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toBeTruthy();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: raw.split(requestId ?? '').join('<request-id>'),
    headers: JSON.stringify(
      [...response.headers.entries()]
        .filter(([name]) => name !== 'x-request-id')
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    raw,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const basic = (user: string, password: string) => ({
  authorization: `Basic ${btoa(`${user}:${password}`)}`,
});
const cookie = (secret: string) => ({ cookie: `__Host-pb_session=${secret}` });

const FORBIDDEN_FRAGMENTS = [
  PAT,
  SVC,
  PAT_SELECTOR,
  SVC_SELECTOR,
  UNKNOWN_SELECTOR,
  SESSION_SECRET,
  EMAIL,
  GROUP,
  'proj-',
  'demo',
  'org-',
  'user-1',
  'svc-1',
  'tok-1',
];

function assertNoReflection(raw: string): void {
  for (const fragment of FORBIDDEN_FRAGMENTS) expect(raw).not.toContain(fragment);
}

type Variant = readonly [string, (state: State) => Call];

const unauthorizedVariants: readonly Variant[] = [
  ['no credential', () => ({})],
  ['malformed bearer token', () => ({ headers: bearer('pb_pat_not-a-token') })],
  ['bearer with extra words', () => ({ headers: { authorization: `Bearer ${PAT} extra` } })],
  ['unknown scheme', () => ({ headers: { authorization: `Token ${PAT}` } })],
  ['altered prefix', () => ({ headers: bearer(PAT.replace('pb_pat_', 'pb_xat_')) })],
  ['unknown selector', () => ({ headers: bearer(formatToken('pat', UNKNOWN_SELECTOR, SECRET)) })],
  ['wrong secret', () => ({ headers: bearer(formatToken('pat', PAT_SELECTOR, OTHER_SECRET)) })],
  [
    'altered final secret character',
    () => ({ headers: bearer(`${PAT.slice(0, -1)}${PAT.endsWith('A') ? 'B' : 'A'}`) }),
  ],
  [
    'expired PAT',
    (state) => {
      state.token.expired = true;
      return { headers: bearer(PAT) };
    },
  ],
  [
    'revoked PAT',
    (state) => {
      state.token.revoked = true;
      return { headers: bearer(PAT) };
    },
  ],
  [
    'stale-validation PAT',
    (state) => {
      state.token.fresh = false;
      return { headers: bearer(PAT) };
    },
  ],
  [
    'PAT of a suspended creator',
    (state) => {
      state.token.principalStatus = 'suspended';
      return { headers: bearer(PAT) };
    },
  ],
  [
    'revoked service token',
    (state) => {
      state.token.kind = 'svc';
      state.token.revoked = true;
      return { headers: bearer(SVC) };
    },
  ],
  ['reserved cst token', () => ({ headers: bearer(formatToken('cst', PAT_SELECTOR, SECRET)) })],
  [
    'Basic carrying two different tokens',
    () => ({ headers: basic(PAT, formatToken('pat', PAT_SELECTOR, OTHER_SECRET)) }),
  ],
  [
    'Basic on an unsafe method without Origin',
    () => ({ method: 'POST', headers: basic('token', PAT) }),
  ],
  [
    'invalid Authorization next to a valid session cookie',
    () => ({ headers: { ...bearer('garbage'), ...cookie(SESSION_SECRET) } }),
  ],
  ['malformed session cookie', () => ({ headers: cookie('short') })],
  ['unknown session cookie', () => ({ headers: cookie('C'.repeat(43)) })],
  [
    'revoked session',
    (state) => {
      state.sessionRevoked = true;
      return { headers: cookie(SESSION_SECRET) };
    },
  ],
];

const notFoundVariants: readonly Variant[] = [
  ['unknown route', () => ({ path: '/_pb/nowhere', headers: bearer(PAT) })],
  [
    'absent project, session',
    () => ({ path: '/_pb/projects/missing', headers: cookie(SESSION_SECRET) }),
  ],
  ['absent project, token', () => ({ path: '/_pb/projects/missing', headers: bearer(PAT) })],
  [
    'archived project, session',
    () => ({ path: '/_pb/projects/old', headers: cookie(SESSION_SECRET) }),
  ],
  [
    'foreign project, session',
    () => ({ path: '/_pb/projects/foreign', headers: cookie(SESSION_SECRET) }),
  ],
  ['foreign project, token', () => ({ path: '/_pb/projects/foreign', headers: bearer(PAT) })],
  [
    'invisible project, session',
    () => ({ path: '/_pb/projects/hidden', headers: cookie(SESSION_SECRET) }),
  ],
  ['cross-project-bound PAT', () => ({ path: '/_pb/projects/other', headers: bearer(PAT) })],
  [
    'cross-project-bound service token',
    (state) => {
      state.token.kind = 'svc';
      return { path: '/_pb/projects/other', headers: bearer(SVC) };
    },
  ],
  [
    'cross-project-bound PAT on a route it could not use anyway',
    () => ({ path: '/_pb/projects/other/settings', headers: bearer(PAT) }),
  ],
  ['invalid slug', () => ({ path: '/_pb/projects/Bad..Slug', headers: cookie(SESSION_SECRET) })],
  ['uppercase slug alias', () => ({ path: '/_pb/projects/DEMO', headers: bearer(PAT) })],
  ['encoded separator alias', () => ({ path: '/_pb/projects/de%2Fmo', headers: bearer(PAT) })],
  [
    'encoded space alias',
    () => ({ path: '/_pb/projects/demo%20', headers: cookie(SESSION_SECRET) }),
  ],
];

const forbiddenVariants: readonly Variant[] = [
  [
    'session without the action on a visible project',
    () => ({ path: '/_pb/projects/demo/settings', headers: cookie(SESSION_SECRET) }),
  ],
  [
    'token without the action on its bound project',
    () => ({ path: '/_pb/projects/demo/settings', headers: bearer(PAT) }),
  ],
  [
    'token carrying a session-only permission',
    (state) => {
      state.token.projectPermissions = ['project:read', 'project:settings:write'];
      return { path: '/_pb/projects/demo/settings', headers: bearer(PAT) };
    },
  ],
  [
    'hook deny carrying a reason with secrets',
    (state) => {
      state.hook = () => ({ deny: true, reason: `${EMAIL} ${GROUP} ${PAT}` });
      return { headers: bearer(PAT) };
    },
  ],
  [
    'hook throwing an error naming secrets',
    (state) => {
      state.hook = () => {
        throw new Error(`${EMAIL} ${GROUP} ${PAT}`);
      };
      return { headers: cookie(SESSION_SECRET) };
    },
  ],
  [
    'hook returning an allow-shaped result',
    (state) => {
      state.hook = () => ({ allow: true, principal: { kind: 'user', id: 'x' } }) as never;
      return { headers: bearer(PAT) };
    },
  ],
];

async function bodiesOf(variants: readonly Variant[]): Promise<Normalized[]> {
  const results: Normalized[] = [];
  for (const [, build] of variants) {
    const state = freshState();
    results.push(await call(state, build(state)));
  }
  return results;
}

describe('refusal contract fixture', () => {
  it('serves the visible project to its session and its bound token', async () => {
    expect((await call(freshState(), { headers: cookie(SESSION_SECRET) })).status).toBe(200);
    expect((await call(freshState(), { headers: bearer(PAT) })).status).toBe(200);
    const state = freshState();
    state.token.kind = 'svc';
    expect((await call(state, { headers: bearer(SVC) })).status).toBe(200);
  });
});

describe('401 envelope', () => {
  it.each(unauthorizedVariants)('%s is a 401 without reflection', async (_name, build) => {
    const state = freshState();
    const result = await call(state, build(state));
    expect(result.status).toBe(401);
    expect(result.contentType).toBe('application/json');
    assertNoReflection(result.raw);
  });

  it('is byte-identical across every variant after request-id normalization', async () => {
    const results = await bodiesOf(unauthorizedVariants);
    expect(new Set(results.map((result) => result.headers)).size).toBe(1);
    const bodies = new Set(results.map((result) => result.body));
    expect(bodies).toEqual(
      new Set([
        '{"error":{"code":"unauthorized","message":"Unauthorized","requestId":"<request-id>"}}',
      ]),
    );
  });

  it('stays the JSON envelope for a browser Accept header', async () => {
    const result = await call(freshState(), {
      headers: { accept: 'text/html', ...bearer(formatToken('pat', UNKNOWN_SELECTOR, SECRET)) },
    });
    expect(result.status).toBe(401);
    expect(result.contentType).toBe('application/json');
    const plain = await call(freshState(), {
      headers: bearer(formatToken('pat', UNKNOWN_SELECTOR, SECRET)),
    });
    expect(result.headers).toBe(plain.headers);
    expect(result.body).toBe(plain.body);
  });
});

describe('404 envelope', () => {
  it.each(notFoundVariants)('%s is a 404 without reflection', async (_name, build) => {
    const state = freshState();
    const result = await call(state, build(state));
    expect(result.status).toBe(404);
    assertNoReflection(result.raw);
  });

  it('is byte-identical to an unknown route for every project refusal', async () => {
    const results = await bodiesOf(notFoundVariants);
    expect(new Set(results.map((result) => result.headers)).size).toBe(1);
    expect(new Set(results.map((result) => result.body))).toEqual(
      new Set([
        '{"error":{"code":"not_found","message":"Route not found","requestId":"<request-id>"}}',
      ]),
    );
    expect(new Set(results.map((result) => result.contentType))).toEqual(
      new Set(['application/json']),
    );
  });

  it('keeps the same headers and body for a browser Accept header', async () => {
    const html = await call(freshState(), {
      path: '/_pb/projects/other',
      headers: { accept: 'text/html', ...bearer(PAT) },
    });
    const plain = await call(freshState(), { path: '/_pb/nowhere' });
    expect(html.status).toBe(404);
    expect(html.headers).toBe(plain.headers);
    expect(html.body).toBe(plain.body);
  });
});

describe('403 envelope', () => {
  it.each(forbiddenVariants)('%s is the generic 403', async (_name, build) => {
    const state = freshState();
    const result = await call(state, build(state));
    expect(result.status).toBe(403);
    assertNoReflection(result.raw);
  });

  it('is byte-identical across every variant after request-id normalization', async () => {
    const results = await bodiesOf(forbiddenVariants);
    expect(new Set(results.map((result) => result.headers)).size).toBe(1);
    expect(new Set(results.map((result) => result.body))).toEqual(
      new Set(['{"error":{"code":"forbidden","message":"Forbidden","requestId":"<request-id>"}}']),
    );
  });
});

describe('HTML denial page', () => {
  const html = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

  it.each(forbiddenVariants)('%s gives the static page without detail', async (_name, build) => {
    const state = freshState();
    const base = build(state);
    const result = await call(state, { ...base, headers: { ...base.headers, ...html } });
    expect(result.status).toBe(403);
    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.raw).toContain(DENIAL_MESSAGE);
    assertNoReflection(result.raw);
    expect(result.raw).not.toMatch(/@|pb_(pat|svc|cst)_|group/i);
  });

  it('is the same page for every variant', async () => {
    const pages = new Set<string>();
    for (const [, build] of forbiddenVariants) {
      const state = freshState();
      const base = build(state);
      const result = await call(state, { ...base, headers: { ...base.headers, ...html } });
      pages.add(`${result.headers}\n${result.body}`);
    }
    expect(pages.size).toBe(1);
  });
});
