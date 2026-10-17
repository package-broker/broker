import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError, classifySqliteError } from '../db/errors.js';
import type { SqlExecutor, Statement, StatementResult } from '../db/port.js';
import {
  classifyFailure,
  delegatedMutationFence,
  fenceGuard,
  fenceKind,
  mutationFence,
  runFenced,
  systemMutationFence,
  tokenMutationFence,
} from './fence.js';
import type {
  AnyMutationFence,
  AuthenticatedActor,
  AuthenticatedTokenActor,
  DelegatedMutationFence,
  FailureProbes,
  FenceGuard,
  FenceKind,
  MutationFence,
  SystemMutationFence,
  SystemWriter,
  TokenMutationFence,
} from './fence.js';
import { PERMISSIONS } from './permissions.js';
import type { JobGuard } from '../platform/job-repository.js';
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

  it('only packages/cli and the listed modules import system-fence', () => {
    expect(scan(/system-fence/, mayImportSystemFence, 'authz/system-fence.ts')).toEqual([]);
  });

  it('does not allow a file by its name alone', () => {
    expect(mayImportSystemFence('cli/src/main.ts')).toBe(true);
    expect(mayImportSystemFence('core/src/kernel/bootstrap-helper.ts')).toBe(false);
    expect(mayImportSystemFence('db-sqlite/src/repositories/admin-bootstrap.ts')).toBe(false);
    expect(mayImportSystemFence('plugin-x/src/cli/a.ts')).toBe(false);
  });
});

const SYSTEM_FENCE_IMPORTER_PREFIXES = ['cli/'];
const SYSTEM_FENCE_IMPORTER_MODULES: readonly string[] = [];

function mayImportSystemFence(relative: string): boolean {
  return (
    SYSTEM_FENCE_IMPORTER_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    SYSTEM_FENCE_IMPORTER_MODULES.includes(relative)
  );
}

function scan(
  pattern: RegExp,
  allowed: (relative: string) => boolean,
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
        if (!allowed(relative) && pattern.test(readFileSync(full, 'utf8'))) {
          offenders.push(relative);
        }
      }
    }
  };
  walk(root);
  return offenders;
}

const job: JobGuard = { id: 'j1', owner: 'o1', fence: 3 };
const tokenActor = {
  tokenId: 't1',
  tokenKind: 'pat',
  principalId: 'p1',
} as unknown as AuthenticatedTokenActor;
const tokenPermission = 'project:packages:write';
const issuedFences = (): Record<FenceKind, AnyMutationFence> => ({
  session: mutationFence(actor, { 'role:r1': 1 }),
  system: systemMutationFence('audit-seal', job, { 'audit:head': 1 }),
  token: tokenMutationFence(tokenActor, tokenPermission, {}),
  delegated: delegatedMutationFence('u1', 'run1', job, { 'import:run1': 2 }),
});

describe('session fence shape', () => {
  it('keeps exactly userId, sessionId and expected', () => {
    expect(Object.keys(mutationFence(actor, { k: 1 }))).toEqual([
      'userId',
      'sessionId',
      'expected',
    ]);
  });
});

describe('fence kind separation at compile time', () => {
  const { system, token, delegated } = issuedFences() as {
    system: SystemMutationFence;
    token: TokenMutationFence;
    delegated: DelegatedMutationFence;
  };
  const session = fence;

  it('a SystemMutationFence is not a MutationFence', () => {
    // @ts-expect-error a job fence must not satisfy a session writer
    const asSession: MutationFence = system;
    expect(asSession).toBeDefined();
  });

  it('a TokenMutationFence is not a MutationFence', () => {
    // @ts-expect-error a token fence must not satisfy a session writer
    const asSession: MutationFence = token;
    expect(asSession).toBeDefined();
  });

  it('a DelegatedMutationFence is not a MutationFence', () => {
    // @ts-expect-error a delegated fence must not satisfy a session writer
    const asSession: MutationFence = delegated;
    expect(asSession).toBeDefined();
  });

  it('the bootstrap SystemFence is not a SystemMutationFence or any other new fence', () => {
    const bootstrap: SystemFence = systemFence();
    // @ts-expect-error the bootstrap fence is not a job fence
    const asSystem: SystemMutationFence = bootstrap;
    // @ts-expect-error the bootstrap fence is not a token fence
    const asToken: TokenMutationFence = bootstrap;
    // @ts-expect-error the bootstrap fence is not a delegated fence
    const asDelegated: DelegatedMutationFence = bootstrap;
    // @ts-expect-error the bootstrap fence is not accepted by runFenced
    const asAny: AnyMutationFence = bootstrap;
    expect([asSystem, asToken, asDelegated, asAny]).toHaveLength(4);
  });

  it('a SystemMutationFence is not a token or delegated fence', () => {
    // @ts-expect-error system is not token
    const asToken: TokenMutationFence = system;
    // @ts-expect-error system is not delegated
    const asDelegated: DelegatedMutationFence = system;
    expect([asToken, asDelegated]).toHaveLength(2);
  });

  it('a TokenMutationFence is not a system or delegated fence', () => {
    // @ts-expect-error token is not system
    const asSystem: SystemMutationFence = token;
    // @ts-expect-error token is not delegated
    const asDelegated: DelegatedMutationFence = token;
    expect([asSystem, asDelegated]).toHaveLength(2);
  });

  it('a DelegatedMutationFence is not a system or token fence', () => {
    // @ts-expect-error delegated is not system
    const asSystem: SystemMutationFence = delegated;
    // @ts-expect-error delegated is not token
    const asToken: TokenMutationFence = delegated;
    expect([asSystem, asToken]).toHaveLength(2);
  });

  it('a MutationFence is not a system, token or delegated fence', () => {
    // @ts-expect-error session is not system
    const asSystem: SystemMutationFence = session;
    // @ts-expect-error session is not token
    const asToken: TokenMutationFence = session;
    // @ts-expect-error session is not delegated
    const asDelegated: DelegatedMutationFence = session;
    expect([asSystem, asToken, asDelegated]).toHaveLength(3);
  });

  it('a session actor is not a token actor, and plain data is neither', () => {
    // @ts-expect-error a session actor cannot issue a token fence
    expect(() => tokenMutationFence(actor, tokenPermission, {})).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error plain data is not an AuthenticatedTokenActor
      tokenMutationFence({ tokenId: 't', tokenKind: 'pat', principalId: 'p' }, tokenPermission, {}),
    ).not.toThrow();
  });

  it('SystemWriter is a closed union', () => {
    // @ts-expect-error an unknown writer name does not compile
    const unknown: SystemWriter = 'import-apply';
    expect(unknown).toBe('import-apply');
  });
});

describe('systemMutationFence', () => {
  it('issues a frozen system fence carrying the writer, lease and revisions', () => {
    const expected = { 'audit:head': 4 };
    const made = systemMutationFence('ingest-finalize', job, expected);
    expected['audit:head'] = 9;
    expect(made.writer).toBe('ingest-finalize');
    expect(made.job).toEqual(job);
    expect(made.expected).toEqual({ 'audit:head': 4 });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.job)).toBe(true);
    expect(Object.isFrozen(made.expected)).toBe(true);
  });

  it('accepts every design writer', () => {
    for (const writer of ['ingest-finalize', 'purge', 'audit-seal', 'audit-verify', 'verifier']) {
      expect(fenceKind(systemMutationFence(writer as SystemWriter, job, {}))).toBe('system');
    }
  });

  it('rejects an unknown writer', () => {
    expect(() => systemMutationFence('import-apply' as SystemWriter, job, {})).toThrow(TypeError);
  });

  it('rejects an empty job id', () => {
    expect(() => systemMutationFence('purge', { ...job, id: '' }, {})).toThrow(TypeError);
  });

  it('rejects an empty job owner', () => {
    expect(() => systemMutationFence('purge', { ...job, owner: '' }, {})).toThrow(TypeError);
  });

  it('rejects a non-integer job fence', () => {
    for (const bad of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => systemMutationFence('purge', { ...job, fence: bad }, {})).toThrow(TypeError);
    }
  });

  it('rejects a job fence below 1', () => {
    for (const bad of [0, -1]) {
      expect(() => systemMutationFence('purge', { ...job, fence: bad }, {})).toThrow(TypeError);
      expect(() => delegatedMutationFence('u1', 'run1', { ...job, fence: bad }, {})).toThrow(
        TypeError,
      );
    }
  });

  it('rejects invalid expected revisions', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => systemMutationFence('purge', job, { k: bad })).toThrow(TypeError);
    }
  });
});

describe('tokenMutationFence', () => {
  const sessionOnly = PERMISSIONS.filter((info) => info.sessionOnly).map((info) => info.name);
  const reads = PERMISSIONS.filter((info) => !info.sessionOnly && info.name.endsWith(':read')).map(
    (info) => info.name,
  );
  const tokenAllowed = PERMISSIONS.filter(
    (info) => !info.sessionOnly && !info.name.endsWith(':read'),
  ).map((info) => info.name);

  it('the catalogue has both kinds of permission', () => {
    expect(sessionOnly.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
    expect(tokenAllowed.length).toBeGreaterThan(0);
  });

  it.each(sessionOnly)('refuses session-only permission %s', (name) => {
    expect(() => tokenMutationFence(tokenActor, name, {})).toThrow(TypeError);
  });

  it.each(reads)('refuses read permission %s', (name) => {
    expect(() => tokenMutationFence(tokenActor, name, {})).toThrow(TypeError);
  });

  it.each(tokenAllowed)('issues a token fence for %s', (name) => {
    const made = tokenMutationFence(tokenActor, name, { k: 1 });
    expect(made.permission).toBe(name);
    expect(fenceKind(made)).toBe('token');
  });

  it('refuses an unknown permission', () => {
    expect(() => tokenMutationFence(tokenActor, 'project:packages:launch', {})).toThrow(TypeError);
  });

  it('refuses an empty token id', () => {
    const blank = { ...tokenActor, tokenId: '' } as AuthenticatedTokenActor;
    expect(() => tokenMutationFence(blank, tokenPermission, {})).toThrow(TypeError);
  });

  it('refuses an empty principal id', () => {
    const blank = { ...tokenActor, principalId: '' } as AuthenticatedTokenActor;
    expect(() => tokenMutationFence(blank, tokenPermission, {})).toThrow(TypeError);
  });

  it('refuses an unknown token kind', () => {
    const odd = { ...tokenActor, tokenKind: 'session' } as unknown as AuthenticatedTokenActor;
    expect(() => tokenMutationFence(odd, tokenPermission, {})).toThrow(TypeError);
  });

  it('refuses invalid expected revisions', () => {
    expect(() => tokenMutationFence(tokenActor, tokenPermission, { k: 0 })).toThrow(TypeError);
  });

  it('issues a frozen fence with the token identity', () => {
    const made = tokenMutationFence(tokenActor, tokenPermission, {});
    expect(made).toMatchObject({ tokenId: 't1', tokenKind: 'pat', principalId: 'p1' });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.expected)).toBe(true);
  });
});

describe('delegatedMutationFence', () => {
  it('issues a frozen fence carrying approver, run and lease', () => {
    const made = delegatedMutationFence('u1', 'run1', job, { 'import:run1': 2 });
    expect(made).toMatchObject({ approverUserId: 'u1', runId: 'run1', job });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.job)).toBe(true);
    expect(Object.isFrozen(made.expected)).toBe(true);
  });

  it('rejects an empty approver', () => {
    expect(() => delegatedMutationFence('', 'run1', job, {})).toThrow(TypeError);
  });

  it('rejects an empty run id', () => {
    expect(() => delegatedMutationFence('u1', '', job, {})).toThrow(TypeError);
  });

  it('rejects an empty job id or owner', () => {
    expect(() => delegatedMutationFence('u1', 'run1', { ...job, id: '' }, {})).toThrow(TypeError);
    expect(() => delegatedMutationFence('u1', 'run1', { ...job, owner: '' }, {})).toThrow(
      TypeError,
    );
  });

  it('rejects a non-integer job fence', () => {
    expect(() => delegatedMutationFence('u1', 'run1', { ...job, fence: 2.5 }, {})).toThrow(
      TypeError,
    );
  });

  it('rejects invalid expected revisions', () => {
    expect(() => delegatedMutationFence('u1', 'run1', job, { k: -1 })).toThrow(TypeError);
  });
});

describe('fenceKind', () => {
  it('names the kind of every issued fence', () => {
    for (const [kind, made] of Object.entries(issuedFences())) {
      expect(fenceKind(made)).toBe(kind);
      expect(Object.isFrozen(made)).toBe(true);
    }
  });

  it('throws for a forged object of every shape', () => {
    for (const made of Object.values(issuedFences())) {
      const forged = JSON.parse(JSON.stringify(made)) as AnyMutationFence;
      expect(() => fenceKind(forged)).toThrow(TypeError);
    }
    expect(() => fenceKind(systemFence() as unknown as AnyMutationFence)).toThrow(TypeError);
    expect(() => fenceKind(null as unknown as AnyMutationFence)).toThrow(TypeError);
  });
});

describe('runFenced with every fence kind', () => {
  it.each(Object.keys(issuedFences()) as FenceKind[])('runs a %s fence batch', async (kind) => {
    const h = harness();
    const outcome = await runFenced(
      h.executor,
      issuedFences()[kind],
      revisionGuard(1),
      [rename],
      probes(),
    );
    expect(outcome.ok).toBe(true);
    expect(nameOf(h)).toBe('new');
  });

  it.each(Object.keys(issuedFences()) as FenceKind[])(
    'refuses a structurally identical %s fence that was not issued',
    async (kind) => {
      const h = harness();
      const forged = { ...issuedFences()[kind] } as AnyMutationFence;
      await expect(runFenced(h.executor, forged, revisionGuard(1), [rename], {})).rejects.toThrow(
        TypeError,
      );
      expect(nameOf(h)).toBe('old');
    },
  );

  it('refuses the bootstrap SystemFence', async () => {
    const h = harness();
    const bootstrap = systemFence() as unknown as AnyMutationFence;
    await expect(runFenced(h.executor, bootstrap, revisionGuard(1), [rename], {})).rejects.toThrow(
      TypeError,
    );
  });

  it('keeps conflict classification for a token fence', async () => {
    const h = harness();
    h.database.exec("UPDATE target SET revision = 2 WHERE id = 'r1'");
    const outcome = await runFenced(
      h.executor,
      issuedFences().token,
      revisionGuard(1),
      [rename],
      probes(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'conflict' });
  });

  it('keeps indeterminate without probes for a system fence', async () => {
    let probed = false;
    const executor: SqlExecutor = {
      driver: 'node-sqlite',
      all: async <R>() => {
        probed = true;
        return [] as R[];
      },
      batch: async () => {
        throw new DbError('unknown', 'lost');
      },
    };
    const outcome = await runFenced(
      executor,
      issuedFences().system,
      revisionGuard(1),
      [rename],
      probes(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'indeterminate' });
    expect(probed).toBe(false);
  });

  it('keeps the guard size limit for a delegated fence', async () => {
    const executor = stub(async () => []);
    await expect(
      runFenced(executor, issuedFences().delegated, fenceGuard([]), [rename], {}),
    ).rejects.toThrow(TypeError);
  });
});

describe('guard constraint on a real node:sqlite database', () => {
  it('names the guard constraint access_mutation_guard.key', () => {
    expect(ACCESS_MUTATION_GUARD_CONSTRAINT).toBe('access_mutation_guard.key');
  });

  it('a forced guard failure carries the guard constraint', async () => {
    const h = harness();
    const error = await h.executor.batch([...revisionGuard(99)]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('unique');
    expect((error as DbError).constraint).toBe(ACCESS_MUTATION_GUARD_CONSTRAINT);
  });

  it('another unique failure carries its own constraint', async () => {
    const h = harness();
    const dup: Statement = {
      sql: "INSERT INTO target (id, revision, name) VALUES ('r1', 1, 'dup')",
      params: [],
    };
    const error = await h.executor.batch([dup]).catch((caught: unknown) => caught);
    expect((error as DbError).constraint).toBe('target.id');
  });
});
