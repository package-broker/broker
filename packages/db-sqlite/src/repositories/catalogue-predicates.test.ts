import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  matchesPattern,
  MAX_PATTERN_WILDCARDS,
  MAX_PATTERNS_PER_RULE,
} from '@package-broker/core/catalogue/patterns';
import { orgContext, type OrgContext } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { compile, db } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  admissionCondition,
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
  winnerOrder,
} from './catalogue-predicates.js';

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function project(id: string, orgId: string, status = 'active'): Promise<void> {
  await exec('INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)', [
    id,
    orgId,
    id.toLowerCase(),
    id,
    status,
  ]);
}

async function source(
  id: string,
  orgId: string,
  type: string,
  options: { project?: string | null; ecosystem?: string; policy?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      orgId,
      options.project ?? null,
      id,
      options.ecosystem ?? 'composer',
      type,
      options.policy ?? 'flag',
    ],
  );
}

async function pkg(
  id: string,
  orgId: string,
  sourceId: string,
  name: string,
  options: { flag?: number; status?: string; ecosystem?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      orgId,
      sourceId,
      options.ecosystem ?? 'composer',
      name,
      options.flag ?? 1,
      options.status ?? 'active',
    ],
  );
}

async function attach(
  orgId: string,
  projectId: string,
  sourceId: string,
  precedence = 100,
): Promise<void> {
  await exec(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [orgId, projectId, sourceId, precedence],
  );
}

async function pattern(
  projectId: string,
  sourceId: string,
  text: string,
  effect: string,
  orgId: string = ctx.orgId,
): Promise<void> {
  await exec(
    'INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, ?)',
    [
      `PAT-${orgId}-${projectId}-${sourceId}-${text}-${effect}`,
      orgId,
      projectId,
      sourceId,
      text,
      effect,
    ],
  );
}

async function ids(query: Parameters<typeof compile>[0]): Promise<string[]> {
  const rows = await database.executor.all<{ id: string }>(compile(query));
  return rows.map((row) => row.id);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = orgContext(database.orgs.a.orgId);
  other = orgContext(database.orgs.b.orgId);
});

afterEach(async () => {
  await database.close();
});

describe('catalogue pattern SQL limits', () => {
  function expectLimits(
    predicates: Pick<
      typeof import('./catalogue-predicates.js'),
      'admissionCondition' | 'proxyEligibleCondition'
    >,
    wildcards: number,
    patterns: number,
  ): void {
    const admission = compile(
      db
        .selectFrom('package as pkg')
        .select('pkg.id')
        .where(
          predicates.admissionCondition(
            ctx,
            sql.lit('P1'),
            col('pkg.source_id'),
            col('pkg.name'),
            col('pkg.visible_to_new_projects'),
          ),
        ),
    ).sql;
    const proxy = compile(
      db
        .selectFrom('package as pkg')
        .innerJoin('source as src', 'src.id', 'pkg.source_id')
        .select('pkg.id')
        .where(predicates.proxyEligibleCondition({ package: 'pkg', source: 'src' })),
    ).sql;
    for (const statement of [admission, proxy]) {
      expect(statement).toContain(`, '*', '')) > ${wildcards}`);
    }
    expect([...admission.matchAll(/\)\s*<= (\d+)/g)].map((match) => Number(match[1]))).toEqual([
      patterns,
      patterns,
    ]);
  }

  it('embeds the core limits in admission and proxy SQL', () => {
    expectLimits(
      { admissionCondition, proxyEligibleCondition },
      MAX_PATTERN_WILDCARDS,
      MAX_PATTERNS_PER_RULE,
    );
  });

  it.each(['MAX_PATTERN_WILDCARDS', 'MAX_PATTERNS_PER_RULE'] as const)(
    'follows a changed core %s instead of a local copy',
    async (constant) => {
      vi.resetModules();
      const limits = { MAX_PATTERN_WILDCARDS, MAX_PATTERNS_PER_RULE };
      limits[constant] += 1;
      vi.doMock('@package-broker/core/catalogue/patterns', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@package-broker/core/catalogue/patterns')>()),
        ...limits,
      }));
      try {
        const predicates = await import('./catalogue-predicates.js');
        expectLimits(predicates, limits.MAX_PATTERN_WILDCARDS, limits.MAX_PATTERNS_PER_RULE);
      } finally {
        vi.doUnmock('@package-broker/core/catalogue/patterns');
        vi.resetModules();
      }
    },
  );
});

describe('attachedSourceCondition', () => {
  function attached(projectId: string) {
    return db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        attachedSourceCondition(
          ctx,
          sql.lit(projectId),
          col('pkg.source_id'),
          col('pkg.ecosystem'),
        ),
      )
      .orderBy('pkg.id');
  }

  it('accepts an organization source and the project own source, refuses a foreign project source', async () => {
    await project('P1', ctx.orgId);
    await project('P2', ctx.orgId);
    await source('S-ORG', ctx.orgId, 'vcs');
    await source('S-P1', ctx.orgId, 'vcs', { project: 'P1' });
    await source('S-P2', ctx.orgId, 'vcs', { project: 'P2' });
    for (const s of ['S-ORG', 'S-P1', 'S-P2'])
      await pkg(`K-${s}`, ctx.orgId, s, `acme/${s.toLowerCase()}`);
    await attach(ctx.orgId, 'P1', 'S-ORG');
    await attach(ctx.orgId, 'P1', 'S-P1');
    await attach(ctx.orgId, 'P1', 'S-P2');
    expect(await ids(attached('P1'))).toEqual(['K-S-ORG', 'K-S-P1']);
  });

  it('refuses a source that is not attached and a source of another organization', async () => {
    await project('P1', ctx.orgId);
    await source('S-LOOSE', ctx.orgId, 'vcs');
    await source('S-FOREIGN', other.orgId, 'vcs');
    await pkg('K-LOOSE', ctx.orgId, 'S-LOOSE', 'acme/a');
    await pkg('K-FOREIGN', other.orgId, 'S-FOREIGN', 'acme/b');
    await attach(ctx.orgId, 'P1', 'S-FOREIGN');
    expect(await ids(attached('P1'))).toEqual([]);
  });

  it('refuses attachments that point at a foreign-org project or carry a foreign org_id', async () => {
    await project('P1', ctx.orgId);
    await project('P-OTHER', other.orgId);
    await source('S-ORG', ctx.orgId, 'vcs');
    await pkg('K-A', ctx.orgId, 'S-ORG', 'acme/a');
    await attach(ctx.orgId, 'P-OTHER', 'S-ORG');
    await attach(other.orgId, 'P1', 'S-ORG');
    expect(await ids(attached('P-OTHER'))).toEqual([]);
    expect(await ids(attached('P1'))).toEqual([]);
  });

  it('refuses a source of another ecosystem than the package', async () => {
    await project('P1', ctx.orgId);
    await source('S-NPM', ctx.orgId, 'npm_registry', { ecosystem: 'npm' });
    await pkg('K-MISMATCH', ctx.orgId, 'S-NPM', 'acme/a', { ecosystem: 'composer' });
    await attach(ctx.orgId, 'P1', 'S-NPM');
    expect(await ids(attached('P1'))).toEqual([]);
  });
});

describe('proxyEligibleCondition', () => {
  const eligible = () =>
    db
      .selectFrom('package as pkg')
      .innerJoin('source as src', 'src.id', 'pkg.source_id')
      .select('pkg.id')
      .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }))
      .orderBy('pkg.id');

  it('keeps non-proxy rows eligible whatever else exists', async () => {
    await source('S-VCS', ctx.orgId, 'vcs');
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await pkg('K-VCS', ctx.orgId, 'S-VCS', 'acme/a');
    await pkg('K-PROXY-SAME', ctx.orgId, 'S-PROXY', 'acme/a');
    expect(await ids(eligible())).toEqual(['K-VCS']);
  });

  it('makes a proxy row ineligible when a hidden private package has the same key', async () => {
    await project('P1', ctx.orgId);
    await source('S-PRIV', ctx.orgId, 'vcs', { project: 'P1' });
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await pkg('K-PRIV', ctx.orgId, 'S-PRIV', 'acme/a', { flag: 0, status: 'removed_upstream' });
    await pkg('K-SHADOW', ctx.orgId, 'S-PROXY', 'acme/a');
    await pkg('K-FREE', ctx.orgId, 'S-PROXY', 'acme/b');
    expect(await ids(eligible())).toEqual(['K-FREE', 'K-PRIV']);
  });

  it('ignores same-named packages of another organization or ecosystem', async () => {
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await source('S-FOREIGN', other.orgId, 'vcs');
    await source('S-NPM', ctx.orgId, 'npm_registry', { ecosystem: 'npm' });
    await pkg('K-PROXY', ctx.orgId, 'S-PROXY', 'acme/a');
    await pkg('K-FOREIGN', other.orgId, 'S-FOREIGN', 'acme/a');
    await pkg('K-NPM', ctx.orgId, 'S-NPM', 'acme/a', { ecosystem: 'npm' });
    expect(await ids(eligible())).toEqual(['K-FOREIGN', 'K-NPM', 'K-PROXY']);
  });

  it('is blocked by a registered name pattern of the same organization and ecosystem only', async () => {
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await source('S-VCS', ctx.orgId, 'vcs');
    await pkg('K-BLOCKED', ctx.orgId, 'S-PROXY', 'acme/widget');
    await pkg('K-EXACT', ctx.orgId, 'S-PROXY', 'exact/name');
    await pkg('K-OPEN', ctx.orgId, 'S-PROXY', 'other/widget');
    const register = (id: string, orgId: string, ecosystem: string, text: string) =>
      exec(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        [id, orgId, 'S-VCS', ecosystem, text],
      );
    await register('R1', ctx.orgId, 'composer', 'acme/*');
    await register('R2', ctx.orgId, 'composer', 'exact/name');
    await register('R3', ctx.orgId, 'npm', 'other/*');
    await register('R4', other.orgId, 'composer', 'other/*');
    expect(await ids(eligible())).toEqual(['K-OPEN']);
  });

  it.each(['acme/?', 'a*c*m*e*/*x', '', 'acme/x ', 'acme+x', '[a]*', 'a'.repeat(429)])(
    'is blocked by the invalid registered pattern %j',
    async (bad) => {
      await source('S-PROXY', ctx.orgId, 'packagist_proxy');
      await source('S-VCS', ctx.orgId, 'vcs');
      await pkg('K-P', ctx.orgId, 'S-PROXY', 'zeta/z');
      await exec(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        ['R-BAD', ctx.orgId, 'S-VCS', 'composer', bad],
      );
      expect(await ids(eligible())).toEqual([]);
    },
  );

  it('treats npmjs_proxy as a proxy and ignores same-name proxy-only and other-ecosystem sources', async () => {
    await source('S-NPMJS', ctx.orgId, 'npmjs_proxy', { ecosystem: 'npm' });
    await source('S-NPM', ctx.orgId, 'npm_registry', { ecosystem: 'npm' });
    await source('S-COMP', ctx.orgId, 'vcs');
    await pkg('K-PROXY', ctx.orgId, 'S-NPMJS', 'acme/a', { ecosystem: 'npm' });
    await pkg('K-PRIVATE', ctx.orgId, 'S-NPM', 'acme/a', { ecosystem: 'npm' });
    await pkg('K-FREE', ctx.orgId, 'S-NPMJS', 'acme/b', { ecosystem: 'npm' });
    await pkg('K-COMP', ctx.orgId, 'S-COMP', 'acme/b');
    expect(await ids(eligible())).toEqual(['K-COMP', 'K-FREE', 'K-PRIVATE']);
  });

  it('ignores a same-named package whose source belongs to another organization', async () => {
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await source('S-FOREIGN', other.orgId, 'vcs');
    await pkg('K-PROXY', ctx.orgId, 'S-PROXY', 'acme/a');
    await pkg('K-MISMATCH', ctx.orgId, 'S-FOREIGN', 'acme/a');
    expect(await ids(eligible())).toEqual(['K-MISMATCH', 'K-PROXY']);
  });

  it('uses package_by_name and registered_name_pattern', async () => {
    const statement = compile(eligible());
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/package_by_name/);
    expect(details).toMatch(/registered_name_pattern/);
    expect(details).not.toMatch(/SCAN guard_(q|r)\w*\b/);
  });
});

describe('readTimeCondition', () => {
  const visible = (projectId: string) =>
    db
      .selectFrom('package as pkg')
      .innerJoin('source as src', 'src.id', 'pkg.source_id')
      .select('pkg.id')
      .where(readTimeCondition(ctx, sql.lit(projectId), { package: 'pkg', source: 'src' }))
      .orderBy('pkg.id');

  it('serves removed_upstream only under the flag policy', async () => {
    await project('P1', ctx.orgId);
    await source('S-FLAG', ctx.orgId, 'vcs', { policy: 'flag' });
    await source('S-EXCL', ctx.orgId, 'vcs', { policy: 'exclude' });
    await pkg('K-A', ctx.orgId, 'S-FLAG', 'acme/a');
    await pkg('K-R-FLAG', ctx.orgId, 'S-FLAG', 'acme/b', { status: 'removed_upstream' });
    await pkg('K-R-EXCL', ctx.orgId, 'S-EXCL', 'acme/c', { status: 'removed_upstream' });
    await pkg('K-A-EXCL', ctx.orgId, 'S-EXCL', 'acme/d');
    expect(await ids(visible('P1'))).toEqual(['K-A', 'K-A-EXCL', 'K-R-FLAG']);
  });

  it('serves nothing for an archived project or a project of another organization', async () => {
    await project('P-OLD', ctx.orgId, 'archived');
    await project('P-OTHER', other.orgId);
    await source('S-FLAG', ctx.orgId, 'vcs');
    await pkg('K-A', ctx.orgId, 'S-FLAG', 'acme/a');
    expect(await ids(visible('P-OLD'))).toEqual([]);
    expect(await ids(visible('P-OTHER'))).toEqual([]);
  });
});

describe('admissionCondition', () => {
  const admitted = (projectId: string) =>
    db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        admissionCondition(
          ctx,
          sql.lit(projectId),
          col('pkg.source_id'),
          col('pkg.name'),
          col('pkg.visible_to_new_projects'),
        ),
      )
      .orderBy('pkg.id');

  beforeEach(async () => {
    await project('P1', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await source('S2', ctx.orgId, 'vcs');
  });

  it('admits a matching 50-byte stored pattern', async () => {
    const name = `acme/${'a'.repeat(45)}`;
    await pkg('K-50', ctx.orgId, 'S1', name);
    await pattern('P1', 'S1', name, 'include');
    expect(await ids(admitted('P1'))).toEqual(['K-50']);
  });

  it.each(['include', 'exclude'])('fails closed for a seeded 51-byte %s rule', async (effect) => {
    await pkg('K-51', ctx.orgId, 'S1', 'acme/a');
    await pattern('P1', 'S1', 'acme/*', 'include');
    await pattern('P1', 'S1', `other/${'a'.repeat(45)}`, effect);
    expect(await ids(admitted('P1'))).toEqual([]);
  });

  it('admits every flag-1 package without patterns and never a flag-0 package', async () => {
    await pkg('K-ON', ctx.orgId, 'S1', 'acme/on');
    await pkg('K-OFF', ctx.orgId, 'S1', 'acme/off', { flag: 0 });
    expect(await ids(admitted('P1'))).toEqual(['K-ON']);
  });

  it('never admits flag 0 through a matching include', async () => {
    await pkg('K-OFF', ctx.orgId, 'S1', 'acme/off', { flag: 0 });
    await pattern('P1', 'S1', 'acme/*', 'include');
    expect(await ids(admitted('P1'))).toEqual([]);
  });

  it('narrows to matching includes for that source only', async () => {
    await pkg('K-IN', ctx.orgId, 'S1', 'acme/in');
    await pkg('K-OUT', ctx.orgId, 'S1', 'beta/out');
    await pkg('K-S2', ctx.orgId, 'S2', 'beta/other');
    await pattern('P1', 'S1', 'acme/*', 'include');
    expect(await ids(admitted('P1'))).toEqual(['K-IN', 'K-S2']);
  });

  it('lets an exclude win over an include and applies without includes', async () => {
    await pkg('K-A', ctx.orgId, 'S1', 'acme/a');
    await pkg('K-B', ctx.orgId, 'S1', 'acme/b-internal');
    await pkg('K-C', ctx.orgId, 'S1', 'zeta/c');
    await pattern('P1', 'S1', '*-internal', 'exclude');
    expect(await ids(admitted('P1'))).toEqual(['K-A', 'K-C']);
    await pattern('P1', 'S1', 'acme/*', 'include');
    expect(await ids(admitted('P1'))).toEqual(['K-A']);
  });
});

describe('admissionCondition fail closed', () => {
  const admitted = () =>
    db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        admissionCondition(
          ctx,
          sql.lit('P1'),
          col('pkg.source_id'),
          col('pkg.name'),
          col('pkg.visible_to_new_projects'),
        ),
      )
      .orderBy('pkg.id');

  beforeEach(async () => {
    await project('P1', ctx.orgId);
    await project('P2', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await source('S2', ctx.orgId, 'vcs');
    await pkg('K-1', ctx.orgId, 'S1', 'acme/a');
    await pkg('K-2', ctx.orgId, 'S2', 'acme/a');
  });

  it.each(['include', 'exclude'])(
    'admits nothing of the pair when an %s pattern is invalid',
    async (effect) => {
      await pattern('P1', 'S1', 'acme/?', effect);
      expect(await ids(admitted())).toEqual(['K-2']);
    },
  );

  it('admits nothing of the pair with 65 includes', async () => {
    for (let i = 0; i < 64; i += 1) await pattern('P1', 'S1', `acme/a*${i}`, 'include');
    await pattern('P1', 'S1', 'acme/a', 'include');
    expect(await ids(admitted())).toEqual(['K-2']);
  });

  it('admits with exactly 64 excludes and refuses with 65', async () => {
    for (let i = 0; i < 64; i += 1) await pattern('P1', 'S1', `zzz/${i}`, 'exclude');
    expect(await ids(admitted())).toEqual(['K-1', 'K-2']);
    await pattern('P1', 'S1', 'zzz/64', 'exclude');
    expect(await ids(admitted())).toEqual(['K-2']);
  });

  it('ignores excludes of another source and patterns of another project', async () => {
    await pattern('P1', 'S2', 'acme/*', 'exclude');
    await pattern('P2', 'S1', 'acme/*', 'exclude');
    await pattern('P2', 'S1', 'nomatch', 'include');
    await pattern('P2', 'S1', 'acme/?', 'include');
    expect(await ids(admitted())).toEqual(['K-1']);
  });
});

describe('round 3 regressions', () => {
  const BAD = ['acme/*\u0000?', 'acme/\u00e9*'];

  it.each(BAD)('blocks a proxy on the registered pattern %j (NUL or non-ASCII)', async (bad) => {
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await source('S-VCS', ctx.orgId, 'vcs');
    await pkg('K-P', ctx.orgId, 'S-PROXY', 'zeta/z');
    await exec(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      ['R-BAD', ctx.orgId, 'S-VCS', 'composer', bad],
    );
    const query = db
      .selectFrom('package as pkg')
      .innerJoin('source as src', 'src.id', 'pkg.source_id')
      .select('pkg.id')
      .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }));
    expect(await ids(query)).toEqual([]);
  });

  it.each(BAD)('admits nothing of the pair with the pattern %j', async (bad) => {
    await project('P1', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await pkg('K-1', ctx.orgId, 'S1', 'zeta/z');
    await pattern('P1', 'S1', bad, 'exclude');
    const query = db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        admissionCondition(
          ctx,
          sql.lit('P1'),
          col('pkg.source_id'),
          col('pkg.name'),
          col('pkg.visible_to_new_projects'),
        ),
      );
    expect(await ids(query)).toEqual([]);
  });

  it('refuses a key matched only by another project include on the same source', async () => {
    await project('P1', ctx.orgId);
    await project('P2', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await pkg('K-1', ctx.orgId, 'S1', 'acme/a');
    await pattern('P1', 'S1', 'beta/*', 'include');
    await pattern('P2', 'S1', 'acme/*', 'include');
    const query = db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        admissionCondition(
          ctx,
          sql.lit('P1'),
          col('pkg.source_id'),
          col('pkg.name'),
          col('pkg.visible_to_new_projects'),
        ),
      );
    expect(await ids(query)).toEqual([]);
  });

  it('blocks a proxy row for a same-name package whose source ecosystem disagrees', async () => {
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await source('S-NPM', ctx.orgId, 'npm_registry', { ecosystem: 'npm' });
    await pkg('K-PROXY', ctx.orgId, 'S-PROXY', 'acme/a');
    await pkg('K-ODD', ctx.orgId, 'S-NPM', 'acme/a', { ecosystem: 'composer' });
    const query = db
      .selectFrom('package as pkg')
      .innerJoin('source as src', 'src.id', 'pkg.source_id')
      .select('pkg.id')
      .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }));
    expect(await ids(query)).toEqual(['K-ODD']);
  });

  it('is not shadowed by caller aliases named like the internal ones', async () => {
    await project('P1', ctx.orgId);
    await project('P2', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await pkg('K-1', ctx.orgId, 'S1', 'acme/a');
    await attach(ctx.orgId, 'P1', 'S1');
    const outer = (projectId: string) =>
      db
        .selectFrom('package as pkg')
        .innerJoin('project as guard_p', 'guard_p.org_id', 'pkg.org_id')
        .innerJoin('project_source as guard_ps', 'guard_ps.source_id', 'pkg.source_id')
        .innerJoin('source as guard_s', 'guard_s.id', 'pkg.source_id')
        .select('pkg.id')
        .where('guard_p.id', '=', projectId);
    const attached = (projectId: string) =>
      outer(projectId).where(
        attachedSourceCondition(ctx, col('guard_p.id'), col('guard_s.id'), col('pkg.ecosystem')),
      );
    expect(await ids(attached('P1'))).toEqual(['K-1']);
    expect(await ids(attached('P2'))).toEqual([]);
    const readable = (projectId: string) =>
      outer(projectId).where(
        readTimeCondition(ctx, col('guard_p.id'), { package: 'pkg', source: 'guard_s' }),
      );
    await exec("UPDATE project SET status = 'archived' WHERE id = 'P2'");
    expect(await ids(readable('P1'))).toEqual(['K-1']);
    expect(await ids(readable('P2'))).toEqual([]);
  });

  it('is not shadowed when the caller aliases pattern or package tables like the internal ones', async () => {
    await project('P1', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await source('S-PROXY', ctx.orgId, 'packagist_proxy');
    await pkg('K-1', ctx.orgId, 'S1', 'acme/a');
    await pkg('K-PROXY', ctx.orgId, 'S-PROXY', 'acme/a');
    await pkg('K-FREE', ctx.orgId, 'S-PROXY', 'zeta/x');
    await project('P2', ctx.orgId);
    await pattern('P1', 'S1', 'beta/*', 'include');
    await pattern('P2', 'S1', 'acme/*', 'include');
    const admitted = db
      .selectFrom('package as guard_x')
      .innerJoin('project_package_pattern as guard_i', 'guard_i.source_id', 'guard_x.source_id')
      .select('guard_x.id')
      .where('guard_i.project_id', '=', 'P1')
      .where(
        admissionCondition(
          ctx,
          col('guard_i.project_id'),
          col('guard_x.source_id'),
          col('guard_x.name'),
          col('guard_x.visible_to_new_projects'),
        ),
      );
    expect(await ids(admitted)).toEqual([]);
    const eligible = db
      .selectFrom('package as guard_q')
      .innerJoin('source as guard_qs', 'guard_qs.id', 'guard_q.source_id')
      .select('guard_q.id')
      .where(proxyEligibleCondition({ package: 'guard_q', source: 'guard_qs' }));
    expect(await ids(eligible)).toEqual(['K-1', 'K-FREE']);
  });

  it.each([
    ['an unqualified column', () => sql.ref('id')],
    ['raw SQL', () => sql`1`],
  ])('rejects %s as a ref', (_label, make) => {
    expect(() =>
      attachedSourceCondition(ctx, make(), col('pkg.source_id'), col('pkg.ecosystem')),
    ).toThrow(TypeError);
  });
});

describe('GLOB agrees with matchesPattern', () => {
  const patterns = [
    '*',
    'acme/*',
    '*-plugin',
    'a*b*c',
    'acme/exact',
    '@acme/*',
    '!j!s!o!n*',
    'a*b*c*d*e',
    '*/*',
    'x*x',
  ];
  const keys = [
    '',
    'acme/',
    'acme/x',
    'acme/exact',
    'acme/exact2',
    'my-plugin',
    '-plugin',
    'abc',
    'aXbYc',
    'ab',
    '@acme/pkg',
    'acme',
    '!j!s!o!n!stream',
    'a/b/c',
    'axbxcxdxe',
    'xx',
    'x',
    'a.b_c~d',
  ];

  it('returns the same answer on the whole corpus', async () => {
    for (const p of patterns) {
      for (const k of keys) {
        const rows = await database.executor.all<{ hit: number }>({
          sql: 'SELECT ? GLOB ? AS hit',
          params: [k, p],
        });
        expect(rows[0]?.hit === 1, `${p} vs ${k}`).toBe(matchesPattern(p, k));
      }
    }
  });
});

describe('winnerOrder', () => {
  it('puts non-proxy first, then project-level, then precedence, then source id', async () => {
    await project('P1', ctx.orgId);
    await source('S-PROXY', ctx.orgId, 'packagist_proxy', { project: 'P1' });
    await source('S-ORG-LOW', ctx.orgId, 'vcs');
    await source('S-ORG-HIGH', ctx.orgId, 'vcs');
    await source('S-PRJ', ctx.orgId, 'vcs', { project: 'P1' });
    await source('S-ORG-TIE', ctx.orgId, 'vcs');
    await attach(ctx.orgId, 'P1', 'S-PROXY', 0);
    await attach(ctx.orgId, 'P1', 'S-ORG-LOW', 10);
    await attach(ctx.orgId, 'P1', 'S-ORG-HIGH', 50);
    await attach(ctx.orgId, 'P1', 'S-PRJ', 90);
    await attach(ctx.orgId, 'P1', 'S-ORG-TIE', 10);
    let query = db
      .selectFrom('project_source as ps')
      .innerJoin('source as src', 'src.id', 'ps.source_id')
      .select('src.id as id');
    for (const term of winnerOrder({ source: 'src', attachment: 'ps' }))
      query = query.orderBy(term);
    expect(await ids(query)).toEqual(['S-PRJ', 'S-ORG-LOW', 'S-ORG-TIE', 'S-ORG-HIGH', 'S-PROXY']);
  });
});

describe('admissionCondition org consistency', () => {
  const admitted = () =>
    db
      .selectFrom('package as pkg')
      .select('pkg.id')
      .where(
        admissionCondition(
          ctx,
          sql.lit('P1'),
          col('pkg.source_id'),
          col('pkg.name'),
          col('pkg.visible_to_new_projects'),
        ),
      )
      .orderBy('pkg.id');

  beforeEach(async () => {
    await project('P1', ctx.orgId);
    await source('S1', ctx.orgId, 'vcs');
    await pkg('K-A', ctx.orgId, 'S1', 'acme/a');
  });

  it('a mismatched-org exclude pattern does not exclude', async () => {
    await pattern('P1', 'S1', 'acme/*', 'exclude', other.orgId);
    expect(await ids(admitted())).toEqual(['K-A']);
  });

  it('a mismatched-org include pattern does not restrict', async () => {
    await pattern('P1', 'S1', 'zzz/*', 'include', other.orgId);
    expect(await ids(admitted())).toEqual(['K-A']);
  });

  it('a mismatched-org include pattern does not admit', async () => {
    await pattern('P1', 'S1', 'zzz/*', 'include');
    await pattern('P1', 'S1', 'acme/*', 'include', other.orgId);
    expect(await ids(admitted())).toEqual([]);
  });

  it('a mismatched-org invalid pattern does not fail the pair closed', async () => {
    await pattern('P1', 'S1', 'acme/?', 'exclude', other.orgId);
    expect(await ids(admitted())).toEqual(['K-A']);
  });

  it('mismatched-org includes do not count toward the include limit', async () => {
    for (let i = 0; i < 65; i += 1)
      await pattern('P1', 'S1', `acme/a*${i}`, 'include', other.orgId);
    expect(await ids(admitted())).toEqual(['K-A']);
  });

  it('mismatched-org excludes do not count toward the exclude limit', async () => {
    for (let i = 0; i < 65; i += 1) await pattern('P1', 'S1', `zzz/${i}`, 'exclude', other.orgId);
    expect(await ids(admitted())).toEqual(['K-A']);
  });
});
