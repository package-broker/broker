import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type {
  ScalarSqlExecutor,
  ScalarStatement,
  StatementResult,
} from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { createOrganizationBootstrap, createOrganizationRepository } from './organization.js';

const initUrl = new URL('../../migrations/0001_init.sql', import.meta.url);
const initText = readFileSync(initUrl, 'utf8');

const FIRST = {
  id: '01J0ACME000000000000000000',
  slug: 'acme',
  name: 'Acme',
  now: '2026-10-15T09:00:00.000Z',
} as const;
const SECOND = {
  id: '01J0BETA000000000000000000',
  slug: 'beta',
  name: 'Beta',
  now: '2026-10-15T10:00:00.000Z',
} as const;

interface Recording {
  readonly executor: ScalarSqlExecutor;
  readonly statements: ScalarStatement[];
  readonly violations: string[];
}

function recordingExecutor(executor: ScalarSqlExecutor): Recording {
  const statements: ScalarStatement[] = [];
  const violations: string[] = [];
  const inspect = (statement: ScalarStatement): void => {
    statements.push(statement);
    statement.params.forEach((param, index) => {
      const scalar =
        typeof param === 'string' || (typeof param === 'number' && Number.isSafeInteger(param));
      if (!scalar) violations.push(`${statement.sql} parameter ${index}`);
    });
  };
  return {
    statements,
    violations,
    executor: {
      driver: executor.driver,
      all: async <R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> => {
        inspect(statement);
        return executor.all<R>(statement);
      },
      batch: async (list: readonly ScalarStatement[]): Promise<StatementResult[]> => {
        for (const statement of list) inspect(statement);
        return executor.batch(list);
      },
    },
  };
}

let opened: OpenedExecutor;
let init: MigrationSource;

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  init = await loadMigrationSource('core', '0001_init.sql', initText);
  await migrate(opened.executor, [init], { holder: 't99' });
});

afterEach(async () => {
  await opened.close();
});

async function countOrganizations(): Promise<number> {
  const rows = await opened.executor.all<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM organization',
    params: [],
  });
  return rows[0]?.n ?? -1;
}

describe('createOrganizationBootstrap', () => {
  it('1: creates once and then reports the existing row without changing it', async () => {
    const bootstrap = createOrganizationBootstrap(opened.executor);

    const first = await bootstrap.bootstrap(FIRST);
    const second = await bootstrap.bootstrap(SECOND);

    expect(first).toEqual({ created: true, id: FIRST.id, slug: 'acme', name: 'Acme' });
    expect(second).toEqual({ created: false, id: FIRST.id, slug: 'acme', name: 'Acme' });
    expect(await countOrganizations()).toBe(1);
  });

  it('2: rejects an invalid slug with TypeError before making any call', async () => {
    const counted = countCalls(opened.executor);
    const bootstrap = createOrganizationBootstrap(counted.executor);

    await expect(bootstrap.bootstrap({ ...FIRST, slug: 'Bad Slug' })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    expect(await countOrganizations()).toBe(0);
  });
});

describe('createOrganizationRepository', () => {
  it('3: reads defaults, updates settings and reports a CHECK violation as a DbError', async () => {
    await createOrganizationBootstrap(opened.executor).bootstrap(FIRST);
    const repository = createOrganizationRepository(opened.executor);
    const ctx = orgContext(FIRST.id);

    const loaded = await repository.get(ctx);
    expect(loaded?.settings).toEqual({
      retentionRemovedUpstreamDays: 365,
      tokenDefaultExpiryDays: 90,
      tokenCiReadonlyExpiryDays: 365,
    });

    const now = '2026-10-15T11:00:00.000Z';
    const updated = await repository.updateSettings(
      ctx,
      { tokenDefaultExpiryDays: 30, name: 'Acme Two' },
      now,
    );
    expect(updated).toMatchObject({ name: 'Acme Two', updatedAt: now });
    expect(updated?.settings.tokenDefaultExpiryDays).toBe(30);
    expect(updated?.settings.retentionRemovedUpstreamDays).toBe(365);

    const reread = await repository.get(ctx);
    expect(reread).toMatchObject({ name: 'Acme Two', updatedAt: now });

    const error = await repository
      .updateSettings(ctx, { retentionRemovedUpstreamDays: -1 }, now)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('check');
  });

  it('3b: get and updateSettings resolve to null for an absent organization', async () => {
    const repository = createOrganizationRepository(opened.executor);
    const ctx = orgContext('01J0MISSING0000000000000000');

    expect(await repository.get(ctx)).toBeNull();
    expect(await repository.updateSettings(ctx, { name: 'nobody' }, FIRST.now)).toBeNull();
  });
});

describe('executor calls', () => {
  it('4: each method makes one call and findSingleton binds no parameter', async () => {
    const recorded = recordingExecutor(opened.executor);
    const counted = countCalls(recorded.executor);
    const repository = createOrganizationRepository(counted.executor);
    const bootstrap = createOrganizationBootstrap(counted.executor);
    const ctx = orgContext(FIRST.id);

    const created = counted.counts().all;
    await bootstrap.bootstrap(FIRST);
    expect(counted.counts().all - created).toBe(1);

    const read = counted.counts().all;
    await repository.get(ctx);
    expect(counted.counts().all - read).toBe(1);

    const written = counted.counts().all;
    await repository.updateSettings(ctx, { name: 'Acme' }, FIRST.now);
    expect(counted.counts().all - written).toBe(1);

    const found = counted.counts().all;
    await bootstrap.findSingleton();
    expect(counted.counts().all - found).toBe(1);
    expect(counted.counts().batch).toBe(0);

    const singleton = recorded.statements.at(-1);
    expect(singleton?.sql).toContain('"singleton" = 1');
    expect(singleton?.params).toEqual([]);
  });

  it('5: every compiled statement binds strings or safe integers only', async () => {
    const recorded = recordingExecutor(opened.executor);
    const repository = createOrganizationRepository(recorded.executor);
    const bootstrap = createOrganizationBootstrap(recorded.executor);
    const ctx = orgContext(FIRST.id);

    await bootstrap.bootstrap(FIRST);
    await repository.get(ctx);
    await repository.updateSettings(
      ctx,
      {
        name: 'Acme Two',
        retentionRemovedUpstreamDays: 30,
        tokenDefaultExpiryDays: 180,
        tokenCiReadonlyExpiryDays: 365,
      },
      FIRST.now,
    );
    await bootstrap.bootstrap(SECOND);
    await bootstrap.findSingleton();

    expect(recorded.statements.length).toBeGreaterThanOrEqual(6);
    expect(recorded.violations).toEqual([]);
  });

  it('6: rejects fractional, NaN and Infinity settings before any executor call', async () => {
    const counted = countCalls(opened.executor);
    const repository = createOrganizationRepository(counted.executor);
    const ctx = orgContext(FIRST.id);

    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        repository.updateSettings(ctx, { tokenDefaultExpiryDays: value }, FIRST.now),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        repository.updateSettings(ctx, { retentionRemovedUpstreamDays: value }, FIRST.now),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        repository.updateSettings(ctx, { tokenCiReadonlyExpiryDays: value }, FIRST.now),
      ).rejects.toBeInstanceOf(TypeError);
    }

    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});
