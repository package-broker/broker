import { describe, expect, it, vi } from 'vitest';
import { KernelConfigError } from '../kernel/registry.js';
import { createRegistryModule, type RegistryModuleDeps } from './module.js';
import { resolveRegistryConfig } from './registry-config.js';
import type { RegisteredReadHook } from './policy/hooks.js';
import { setAccessContext } from '../authz/access-context.js';
import { orgContext } from '../db/port.js';
import type { RequestContext } from '../plugin.js';

const captured = vi.hoisted(() => ({
  npm: [] as { policy?: unknown }[],
  composer: [] as { policy?: unknown }[],
}));

vi.mock('./npm/routes.js', async (original) => {
  const actual = await original<typeof import('./npm/routes.js')>();
  return {
    ...actual,
    npmRoutes: vi.fn((deps: Parameters<typeof actual.npmRoutes>[0]) => {
      captured.npm.push(deps);
      return actual.npmRoutes(deps);
    }),
  };
});
vi.mock('./composer/routes.js', async (original) => {
  const actual = await original<typeof import('./composer/routes.js')>();
  return {
    ...actual,
    composerRoutes: vi.fn((deps: Parameters<typeof actual.composerRoutes>[0]) => {
      captured.composer.push(deps);
      return actual.composerRoutes(deps);
    }),
  };
});

function deps(enabled: boolean, policy: boolean) {
  const reader = { snapshot: vi.fn(), namespace: vi.fn() };
  const hooks = vi.fn((): readonly RegisteredReadHook[] => []);
  const registry = resolveRegistryConfig(
    enabled ? { policy: { enabled: true } } : undefined,
    'node',
    'https://broker.test',
  );
  const value = {
    runtime: 'node',
    ports: { blob: {}, cache: {}, observability: { log: vi.fn(), counter: vi.fn() } },
    clock: { now: () => new Date('2026-11-02T00:00:00.000Z') },
    codecs: {},
    publicUrl: 'https://broker.test',
    registry,
    outboundPolicy: { allowPrivateHosts: [], runtime: 'node', selfOrigins: [] },
    policyFetch: () => vi.fn(),
    deploymentId: 'dep-1',
    catalogue: {
      reader: {},
      scopedAdmission: { admitScoped: vi.fn() },
      epoch: { read: async () => '1' },
      representationClock: {},
      upstreamState: { get: vi.fn() },
      sources: { get: vi.fn() },
      covers: vi.fn(),
      versionById: vi.fn(),
    },
    ingest: { sessions: {}, apply: {}, writeGuard: vi.fn(), credential: vi.fn() },
    dist: {
      leases: {},
      leaseKey: async (parts: string[]) => parts.join(':'),
      writeGuard: vi.fn(),
      writer: {},
      blobReplacer: {},
      recorder: { record: vi.fn() },
    },
    ...(policy
      ? { policy: { reader, audit: { record: vi.fn() }, hooks, ids: { ulid: () => 'id' } } }
      : {}),
  } as unknown as RegistryModuleDeps;
  return { value, reader, hooks };
}

function actorContext(): RequestContext {
  const ctx = {
    request: new Request('https://broker.test/demo/npm/left-pad'),
    requestId: 'req-1',
    org: orgContext('org-1'),
    principal: { kind: 'user', id: 'user-1' },
    projectId: 'proj-1',
    params: {},
  } as unknown as RequestContext;
  setAccessContext(ctx, {
    principal: { kind: 'user', id: 'user-1' },
    projectId: 'proj-1',
    boundary: 'project',
    sessionId: null,
    token: { kind: 'pat', scope: null, readOnly: true },
    actor: null,
    rateKey: {
      stage: 'authenticated',
      tokenSelector: 'sel',
      principalId: 'user-1',
      routeClass: 'project',
    },
  });
  return ctx;
}

describe('registry policy composition', () => {
  it('keeps every serving handler on its legacy path while the flag is off', () => {
    captured.npm.length = 0;
    captured.composer.length = 0;
    const { value, reader, hooks } = deps(false, true);
    const module = createRegistryModule(value);
    expect(module.policy).toBeUndefined();
    expect('policy' in module).toBe(false);
    expect(captured.npm.map((entry) => 'policy' in entry)).toEqual([false]);
    expect(captured.composer.map((entry) => 'policy' in entry)).toEqual([false]);
    expect(reader.snapshot).not.toHaveBeenCalled();
    expect(hooks).not.toHaveBeenCalled();
  });

  it('hands one policy port to the npm and Composer serving routes when enabled', () => {
    captured.npm.length = 0;
    captured.composer.length = 0;
    const { value } = deps(true, true);
    const module = createRegistryModule(value);
    expect(module.policy).toBeDefined();
    expect(captured.npm[0]?.policy).toBe(module.policy);
    expect(captured.composer[0]?.policy).toBe(module.policy);
  });

  it('reads the compiled hooks per request, so plugins registered after assembly apply', () => {
    const { value, hooks } = deps(true, true);
    const module = createRegistryModule(value);
    expect(hooks).not.toHaveBeenCalled();
    const actor = {
      kind: 'project',
      userId: 'user-1',
      orgId: 'org-1',
      projectId: 'proj-1',
      permissions: new Set(['project:packages:read']),
    } as never;
    const session = module.policy!.open(actorContext(), actor, 'npm', 'metadata');
    expect(session.kind).toBe('metadata');
    expect(hooks).toHaveBeenCalledTimes(1);
  });

  it('refuses an enabled flag that has no policy wiring', () => {
    expect(() => createRegistryModule(deps(true, false).value)).toThrow(KernelConfigError);
  });
});
