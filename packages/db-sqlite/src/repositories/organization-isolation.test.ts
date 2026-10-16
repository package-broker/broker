import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Organization } from '@package-broker/core/db/organization';
import { orgContext } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { seedTwoOrganizations } from '../contract/two-organizations.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { createOrganizationRepository } from './organization.js';

const initUrl = new URL('../../migrations/0001_init.sql', import.meta.url);
const initText = readFileSync(initUrl, 'utf8');
const epochText = readFileSync(
  new URL('../../migrations/0004_cache_epoch.sql', import.meta.url),
  'utf8',
);

const UNKNOWN = '01J0UNKNOWN0000000000000000';
const NOW = '2026-10-15T12:00:00.000Z';

let opened: OpenedExecutor;

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  const init: MigrationSource = await loadMigrationSource('core', '0001_init.sql', initText);
  const epoch = await loadMigrationSource('core', '0004_cache_epoch.sql', epochText);
  await migrate(opened.executor, [init, epoch], { holder: 't100' });
});

afterEach(async () => {
  await opened.close();
});

async function rows(): Promise<Record<string, unknown>[]> {
  return opened.executor.all({ sql: 'SELECT * FROM organization ORDER BY id', params: [] });
}

async function row(id: string): Promise<Record<string, unknown> | undefined> {
  const found = await opened.executor.all<Record<string, unknown>>({
    sql: 'SELECT * FROM organization WHERE id = ?',
    params: [id],
  });
  return found[0];
}

describe('seedTwoOrganizations', () => {
  it('1: inserts both organizations in one batch and keeps the singleton index dropped', async () => {
    const counted = countCalls(opened.executor);
    const { a, b } = await seedTwoOrganizations(counted.executor);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.map((entry) => entry.singleton)).toEqual([1, 1]);

    const indexes = await opened.executor.all<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'organization_singleton'",
      params: [],
    });
    expect(indexes).toEqual([]);

    expect(a).toEqual(orgContext('01J00000000000000000000A0A'));
    expect(b).toEqual(orgContext('01J00000000000000000000B0B'));
  });
});

describe('organization isolation', () => {
  it('2: get() returns each organization its own row', async () => {
    const { a, b } = await seedTwoOrganizations(opened.executor);
    const repository = createOrganizationRepository(opened.executor);

    const first = await repository.get(a);
    const second = await repository.get(b);

    expect(first).toMatchObject({ id: a.orgId, slug: 'org-a', name: 'Organization A' });
    expect(second).toMatchObject({ id: b.orgId, slug: 'org-b', name: 'Organization B' });
    expect(first?.id).not.toBe(second?.id);
  });

  it('3: updateSettings(a, ...) leaves B unchanged', async () => {
    const { a, b } = await seedTwoOrganizations(opened.executor);
    const repository = createOrganizationRepository(opened.executor);
    const before: Organization | null = await repository.get(b);

    const updated = await repository.updateSettings(
      a,
      {
        name: 'Organization A renamed',
        retentionRemovedUpstreamDays: 30,
        tokenDefaultExpiryDays: 7,
        tokenCiReadonlyExpiryDays: 14,
      },
      NOW,
    );

    expect(updated).toMatchObject({ id: a.orgId, name: 'Organization A renamed', updatedAt: NOW });
    expect(updated?.settings).toEqual({
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: 7,
      tokenCiReadonlyExpiryDays: 14,
    });
    expect(await repository.get(b)).toEqual(before);
    expect(await row(b.orgId)).toMatchObject({
      id: b.orgId,
      slug: 'org-b',
      name: 'Organization B',
      retention_removed_upstream_days: 365,
      token_default_expiry_days: 90,
      token_ci_readonly_expiry_days: 365,
    });
  });

  it('4: an unknown organization reads as null and writes to no row', async () => {
    await seedTwoOrganizations(opened.executor);
    const repository = createOrganizationRepository(opened.executor);
    const ctx = orgContext(UNKNOWN);
    const before = await rows();

    expect(await repository.get(ctx)).toBeNull();
    expect(
      await repository.updateSettings(ctx, { name: 'nobody', tokenDefaultExpiryDays: 1 }, NOW),
    ).toBeNull();

    expect(await rows()).toEqual(before);
    expect(await row(UNKNOWN)).toBeUndefined();
  });
});
