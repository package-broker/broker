import { setAccessContext } from '../authz/access-context.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { createPackageAccess, type PackageAccess } from '../catalogue/package-access.js';
import type { PolicyRule } from '../db/registry-policy.js';
import { ulid } from '../ids.js';
import type { OnDemandFill } from '../ingest/on-demand.js';
import { setContextPackageActor } from '../internal/package-actor.js';
import { setResolvedPackage } from '../internal/package-context.js';
import type { HookMap, RequestContext, RouteDefinition } from '../plugin.js';
import { composerRoutes } from '../registry/composer/routes.js';
import type { RepresentationClock } from '../registry/conditional.js';
import type { DistService } from '../registry/dist-service.js';
import { npmRoutes } from '../registry/npm/routes.js';
import { createPolicyServing } from '../registry/policy/serving.js';
import {
  catalogueVersion,
  memoryCatalogue,
  type CatalogueEntry,
} from './registry-policy-catalogue.js';
import { projectActor, sessionSetup } from './registry-policy-session.js';

export const NPM_UA = 'npm/10.2.4 node/v20.11.0 linux x64 workspaces/false';
export const COMPOSER_UA = 'Composer/2.7.1 (Linux; 6.1; PHP 8.3.0)';

export function composerVersionId(n: number): string {
  return `01J0V0000000000000000${String(n).padStart(5, '0')}`;
}

/** A Composer package whose versions render as zip dists. */
export function composerEntry(count: number, key = 'acme/lib'): CatalogueEntry {
  const versions = Array.from({ length: count }, (_, n) =>
    catalogueVersion(n, {
      versionId: composerVersionId(n),
      versionNormalized: `1.0.${String(n)}.0`,
      distType: 'zip',
      metadataJson: JSON.stringify({ name: key, dist: { reference: `ref${String(n)}` } }),
    }),
  );
  return {
    pkg: {
      projectId: 'P',
      ecosystem: 'composer',
      key,
      packageId: `K-${key.replace('/', '-')}`,
      sourceId: 'S',
      rev: 1,
      modifiedAt: '2025-12-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      listingComplete: true,
      cacheEpoch: 'e1',
    },
    versions,
    tags: {},
  };
}

export interface PolicyHttpSetup {
  readonly entries: CatalogueEntry[];
  readonly rules?: PolicyRule[];
  readonly hooks?: Array<HookMap['registry.read']>;
  readonly auditFails?: boolean;
  /** False builds the routes exactly as with `registry.policy.enabled` off. */
  readonly policy?: boolean;
  readonly serve?: DistService['serve'];
  readonly openNamespace?: boolean;
  /** The policy reader also answers namespace reads. */
  readonly namespace?: boolean;
  /** Keys absent from the catalogue that a proxy source would admit. */
  readonly admissible?: readonly string[];
}

/**
 * The npm and Composer routes over an in-memory catalogue, called directly with an authorized
 * request context, with or without the policy port.
 */
export function policyHttp(setup: PolicyHttpSetup) {
  const actor: ProjectActor = projectActor();
  const catalogue = memoryCatalogue(setup.entries, {
    openNamespace: setup.openNamespace ?? false,
    ...(setup.admissible === undefined ? {} : { admissible: setup.admissible }),
  });
  const raw: PackageAccess = createPackageAccess(catalogue.reader);
  const policy = sessionSetup({
    actor,
    rules: setup.rules ?? [],
    ...(setup.hooks ? { hooks: setup.hooks } : {}),
    ...(setup.auditFails ? { auditFails: true } : {}),
    ...(setup.namespace ? { namespace: true } : {}),
  });
  const serving = setup.policy === false ? undefined : createPolicyServing(policy.deps);
  const fills: string[] = [];
  const fill: OnDemandFill = {
    ensure: async (_actor, input) => {
      fills.push(input.key);
      return { kind: 'serve', stale: false };
    },
  };
  const clockCalls: string[] = [];
  const representationClock: RepresentationClock = {
    advance: async (_ctx, input) => {
      clockCalls.push(input.form);
      return { stale: false, validator: input.validator, lastModified: '2025-12-01T00:00:00Z' };
    },
  };
  const served: string[] = [];
  const serve: DistService['serve'] =
    setup.serve ??
    (async (_actor, request, options) => {
      const target = await (options?.policy?.access ?? raw).dist(
        _actor,
        request.ecosystem,
        request.key,
        { by: 'id', versionId: request.versionId, revision: Number(request.revision) },
      );
      if (target === null) return { kind: 'not_found' };
      served.push(target.versionId);
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${target.versionId}.${String(target.revision)}.${target.fetch.distType ?? 'bin'}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      return { kind: 'file', headers, size: 3, body: new Response('tgz').body! };
    });
  const npm = npmRoutes({
    access: raw,
    dist: { serve },
    onDemand: fill,
    reresolve: async () => ({ kind: 'absent' }),
    handleOf: async () => null,
    publicUrl: 'https://broker.test',
    codecs: { gunzip: () => new TransformStream() },
    audit: { enabled: false },
    defer: () => undefined,
    ...(serving === undefined ? {} : { policy: serving }),
  });
  const composer = composerRoutes({
    access: raw,
    fill,
    dist: { serve },
    clock: representationClock,
    publicUrl: 'https://broker.test',
    ...(serving === undefined ? {} : { policy: serving }),
  });

  async function context(
    url: string,
    params: Record<string, string>,
    resolve: { ecosystem: 'npm' | 'composer'; name: string } | null,
    headers: Record<string, string>,
  ): Promise<RequestContext> {
    const ctx = {
      request: new Request(url, { headers }),
      requestId: ulid(),
      org: { orgId: actor.orgId },
      principal: { kind: 'user', id: actor.userId },
      projectId: actor.projectId,
      params,
      ports: { clock: policy.time.clock },
    } as unknown as RequestContext;
    setAccessContext(ctx, {
      principal: { kind: 'user', id: actor.userId },
      projectId: actor.projectId,
      boundary: 'project',
      sessionId: null,
      token: { kind: 'pat', scope: null, readOnly: false },
      actor: null,
      rateKey: {
        stage: 'authenticated',
        tokenSelector: 't',
        principalId: actor.userId,
        routeClass: 'project',
      },
    });
    setContextPackageActor(ctx, actor);
    if (resolve !== null) {
      const outcome = await raw.resolve(actor, resolve.ecosystem, resolve.name);
      if (outcome.kind !== 'absent') setResolvedPackage(ctx, outcome);
    }
    return ctx;
  }

  function route(routes: readonly RouteDefinition[], path: string): RouteDefinition {
    const found = routes.find((entry) => entry.method === 'GET' && entry.path === path);
    if (found === undefined) throw new Error(`missing route ${path}`);
    return found;
  }

  /** GET `/demo/npm/<segments>`; the package is resolved like the kernel would. */
  async function npmGet(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const segments = path.replace(/^\//, '').split('/');
    const all = { 'user-agent': NPM_UA, ...headers };
    if (segments[0] === '-' && segments[1] === 'v1') {
      return route(npm, '/:project/npm/-/v1/search').handler(
        await context(`https://broker.test/demo/npm${path}`, { project: 'demo' }, null, all),
      );
    }
    if (segments[0] === '-' && segments[1] === 'package') {
      const name = decodeURIComponent(segments[2]!);
      return route(npm, '/:project/npm/-/package/:a/dist-tags').handler(
        await context(
          `https://broker.test/demo/npm${path}`,
          { project: 'demo', a: name },
          { ecosystem: 'npm', name },
          all,
        ),
      );
    }
    const names = ['a', 'b', 'c', 'd'].slice(0, segments.length);
    const params = Object.fromEntries([
      ['project', 'demo'],
      ...names.map((name, index) => [name, decodeURIComponent(segments[index]!)]),
    ]) as Record<string, string>;
    return route(npm, `/:project/npm/${names.map((name) => `:${name}`).join('/')}`).handler(
      await context(
        `https://broker.test/demo/npm${path}`,
        params,
        { ecosystem: 'npm', name: decodeURIComponent(segments[0]!) },
        all,
      ),
    );
  }

  async function composerGet(path: string, headers: Record<string, string> = {}) {
    const all = { 'user-agent': COMPOSER_UA, ...headers };
    const url = `https://broker.test/demo${path}`;
    if (path === '/packages.json') {
      return route(composer, '/:project/packages.json').handler(
        await context(url, { project: 'demo' }, null, all),
      );
    }
    const p2 = /^\/p2\/([^/]+)\/([^/]+)$/.exec(path);
    if (p2 !== null) {
      const name = `${p2[1]!}/${p2[2]!.replace(/(~dev)?\.json$/, '')}`;
      return route(composer, '/:project/p2/:vendor/:file').handler(
        await context(
          url,
          { project: 'demo', vendor: p2[1]!, file: p2[2]! },
          { ecosystem: 'composer', name },
          all,
        ),
      );
    }
    const dist = /^\/dist\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)!;
    return route(composer, '/:project/dist/:vendor/:name/:file').handler(
      await context(
        url,
        { project: 'demo', vendor: dist[1]!, name: dist[2]!, file: dist[3]! },
        { ecosystem: 'composer', name: `${dist[1]!}/${dist[2]!}` },
        all,
      ),
    );
  }

  return {
    actor,
    catalogue,
    policy,
    fills,
    served,
    clockCalls,
    npmGet,
    composerGet,
  };
}
