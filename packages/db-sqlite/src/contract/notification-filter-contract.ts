import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { MAX_KEY_LENGTH } from '@package-broker/core/catalogue/names';
import {
  isStoredKey,
  isValidPattern,
  matchesPattern,
} from '@package-broker/core/catalogue/patterns';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { db } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { notificationFilterCondition } from '../repositories/notification-filter.js';
import { ENDPOINT, insertRow, seedNotificationScope } from './notification-migration-contract.js';

export interface OpenedFilterDatabase {
  readonly executor: ScalarSqlExecutor;
  close(): Promise<void>;
}

function expected(pattern: string, key: string): boolean {
  return isValidPattern(pattern) && isStoredKey(key) && matchesPattern(pattern, key);
}

const PATTERNS = [
  '*',
  '@acme/*',
  '@acme/!widget',
  '@acme/widget',
  '!widget',
  'widget',
  'widget*',
  '*widget',
  '*/*',
  'a*b*c*d*e',
  'a*b*c*d*e*f',
  '@*/!*',
  'x*x',
  '!j!s!o!n*',
  'a?c',
  'a_c',
  'a.c',
  '[ab]*',
  'a[!b]c',
  'Widget',
  '^widget$',
  '/widget/i',
  'wid\\get',
  'é*',
  `${'é'.repeat(40)}*`,
  'a\u0000*',
  ' *',
];

const KEYS = [
  'widget',
  '!widget',
  '@acme/widget',
  '@acme/!widget',
  '@acme/sub/widget',
  '@other/widget',
  'Widget',
  '@ACME/widget',
  'widget-two',
  'my-widget',
  'abcde',
  'aXbXcXdXe',
  'abcdef',
  'a/b/c/d/e',
  'xx',
  'x',
  '!j!s!o!n',
  '!j!s!o!n!stream',
  'abc',
  'a?c',
  'a_c',
  'a.c',
  'a[b',
  'é',
  'wid\\get',
  'a\u0000b',
  'a'.repeat(MAX_KEY_LENGTH),
  'a'.repeat(MAX_KEY_LENGTH + 1),
];

function generated(seed: number, count: number, alphabet: string, max: number): string[] {
  let state = seed;
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const length = 1 + (state % max);
    let value = '';
    for (let char = 0; char < length; char += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      value += alphabet.charAt(state % alphabet.length);
    }
    out.push(value);
  }
  return out;
}

const GENERATED_PATTERNS = generated(7, 40, 'ab!@/*-.', 8);
const GENERATED_KEYS = generated(11, 60, 'ab!@/-.', 10);

async function matching(
  executor: ScalarSqlExecutor,
  org: string,
  project: string,
  key: string,
): Promise<string[]> {
  const query = sql<{ id: string }>`SELECT id FROM notification_endpoint
    WHERE org_id = ${org} AND project_id = ${project} AND state = 'enabled'
      AND ${notificationFilterCondition(sql.ref('package_pattern'), sql.val(key))}
    ORDER BY id`.compile(db);
  const rows = await executor.all<{ id: string }>({
    sql: query.sql,
    params: query.parameters as string[],
  });
  return rows.map((row) => row.id);
}

export function describeNotificationFilterContract(
  name: string,
  open: () => Promise<OpenedFilterDatabase>,
): void {
  async function withEndpoints(
    patterns: readonly string[],
    body: (executor: ScalarSqlExecutor, ids: readonly string[]) => Promise<void>,
  ): Promise<void> {
    const opened = await open();
    try {
      await migrate(opened.executor, await discoveredMigrations(), {
        holder: 'notification-filter',
      });
      await insertRow(opened.executor, 'organization', { id: 'org', slug: 'org', name: 'Org' });
      await seedNotificationScope(opened.executor, 'org', 'project', ['credential']);
      await seedNotificationScope(opened.executor, 'org', 'other', ['other-credential']);
      const rows = patterns.map((pattern, index) => ({
        pattern,
        id: `endpoint-${String(index).padStart(3, '0')}`,
      }));
      for (const row of rows) {
        await insertRow(opened.executor, 'notification_endpoint', {
          ...ENDPOINT,
          id: row.id,
          state: 'enabled',
          package_pattern: row.pattern,
        });
        await insertRow(opened.executor, 'notification_endpoint', {
          ...ENDPOINT,
          project_id: 'other',
          credential_id: 'other-credential',
          id: `other-${row.id}`,
          state: 'enabled',
          package_pattern: row.pattern,
        });
      }
      const ids = rows.map((row) => row.id);
      await body(opened.executor, ids);
    } finally {
      await opened.close();
    }
  }

  async function agree(patterns: readonly string[], keys: readonly string[]): Promise<void> {
    await withEndpoints(patterns, async (executor, ids) => {
      const pairs = ids.map((id, index) => ({ id, pattern: patterns.at(index) ?? '' }));
      for (const key of keys) {
        const want = pairs.filter((pair) => expected(pair.pattern, key)).map((pair) => pair.id);
        expect(await matching(executor, 'org', 'project', key), JSON.stringify(key)).toEqual(want);
      }
    });
  }

  describe(`notification filter: ${name}`, () => {
    it('selects the same recipients as the TypeScript matcher for listed keys', async () => {
      await agree(PATTERNS, KEYS);
    });

    it('selects the same recipients for generated stored keys and wildcard patterns', async () => {
      await agree(GENERATED_PATTERNS, [...GENERATED_KEYS, ...KEYS.slice(0, 6)]);
    });

    it('matches only the stored key form, never the display name', async () => {
      await withEndpoints(['@acme/!widget', '@acme/Widget'], async (executor, ids) => {
        expect(await matching(executor, 'org', 'project', '@acme/!widget')).toEqual([ids[0]]);
        expect(await matching(executor, 'org', 'project', '@acme/Widget')).toEqual([]);
      });
    });

    it('selects only enabled endpoints of the asked project and organization', async () => {
      await withEndpoints(['*', 'widget'], async (executor, ids) => {
        await executor.all({
          sql: "UPDATE notification_endpoint SET state = 'disabled' WHERE org_id = ? AND id = ?",
          params: ['org', ids[1]!],
        });
        expect(await matching(executor, 'org', 'project', 'widget')).toEqual([ids[0]]);
        expect(await matching(executor, 'org', 'other', 'widget')).toEqual([
          `other-${ids[0]!}`,
          `other-${ids[1]!}`,
        ]);
        expect(await matching(executor, 'foreign', 'project', 'widget')).toEqual([]);
      });
    });
  });
}
