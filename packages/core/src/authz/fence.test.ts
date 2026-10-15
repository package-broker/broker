import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError, classifySqliteError } from '../db/errors.js';
import type { SqlExecutor, Statement, StatementResult } from '../db/port.js';
import { classifyFailure, fenceGuard, mutationFence, runFenced } from './fence.js';
import type { AuthenticatedActor, FailureProbes, FenceGuard, MutationFence } from './fence.js';
import { systemFence } from './system-fence.js';
import type { SystemFence } from './system-fence.js';

const GUARD_DDL =
  'CREATE TABLE access_mutation_guard (key TEXT NOT NULL PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64)) STRICT';
const TARGET_DDL =
  'CREATE TABLE target (id TEXT NOT NULL PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL) STRICT';

const actor = { userId: 'u1', sessionId: 's1' } as unknown as AuthenticatedActor;
const fence = mutationFence(actor, { 'role:r1': 1 });

interface Harness {
  readonly database: DatabaseSync;
  readonly executor: SqlExecutor;
}

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
});

function harness(): Harness {
  const database = new DatabaseSync(':memory:');
  open.push(database);
  database.exec(GUARD_DDL);
  database.exec(TARGET_DDL);
  database.exec("INSERT INTO target (id, revision, name) VALUES ('r1', 1, 'old')");
  const run = (statement: Statement): StatementResult => {
    const prepared = database.prepare(statement.sql);
    if (prepared.columns().length === 0) {
      return { changes: Number(prepared.run(...statement.params).changes), rows: [] };
    }
    return { changes: 0, rows: prepared.all(...statement.params) as Record<string, unknown>[] };
  };
  const executor: SqlExecutor = {
    driver: 'node-sqlite',
    async all<R>(statement: Statement): Promise<R[]> {
      return run(statement).rows as R[];
    },
    async batch(statements: readonly Statement[]): Promise<StatementResult[]> {
      try {
        database.exec('BEGIN IMMEDIATE');
        const results = statements.map(run);
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw classifySqliteError(error);
      }
    },
  };
  return { database, executor };
}

const guardWhen = (condition: string, params: Statement['params'] = [], key = 'K1'): FenceGuard => {
  const statement: Statement = {
    sql: `INSERT INTO access_mutation_guard (key) SELECT ? WHERE (${condition}) IS NOT 1`,
    params: [key, ...params],
  };
  return fenceGuard([statement, statement]);
};
const revisionGuard = (revision: number, key?: string): FenceGuard =>
  guardWhen('EXISTS (SELECT 1 FROM target WHERE id = ? AND revision = ?)', ['r1', revision], key);

const rename: Statement = {
  sql: "UPDATE target SET name = 'new', revision = revision + 1 WHERE id = 'r1'",
  params: [],
};
const probes = (): FailureProbes => ({
  conflict: { sql: "SELECT revision <> 1 AS hit FROM target WHERE id = 'r1'", params: [] },
  collision: {
    sql: "SELECT EXISTS (SELECT 1 FROM target WHERE id = 'dup') AS hit",
    params: [],
  },
});
const nameOf = (h: Harness): unknown =>
  (h.database.prepare("SELECT name FROM target WHERE id = 'r1'").get() as { name: string }).name;
const guardRows = (h: Harness): number =>
  (h.database.prepare('SELECT count(*) AS n FROM access_mutation_guard').get() as { n: number }).n;
const stub = (batch: () => Promise<StatementResult[]>, rows: unknown[] = []): SqlExecutor => ({
  driver: 'node-sqlite',
  all: async <R>() => rows as R[],
  batch,
});

describe('mutationFence', () => {
  it('freezes a copy and rejects malformed input', () => {
    const expected = { 'role:r1': 2 };
    const made = mutationFence(actor, expected);
    expected['role:r1'] = 9;
    expect(made.expected['role:r1']).toBe(2);
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.expected)).toBe(true);
    const blank = (patch: object): AuthenticatedActor => ({ ...actor, ...patch });
    expect(() => mutationFence(blank({ userId: '' }), {})).toThrow(TypeError);
    expect(() => mutationFence(blank({ sessionId: '' }), {})).toThrow(TypeError);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => mutationFence(actor, { k: bad })).toThrow(TypeError);
    }
  });

  it('requires the authenticated actor type at compile time', () => {
    // @ts-expect-error plain data is not an AuthenticatedActor
    expect(() => mutationFence({ userId: 'u', sessionId: 's' }, {})).not.toThrow();
  });

  it('runFenced refuses a fence-shaped HTTP body', async () => {
    const h = harness();
    const body = JSON.parse('{"userId":"u","sessionId":"s","expected":{"k":1}}') as MutationFence;
    await expect(runFenced(h.executor, body, revisionGuard(1), [rename], {})).rejects.toThrow(
      TypeError,
    );
    expect(nameOf(h)).toBe('old');
  });
});

describe('runFenced', () => {
  it('commits a passing guard and the mutation, leaving no guard rows', async () => {
    const h = harness();
    const outcome = await runFenced(h.executor, fence, revisionGuard(1), [rename], probes());
    expect(outcome.ok).toBe(true);
    expect(nameOf(h)).toBe('new');
    expect(guardRows(h)).toBe(0);
  });

  it('puts the guard before the mutations', async () => {
    const seen: string[] = [];
    const executor = stub(async () => []);
    const spy: SqlExecutor = {
      ...executor,
      batch: async (statements) => {
        seen.push(...statements.map((s) => s.sql));
        return [];
      },
    };
    const guard = revisionGuard(1);
    await runFenced(spy, fence, guard, [rename], {});
    expect(seen[0]).toBe(guard[0]?.sql);
    expect(seen.at(-1)).toBe(rename.sql);
  });

  it('refuses an empty guard', async () => {
    const h = harness();
    await expect(runFenced(h.executor, fence, fenceGuard([]), [rename], {})).rejects.toThrow(
      TypeError,
    );
  });

  it('refuses a non-array or oversized guard', async () => {
    const h = harness();
    const long = fenceGuard(Array.from({ length: 5 }, () => rename));
    await expect(runFenced(h.executor, fence, long, [rename], {})).rejects.toThrow(TypeError);
    const notArray = { length: 1 } as unknown as FenceGuard;
    await expect(runFenced(h.executor, fence, notArray, [rename], {})).rejects.toThrow(TypeError);
    expect(nameOf(h)).toBe('old');
  });

  it('rolls back an executed mutation when a later statement fails', async () => {
    const h = harness();
    const first: Statement = {
      sql: "INSERT INTO target (id, revision, name) VALUES ('first', 1, 'f')",
      params: [],
    };
    const failing: Statement = {
      sql: "INSERT INTO target (id, revision, name) VALUES ('r1', 1, 'dup')",
      params: [],
    };
    const outcome = await runFenced(
      h.executor,
      fence,
      revisionGuard(1),
      [rename, first, failing],
      probes(),
    );
    expect(outcome.ok).toBe(false);
    expect(h.database.prepare("SELECT 1 FROM target WHERE id = 'first'").get()).toBeUndefined();
    expect(nameOf(h)).toBe('old');
  });

  it('false guard rolls back, classifies conflict, and leaves no partial row', async () => {
    const h = harness();
    h.database.exec("UPDATE target SET revision = 2 WHERE id = 'r1'");
    const insert: Statement = {
      sql: "INSERT INTO target (id, revision, name) VALUES ('extra', 1, 'x')",
      params: [],
    };
    const outcome = await runFenced(
      h.executor,
      fence,
      revisionGuard(1),
      [insert, rename],
      probes(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'conflict' });
    expect(nameOf(h)).toBe('old');
    expect(h.database.prepare("SELECT 1 FROM target WHERE id = 'extra'").get()).toBeUndefined();
    expect(guardRows(h)).toBe(0);
  });

  it('rolls back even when the guard key already exists as a row', async () => {
    const h = harness();
    h.database.exec("INSERT INTO access_mutation_guard (key) VALUES ('K1')");
    const outcome = await runFenced(h.executor, fence, revisionGuard(99), [rename], {});
    expect(outcome.ok).toBe(false);
    expect(nameOf(h)).toBe('old');
    expect(guardRows(h)).toBe(1);
  });

  it('a NULL condition fails closed', async () => {
    const h = harness();
    const outcome = await runFenced(h.executor, fence, guardWhen('NULL'), [rename], {});
    expect(outcome.ok).toBe(false);
    expect(nameOf(h)).toBe('old');
  });

  it('the guard column refuses NULL and oversize keys', () => {
    const h = harness();
    expect(() =>
      h.database.exec('INSERT INTO access_mutation_guard (key) VALUES (NULL)'),
    ).toThrow();
    expect(() =>
      h.database.exec(`INSERT INTO access_mutation_guard (key) VALUES ('${'x'.repeat(65)}')`),
    ).toThrow();
  });

  it('classifies authority before conflict', async () => {
    const h = harness();
    h.database.exec("UPDATE target SET revision = 2 WHERE id = 'r1'");
    const p: FailureProbes = { ...probes(), authority: { sql: 'SELECT 1 AS hit', params: [] } };
    const outcome = await runFenced(h.executor, fence, revisionGuard(1), [rename], p);
    expect(outcome).toEqual({ ok: false, reason: 'authority' });
  });

  it('classifies a unique-violation collision from probe reads', async () => {
    const h = harness();
    h.database.exec("INSERT INTO target (id, revision, name) VALUES ('dup', 1, 'd')");
    const insert: Statement = {
      sql: "INSERT INTO target (id, revision, name) VALUES ('dup', 1, 'x')",
      params: [],
    };
    const outcome = await runFenced(h.executor, fence, revisionGuard(1), [insert], probes());
    expect(outcome).toEqual({ ok: false, reason: 'collision' });
    expect(guardRows(h)).toBe(0);
  });

  it('a constraint failure with no probe answering is unclassified, never success', async () => {
    const h = harness();
    const outcome = await runFenced(h.executor, fence, revisionGuard(99), [rename], {});
    expect(outcome).toEqual({ ok: false, reason: 'unclassified' });
  });

  it('an unknown DbError is indeterminate and runs no probes', async () => {
    let reads = 0;
    const executor: SqlExecutor = {
      driver: 'd1',
      all: async <R>() => {
        reads += 1;
        return [] as R[];
      },
      batch: async () => {
        throw new DbError('unknown', 'lost response');
      },
    };
    const outcome = await runFenced(executor, fence, revisionGuard(1), [rename], probes());
    expect(outcome).toEqual({ ok: false, reason: 'indeterminate' });
    expect(reads).toBe(0);
  });

  it('a busy DbError is unclassified without probes', async () => {
    const executor = stub(async () => {
      throw new DbError('busy', 'locked');
    });
    expect(await runFenced(executor, fence, revisionGuard(1), [rename], probes())).toEqual({
      ok: false,
      reason: 'unclassified',
    });
  });

  it('rethrows an error that is not a DbError', async () => {
    const executor = stub(async () => {
      throw new RangeError('bug');
    });
    await expect(runFenced(executor, fence, revisionGuard(1), [rename], probes())).rejects.toThrow(
      RangeError,
    );
  });
});

describe('classifyFailure', () => {
  it('reads bigint and number probe values', async () => {
    const hit = { sql: 'SELECT 1', params: [] };
    expect(
      await classifyFailure(
        stub(async () => [], [{ hit: 1n }]),
        { conflict: hit },
      ),
    ).toBe('conflict');
    expect(
      await classifyFailure(
        stub(async () => [], [{ hit: 0n }]),
        { conflict: hit },
      ),
    ).toBe('unclassified');
    expect(
      await classifyFailure(
        stub(async () => [], [{ hit: 1 }]),
        { collision: hit },
      ),
    ).toBe('collision');
  });

  it('a failing probe read degrades to unclassified', async () => {
    const h = harness();
    const bad: FailureProbes = { authority: { sql: 'SELECT * FROM nope', params: [] } };
    expect(await classifyFailure(h.executor, bad)).toBe('unclassified');
  });
});

describe('SystemFence boundary', () => {
  it('is not assignable to MutationFence', () => {
    const system: SystemFence = systemFence();
    // @ts-expect-error a SystemFence must not satisfy a service writer parameter
    const asMutation: MutationFence = system;
    expect(asMutation).toBeDefined();
  });

  it('only db-sqlite sources import fenceGuard', () => {
    expect(
      scan(/\bfenceGuard\b/, (relative) => relative.startsWith('db-sqlite/src/'), 'authz/fence.ts'),
    ).toEqual([]);
  });

  it('only packages/cli and bootstrap modules import system-fence', () => {
    expect(
      scan(
        /system-fence/,
        (relative, name) => relative.startsWith('cli/') || /bootstrap/.test(name),
        'authz/system-fence.ts',
      ),
    ).toEqual([]);
  });
});

function scan(
  pattern: RegExp,
  allowed: (relative: string, name: string) => boolean,
  definingFile: string,
): string[] {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        const relative = path.relative(root, full);
        if (relative.endsWith(definingFile)) continue;
        if (!allowed(relative, entry.name) && pattern.test(readFileSync(full, 'utf8'))) {
          offenders.push(relative);
        }
      }
    }
  };
  walk(root);
  return offenders;
}
