import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createProjectSourceReader } from './project-source-read.js';

let database: MigratedDatabase;
let own: OrgContext;
let foreign: OrgContext;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  own = database.orgs!.a;
  foreign = database.orgs!.b;
  await database.executor.batch([
    ...[
      [own, 'P1'],
      [own, 'P2'],
      [foreign, 'PF'],
    ].map(([org, id]) =>
      stmt(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        id as string,
        (org as OrgContext).orgId,
        (id as string).toLowerCase(),
        id as string,
        'active',
      ),
    ),
    ...[
      ['S-ORG', own, null],
      ['S-OWNED', own, 'P1'],
      ['S-UNATTACHED', own, 'P1'],
      ['S-OTHER', own, 'P2'],
      ['S-FOREIGN', foreign, null],
    ].map(([id, org, project]) =>
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
        id as string,
        (org as OrgContext).orgId,
        id as string,
        project as string | null,
      ),
    ),
    stmt(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
      own.orgId,
      'P1',
      'S-ORG',
      1,
    ),
    stmt(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
      own.orgId,
      'P1',
      'S-OWNED',
      0,
    ),
    stmt(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
      foreign.orgId,
      'PF',
      'S-FOREIGN',
      0,
    ),
  ]);
});

afterEach(() => database.close());

describe('project source attachment reader', () => {
  it('returns exactly the attachment set in precedence order', async () => {
    const reader = createProjectSourceReader(database.executor);
    expect(await reader.list(own, { projectId: 'P1' })).toEqual([
      { sourceId: 'S-OWNED', precedence: 0 },
      { sourceId: 'S-ORG', precedence: 1 },
    ]);
  });

  it('omits an unattached project-owned source and other projects', async () => {
    const reader = createProjectSourceReader(database.executor);
    const ids = (await reader.list(own, { projectId: 'P1' })).map((row) => row.sourceId);
    expect(ids).not.toContain('S-UNATTACHED');
    expect(ids).not.toContain('S-OTHER');
    expect(await reader.list(own, { projectId: 'P2' })).toEqual([]);
  });

  it('never returns another organization attachments', async () => {
    const reader = createProjectSourceReader(database.executor);
    expect(await reader.list(own, { projectId: 'PF' })).toEqual([]);
    expect(await reader.list(foreign, { projectId: 'P1' })).toEqual([]);
  });

  it('rejects a blank project id', async () => {
    const reader = createProjectSourceReader(database.executor);
    await expect(reader.list(own, { projectId: '' })).rejects.toThrow(RangeError);
  });
});

it('exposes the stored attachment precedence, including gaps', async () => {
  await database.executor.batch([
    stmt(
      'UPDATE project_source SET precedence = 7 WHERE org_id = ? AND project_id = ? AND source_id = ?',
      own.orgId,
      'P1',
      'S-ORG',
    ),
  ]);
  expect(await createProjectSourceReader(database.executor).list(own, { projectId: 'P1' })).toEqual(
    [
      { sourceId: 'S-OWNED', precedence: 0 },
      { sourceId: 'S-ORG', precedence: 7 },
    ],
  );
});
