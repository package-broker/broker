import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import {
  orgContext,
  type OrgContext,
  type SqlExecutor,
  type Statement,
} from '@package-broker/core/db/port';
import { deriveVisibility } from '@package-broker/core/catalogue/visibility';
import { MAX_PATTERNS_PER_RULE } from '@package-broker/core/catalogue/patterns';
import type { ProtectedHolderProvider } from '../kysely.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
  type CatalogueConfig,
  type FixturePattern,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createVisibilitySubsetRepository,
  type VisibilitySubsetRepository,
} from './visibility-subset.js';

const MAX_PROVIDERS = 64;
const ANCHORS: readonly ProtectedHolderProvider[] = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const NOW = '2026-10-15T12:00:00.000Z';

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

interface Row {
  readonly projectId: string;
  readonly packageId: string;
  readonly origin: string;
}

const byKey = (a: Row, b: Row): number => {
  const x = `${a.projectId}\0${a.packageId}`;
  const y = `${b.projectId}\0${b.packageId}`;
  return x < y ? -1 : x > y ? 1 : 0;
};

async function rows(database: MigratedDatabase, where = '1 = 1'): Promise<Row[]> {
  const result = await database.executor.all<Row>(
    stmt(
      `SELECT project_id AS projectId, package_id AS packageId, origin FROM project_package WHERE ${where}`,
    ),
  );
  return result.sort(byKey);
}

async function patterns(database: MigratedDatabase, projectId: string, sourceId: string) {
  return database.executor.all<{ pattern: string; effect: string }>(
    stmt(
      'SELECT pattern, effect FROM project_package_pattern WHERE project_id = ? AND source_id = ? ORDER BY pattern',
      projectId,
      sourceId,
    ),
  );
}

let counter = 0;
const nextId = (kind: string) => `01J${kind}${String((counter += 1)).padStart(21, '0')}`;

interface Actor {
  readonly fence: MutationFence;
}

/** A user with a verified identity, a live session and an e-mail grant of `permissions` at the given scope. */
async function seedActor(
  database: MigratedDatabase,
  orgId: string,
  grants: readonly { readonly projectId: string | null; readonly permissions: readonly string[] }[],
): Promise<Actor> {
  const userId = nextId('USR');
  const sessionId = nextId('SES');
  const email = `${userId.toLowerCase()}@example.test`;
  const hash = sessionId
    .toLowerCase()
    .replace(/[^0-9a-f]/g, 'a')
    .padEnd(64, '0')
    .slice(0, 64);
  const now = new Date().toISOString();
  const statements: Statement[] = [
    stmt(
      'INSERT OR IGNORE INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      orgId,
      'oidc',
      'oidc:https://idp.example.test',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      userId,
      orgId,
      email,
      'active',
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      nextId('IDN'),
      orgId,
      userId,
      'oidc',
      `subject-${userId}`,
      email,
      new Date(Date.now() - 60_000).toISOString(),
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sessionId,
      orgId,
      userId,
      hash,
      hash,
      now,
      now,
      '2999-01-01T00:00:00.000Z',
    ),
  ];
  for (const grant of grants) {
    const roleId = nextId('ROL');
    statements.push(
      stmt(
        'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
        roleId,
        orgId,
        roleId.toLowerCase(),
        roleId,
        grant.projectId === null ? 'organization' : 'project',
      ),
      ...grant.permissions.map((permission) =>
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          orgId,
          roleId,
          permission,
        ),
      ),
      stmt(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
        nextId('GRT'),
        orgId,
        'email',
        email,
        grant.projectId === null ? 'organization' : 'project',
        grant.projectId,
        roleId,
        NOW,
        NOW,
      ),
    );
  }
  await database.executor.batch(statements);
  return {
    fence: mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {}),
  };
}

function expected(config: CatalogueConfig): Row[] {
  return deriveVisibility(toVisibilityInputs(config))
    .map((r) => ({ projectId: r.projectId, packageId: r.packageId, origin: r.origin }))
    .sort(byKey);
}

function serves(config: CatalogueConfig, projectId: string, sourceId: string): boolean {
  const project = config.projects.find((p) => p.id === projectId);
  const source = config.sources.find((s) => s.id === sourceId);
  return (
    project !== undefined &&
    source !== undefined &&
    source.orgId === project.orgId &&
    (source.projectId === null || source.projectId === projectId) &&
    config.attachments.some(
      (a) => a.projectId === projectId && a.sourceId === sourceId && a.orgId === project.orgId,
    )
  );
}

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('visibility subset writes against the oracle', () => {
  it('1: after each operation the database equals deriveVisibility; refused writes change nothing', async () => {
    let applied = 0;
    let refused = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const database = await openMigratedDatabase();
      try {
        let config = randomCatalogueConfig(seed, 6);
        await seedCatalogue(database.executor, config);
        await seedDerivedRows(database.executor, config);
        expect(await rows(database)).toEqual(expected(config));
        const repo = createVisibilitySubsetRepository(database.executor);
        const actors = new Map<string, Actor>();
        for (const org of new Set(config.projects.map((p) => p.orgId))) {
          actors.set(
            org,
            await seedActor(database, org, [
              {
                projectId: null,
                permissions: [
                  'org:sources:write',
                  'project:packages:manage',
                  'project:sources:write',
                ],
              },
            ]),
          );
        }
        const next = mulberry(seed * 104729);
        const pick = <T>(items: readonly T[]): T | undefined =>
          items[Math.floor(next() * items.length)];
        for (let step = 0; step < 8; step += 1) {
          const project = pick(config.projects);
          if (!project) break;
          const ctx = orgContext(project.orgId);
          const fence = (actors.get(project.orgId) as Actor).fence;
          const active = project.status === 'active';
          const sources = config.sources.filter((s) => s.orgId === project.orgId);
          const source = pick(sources);
          const pkgs = config.packages.filter((k) => k.orgId === project.orgId);
          const roll = next();
          let ok: boolean;
          if (roll < 0.45 && source) {
            const key = pick(pkgs.filter((k) => k.sourceId === source.id))?.key ?? 'zz';
            const pattern = next() < 0.2 ? '*' : `${key.slice(0, 1 + Math.floor(next() * 3))}*`;
            const effect = next() < 0.5 ? 'include' : 'exclude';
            const existing = config.patterns.find(
              (p) =>
                p.projectId === project.id && p.sourceId === source.id && p.pattern === pattern,
            );
            const result = await repo.addPattern(ctx, fence, {
              projectId: project.id,
              sourceId: source.id,
              pattern,
              effect,
              providerAnchors: ANCHORS,
            });
            const allowed =
              serves(config, project.id, source.id) &&
              (active || effect === 'exclude') &&
              (existing === undefined || existing.effect === effect);
            ok = allowed;
            expect(result, `seed ${seed} step ${step} addPattern`).toBe(
              allowed ? (existing ? 'unchanged' : 'added') : result,
            );
            expect(['added', 'unchanged'].includes(result)).toBe(allowed);
            if (allowed && !existing) {
              const added: FixturePattern = {
                id: nextId('PAT'),
                orgId: project.orgId,
                projectId: project.id,
                sourceId: source.id,
                pattern,
                effect,
              };
              config = { ...config, patterns: [...config.patterns, added] };
            }
          } else if (roll < 0.65) {
            const own = config.patterns.filter((p) => p.projectId === project.id);
            const target = pick(own);
            if (!target) continue;
            const others = own.filter(
              (p) => p.sourceId === target.sourceId && p.effect === 'include' && p.id !== target.id,
            );
            const result = await repo.removePattern(ctx, fence, {
              projectId: project.id,
              sourceId: target.sourceId,
              pattern: target.pattern,
              providerAnchors: ANCHORS,
            });
            const allowed = active || (target.effect === 'include' && others.length > 0);
            ok = allowed;
            expect(result, `seed ${seed} step ${step} removePattern`).toBe(
              allowed ? 'removed' : 'forbidden',
            );
            if (allowed) {
              config = { ...config, patterns: config.patterns.filter((p) => p !== target) };
            }
          } else if (roll < 0.85) {
            const pkg = pick(pkgs);
            if (!pkg) continue;
            const already = config.explicit.some(
              (e) => e.projectId === project.id && e.packageId === pkg.id,
            );
            const result = await repo.addExplicit(ctx, fence, {
              projectId: project.id,
              packageId: pkg.id,
              providerAnchors: ANCHORS,
            });
            const eligible = serves(config, project.id, pkg.sourceId);
            ok = eligible && active;
            expect(['added', 'unchanged'].includes(result), `seed ${seed} addExplicit`).toBe(ok);
            if (ok && !already) {
              config = {
                ...config,
                explicit: [
                  ...config.explicit,
                  { orgId: project.orgId, projectId: project.id, packageId: pkg.id },
                ],
              };
            }
          } else {
            const own = config.explicit.filter((e) => e.projectId === project.id);
            const target = pick(own);
            if (!target) continue;
            const result = await repo.removeExplicit(ctx, fence, {
              projectId: project.id,
              packageId: target.packageId,
              providerAnchors: ANCHORS,
            });
            ok = true;
            expect(result, `seed ${seed} removeExplicit`).toBe('removed');
            config = { ...config, explicit: config.explicit.filter((e) => e !== target) };
          }
          if (ok) applied += 1;
          else refused += 1;
          expect(await rows(database), `seed ${seed} step ${step}`).toEqual(expected(config));
        }
      } finally {
        await database.close();
      }
    }
    expect(applied).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(5);
  }, 120_000);
});

const ORG = '01J00000000000000000000A0A';
const ORG_B = '01J00000000000000000000B0B';
const P = '01JPRJ000000000000000000001';
const Q = '01JPRJ000000000000000000002';
const ARCHIVED = '01JPRJ000000000000000000003';
const FOREIGN_PROJECT = '01JPRJ000000000000000000009';
const S_ORG = '01JSRC000000000000000000001';
const S_OWN = '01JSRC000000000000000000002';
const S_Q = '01JSRC000000000000000000003';
const S_UNATTACHED = '01JSRC000000000000000000004';
const S_FOREIGN = '01JSRC000000000000000000009';
const K_PUBLIC = '01JPKG000000000000000000001';
const K_HIDDEN = '01JPKG000000000000000000002';
const K_OWN_HIDDEN = '01JPKG000000000000000000003';
const K_Q = '01JPKG000000000000000000004';
const K_UNATTACHED = '01JPKG000000000000000000005';
const K_FOREIGN = '01JPKG000000000000000000009';

describe('visibility subset authority and refusals', () => {
  let database: MigratedDatabase;
  let repo: VisibilitySubsetRepository;
  let ctx: OrgContext;
  let owner: Actor;
  let admin: Actor;

  beforeEach(async () => {
    database = await openMigratedDatabase();
    const config: CatalogueConfig = {
      organizations: [
        { id: ORG, slug: 'org-a', name: 'A' },
        { id: ORG_B, slug: 'org-b', name: 'B' },
      ],
      projects: [
        { id: P, orgId: ORG, slug: 'p', name: 'p', status: 'active' },
        { id: Q, orgId: ORG, slug: 'q', name: 'q', status: 'active' },
        { id: ARCHIVED, orgId: ORG, slug: 'x', name: 'x', status: 'archived' },
        { id: FOREIGN_PROJECT, orgId: ORG_B, slug: 'f', name: 'f', status: 'active' },
      ],
      sources: [
        source(S_ORG, ORG, null),
        source(S_OWN, ORG, P),
        source(S_Q, ORG, Q),
        source(S_UNATTACHED, ORG, null),
        source(S_FOREIGN, ORG_B, null),
      ],
      attachments: [
        { orgId: ORG, projectId: P, sourceId: S_ORG, precedence: 100 },
        { orgId: ORG, projectId: P, sourceId: S_OWN, precedence: 100 },
        { orgId: ORG, projectId: Q, sourceId: S_ORG, precedence: 100 },
        { orgId: ORG, projectId: Q, sourceId: S_Q, precedence: 100 },
        { orgId: ORG, projectId: ARCHIVED, sourceId: S_ORG, precedence: 100 },
        { orgId: ORG_B, projectId: FOREIGN_PROJECT, sourceId: S_FOREIGN, precedence: 100 },
      ],
      patterns: [],
      packages: [
        pkg(K_PUBLIC, ORG, S_ORG, 'acme/public', 1),
        pkg(K_HIDDEN, ORG, S_ORG, 'acme/hidden', 0),
        pkg(K_OWN_HIDDEN, ORG, S_OWN, 'acme/own-hidden', 0),
        pkg(K_Q, ORG, S_Q, 'acme/q', 1),
        pkg(K_UNATTACHED, ORG, S_UNATTACHED, 'acme/unattached', 1),
        pkg(K_FOREIGN, ORG_B, S_FOREIGN, 'acme/foreign', 1),
      ],
      explicit: [],
      registeredNames: [],
      versions: [],
    };
    await seedCatalogue(database.executor, config);
    await seedDerivedRows(database.executor, config);
    repo = createVisibilitySubsetRepository(database.executor);
    ctx = orgContext(ORG);
    owner = await seedActor(database, ORG, [
      { projectId: P, permissions: ['project:packages:manage', 'project:sources:write'] },
      {
        projectId: ARCHIVED,
        permissions: ['project:packages:manage', 'project:sources:write'],
      },
    ]);
    admin = await seedActor(database, ORG, [
      {
        projectId: null,
        permissions: ['org:sources:write', 'project:packages:manage', 'project:sources:write'],
      },
    ]);
  });

  afterEach(async () => {
    await database.close();
  });

  function source(id: string, orgId: string, projectId: string | null) {
    return {
      id,
      orgId,
      projectId,
      name: id,
      ecosystem: 'composer' as const,
      type: 'vcs' as const,
      defaultVisible: 1 as const,
      removalPolicy: 'flag' as const,
    };
  }

  function pkg(id: string, orgId: string, sourceId: string, key: string, visible: 0 | 1) {
    return {
      id,
      orgId,
      sourceId,
      ecosystem: 'composer' as const,
      key,
      visible,
      status: 'active' as const,
    };
  }

  const visible = async (projectId: string) =>
    (await rows(database, `project_id = '${projectId}'`)).map((r) => [r.packageId, r.origin]);

  async function epoch(): Promise<string> {
    const [row] = await database.executor.all<{ version: string }>(
      stmt('SELECT version FROM cache_epoch WHERE org_id = ?', ORG),
    );
    return row?.version ?? '';
  }

  const pattern = (
    actor: Actor,
    projectId: string,
    sourceId: string,
    p: string,
    effect: 'include' | 'exclude',
  ) =>
    repo.addPattern(ctx, actor.fence, {
      projectId,
      sourceId,
      pattern: p,
      effect,
      providerAnchors: ANCHORS,
    });

  it("2: a project owner's include * never exposes flag-0 packages", async () => {
    expect(await pattern(owner, P, S_ORG, '*', 'include')).toBe('added');
    expect(await pattern(owner, P, S_OWN, '*', 'include')).toBe('added');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'pattern']]);
  });

  it('2: explicit add of a flag-0 organization package needs org:sources:write', async () => {
    const before = await epoch();
    expect(
      await repo.addExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'subscription']]);
    expect(await epoch()).toBe(before);
    expect(
      await repo.addExplicit(ctx, admin.fence, {
        projectId: P,
        packageId: K_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('added');
    expect(await visible(P)).toEqual([
      [K_PUBLIC, 'subscription'],
      [K_HIDDEN, 'explicit'],
    ]);
    expect(await epoch()).not.toBe(before);
  });

  it('2: the flag is evaluated in the batch, not from a read before it', async () => {
    const before = await epoch();
    const visibleBefore = await visible(P);
    let flipped = false;
    const racing = createVisibilitySubsetRepository({
      driver: database.executor.driver,
      all: (s: Statement) => database.executor.all(s),
      batch: async (statements: readonly Statement[]) => {
        if (!flipped) {
          flipped = true;
          await database.executor.batch([
            stmt('UPDATE package SET visible_to_new_projects = 0 WHERE id = ?', K_PUBLIC),
          ]);
        }
        return database.executor.batch(statements);
      },
    } as SqlExecutor);
    expect(
      await racing.addExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(flipped).toBe(true);
    const [flag] = await database.executor.all<{ v: number }>(
      stmt('SELECT visible_to_new_projects AS v FROM package WHERE id = ?', K_PUBLIC),
    );
    expect(flag?.v).toBe(0);
    expect(await visible(P)).toEqual(visibleBefore);
    expect(await epoch()).toBe(before);
  });

  it('2: flag-0 package of its own project source needs project:sources:write on the owner', async () => {
    const manageOnly = await seedActor(database, ORG, [
      { projectId: P, permissions: ['project:packages:manage'] },
    ]);
    expect(
      await repo.addExplicit(ctx, manageOnly.fence, {
        projectId: P,
        packageId: K_OWN_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(
      await repo.addExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_OWN_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('added');
  });

  it('2: a flag-1 explicit add needs project:packages:manage', async () => {
    const sourcesOnly = await seedActor(database, ORG, [
      { projectId: P, permissions: ['project:sources:write'] },
    ]);
    expect(
      await repo.addExplicit(ctx, sourcesOnly.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(
      await repo.addExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('added');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'explicit']]);
  });

  it('3: explicit add from an unattached, a foreign project-level or another organization source is refused', async () => {
    for (const packageId of [K_UNATTACHED, K_Q, K_FOREIGN]) {
      expect(
        await repo.addExplicit(ctx, admin.fence, {
          projectId: P,
          packageId,
          providerAnchors: ANCHORS,
        }),
      ).toBe('not_eligible');
    }
    await database.executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
        ORG,
        P,
        S_Q,
      ),
    ]);
    expect(
      await repo.addExplicit(ctx, admin.fence, {
        projectId: P,
        packageId: K_Q,
        providerAnchors: ANCHORS,
      }),
    ).toBe('not_eligible');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'subscription']]);
  });

  it('3: patterns need the source attached and serving the project', async () => {
    expect(await pattern(admin, P, S_UNATTACHED, '*', 'include')).toBe('not_attached');
    expect(await pattern(admin, P, S_Q, '*', 'include')).toBe('not_attached');
    expect(await pattern(admin, FOREIGN_PROJECT, S_FOREIGN, '*', 'include')).not.toBe('added');
    expect(await patterns(database, P, S_UNATTACHED)).toEqual([]);
  });

  it('3: archived projects allow narrowing and refuse widening', async () => {
    expect(await visible(ARCHIVED)).toEqual([[K_PUBLIC, 'subscription']]);
    expect(await pattern(owner, ARCHIVED, S_ORG, 'acme/*', 'include')).toBe('forbidden');
    expect(
      await repo.addExplicit(ctx, admin.fence, {
        projectId: ARCHIVED,
        packageId: K_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await pattern(owner, ARCHIVED, S_ORG, 'acme/pub*', 'exclude')).toBe('added');
    expect(await visible(ARCHIVED)).toEqual([]);
    const remove = (p: string) =>
      repo.removePattern(ctx, owner.fence, {
        projectId: ARCHIVED,
        sourceId: S_ORG,
        pattern: p,
        providerAnchors: ANCHORS,
      });
    expect(await remove('acme/pub*')).toBe('forbidden');
    await database.executor.batch([
      stmt(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('01JPAT1', ?, ?, ?, 'acme/p*', 'include'), ('01JPAT2', ?, ?, ?, 'acme/h*', 'include')",
        ORG,
        ARCHIVED,
        S_ORG,
        ORG,
        ARCHIVED,
        S_ORG,
      ),
    ]);
    expect(await remove('acme/h*')).toBe('removed');
    expect(await remove('acme/p*')).toBe('forbidden');
    await database.executor.batch([
      stmt(
        "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
        ORG,
        ARCHIVED,
        K_HIDDEN,
      ),
    ]);
    expect(
      await repo.removeExplicit(ctx, owner.fence, {
        projectId: ARCHIVED,
        packageId: K_HIDDEN,
        providerAnchors: ANCHORS,
      }),
    ).toBe('removed');
    expect(await visible(ARCHIVED)).toEqual([]);
  });

  it('a different effect for an existing pattern is a conflict; the same effect is unchanged', async () => {
    expect(await pattern(owner, P, S_ORG, 'acme/*', 'include')).toBe('added');
    expect(await pattern(owner, P, S_ORG, 'acme/*', 'exclude')).toBe('conflict');
    expect(await pattern(owner, P, S_ORG, 'acme/*', 'include')).toBe('unchanged');
    expect(await patterns(database, P, S_ORG)).toEqual([{ pattern: 'acme/*', effect: 'include' }]);
  });

  it('OQ-41: invalid patterns and a list over the limit are refused', async () => {
    for (const bad of ['', 'Acme/*', 'a?b', 'a[b]', '*a*b*c*d*e', 'a'.repeat(51)]) {
      expect(await pattern(owner, P, S_ORG, bad, 'include')).toBe('invalid_pattern');
    }
    const fill: Statement[] = [];
    for (let n = 0; n < MAX_PATTERNS_PER_RULE; n += 1) {
      fill.push(
        stmt(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, 'exclude')",
          `01JFILL${n}`,
          ORG,
          P,
          S_ORG,
          `x${n}`,
        ),
      );
    }
    await database.executor.batch(fill);
    expect(await pattern(owner, P, S_ORG, 'y*', 'exclude')).toBe('too_many_patterns');
    expect(await pattern(owner, P, S_ORG, 'y*', 'include')).toBe('added');
  });

  it('removing an explicit row re-derives the package; excludes do not remove explicit rows', async () => {
    expect(
      await repo.addExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('added');
    expect(await pattern(owner, P, S_ORG, '*', 'exclude')).toBe('added');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'explicit']]);
    expect(
      await repo.removeExplicit(ctx, owner.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('removed');
    expect(await visible(P)).toEqual([]);
    expect(
      await repo.removePattern(ctx, owner.fence, {
        projectId: P,
        sourceId: S_ORG,
        pattern: '*',
        providerAnchors: ANCHORS,
      }),
    ).toBe('removed');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'subscription']]);
    expect(await visible(Q)).toEqual([
      [K_PUBLIC, 'subscription'],
      [K_Q, 'subscription'],
    ]);
  });

  it('an actor without the permission, or of another project, is refused and nothing changes', async () => {
    const before = await epoch();
    const outsider = await seedActor(database, ORG, [
      { projectId: Q, permissions: ['project:packages:manage', 'project:sources:write'] },
    ]);
    expect(await pattern(outsider, P, S_ORG, '*', 'exclude')).toBe('forbidden');
    expect(
      await repo.removeExplicit(ctx, outsider.fence, {
        projectId: P,
        packageId: K_PUBLIC,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await visible(P)).toEqual([[K_PUBLIC, 'subscription']]);
    expect(await epoch()).toBe(before);
  });

  it('an unknown package id is forbidden without authority and absent with it', async () => {
    const outsider = await seedActor(database, ORG, [
      { projectId: Q, permissions: ['project:packages:manage', 'project:sources:write'] },
    ]);
    const unknown = {
      projectId: P,
      packageId: '01JPKGUNKNOWN0000000000001',
      providerAnchors: ANCHORS,
    };
    expect(await repo.addExplicit(ctx, outsider.fence, unknown)).toBe('forbidden');
    expect(await repo.removeExplicit(ctx, outsider.fence, unknown)).toBe('forbidden');
    expect(await repo.addExplicit(ctx, outsider.fence, { ...unknown, packageId: K_PUBLIC })).toBe(
      'forbidden',
    );
    expect(await repo.addExplicit(ctx, owner.fence, unknown)).toBe('not_eligible');
    expect(await repo.removeExplicit(ctx, owner.fence, unknown)).toBe('not_found');
    const foreign = { projectId: P, packageId: K_FOREIGN, providerAnchors: ANCHORS };
    expect(await repo.addExplicit(ctx, outsider.fence, foreign)).toBe('forbidden');
    expect(await repo.removeExplicit(ctx, outsider.fence, foreign)).toBe('forbidden');
  });

  it('every statement, probes included, stays within the D1 bound-parameter limit at 64 provider anchors', async () => {
    const anchors: ProtectedHolderProvider[] = [
      ...ANCHORS,
      ...Array.from({ length: MAX_PROVIDERS - ANCHORS.length }, (_, n) => ({
        provider: `idp${n}`,
        anchor: `oidc:https://idp${n}.example.test`,
        emailAuthoritative: n % 2 === 0,
        emailAuthoritativeDomains: ['example.test'],
      })),
    ];
    expect(anchors).toHaveLength(MAX_PROVIDERS);
    const outsider = await seedActor(database, ORG, [
      { projectId: Q, permissions: ['project:packages:manage', 'project:sources:write'] },
    ]);
    const seen: Statement[] = [];
    const spy = createVisibilitySubsetRepository({
      driver: database.executor.driver,
      all: (s: Statement) => {
        seen.push(s);
        return database.executor.all(s);
      },
      batch: (statements: readonly Statement[]) => {
        seen.push(...statements);
        return database.executor.batch(statements);
      },
    } as SqlExecutor);
    const addPattern = (
      actor: Actor,
      projectId: string,
      sourceId: string,
      p: string,
      effect: 'include' | 'exclude',
    ) =>
      spy.addPattern(ctx, actor.fence, {
        projectId,
        sourceId,
        pattern: p,
        effect,
        providerAnchors: anchors,
      });
    const removePattern = (actor: Actor, projectId: string, p: string) =>
      spy.removePattern(ctx, actor.fence, {
        projectId,
        sourceId: S_ORG,
        pattern: p,
        providerAnchors: anchors,
      });
    const explicit = (actor: Actor, projectId: string, packageId: string) => ({
      add: () =>
        spy.addExplicit(ctx, actor.fence, { projectId, packageId, providerAnchors: anchors }),
      remove: () =>
        spy.removeExplicit(ctx, actor.fence, { projectId, packageId, providerAnchors: anchors }),
    });
    expect(await addPattern(owner, P, S_ORG, '*', 'include')).toBe('added');
    expect(await addPattern(owner, P, S_ORG, '*', 'exclude')).toBe('conflict');
    expect(await addPattern(owner, P, S_UNATTACHED, '*', 'include')).toBe('not_attached');
    expect(await addPattern(outsider, P, S_ORG, 'a*', 'exclude')).toBe('forbidden');
    expect(await addPattern(owner, ARCHIVED, S_ORG, 'acme/*', 'exclude')).toBe('added');
    expect(await removePattern(owner, ARCHIVED, 'acme/*')).toBe('forbidden');
    expect(await removePattern(outsider, P, '*')).toBe('forbidden');
    expect(await explicit(owner, P, K_HIDDEN).add()).toBe('forbidden');
    expect(await explicit(admin, P, K_HIDDEN).add()).toBe('added');
    expect(await explicit(owner, P, K_OWN_HIDDEN).add()).toBe('added');
    expect(await explicit(admin, P, K_UNATTACHED).add()).toBe('not_eligible');
    expect(await explicit(outsider, P, '01JPKGUNKNOWN0000000000001').add()).toBe('forbidden');
    expect(await explicit(outsider, P, '01JPKGUNKNOWN0000000000001').remove()).toBe('forbidden');
    expect(await explicit(outsider, P, K_OWN_HIDDEN).remove()).toBe('forbidden');
    expect(await explicit(owner, P, K_OWN_HIDDEN).remove()).toBe('removed');
    expect(await removePattern(owner, P, '*')).toBe('removed');
    expect(seen.length).toBeGreaterThan(40);
    const widest = Math.max(...seen.map((s) => s.params.length));
    expect(widest).toBeLessThanOrEqual(100);
  });
});
