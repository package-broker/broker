import { SESSION_COOKIE } from '../auth/cookies.js';
import { sha256Hex } from '../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import { orgContext, type OrgContext } from '../db/port.js';
import type { PolicyRuleDetail, PolicyRule } from '../db/registry-policy.js';
import type { PolicyVersionFacts } from '../db/package-admin.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { AuditEvent } from '../audit/actions.js';
import { createPolicyInspectService } from '../registry/policy/inspect.js';
import { createPolicyManageService } from '../registry/policy/manage.js';
import { createPolicyMemberService } from '../registry/policy/manage-members.js';
import { createKeyring } from '../secrets/keyring.js';
import { policyReadRoutes } from '../api/routes/policies-read.js';
import { policyWriteRoutes } from '../api/routes/policies-write.js';
import { POLICY_NOW, policyRepositories } from './policy-manage.js';

export const POLICY_ORIGIN = 'https://broker.test';
export const POLICY_PROJECT = '01J0PR0J000000000000000001';
export const POLICY_USER = '01J0P0SER00000000000000001';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);

export interface PolicyRouteFixtureOptions {
  readonly permissions?: readonly string[];
  readonly rules?: PolicyRuleDetail[];
  readonly facts?: PolicyVersionFacts[];
  readonly snapshotRules?: PolicyRule[];
  readonly visible?: boolean;
}

/** The policy routes behind the real kernel and authorization engine, over in-memory repositories. */
export async function policyRouteFixture(options: PolicyRouteFixtureOptions = {}) {
  const permissions = options.permissions ?? [
    'org:packages:read',
    'org:packages:manage',
    'org:settings:write',
    'project:packages:read',
    'project:packages:manage',
    'project:settings:write',
  ];
  const repos = policyRepositories(options.rules);
  let user = POLICY_USER;
  const clock = fixedClock(POLICY_NOW);
  let ids = 0;
  const ulid = () => `01J0R00TE00000000000000${String(ids++).padStart(3, '0')}`;
  const audits: AuditEvent[] = [];
  const manage = createPolicyManageService(repos.deps);
  const fences: unknown[] = [];
  const deps = {
    ids: { ulid },
    clock,
    clientIp: () => null,
    manage,
    members: createPolicyMemberService({ ...repos.deps, manage }),
    inspect: createPolicyInspectService({
      policy: { snapshot: async () => ({ epoch: 'e', rules: options.snapshotRules ?? [] }) },
      facts: { versionFacts: async () => options.facts ?? [] },
      packages: {
        listVersions: async () => (options.visible === false ? null : { items: [], next: null }),
      },
      audit: {
        record: async (_ctx: OrgContext, events: readonly AuditEvent[]) => {
          audits.push(...events);
        },
      },
      ids: { ulid },
      clock,
    }),
    idempotency: {
      find: async (_ctx: OrgContext, principal: string, key: string) => {
        const record = repos.records.get(key);
        return record?.principalKey === principal ? record : null;
      },
    },
  };
  const original = repos.deps.store.create.bind(repos.deps.store);
  repos.deps.store.create = async (ctx, fence, input) => {
    fences.push(fence);
    return original(ctx, fence, input);
  };
  const routes = [...policyReadRoutes(deps), ...policyWriteRoutes(deps)];
  const log = (): void => undefined;
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    packageResolver: { resolve: async () => ({ kind: 'absent' as const }) },
    ports: { organizations: { get: async () => null }, clock, ids: { ulid } },
    resolveOrg: async () => orgContext('org-a'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: user },
          identity: null,
          protectedHolder: false,
          project: input.projectSlug === 'demo' ? { id: POLICY_PROJECT } : null,
          organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
          projectPermissions: permissions.filter((p) => p.startsWith('project:')),
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: () => undefined,
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: POLICY_ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      etag?: string;
      key?: string;
      session?: boolean;
    } = {},
  ) =>
    kernel.fetch(
      new Request(POLICY_ORIGIN + path, {
        method: init.method ?? 'GET',
        headers: {
          origin: POLICY_ORIGIN,
          ...(init.session === false ? {} : { cookie: `${SESSION_COOKIE}=${SECRET}` }),
          'x-csrf-token': CSRF,
          'content-type': 'application/json',
          ...(init.etag === undefined ? {} : { 'if-match': init.etag }),
          ...(init.key === undefined ? {} : { 'idempotency-key': init.key }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  /** Later requests come from another user's session. */
  const actAs = (id: string): void => {
    user = id;
  };
  return { request, repos, routes, deps, audits, fences, actAs };
}
