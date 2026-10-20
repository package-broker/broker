import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogueWriteGuard, VersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { versionUpdateStatements } from './catalogue-write-version-update.js';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import { distAttachStatements } from './catalogue-write-dist.js';
import { distTagStatements } from './catalogue-write-tags.js';

let database: MigratedDatabase;
let org: OrgContext;
let guard: CatalogueWriteGuard;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
});

afterEach(async () => {
  await database.close();
});

function request(ecosystem: 'composer' | 'npm') {
  const versions: VersionInput[] = [1, 2].map((n) => ({
    version: `${n}.0.0`,
    versionNormalized: ecosystem === 'composer' ? `${n}.0.0.0` : `${n}.0.0`,
    license: null,
    distType: null,
    sourceRef: null,
    upstreamReleasedAt: null,
    history: { at: '2020-01-01T00:00:00.000Z', basis: 'release_date' },
    metadata: normalizeVersionMetadata(ecosystem, { name: 'pkg' }),
  }));
  return { packageId: 'package', ecosystem, versions };
}

async function explain(statement: Statement): Promise<string[]> {
  const rows = await database.executor.all<{ detail: string }>({
    sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    params: statement.params,
  });
  return rows.map((row) => row.detail);
}

describe('catalogue write version access paths', () => {
  it.each(['composer', 'npm'] as const)(
    '%s revision advance drives identity seeks from the incoming list',
    async (ecosystem) => {
      const plan = versionUpdateStatements(org, guard, request(ecosystem));
      const advance = plan.statements.find((s) => s.sql.startsWith('update "package"'))!;
      const details = await explain(advance);
      const incoming = details.findIndex((d) => /^SCAN incoming VIRTUAL TABLE INDEX /.test(d));
      const version = details.findIndex((d) =>
        /^SEARCH version USING INDEX version_identity /.test(d),
      );
      expect(incoming, details.join('\n')).toBeGreaterThanOrEqual(0);
      expect(version, details.join('\n')).toBeGreaterThan(incoming);
      expect(details[version]).toContain('(package_id=? AND version_normalized=?)');
      expect(details.some((d) => /^SCAN version\b/.test(d))).toBe(false);
    },
  );

  it('all sibling version accesses seek by identity, id or operation', async () => {
    const plans = [
      ...(['composer', 'npm'] as const).flatMap((ecosystem) => [
        versionUpdateStatements(org, guard, request(ecosystem)),
        versionInsertStatements(org, guard, request(ecosystem)),
      ]),
      distAttachStatements(org, guard, {
        versionId: 'version',
        revision: 1,
        sha256: 'a'.repeat(64) as Sha256,
      }),
      distTagStatements(org, guard, {
        packageId: 'package',
        ecosystem: 'npm',
        tags: { latest: '1.0.0' },
        actorType: 'sync',
        actorId: null,
        opId: 'operation',
      }),
    ];
    const accesses: { detail: string; sql: string }[] = [];
    for (const plan of plans) {
      for (const statement of plan.statements) {
        if (
          !/\bfrom "?version\b/i.test(statement.sql) &&
          !statement.sql.startsWith('update "version"')
        )
          continue;
        accesses.push(
          ...(await explain(statement))
            .filter((d) => /^(?:SCAN|SEARCH) version\b/.test(d))
            .map((detail) => ({ detail, sql: statement.sql })),
        );
      }
    }
    expect(accesses.length).toBeGreaterThan(0);
    for (const { detail, sql } of accesses) {
      expect(detail, sql).toMatch(
        /^SEARCH version USING (?:COVERING )?INDEX (?:version_identity \(package_id=\? AND version_normalized=\?\)|(?:sqlite_autoindex_version_\d+|version_org_id) \(id=\?(?: AND org_id=\?)?\)|version_op \(last_op_id=\?\))$/,
      );
    }
    expect(accesses.some(({ detail }) => detail.includes('version_op (last_op_id=?)'))).toBe(true);
  });
});
