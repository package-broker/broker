import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { deriveVisibility, type VisibilityConfig } from '@package-broker/core/catalogue/visibility';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import {
  completeVersionListing,
  type HistoryBasis,
} from '@package-broker/core/catalogue/version-rules';
import type {
  CatalogueReader,
  CatalogueWriteGuard,
  CatalogueWriter,
  SyncPackageInput,
  VersionInput,
  VisibilityStore,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { createCatalogueReconciler } from '../repositories/catalogue-reconcile.js';
import { createCatalogueWriter, createVisibilityStore } from '../repositories/catalogue-writer.js';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedCatalogueRaceDatabase {
  readonly executor: SqlExecutor;
  second(): Promise<SqlExecutor>;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedCatalogueRaceDatabase>;
export type Wrap = (executor: SqlExecutor) => SqlExecutor;
export type Order = 'first-then-second' | 'second-then-first';
const ORDERS: readonly Order[] = ['first-then-second', 'second-then-first'];

const HISTORY = '2020-01-01T00:00:00.000Z';
const PROJECT = 'project';
const SOURCE = 'source';
const DIGEST = 'd'.repeat(64) as Sha256;

const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const fence = () =>
  mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {});

interface Actor {
  readonly executor: SqlExecutor;
  readonly writer: CatalogueWriter;
  readonly store: VisibilityStore;
  readonly reader: CatalogueReader;
  readonly guard: CatalogueWriteGuard;
}

interface World {
  readonly org: OrgContext;
  readonly first: SqlExecutor;
  readonly second: SqlExecutor;
  readonly guard: CatalogueWriteGuard;
  actor(executor: SqlExecutor, guard?: CatalogueWriteGuard): Actor;
  takeover(): CatalogueWriteGuard;
  rows(sql: string, ...params: Statement['params']): Promise<Record<string, unknown>[]>;
}

type Op<T> = (actor: Actor) => Promise<T>;

interface Gate {
  readonly executor: SqlExecutor;
  readonly parked: Promise<void>;
  release(): void;
}

function gateBeforeFirstCall(inner: SqlExecutor): Gate {
  let signal: () => void = () => undefined;
  let open: () => void = () => undefined;
  const parked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let used = false;
  const hold = async () => {
    if (used) return;
    used = true;
    signal();
    await opened;
  };
  return {
    executor: {
      driver: inner.driver,
      all: async (statement) => {
        await hold();
        return inner.all(statement);
      },
      batch: async (statements) => {
        await hold();
        return inner.batch(statements);
      },
    },
    parked,
    release: open,
  };
}

const version = (n: number): VersionInput => ({
  version: `1.0.${String(n)}`,
  versionNormalized: `1.0.${String(n)}`,
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  history: { at: HISTORY, basis: 'release_date' as HistoryBasis },
});

function discover(
  w: World,
  key: string,
  numbers: readonly number[] = [0],
  extra: Partial<SyncPackageInput> = {},
): Op<{ packageId: string }> {
  return (a) =>
    a.writer.syncPackage(w.org, a.guard, {
      sourceId: SOURCE,
      ecosystem: 'npm',
      key,
      description: null,
      versions: numbers.map(version),
      ...extra,
    });
}

async function seed(opened: OpenedCatalogueRaceDatabase, wrap: Wrap = (e) => e): Promise<World> {
  const first = opened.executor;
  const second = await opened.second();
  const { a: org } = await seedTwoOrganizations(first);
  const now = new Date().toISOString();
  const address = ['admin', 'example.test'].join('@');
  await first.batch([
    st(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      org.orgId,
    ),
    st(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
      org.orgId,
    ),
    st(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
      org.orgId,
    ),
    st(
      "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
      org.orgId,
      address,
    ),
    st(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      org.orgId,
    ),
    st(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'subject', ?, 1, ?)",
      org.orgId,
      address,
      now,
    ),
    st(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      org.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
      now,
      now,
    ),
    st(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
      org.orgId,
    ),
    ...['org:sources:write', 'project:sources:write', 'project:packages:manage'].map((p) =>
      st(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', ?)",
        org.orgId,
        p,
      ),
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES ('grant', ?, 'email', ?, 'organization', 'role', ?, ?)",
      org.orgId,
      address,
      now,
      now,
    ),
  ]);
  const guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
  return {
    org,
    first,
    second,
    guard,
    actor: (raw, actorGuard = guard) => {
      const executor = wrap(raw);
      return {
        executor,
        writer: createCatalogueWriter(executor),
        store: createVisibilityStore(executor, {
          providerAnchors: [
            {
              provider: 'oidc',
              anchor: 'oidc:https://idp.example.test',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ],
        }),
        reader: createCatalogueReader(executor),
        guard: actorGuard,
      };
    },
    takeover: () => createCatalogueWriteGuard(org, { id: 'job', owner: 'successor', fence: 2 }),
    async rows(sql, ...params) {
      return (await first.batch([st(sql, org.orgId, ...params)]))[0]!.rows;
    },
  };
}

/** Runs `a` on the first connection and `b` on the second; in the reverse order `a` is already built and parked at its first database call when `b` completes. */
async function race<A, B>(
  w: World,
  order: Order,
  a: Op<A>,
  b: Op<B>,
): Promise<{ readonly a: A; readonly b: B }> {
  if (order === 'first-then-second') {
    const resultA = await a(w.actor(w.first));
    return { a: resultA, b: await b(w.actor(w.second)) };
  }
  const gate = gateBeforeFirstCall(w.first);
  const pending = a(w.actor(gate.executor));
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await Promise.race([gate.parked, outcome]);
  const resultB = await b(w.actor(w.second));
  gate.release();
  const settled = await outcome;
  if ('error' in settled) throw settled.error;
  return { a: settled.value, b: resultB };
}

async function raceSettled<A, B>(
  w: World,
  order: Order,
  a: Op<A>,
  b: Op<B>,
): Promise<{ readonly a: PromiseSettledResult<A>; readonly b: B }> {
  const settle: Op<PromiseSettledResult<A>> = (actor) =>
    a(actor).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    );
  return race(w, order, settle, b);
}

async function derivedConfig(w: World): Promise<VisibilityConfig> {
  const orgId = w.org.orgId;
  const pick = (table: string) => w.rows(`SELECT * FROM ${table} WHERE org_id = ?`);
  const [projects, sources, packages, attached, patterns, explicit, names] = await Promise.all([
    pick('project'),
    pick('source'),
    pick('package'),
    pick('project_source'),
    pick('project_package_pattern'),
    w.rows("SELECT * FROM project_package WHERE org_id = ? AND origin = 'explicit'"),
    pick('registered_name'),
  ]);
  return {
    projects: projects.map((p) => ({
      id: p['id'] as string,
      orgId,
      active: p['status'] === 'active',
    })),
    sources: sources.map((s) => ({
      id: s['id'] as string,
      orgId,
      ecosystem: s['ecosystem'] as 'npm' | 'composer',
      type: s['type'] as 'npm_registry',
      ownerProjectId: s['project_id'] as string | null,
      removalPolicy: s['removal_policy'] as 'flag' | 'exclude',
      defaultVisible: s['default_visible_to_new_projects'] as 0 | 1,
    })),
    packages: packages.map((p) => ({
      id: p['id'] as string,
      orgId,
      sourceId: p['source_id'] as string,
      ecosystem: p['ecosystem'] as 'npm' | 'composer',
      key: p['name'] as string,
      status: p['status'] as 'active' | 'removed_upstream',
      visible: p['visible_to_new_projects'] as 0 | 1,
    })),
    attachments: attached.map((a) => {
      const own = patterns.filter(
        (p) => p['project_id'] === a['project_id'] && p['source_id'] === a['source_id'],
      );
      const of = (effect: string) =>
        own.filter((p) => p['effect'] === effect).map((p) => p['pattern'] as string);
      return {
        projectId: a['project_id'] as string,
        sourceId: a['source_id'] as string,
        precedence: a['precedence'] as number,
        includes: of('include'),
        excludes: of('exclude'),
      };
    }),
    explicit: explicit.map((e) => ({
      projectId: e['project_id'] as string,
      packageId: e['package_id'] as string,
    })),
    registeredNames: names.map((n) => ({
      orgId,
      ecosystem: n['ecosystem'] as 'npm' | 'composer',
      pattern: n['pattern'] as string,
    })),
  };
}

/** Compares project_package with the pure oracle and returns the visible keys with their origins. */
async function expectDerived(w: World): Promise<string[]> {
  const config = await derivedConfig(w);
  const keyOf = new Map(config.packages.map((p) => [p.id, p.key]));
  const expected = deriveVisibility(config).map(
    (r) => `${r.projectId}:${keyOf.get(r.packageId) ?? '?'}:${r.origin}`,
  );
  const actual = (
    await w.rows('SELECT project_id, package_id, origin FROM project_package WHERE org_id = ?')
  ).map(
    (r) =>
      `${r['project_id'] as string}:${keyOf.get(r['package_id'] as string) ?? '?'}:${r['origin'] as string}`,
  );
  expect(actual.sort()).toEqual(expected.sort());
  return actual.sort();
}

type Case = (w: World, order: Order) => Promise<void>;

async function attachedWorld(w: World): Promise<void> {
  const a = w.actor(w.first);
  await a.store.attachSource(w.org, fence(), { projectId: PROJECT, sourceId: SOURCE });
}

const cases: Record<string, Case> = {
  async attachVsDiscovery(w, order) {
    await discover(w, 'existing')(w.actor(w.first));
    const { a } = await race(
      w,
      order,
      (actor) => actor.store.attachSource(w.org, fence(), { projectId: PROJECT, sourceId: SOURCE }),
      discover(w, 'fresh'),
    );
    expect(a).toMatchObject({ ok: true });
    expect(await expectDerived(w)).toEqual([
      'project:existing:subscription',
      'project:fresh:subscription',
    ]);
  },

  async patternAddVsDiscovery(w, order) {
    await attachedWorld(w);
    await discover(w, 'widget-a')(w.actor(w.first));
    await discover(w, 'other-a')(w.actor(w.first));
    const { a } = await race(
      w,
      order,
      (actor) =>
        actor.store.addPattern(w.org, fence(), {
          projectId: PROJECT,
          sourceId: SOURCE,
          pattern: 'widget-*',
          effect: 'include',
        }),
      async (actor) => {
        await discover(w, 'widget-b')(actor);
        await discover(w, 'other-b')(actor);
      },
    );
    expect(a).toMatchObject({ ok: true });
    expect(await expectDerived(w)).toEqual([
      'project:widget-a:pattern',
      'project:widget-b:pattern',
    ]);
  },

  async flagFlipVsDiscovery(w, order) {
    await attachedWorld(w);
    const { packageId } = await discover(w, 'widget')(w.actor(w.first));
    const { a } = await race(
      w,
      order,
      (actor) =>
        actor.store.setPackageFlag(w.org, fence(), { packageId, visibleToNewProjects: false }),
      async (actor) => {
        await discover(w, 'widget', [0, 1])(actor);
        await discover(w, 'fresh')(actor);
      },
    );
    expect(a).toMatchObject({ ok: true });
    expect(await expectDerived(w)).toEqual(['project:fresh:subscription']);
  },

  async projectRestoreVsDiscovery(w, order) {
    await attachedWorld(w);
    await discover(w, 'widget')(w.actor(w.first));
    await w.first.batch([
      st("UPDATE project SET status = 'archived' WHERE org_id = ? AND id = 'project'", w.org.orgId),
    ]);
    await discover(w, 'archived-fresh')(w.actor(w.first));
    await race(
      w,
      order,
      async (actor) => {
        await actor.executor.batch([
          st(
            "UPDATE project SET status = 'active' WHERE org_id = ? AND id = 'project'",
            w.org.orgId,
          ),
        ]);
      },
      discover(w, 'fresh'),
    );
    expect(await expectDerived(w)).toEqual([
      'project:archived-fresh:subscription',
      'project:fresh:subscription',
      'project:widget:subscription',
    ]);
  },

  async detachBetweenPages(w, order) {
    await attachedWorld(w);
    await discover(w, 'widget', [0, 1])(w.actor(w.first));
    const query = { projectId: PROJECT, ecosystem: 'npm' as const, key: 'widget', limit: 1 };
    const page = await w.actor(w.first).reader.resolveVersions(w.org, query);
    if (page === null || 'changed' in page || page.next === null) throw new Error('no first page');
    const { binding, next } = page;
    const { a } = await race(
      w,
      order,
      (actor) => actor.reader.resolveVersions(w.org, { ...query, binding, after: next }),
      (actor) => actor.store.detachSource(w.org, fence(), { projectId: PROJECT, sourceId: SOURCE }),
    );
    if (order === 'second-then-first') {
      expect(a).toEqual({ changed: true });
    } else {
      expect(a).not.toBeNull();
      expect(a).not.toHaveProperty('changed');
    }
    expect(await expectDerived(w)).toEqual([]);
    expect(
      await w.actor(w.first).reader.resolveVersions(w.org, { ...query, binding, after: next }),
    ).toEqual({ changed: true });
  },

  async staleJobAfterTakeover(w, order) {
    await attachedWorld(w);
    const successor = w.takeover();
    const takeover: Op<unknown> = async (actor) => {
      await w.second.batch([
        st(
          "UPDATE job SET lease_owner = 'successor', fence = 2 WHERE org_id = ? AND id = 'job'",
          w.org.orgId,
        ),
      ]);
      return discover(w, 'fresh', [1])({ ...actor, guard: successor });
    };
    const { a } = await raceSettled(w, order, discover(w, 'fresh', [0]), takeover);
    expect(a.status).toBe(order === 'first-then-second' ? 'fulfilled' : 'rejected');
    const versions = await w.rows(
      "SELECT version FROM version WHERE org_id = ? AND package_id IN (SELECT id FROM package WHERE org_id = ? AND name = 'fresh') ORDER BY version",
      w.org.orgId,
    );
    expect(versions.map((v) => v['version'])).toEqual(
      order === 'first-then-second' ? ['1.0.0', '1.0.1'] : ['1.0.1'],
    );
    expect(await w.rows("SELECT id FROM package WHERE org_id = ? AND name = 'fresh'")).toHaveLength(
      1,
    );
    expect(await expectDerived(w)).toEqual(['project:fresh:subscription']);
  },

  async twoSyncsOfOnePackage(w, order) {
    await attachedWorld(w);
    const { a, b } = await race(
      w,
      order,
      discover(w, 'widget', [0, 1]),
      discover(w, 'widget', [1, 2]),
    );
    expect(a.packageId).toBe(b.packageId);
    expect(
      await w.rows("SELECT id FROM package WHERE org_id = ? AND name = 'widget'"),
    ).toHaveLength(1);
    const versions = await w.rows('SELECT version FROM version WHERE org_id = ? ORDER BY version');
    expect(versions.map((v) => v['version'])).toEqual(['1.0.0', '1.0.1', '1.0.2']);
    expect(await expectDerived(w)).toEqual(['project:widget:subscription']);
  },

  async quarantineVsDistAttach(w, order) {
    await attachedWorld(w);
    await discover(w, 'widget')(w.actor(w.first));
    await w.first.batch([
      st(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('blob', ?, ?, 1, 'blob')",
        w.org.orgId,
        DIGEST,
      ),
    ]);
    const [row] = await w.rows('SELECT id, revision FROM version WHERE org_id = ?');
    const identity = { versionId: row!['id'] as string, revision: row!['revision'] as number };
    const query = {
      projectId: PROJECT,
      ecosystem: 'npm' as const,
      key: 'widget',
      versionNormalized: '1.0.0',
    };
    const { a, b } = await raceSettled(
      w,
      order,
      (actor) =>
        actor.writer.quarantine(w.org, actor.guard, { ...identity, reason: 'digest_mismatch' }),
      async (actor) =>
        actor.writer.attachDist(w.org, actor.guard, { ...identity, sha256: DIGEST }).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
    );
    expect(a).toMatchObject({ status: 'fulfilled', value: { changed: true } });
    const attachedFirst = order === 'second-then-first';
    expect(b.status).toBe(attachedFirst ? 'fulfilled' : 'rejected');
    const [after] = await w.rows('SELECT status, blob_id FROM version WHERE org_id = ?');
    expect(after!['status']).toBe('quarantined');
    expect(after!['blob_id']).toBe(attachedFirst ? 'blob' : null);
    const reader = w.actor(w.first).reader;
    expect(await reader.lookupVersion(w.org, query)).toBeNull();
    expect(
      await reader.resolveDist(w.org, { ...query, by: 'version', versionNormalized: '1.0.0' }),
    ).toBeNull();
    expect(await expectDerived(w)).toEqual(['project:widget:subscription']);
  },

  async reconcileFinalizeVsVersionInsert(w, order) {
    await attachedWorld(w);
    const { packageId } = await discover(w, 'widget', [])(w.actor(w.first));
    await w.first.batch(
      ['1.0.0', '1.0.1'].map((name) =>
        st(
          "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'release_date', '{}', ?)",
          `version-${name}`,
          w.org.orgId,
          packageId,
          name,
          name,
          HISTORY,
          HISTORY,
        ),
      ),
    );
    const scope = { kind: 'package' as const, packageId };
    const writer = w.actor(w.first).writer;
    const { stamp } = await writer.openListing(w.org, w.guard, scope);
    await writer.markListing(w.org, w.guard, { scope, stamp, present: ['1.0.0'] });
    const { a } = await race(
      w,
      order,
      (actor) =>
        createCatalogueReconciler(actor.executor, { maxAbsenceShare: 0.5 }).finalizeListing(
          w.org,
          actor.guard,
          completeVersionListing({ packageId, stamp, count: 1 }),
          { attemptedCandidates: 2, successfulCandidates: 1, definitiveAbsent: 1 },
        ),
      discover(w, 'widget', [2]),
    );
    expect(a).toMatchObject({ removed: 1, restored: 0 });
    const statuses = await w.rows(
      'SELECT version, status FROM version WHERE org_id = ? ORDER BY version',
    );
    expect(statuses.map((r) => `${r['version'] as string}:${r['status'] as string}`)).toEqual([
      '1.0.0:active',
      '1.0.1:removed_upstream',
      '1.0.2:active',
    ]);
    expect(await expectDerived(w)).toEqual(['project:widget:subscription']);
  },
};

export async function runCatalogueRaceCase(
  open: Open,
  name: string,
  order: Order,
  wrap?: Wrap,
): Promise<void> {
  const opened = await open();
  try {
    const run = cases[name];
    if (run === undefined) throw new RangeError('unknown catalogue race case');
    await run(await seed(opened, wrap), order);
  } finally {
    await opened.close();
  }
}

export function describeCatalogueRaceContract(label: string, open: Open): void {
  describe(`catalogue race contract on ${label}`, () => {
    let opened: OpenedCatalogueRaceDatabase;
    let world: World;

    beforeEach(async () => {
      opened = await open();
      world = await seed(opened);
    });

    afterEach(async () => {
      await opened.close();
    });

    for (const [name, run] of Object.entries(cases)) {
      for (const order of ORDERS) {
        it(`${name}, ${order}`, async () => {
          await run(world, order);
        });
      }
    }
  });
}
