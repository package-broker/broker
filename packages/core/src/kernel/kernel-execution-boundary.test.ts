import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { EngineSessionAccess } from '../authz/engine.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type { CatalogueReader, PackageVisibility, PackageVisibilityPort } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { OnDemandFill } from '../ingest/on-demand.js';
import { contextPackageActorOf, setContextPackageActor } from '../internal/package-actor.js';
import type { PluginDefinition, PluginPorts, RequestContext } from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import type { RepresentationClock } from '../registry/conditional.js';
import { composerRoutes } from '../registry/composer/routes.js';
import * as packageActorModule from '../internal/package-actor.js';
import { createKernel } from './kernel.js';
import { waitUntilOf } from './execution.js';

const org = orgContext('org-1');
const read = 'project:packages:read';
const write = 'project:packages:write';
const cookie = { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` };
const ports: PluginPorts = {
  organizations: { get: async () => null },
  clock: fixedClock('2026-10-20T00:00:00Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};
const admission: PackageVisibility = {
  kind: 'proxy_admissible',
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'acme/lib',
  sourceIds: ['source-1'],
};

function engine() {
  const session: EngineSessionAccess = {
    session: { id: 'session-1', csrfHash: '' },
    user: { id: 'user-1' },
    identity: null,
    protectedHolder: false,
    project: { id: 'proj-1' },
    organizationPermissions: [],
    projectPermissions: [read, write],
  };
  return createAuthorizationEngine({
    access: {
      lookupSession: async (_ctx, input) => ({
        ...session,
        project:
          input.projectSlug === 'foreign'
            ? { id: 'proj-foreign' }
            : input.projectSlug === 'demo'
              ? session.project
              : null,
        projectPermissions: input.projectSlug === 'foreign' ? [] : session.projectPermissions,
      }),
      lookupToken: async () => {
        throw new Error('unused');
      },
      touchSession: async () => true,
      touchToken: async () => true,
    },
    tokenUse: {
      keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
      nowMs: () => 0,
      dispatch: () => undefined,
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: 'https://broker.test',
    providerAnchors: async () => [],
  });
}

async function composerHarness(resolve?: PackageVisibilityPort['resolve']) {
  const resolveVersions = vi.fn(async () => null);
  const admitProxy = vi.fn(async () => []);
  const reader = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'resolveVersions'
          ? resolveVersions
          : property === 'admitProxy'
            ? admitProxy
            : vi.fn(() => {
                throw new Error('reader must not run');
              }),
    },
  ) as CatalogueReader;
  const access = createPackageAccess(reader);
  const resolver = vi.fn<PackageVisibilityPort['resolve']>(resolve ?? access.resolve);
  const ensure = vi.fn<OnDemandFill['ensure']>(async () => ({ kind: 'not_found' }));
  const clock: RepresentationClock = {
    advance: async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: '2026-10-01T00:00:00Z',
    }),
  };
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports,
    authorization: engine(),
    ecosystemRoutes: composerRoutes({
      access: { ...access, resolve: resolver },
      fill: { ensure },
      dist: { serve: async () => ({ kind: 'not_found' }) },
      clock,
      publicUrl: 'https://broker.test',
    }),
    packageResolver: { resolve: resolver },
    resolveOrg: async () => org,
    health: async () => true,
    log: () => undefined,
  });
  return {
    ensure,
    resolver,
    resolveVersions,
    admitProxy,
    get: (path: string, anonymous = false) =>
      kernel.fetch(new Request(`https://broker.test${path}`, { headers: anonymous ? {} : cookie })),
    getWith: (path: string, method: string) =>
      kernel.fetch(new Request(`https://broker.test${path}`, { method, headers: cookie })),
  };
}

describe('kernel Composer p2 boundary', () => {
  it('answers anonymous requests 401 before the handler, resolver or fill', async () => {
    const h = await composerHarness();
    const response = await h.get('/demo/p2/acme/lib.json', true);
    expect(response.status).toBe(401);
    expect(h.resolver).not.toHaveBeenCalled();
    expect(h.resolveVersions).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'unknown'])(
    'answers 404 for a project the caller cannot read (%s)',
    async (project) => {
      const h = await composerHarness();
      const baseline = await h.get('/unknown/p2/acme/lib.json');
      const response = await h.get(`/${project}/p2/acme/lib.json`);
      expect(response.status).toBe(404);
      const stripped = async (r: Response) => (await r.text()).replace(/"requestId":"[^"]*"/, '');
      expect(await stripped(response)).toBe(await stripped(baseline));
      expect(h.resolver).not.toHaveBeenCalled();
      expect(h.ensure).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for an unadmitted name and never calls ensure', async () => {
    const h = await composerHarness();
    const response = await h.get('/demo/p2/acme/lib.json');
    expect(response.status).toBe(404);
    expect(h.resolver).toHaveBeenCalledTimes(1);
    expect(h.resolveVersions).toHaveBeenCalledTimes(1);
    expect(h.admitProxy).toHaveBeenCalledTimes(1);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('reaches ensure for an admitted name with the actor used for the decision', async () => {
    const h = await composerHarness(async () => admission);
    expect((await h.get('/demo/p2/acme/lib.json')).status).toBe(404);
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.calls[0]![0]).toBe(h.resolver.mock.calls[0]![0]);
  });

  it.each(['lib.txt', 'lib', 'lib.json.bak', '~dev.json'])(
    'answers 404 for the bad p2 file %s without calling the resolver',
    async (file) => {
      const h = await composerHarness(async () => admission);
      const response = await h.get(`/demo/p2/acme/${file}`);
      expect(response.status).toBe(404);
      expect(h.resolver).not.toHaveBeenCalled();
      expect(h.ensure).not.toHaveBeenCalled();
    },
  );
});

async function pluginHarness(handler: (ctx: RequestContext) => Response | Promise<Response>) {
  const logs: unknown[] = [];
  const resolve = vi.fn<PackageVisibilityPort['resolve']>(async () => admission);
  const plugin: PluginDefinition = {
    id: 'execution-test',
    package: '@test/execution-test',
    apiVersion: 3,
    platforms: ['node'],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/p/:project/pkg/:name',
        boundary: 'package',
        permission: read,
        package: { ecosystem: 'composer', name: () => 'acme/lib', fetchOnAdmission: true },
        handler,
      });
      registry.route({
        method: 'GET',
        path: '/p/:project/plain',
        boundary: 'project',
        permission: read,
        handler,
      });
    },
  };
  const kernel = await createKernel({
    platform: 'node',
    plugins: [plugin],
    ports,
    authorization: engine(),
    packageResolver: { resolve },
    resolveOrg: async () => org,
    health: async () => true,
    log: (entry) => {
      logs.push(entry);
    },
  });
  return { kernel, resolve, logs };
}

describe('kernel package-actor accessor', () => {
  it('exposes exactly the actor the visibility decision used', async () => {
    let seen: ReturnType<typeof contextPackageActorOf> | undefined;
    let ctxSeen: RequestContext | undefined;
    const { kernel, resolve } = await pluginHarness((ctx) => {
      ctxSeen = ctx;
      seen = contextPackageActorOf(ctx);
      return new Response('ok');
    });
    const response = await kernel.fetch(
      new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }),
    );
    expect(response.status).toBe(200);
    expect(seen).toBe(resolve.mock.calls[0]![0]);
    expect(seen).toMatchObject({
      kind: 'project',
      userId: 'user-1',
      orgId: org.orgId,
      projectId: ctxSeen!.projectId,
    });
    expect(Object.isFrozen(seen)).toBe(true);
    expect([...seen!.permissions]).toEqual([read]);
  });

  it('exposes the project actor on a project-boundary route', async () => {
    let seen: ReturnType<typeof contextPackageActorOf> | undefined;
    const { kernel } = await pluginHarness((ctx) => {
      seen = contextPackageActorOf(ctx);
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/plain', { headers: cookie }));
    expect(seen).toMatchObject({ projectId: 'proj-1', userId: 'user-1' });
  });

  it('never yields an actor for a context the kernel did not build, and sets once', async () => {
    let ctxSeen: RequestContext | undefined;
    const { kernel } = await pluginHarness((ctx) => {
      ctxSeen = ctx;
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }));
    expect(contextPackageActorOf({ ...ctxSeen! })).toBeNull();
    expect(contextPackageActorOf({} as RequestContext)).toBeNull();
    const actor = contextPackageActorOf(ctxSeen!)!;
    expect(() => setContextPackageActor(ctxSeen!, { ...actor, projectId: 'other' })).toThrow();
    expect(contextPackageActorOf(ctxSeen!)).toBe(actor);
  });

  it('keeps the context keys unchanged', async () => {
    let keys: string[] = [];
    const { kernel } = await pluginHarness((ctx) => {
      keys = Object.keys(ctx).sort();
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }));
    expect(keys).toEqual(
      ['request', 'requestId', 'org', 'principal', 'projectId', 'params', 'ports'].sort(),
    );
  });
});

describe('kernel actor consistency', () => {
  it.each(['package', 'plain'] as const)(
    'fails closed with 503 on a mismatched actor for the %s route',
    async (kind) => {
      const real = packageActorModule.packageActorOf;
      const spy = vi.spyOn(packageActorModule, 'packageActorOf').mockImplementation((request) => {
        const actor = real(request);
        return actor === null ? null : { ...actor, projectId: 'other' };
      });
      try {
        const handler = vi.fn(() => new Response('ok'));
        const { kernel, resolve } = await pluginHarness(handler);
        const response = await kernel.fetch(
          new Request(`https://broker.test/p/demo/${kind === 'package' ? 'pkg/x' : 'plain'}`, {
            headers: cookie,
          }),
        );
        expect(response.status).toBe(503);
        expect(handler).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('kernel admission rules', () => {
  it('answers HEAD for an admissible name 404 without fetching', async () => {
    const h = await composerHarness(async () => admission);
    const response = await h.getWith('/demo/p2/acme/lib.json', 'HEAD');
    expect(response.status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('answers 404 for an admission on a binding without fetchOnAdmission', async () => {
    const h = await composerHarness(async () => admission);
    const response = await h.get('/demo/dist/acme/lib/01ARZ3NDEKTSV4RRFFQ69G5FAV.1.zip');
    expect(response.status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
  });
});

describe('kernel waitUntil port', () => {
  it('logs a warning for deferred work that rejects', async () => {
    const { kernel, logs } = await pluginHarness((ctx) => {
      waitUntilOf(ctx)(Promise.reject(new Error('secret detail')));
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }));
    await kernel.idle();
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'http.error', error_name: 'Error' }),
    );
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });

  it('stops waiting at the idle deadline', async () => {
    const { kernel } = await pluginHarness((ctx) => {
      waitUntilOf(ctx)(new Promise<void>(() => undefined));
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }));
    await expect(kernel.idle(20)).resolves.toBeUndefined();
  });

  it('forwards handler work to the runtime port and drains it on idle', async () => {
    const forwarded: Promise<unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const { kernel } = await pluginHarness((ctx) => {
      waitUntilOf(ctx)(
        gate.then(() => {
          finished = true;
        }),
      );
      return new Response('ok');
    });
    const response = await kernel.fetch(
      new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }),
      { waitUntil: (promise) => forwarded.push(promise) },
    );
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(finished).toBe(false);
    const idle = kernel.idle();
    release();
    await idle;
    expect(finished).toBe(true);
  });

  it('tracks deferred work without a runtime port and swallows its rejection', async () => {
    let finished = false;
    const { kernel } = await pluginHarness((ctx) => {
      waitUntilOf(ctx)(Promise.reject(new Error('boom')));
      waitUntilOf(ctx)(
        new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
          finished = true;
        }),
      );
      return new Response('ok');
    });
    await kernel.fetch(new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }));
    await expect(kernel.idle()).resolves.toBeUndefined();
    expect(finished).toBe(true);
  });

  it('survives a runtime port that throws', async () => {
    let finished = false;
    const { kernel } = await pluginHarness((ctx) => {
      waitUntilOf(ctx)(
        Promise.resolve().then(() => {
          finished = true;
        }),
      );
      return new Response('ok');
    });
    const response = await kernel.fetch(
      new Request('https://broker.test/p/demo/pkg/x', { headers: cookie }),
      {
        waitUntil: () => {
          throw new Error('closed');
        },
      },
    );
    expect(response.status).toBe(200);
    await kernel.idle();
    expect(finished).toBe(true);
  });

  it('falls back to a detached no-op for a context the kernel did not build', async () => {
    const rejected = Promise.reject(new Error('boom'));
    expect(() => waitUntilOf({} as RequestContext)(rejected)).not.toThrow();
    await Promise.resolve();
  });
});
