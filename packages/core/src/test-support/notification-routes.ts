import type { AuthenticatedSession } from '../auth/session.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { sha256Hex } from '../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../authz/engine.js';
import { PERMISSIONS } from '../authz/permissions.js';
import {
  NotificationRepositoryError,
  type NotificationDeliveryDetail,
  type NotificationEndpointSummary,
  type NotificationReadRepository,
  type NotificationWriteRepository,
} from '../db/notifications.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import { createNotificationEndpointService } from '../notifications/endpoints.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { notificationReadRoutes } from '../api/routes/notifications-read.js';
import { notificationWriteRoutes } from '../api/routes/notifications-write.js';

export const ORIGIN = 'https://broker.test';
export const PROJECT = '01JA0000000000000000000001';
export const OTHER = '01JA0000000000000000000002';
export const ENDPOINT = '01JB0000000000000000000001';
export const FOREIGN = '01JB0000000000000000000002';
export const DELIVERY = '0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b';
export const KEY = 'S'.repeat(42) + 'A';
export const SENTINELS = /SENTINEL|hooks\.example\.com/;
export const SECRET = {
  url: 'https://hooks.example.com/SENTINELPATH?token=SENTINELQUERY',
  headers: [{ name: 'Authorization', value: 'Bearer SENTINELHEADER' }],
  signingKey: KEY,
  template: '{"text":"{{package.name}}","tag":"SENTINELTEMPLATE"}',
};
export const OPTIONS = {
  name: 'Release hook',
  method: 'POST',
  events: ['npm.package.published'],
  packagePattern: '@acme/*',
};

const SECRET_COOKIE = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const clock = fixedClock('2026-11-02T00:00:00.000Z');
const ALL = PERMISSIONS.map((p) => p.name);

function summary(
  projectId: string,
  id: string,
  over: Partial<NotificationEndpointSummary> = {},
): NotificationEndpointSummary {
  return {
    id,
    projectId,
    name: projectId === PROJECT ? 'Release hook' : 'Foreign hook',
    method: 'POST',
    events: ['npm.package.published'],
    packagePattern: '@acme/*',
    state: 'disabled',
    disabledReason: null,
    failureStreak: 0,
    revision: 1,
    destinationConfigured: true,
    signingConfigured: true,
    headersConfigured: true,
    templateConfigured: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

/** The test's `vi.fn`; source files never import vitest. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Spy = <F extends (...args: any[]) => any>(
  impl: F,
) => F & {
  mock: { calls: readonly (readonly unknown[])[] };
  mockRejectedValueOnce(value: unknown): unknown;
};

export interface RouteFixtureOptions {
  readonly permissions?: readonly string[];
  readonly reauth?: boolean;
  readonly transportAvailable?: boolean;
  /** The reauthenticated session is another session of the same user. */
  readonly otherSession?: boolean;
}

/** Kernel with the notification routes over an in-memory store holding two projects' rows. */
export async function notificationRouteFixture(vi: { fn: Spy }, options: RouteFixtureOptions = {}) {
  const rows = new Map<string, NotificationEndpointSummary>([
    [`${PROJECT}/${ENDPOINT}`, summary(PROJECT, ENDPOINT)],
    [`${OTHER}/${FOREIGN}`, summary(OTHER, FOREIGN)],
  ]);
  const retained = new Set(rows.keys());
  const detail: NotificationDeliveryDetail = {
    id: DELIVERY,
    eventId: '01JC0000000000000000000001',
    endpointId: ENDPOINT,
    eventType: 'npm.package.published',
    state: 'failed',
    attempts: 1,
    nextAttemptAt: null,
    lastStatus: 410,
    outcomeCode: 'http_permanent',
    createdAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:00:01.000Z',
    history: [
      {
        attempt: 1,
        outcome: 'failed',
        outcomeCode: 'http_permanent',
        status: 410,
        durationMs: 12,
        startedAt: '2026-11-01T00:00:00.500Z',
        finishedAt: '2026-11-01T00:00:01.000Z',
      },
    ],
  };
  const own = (projectId: string, id: string) => rows.get(`${projectId}/${id}`) ?? null;
  const reads: NotificationReadRepository = {
    listEndpoints: vi.fn(async (_ctx, projectId) => ({
      items: [...rows.values()].filter((row) => row.projectId === projectId),
      next: null,
    })),
    getEndpoint: vi.fn(async (_ctx, projectId, id) => own(projectId, id)),
    listDeliveries: vi.fn(async (_ctx, projectId, endpointId) => {
      if (!retained.has(`${projectId}/${endpointId}`))
        throw new NotificationRepositoryError('not_found');
      return { items: endpointId === ENDPOINT ? [detail] : [], next: null };
    }),
    getDelivery: vi.fn(async (_ctx, projectId, endpointId, deliveryId) =>
      projectId === PROJECT && endpointId === ENDPOINT && deliveryId === DELIVERY ? detail : null,
    ),
  };
  const step = (
    input: { projectId: string; id: string; expectedRevision: number },
    change: Partial<NotificationEndpointSummary>,
  ) => {
    const row = own(input.projectId, input.id);
    if (row === null) throw new NotificationRepositoryError('not_found');
    if (row.revision !== input.expectedRevision) return { changed: false, revision: row.revision };
    rows.set(`${input.projectId}/${input.id}`, {
      ...row,
      ...change,
      revision: row.revision + 1,
    });
    return { changed: true, revision: row.revision + 1 };
  };
  const writes = {
    create: vi.fn<NotificationWriteRepository['create']>(async (_ctx, _fence, input) => {
      rows.set(`${input.projectId}/${input.id}`, summary(input.projectId, input.id));
      retained.add(`${input.projectId}/${input.id}`);
      return { changed: true, revision: 1 };
    }),
    update: vi.fn<NotificationWriteRepository['update']>(async (_ctx, _fence, input) =>
      step(
        input,
        input.configuration === undefined
          ? { name: input.options?.name ?? 'Release hook' }
          : { state: 'disabled', disabledReason: 'configuration_changed' },
      ),
    ),
    enable: vi.fn<NotificationWriteRepository['enable']>(async (_ctx, _fence, input) =>
      step(input, { state: 'enabled', disabledReason: null }),
    ),
    disable: vi.fn<NotificationWriteRepository['disable']>(async (_ctx, _fence, input) =>
      step(input, { state: 'disabled', disabledReason: 'manual' }),
    ),
    delete: vi.fn<NotificationWriteRepository['delete']>(async (_ctx, _fence, input) => {
      const result = step(input, {});
      if (result.changed) rows.delete(`${input.projectId}/${input.id}`);
      return result;
    }),
  };
  const sealed: unknown[] = [];
  const prepare = vi.fn(
    async (
      _ctx: unknown,
      _binding: unknown,
      secret: { headers: readonly unknown[]; template: unknown },
    ) => {
      sealed.push(secret);
      return {
        credentialId: '01JD0000000000000000000001',
        statement: { sql: 'sealed credential row', params: [] },
        headersConfigured: secret.headers.length > 0,
        templateConfigured: secret.template !== null,
      };
    },
  );
  let sequence = 0;
  const ids = { ulid: () => `01JE${String(++sequence).padStart(22, '0')}` };
  const service = createNotificationEndpointService({
    reads,
    writes,
    credentials: { prepare } as never,
    ids,
    clock,
    selfOrigins: [ORIGIN],
    transportAvailable: options.transportAvailable ?? true,
  });
  const authenticated: AuthenticatedSession = {
    principal: { kind: 'user', id: 'user-1' },
    session: {
      id: options.otherSession === true ? 'session-2' : 'session-1',
      userId: 'user-1',
      identityId: null,
      csrfHash: await sha256Hex(CSRF),
      createdAt: '2026-11-02T00:00:00.000Z',
      expiresAt: '2026-11-03T00:00:00.000Z',
      lastSeenAt: '2026-11-02T00:00:00.000Z',
      reauthAt: options.reauth === false ? null : '2026-11-02T00:00:00.000Z',
      user: { id: 'user-1', email: '', displayName: null },
    },
  };
  const sessions = {
    authenticate: vi.fn(async () => authenticated),
    isReauthFresh: vi.fn((session: AuthenticatedSession) => session.session.reauthAt !== null),
  };
  const deps = { ids, clock, clientIp: () => null, reads, service, sessions };
  const permissions = options.permissions ?? ALL;
  const projectOf = (slug: string | null | undefined) =>
    slug === 'demo' ? { id: PROJECT } : slug === 'other' ? { id: OTHER } : null;
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: [...notificationReadRoutes(deps), ...notificationWriteRoutes(deps)],
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: false,
          project: projectOf(input.projectSlug),
          organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
          projectPermissions: [
            'project:read',
            ...permissions.filter((p) => p.startsWith('project:')),
          ],
        }),
        lookupToken: async (_org, input) =>
          Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: 'user-1',
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
              project: projectOf(input.projectSlug),
              organizationPermissions: ALL,
              projectPermissions: ALL.filter((p) => p.startsWith('project:')),
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
        dispatch: (run) => {
          void run();
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
    path: string,
    init: { auth?: 'token' | 'session'; ifMatch?: string; body?: unknown } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN });
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET_COOKIE}`);
      headers.set('x-csrf-token', CSRF);
    }
    if (init.ifMatch !== undefined) headers.set('if-match', init.ifMatch);
    return kernel.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  };
  return { request, reads, writes, prepare, sealed, sessions, rows };
}
