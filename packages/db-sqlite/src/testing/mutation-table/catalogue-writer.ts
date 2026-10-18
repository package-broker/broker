import { expect } from 'vitest';
import { entries as reconcileEntries } from './catalogue-reconcile.js';
import type { SqlExecutor } from '@package-broker/core/db/port';
import type { VisibilityStore } from '@package-broker/core/db/catalogue';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { MAX_PATTERNS_PER_RULE } from '@package-broker/core/catalogue/patterns';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import {
  createCatalogueWriter,
  createVisibilityStore,
} from '../../repositories/catalogue-writer.js';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import {
  ANCHORS,
  FUTURE,
  HASH,
  NOT_NULL,
  fenceOf,
  npmVersions,
  seedBindings,
  seedPackage,
  seedProject,
  seedSource,
  seedSubject,
  seedVersion,
} from './fixtures.js';

const OLD = '2020-01-01T00:00:00.000Z';

function reconcileCase(kind: 'source' | 'package' | 'absent'): ContractCase {
  return {
    name: `${kind} reconciliation preserves foreign catalogue rows`,
    async run(context) {
      const { executor } = context;
      const { own, foreign } = orgOf(context);
      const seed = seeder(executor);
      await seed(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
         VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', ?, 3)`,
        own.orgId,
        FUTURE,
      );
      for (const [prefix, org] of [
        ['O', own],
        ['F', foreign],
      ] as const) {
        await seedSource(seed, `${prefix}S`, org.orgId, 'composer_repository');
        await seed("UPDATE source SET removal_policy = 'exclude' WHERE id = ?", `${prefix}S`);
        if (kind !== 'source')
          await seedPackage(seed, `${prefix}K`, org.orgId, `${prefix}S`, 'parent');
        for (const key of ['present', 'missing', 'returned']) {
          if (kind === 'source') {
            await seedPackage(seed, `${prefix}-${key}`, org.orgId, 'OS', key);
            await seedVersion(
              seed,
              `V-${prefix}-${key}`,
              org.orgId,
              `O-${key}`,
              `${prefix}-${key}`,
            );
          } else {
            await seedVersion(
              seed,
              `${prefix}-${key}`,
              org.orgId,
              'OK',
              prefix === 'O' ? key : `foreign-${key}`,
            );
          }
        }
      }
      const table = kind === 'source' ? 'package' : 'version';
      await seed(`UPDATE ${table} SET updated_at = ?`, OLD);
      await seed(
        `UPDATE ${table} SET status = 'removed_upstream', removed_upstream_at = ? WHERE id IN ('O-returned', 'F-returned')`,
        OLD,
      );
      const snapshot = async () => {
        const rows = [];
        for (const name of ['package', 'version', 'version_revision', 'cache_epoch']) {
          rows.push(
            await executor.all({
              sql: `SELECT * FROM ${name} WHERE org_id = ? ORDER BY rowid`,
              params: [foreign.orgId],
            }),
          );
        }
        return rows;
      };
      let before = await snapshot();
      const mutating: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(context.mutate(statement)),
        batch: (statements) => executor.batch(context.mutateBatch(statements)),
      };
      const reconciler = createCatalogueWriter(mutating);
      const guard = createCatalogueWriteGuard(own, { id: 'J', owner: 'worker', fence: 3 });
      if (kind === 'absent') {
        await seed(
          `INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at)
           VALUES (?, 'OK', 'composer-p2', ?, ?, 100, ?)`,
          own.orgId,
          OLD,
          OLD,
          OLD,
        );
        await expect(
          reconciler.markPackageAbsent(own, guard, { packageId: 'OK' }),
        ).resolves.toMatchObject({ changed: true });
      } else {
        const scope =
          kind === 'source'
            ? { kind: 'source' as const, sourceId: 'OS' }
            : { kind: 'package' as const, packageId: 'OK' };
        const { stamp } = await reconciler.openListing(own, guard, scope);
        await seed(
          `UPDATE ${table} SET updated_at = ?, listing_seen_stamp = ? WHERE id = 'F-returned'`,
          stamp,
          stamp,
        );
        before = await snapshot();
        await expect(
          reconciler.markListing(own, guard, {
            scope,
            stamp,
            present: ['present', 'returned'],
          }),
        ).resolves.toMatchObject({ changed: true });
        expect(await snapshot()).toEqual(before);
        const listing =
          kind === 'source'
            ? completeSourceListing({ sourceId: 'OS', stamp, count: 2 })
            : completeVersionListing({ packageId: 'OK', stamp, count: 2 });
        await expect(reconciler.finalizeListing(own, guard, listing)).resolves.toMatchObject({
          removed: 1,
          restored: 1,
        });
      }
      expect(await snapshot()).toEqual(before);
      expect(
        await executor.all({
          sql: `SELECT status FROM ${table} WHERE id = 'O-missing' AND org_id = ?`,
          params: [own.orgId],
        }),
      ).toEqual([{ status: 'removed_upstream' }]);
    },
  };
}

function executorOf(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}

async function foreignSnapshot(context: CaseContext): Promise<unknown> {
  const { foreign } = orgOf(context);
  const tables = await context.executor.all<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    params: [],
  });
  const result: unknown[] = [];
  for (const { name } of tables) {
    if (name.startsWith('sqlite_')) continue;
    const columns = await context.executor.all<{ name: string }>({
      sql: `PRAGMA table_info("${name}")`,
      params: [],
    });
    if (!columns.some((column) => column.name === 'org_id')) continue;
    result.push(
      await context.executor.all({
        sql: `SELECT * FROM "${name}" WHERE org_id = ? ORDER BY ${columns.map((_, index) => index + 1).join(', ')}`,
        params: [foreign.orgId],
      }),
    );
  }
  return result;
}

async function seedWriter(context: CaseContext): Promise<void> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  for (const [suffix, ctx] of [
    ['F', foreign],
    ['O', own],
  ] as const) {
    await seedProject(seed, `P-${suffix}`, ctx.orgId);
    await seedSource(seed, `S-${suffix}`, ctx.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, `K-${suffix}`, ctx.orgId, `S-${suffix}`, 'widget', 'npm');
    await seedVersion(seed, `V-${suffix}`, ctx.orgId, `K-${suffix}`, '1.0.0');
    await seed(
      'UPDATE version SET metadata_json = ? WHERE id = ?',
      normalizeVersionMetadata('npm', { name: 'widget' }).json,
      `V-${suffix}`,
    );
    await seed(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
      `B-${suffix}`,
      ctx.orgId,
      HASH,
      `blob-${suffix}`,
    );
  }
  await seed(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
    VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', ?, 3)`,
    own.orgId,
    FUTURE,
  );
}

const writerGuard = (context: CaseContext) =>
  createCatalogueWriteGuard(orgOf(context).own, { id: 'J', owner: 'worker', fence: 3 });

const syncCase: ContractCase = {
  name: 'sync delegates package, version and tag writes without changing foreign rows',
  async run(context) {
    await seedWriter(context);
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seed(
      "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, 'K-O', 'foreign', 'V-O')",
      foreign.orgId,
    );
    const before = await foreignSnapshot(context);
    const writer = createCatalogueWriter(executorOf(context));
    const versions = npmVersions(2);
    await expect(
      writer.syncPackage(own, writerGuard(context), {
        sourceId: 'S-O',
        ecosystem: 'npm',
        key: 'widget',
        description: 'changed',
        versions: versions.map((version) => ({
          ...version,
          metadata: normalizeVersionMetadata('npm', { name: 'widget', deprecated: 'old' }),
        })),
        tags: { latest: '1.0.1' },
      }),
    ).resolves.toMatchObject({
      packageId: 'K-O',
      inserted: 1,
      updated: 1,
      conflicts: [],
      refused: [],
    });
    expect(await foreignSnapshot(context)).toEqual(before);
  },
};

function writerStatusCase(
  method: 'attachDist' | 'quarantine',
  foreignTarget = false,
): ContractCase {
  return {
    name: `${method} ${foreignTarget ? 'rejects a foreign target' : 'changes only own rows'}`,
    async run(context) {
      await seedWriter(context);
      const { own } = orgOf(context);
      const before = await foreignSnapshot(context);
      const writer = createCatalogueWriter(executorOf(context));
      const versionId = foreignTarget ? 'V-F' : 'V-O';
      if (method === 'attachDist') {
        const operation = writer.attachDist(own, writerGuard(context), {
          versionId,
          revision: 1,
          sha256: HASH as Sha256,
        });
        if (foreignTarget) await expect(operation).rejects.toThrow();
        else await expect(operation).resolves.toMatchObject({ changed: true });
      } else {
        await expect(
          writer.quarantine(own, writerGuard(context), { versionId, reason: 'digest_mismatch' }),
        ).resolves.toMatchObject({ changed: !foreignTarget });
      }
      expect(await foreignSnapshot(context)).toEqual(before);
    },
  };
}

const lookupCase: ContractCase = {
  name: 'sync never reports the package of another organization as its winner',
  async run(context) {
    await seedWriter(context);
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-LOOKUP', own.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, 'K-LOOKUP', foreign.orgId, 'S-LOOKUP', 'widget', 'npm');
    const before = await foreignSnapshot(context);
    const result = await createCatalogueWriter(executorOf(context)).syncPackage(
      own,
      writerGuard(context),
      {
        sourceId: 'S-LOOKUP',
        ecosystem: 'npm',
        key: 'widget',
        description: null,
        versions: [],
      },
    );
    const [winner] = await context.executor.all({
      sql: "SELECT id FROM package WHERE org_id = ? AND source_id = 'S-LOOKUP'",
      params: [own.orgId],
    });
    expect(result.packageId).toBe(winner?.['id']);
    expect(await foreignSnapshot(context)).toEqual(before);
  },
};

const tombstoneCase: ContractCase = {
  name: 'sync refusal probe excludes a foreign tombstone on the own package',
  async run(context) {
    await seedWriter(context);
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedVersion(seed, 'V-TOMB', foreign.orgId, 'K-O', '1.0.1');
    await seed(
      "UPDATE version SET status = 'tombstoned', tombstoned_at = ?, tombstone_reason = 'admin_tombstone' WHERE id = 'V-TOMB'",
      OLD,
    );
    const before = await foreignSnapshot(context);
    await expect(
      createCatalogueWriter(executorOf(context)).syncPackage(own, writerGuard(context), {
        sourceId: 'S-O',
        ecosystem: 'npm',
        key: 'widget',
        description: null,
        versions: [npmVersions(2)[1]!],
      }),
    ).resolves.toMatchObject({ packageId: 'K-O', refused: [], inserted: 0, unchanged: 1 });
    expect(await foreignSnapshot(context)).toEqual(before);
  },
};

const foreignSourceCase: ContractCase = {
  name: 'sync never creates a package in a foreign source',
  async run(context) {
    await seedWriter(context);
    const { own } = orgOf(context);
    const before = await foreignSnapshot(context);
    await expect(
      createCatalogueWriter(executorOf(context)).syncPackage(own, writerGuard(context), {
        sourceId: 'S-F',
        ecosystem: 'npm',
        key: 'absent',
        description: null,
        versions: [],
      }),
    ).rejects.toThrow('access_mutation_guard');
    expect(await foreignSnapshot(context)).toEqual(before);
  },
};

function foreignPackageCase(admin: boolean): ContractCase {
  return {
    name: `${admin ? 'admin' : 'job'} quarantine never advances a foreign package`,
    async run(context) {
      const fence = admin ? await seedStore(context, 'quarantineVersion') : undefined;
      if (!admin) await seedWriter(context);
      const seed = seeder(context.executor);
      await seed("UPDATE version SET version_normalized = '9.0.0' WHERE id = 'V-F'");
      await seed("UPDATE version SET package_id = 'K-F' WHERE id = 'V-O'");
      const before = await foreignSnapshot(context);
      const { own } = orgOf(context);
      if (fence !== undefined)
        await expect(
          createVisibilityStore(executorOf(context), {
            providerAnchors: ANCHORS,
          }).quarantineVersion(own, fence, { versionId: 'V-O', reason: 'admin_quarantine' }),
        ).resolves.toMatchObject({ ok: true });
      else
        await expect(
          createCatalogueWriter(executorOf(context)).quarantine(own, writerGuard(context), {
            versionId: 'V-O',
            reason: 'digest_mismatch',
          }),
        ).resolves.toMatchObject({ changed: true });
      expect(await foreignSnapshot(context)).toEqual(before);
    },
  };
}

const derivationScopes = {
  locate:
    /"?(?:project_package|stay_package|derive_attachment|derive_package|guard_ps|guard_s|guard_p|guard_bad|guard_ci|guard_cx|guard_i|guard_im|guard_x|derive_include)"?\."?org_id"? = \?/,
  reason:
    'These rederiveStatements scopes are tested individually in visibility-derive.ts and catalogue-predicates.ts. The factory cases execute all three derivation statements with populated own and foreign catalogues; derivation receives the same globally unique project/package/source ids already validated by the caller.',
};

const storeCalls = {
  attachSource: (store, ctx, fence, suffix) =>
    store.attachSource(ctx, fence, { projectId: `P-${suffix}`, sourceId: `S-${suffix}` }),
  detachSource: (store, ctx, fence, suffix) =>
    store.detachSource(ctx, fence, { projectId: `P-${suffix}`, sourceId: `S-${suffix}` }),
  setPrecedence: (store, ctx, fence, suffix) =>
    store.setPrecedence(ctx, fence, {
      projectId: `P-${suffix}`,
      sourceId: `S-${suffix}`,
      precedence: 42,
    }),
  setPackageFlag: (store, ctx, fence, suffix) =>
    store.setPackageFlag(ctx, fence, { packageId: `K-${suffix}`, visibleToNewProjects: false }),
  addPattern: (store, ctx, fence, suffix) =>
    store.addPattern(ctx, fence, {
      projectId: `P-${suffix}`,
      sourceId: `S-${suffix}`,
      pattern: 'widget*',
      effect: 'include',
    }),
  removePattern: (store, ctx, fence, suffix) =>
    store.removePattern(ctx, fence, {
      projectId: `P-${suffix}`,
      sourceId: `S-${suffix}`,
      pattern: 'widget*',
    }),
  addExplicit: (store, ctx, fence, suffix) =>
    store.addExplicit(ctx, fence, { projectId: `P-${suffix}`, packageId: `K-${suffix}` }),
  removeExplicit: (store, ctx, fence, suffix) =>
    store.removeExplicit(ctx, fence, { projectId: `P-${suffix}`, packageId: `K-${suffix}` }),
  quarantineVersion: (store, ctx, fence, suffix) =>
    store.quarantineVersion(ctx, fence, { versionId: `V-${suffix}`, reason: 'admin_quarantine' }),
  releaseQuarantine: (store, ctx, fence, suffix) =>
    store.releaseQuarantine(ctx, fence, { versionId: `V-${suffix}` }),
  tombstoneVersion: (store, ctx, fence, suffix) =>
    store.tombstoneVersion(ctx, fence, { versionId: `V-${suffix}`, reason: 'admin_tombstone' }),
} satisfies Record<
  keyof VisibilityStore,
  (
    store: VisibilityStore,
    ctx: Parameters<VisibilityStore['attachSource']>[0],
    fence: Parameters<VisibilityStore['attachSource']>[1],
    suffix: string,
  ) => Promise<unknown>
>;

async function seedStore(context: CaseContext, method: keyof VisibilityStore) {
  await seedWriter(context);
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  await seedBindings(context);
  const subject = await seedSubject(context, 'store');
  for (const permission of [
    'org:sources:write',
    'project:sources:write',
    'project:packages:manage',
  ]) {
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-store', ?)",
      own.orgId,
      permission,
    );
  }
  for (const [suffix, ctx] of [
    ['O', own],
    ['F', foreign],
  ] as const) {
    if (method !== 'attachSource')
      await seed(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        ctx.orgId,
        `P-${suffix}`,
        `S-${suffix}`,
      );
    if (method === 'removePattern')
      await seed(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, 'widget*', 'include')",
        `PAT-${suffix}`,
        ctx.orgId,
        `P-${suffix}`,
        `S-${suffix}`,
      );
    if (method === 'removeExplicit')
      await seed(
        "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
        ctx.orgId,
        `P-${suffix}`,
        `K-${suffix}`,
      );
    if (method === 'releaseQuarantine')
      await seed("UPDATE version SET status = 'quarantined' WHERE id = ?", `V-${suffix}`);
  }
  return fenceOf(subject);
}

function storeCase(method: keyof VisibilityStore, foreignTarget = false): ContractCase {
  return {
    name: `${method} through the store ${foreignTarget ? 'refuses a foreign target' : 'preserves every foreign row'}`,
    async run(context) {
      const fence = await seedStore(context, method);
      const before = await foreignSnapshot(context);
      const store = createVisibilityStore(executorOf(context), { providerAnchors: ANCHORS });
      const result = await storeCalls[method](
        store,
        orgOf(context).own,
        fence,
        foreignTarget ? 'F' : 'O',
      );
      expect(result).toMatchObject(
        foreignTarget
          ? {
              ok: false,
              ...(['quarantineVersion', 'releaseQuarantine', 'tombstoneVersion'].includes(method)
                ? { reason: 'conflict' }
                : {}),
            }
          : { ok: true },
      );
      expect(await foreignSnapshot(context)).toEqual(before);
    },
  };
}

function foreignSubsetCase(method: 'removePattern' | 'removeExplicit'): ContractCase {
  return {
    name: `${method} preserves a foreign row sharing own target ids`,
    async run(context) {
      const fence = await seedStore(context, method);
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      if (method === 'removePattern') {
        await seed("DELETE FROM project_package_pattern WHERE id = 'PAT-O'");
        await seed(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('PAT-X', ?, 'P-O', 'S-O', 'widget*', 'include')",
          foreign.orgId,
        );
      } else {
        await seed(
          "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P-O', 'K-O', 'explicit') ON CONFLICT(project_id, package_id) DO UPDATE SET org_id = excluded.org_id",
          foreign.orgId,
        );
      }
      const before = await foreignSnapshot(context);
      const store = createVisibilityStore(executorOf(context), { providerAnchors: ANCHORS });
      await expect(storeCalls[method](store, own, fence, 'O')).resolves.toMatchObject({
        ok: false,
        reason: 'not_found',
      });
      expect(await foreignSnapshot(context)).toEqual(before);
    },
  };
}

const patternLimitCase: ContractCase = {
  name: 'foreign patterns do not consume the own pattern limit',
  async run(context) {
    const fence = await seedStore(context, 'addPattern');
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    for (let i = 0; i < MAX_PATTERNS_PER_RULE; i++) {
      await seed(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, 'P-O', 'S-O', ?, 'include')",
        `FOREIGN-${i}`,
        foreign.orgId,
        `foreign-${i}*`,
      );
    }
    const before = await foreignSnapshot(context);
    const store = createVisibilityStore(executorOf(context), { providerAnchors: ANCHORS });
    await expect(storeCalls.addPattern(store, own, fence, 'O')).resolves.toMatchObject({
      ok: true,
    });
    expect(await foreignSnapshot(context)).toEqual(before);
  },
};

const reconcileEntry = reconcileEntries[0]!;
export const entries: readonly MutationEntry[] = [
  {
    ...reconcileEntry,
    file: 'repositories/catalogue-writer.ts',
    builder: 'createCatalogueWriter',
    cases: [
      ...(['source', 'package', 'absent'] as const).map(reconcileCase),
      syncCase,
      lookupCase,
      tombstoneCase,
      foreignSourceCase,
      foreignPackageCase(false),
      ...(['attachDist', 'quarantine'] as const).flatMap((method) => [
        writerStatusCase(method),
        writerStatusCase(method, true),
      ]),
    ],
    predicates: [
      ...reconcileEntry.predicates,
      {
        name: 'sync source guard is organization scoped',
        locate: /source.org_id = \?(?=\s+AND source.ecosystem)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSourceCase.name,
      },
      {
        name: 'sync returns only an own package winner',
        locate: /(?<=^select "id" from "package" where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: lookupCase.name,
      },
      {
        name: 'sync tombstone probe is organization scoped',
        locate: /(?<=from "version" where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: tombstoneCase.name,
      },
      {
        name: 'quarantine before-image is organization scoped',
        locate: /"version"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        waivedCopies: {
          1: "The update cannot reach a foreign version without the before-image bearing this call's random operation id; the first predicate supplies that independent guard.",
        },
        caseName: writerStatusCase('quarantine', true).name,
      },
      {
        name: 'quarantine advances only an own package',
        locate: /"package"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackageCase(false).name,
      },
      {
        name: 'sync tag deletion is scoped through the writer',
        locate: /dist_tag\.org_id = \?(?=\s+AND dist_tag.tag NOT IN)/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: syncCase.name,
      },
      {
        name: 'quarantine epoch bump is scoped through the writer',
        locate: /"cache_epoch"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: writerStatusCase('quarantine').name,
      },
      {
        name: 'dist attachment assigns only an own blob',
        locate: /(?<=set "blob_id" = \(SELECT blob.id FROM blob\s+WHERE )blob.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: writerStatusCase('attachDist').name,
      },
    ],
    waivers: [
      ...(reconcileEntry.waivers ?? []),
      derivationScopes,
      {
        locate: /"source"\."org_id" = \?/,
        reason:
          'The INSERT SELECT runs after sourceMatches has already refused a source outside the organization. foreignSourceCase exercises that guard through the writer; stripping this later repeated scope alone cannot pass the preceding assertion.',
      },
      {
        locate: /(?<=from "package" where )"org_id" = \?/,
        reason:
          'bindPackage repeats the same lookup in every version/tag statement. lookupCase mutation-tests the returned winner; the nested copies cannot widen the scoped version/package writes and are redundant with their target scopes.',
      },
      {
        locate: /dist_tag\.org_id = \?/,
        reason:
          'Set-history previous/unchanged lookups and conflict update use the same scoped tag target; the independently tested distTagStatements registration covers foreign previous values and conflicts. syncCase executes the complete set/history/removal path and preserves a foreign tag sharing its own package id.',
      },
      {
        locate: /"?blob"?\."?org_id"? = \?/,
        reason:
          'The digest assignment, eligibility and postcondition repeat the same lookup. The full attachDist case requires the own blob with two organizations sharing a digest; each lookup is independently registered in catalogue-write-dist.ts.',
      },
    ],
  },
  {
    file: 'repositories/catalogue-writer.ts',
    builder: 'createVisibilityStore',
    cases: (Object.keys(storeCalls) as (keyof VisibilityStore)[])
      .flatMap((method) => [storeCase(method), storeCase(method, true)])
      .concat(
        foreignPackageCase(true),
        foreignSubsetCase('removePattern'),
        foreignSubsetCase('removeExplicit'),
        patternLimitCase,
      ),
    predicates: [
      ...(['removePattern', 'removeExplicit'] as const).map((method) => ({
        name: `${method} scopes the delegated delete`,
        locate: new RegExp(
          `(?<=delete from "${method === 'removePattern' ? 'project_package_pattern' : 'project_package'}" where )"org_id" = \\?`,
        ),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSubsetCase(method).name,
      })),
      {
        name: 'pattern count excludes foreign patterns',
        locate: /(?<=from "project_package_pattern" where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: patternLimitCase.name,
      },
      {
        name: 'pattern limit postcondition excludes foreign patterns',
        locate: /vs_limit.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: patternLimitCase.name,
      },
      {
        name: 'admin quarantine advances only an own package',
        locate: /"package"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackageCase(true).name,
      },
      ...(['quarantineVersion', 'releaseQuarantine', 'tombstoneVersion'] as const).map(
        (method) => ({
          name: `${method} target belongs to the caller organization`,
          locate: /(?<=where id = \? and )org_id = \?/,
          neutral: NOT_NULL,
          copies: 2,
          caseName: storeCase(method, true).name,
        }),
      ),
      ...(Object.keys(storeCalls) as (keyof VisibilityStore)[]).map((method) => ({
        name: `${method} delegates an organization-scoped epoch bump`,
        locate:
          /(?<=update "cache_epoch" set "version" = hex\(randomblob\(16\)\) where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: storeCase(method).name,
      })),
    ],
    waivers: [
      derivationScopes,
      {
        locate:
          /"(?:actor|i|s|hp_session|hp_project|guard_user|guard_grant|guard_role|guard_perm|guard_member|guard_identity|guard_binding|guard_login|guard_credential)"\."org_id" = /,
        reason:
          'actorHolds repeats the authenticated session and permissionRows chain in the fence and failure probes. actor-authority.ts and access.ts independently mutate those shared guards; every store method here executes the guard and rejects foreign targets with the same own actor.',
      },
      {
        locate: /"version"\."org_id" = \?/,
        reason:
          'Admin status has an independent scoped presence guard, exercised for each status method, before these versionStatusStatements run. Its before-image and update predicates are independently registered in catalogue-status-statements.ts; neither can reach the foreign target after the presence check refuses it.',
      },
      {
        locate: /(?<=from "cache_epoch" where )"org_id" = \?/,
        reason:
          "The deployment-fault probe after a refused write only checks whether an epoch row exists; both organizations have one. Each method's epoch UPDATE has an executable predicate mutation above.",
      },
      {
        locate: /"(?:package|source)"\."org_id" = \?/,
        reason:
          'setPackageFlag joins a globally unique package id to its source; the subsequent target_package/owner_source check repeats both scopes before any write. The foreign-target case refuses that path and foreignPackageCase independently tests status package advancement.',
      },
      {
        locate: /(?<![\w".])"org_id" = \?/,
        reason:
          'The attachment/subset read and write scopes repeat the independently scoped target/authority guards below. Globally unique source/project/package ids and UNIQUE(project_id, source_id), UNIQUE(project_id, package_id), UNIQUE(project_id, source_id, pattern) prevent a second matching row. All eleven delegation paths execute here and their foreign-target calls preserve the complete foreign snapshot; the epoch UPDATE is mutation-tested separately for each method.',
      },
      {
        locate:
          /(?:target_project|target_source|target_attachment|target_package|owner_source|vs_attachment|vs_source|vs_project|vs_package|vs_active|vs_pattern|vs_limit|vs_flag|vs_hidden|vs_owner)\.org_id = \?/,
        reason:
          "These target guards repeat the initial scoped source/project/package reads and the mutation's own org scope. The successful and foreign-target case for every method exercises these paths; a single target guard cannot widen a write past the other checks.",
      },
    ],
  },
];
