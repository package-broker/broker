import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialRecord } from '@package-broker/core/db/credentials';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { DbError } from '@package-broker/core/db/errors';
import { credentialAad, type Sealed } from '@package-broker/core/secrets/cipher';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCredentialRepository } from './credential.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-16T08:30:00.000Z';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 7) % 256);
}

function sealed(seed: number, keyVersion = 1): Sealed {
  return { ciphertext: bytes(33, seed), nonce: bytes(12, seed + 3), keyVersion };
}

function record(
  ctx: OrgContext,
  id: string,
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  const kind = overrides.kind ?? 'source.token';
  return {
    id,
    projectId: null,
    kind,
    sealed: sealed(id.charCodeAt(id.length - 1)),
    aad: credentialAad({ id, orgId: ctx.orgId, kind }),
    rotatedAt: null,
    ...overrides,
  };
}

function id(n: number): string {
  return `01J0CRED${String(n).padStart(18, '0')}`;
}

async function rawRow(orgId: string, rowId: string): Promise<Record<string, unknown> | undefined> {
  const found = await executor.all<Record<string, unknown>>({
    sql: 'SELECT * FROM credential WHERE org_id = ? AND id = ?',
    params: [orgId, rowId],
  });
  return found[0];
}

describe('credential repository', () => {
  it('1: insert then get returns byte-equal ciphertext and nonce, key version, aad and metadata', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(1), { sealed: sealed(11, 3), rotatedAt: '2026-10-01T00:00:00.000Z' });

    await repository.insert(a, { ...row, now: NOW });
    const found = await repository.get(a, row.id);

    expect(found).toEqual(row);
    expect(found?.sealed.ciphertext).toBeInstanceOf(Uint8Array);
    expect(found?.sealed.nonce).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(found?.sealed.ciphertext ?? []).equals(Buffer.from(row.sealed.ciphertext)),
    ).toBe(true);
    expect(Buffer.from(found?.sealed.nonce ?? []).equals(Buffer.from(row.sealed.nonce))).toBe(true);

    const raw = await rawRow(a.orgId, row.id);
    expect(raw).toMatchObject({ org_id: a.orgId, created_at: NOW, updated_at: NOW });
  });

  it('1b: get returns null for an unknown id', async () => {
    const repository = createCredentialRepository(executor);
    expect(await repository.get(a, id(404))).toBeNull();
  });

  it('1c: insertStatement returns the statement without running it', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(2));
    const counted = countCalls(executor);
    const statement = createCredentialRepository(counted.executor).insertStatement(a, {
      ...row,
      now: NOW,
    });
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    expect(await repository.get(a, row.id)).toBeNull();

    await executor.batch([statement]);
    expect(await repository.get(a, row.id)).toEqual(row);
  });

  it('2: reseal with the expected version succeeds once and a stale second reseal changes nothing', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(3));
    await repository.insert(a, { ...row, now: NOW });

    const first = sealed(101, 2);
    expect(await repository.reseal(a, row.id, 1, first, LATER)).toBe(true);

    const afterFirst = await repository.get(a, row.id);
    expect(afterFirst).toEqual({ ...row, sealed: first, rotatedAt: LATER });
    expect(await rawRow(a.orgId, row.id)).toMatchObject({ created_at: NOW, updated_at: LATER });

    const second = sealed(202, 3);
    expect(await repository.reseal(a, row.id, 1, second, '2026-10-17T00:00:00.000Z')).toBe(false);
    expect(await repository.get(a, row.id)).toEqual(afterFirst);
    expect(await rawRow(a.orgId, row.id)).toMatchObject({ updated_at: LATER });
  });

  it('2b: reseal of an unknown id returns false', async () => {
    const repository = createCredentialRepository(executor);
    expect(await repository.reseal(a, id(404), 1, sealed(1, 2), LATER)).toBe(false);
  });

  it('3: listBelowVersion pages v1 rows in id order and skips v2 rows', async () => {
    const repository = createCredentialRepository(executor);
    for (const [n, version] of [
      [5, 1],
      [1, 1],
      [4, 2],
      [3, 1],
      [2, 2],
    ] as const) {
      await repository.insert(a, { ...record(a, id(n), { sealed: sealed(n, version) }), now: NOW });
    }

    const page1 = await repository.listBelowVersion(a, 2, null, 2);
    expect(page1.map((entry) => entry.id)).toEqual([id(1), id(3)]);
    const page2 = await repository.listBelowVersion(a, 2, id(3), 2);
    expect(page2.map((entry) => entry.id)).toEqual([id(5)]);
    expect(await repository.listBelowVersion(a, 2, id(5), 2)).toEqual([]);
    expect(page1[0]).toEqual(record(a, id(1), { sealed: sealed(1, 1) }));
  });

  it('3b: listBelowVersion rejects a limit outside 1..500 or not an integer before any SQL', async () => {
    const counted = countCalls(executor);
    const repository = createCredentialRepository(counted.executor);
    for (const limit of [0, -1, 501, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repository.listBelowVersion(a, 2, null, limit)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });

    const repo = createCredentialRepository(executor);
    expect(await repo.listBelowVersion(a, 2, null, 1)).toEqual([]);
    expect(await repo.listBelowVersion(a, 2, null, 500)).toEqual([]);
  });

  it('4: a row written under A is invisible to B for get, listBelowVersion, reseal and delete', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(6));
    await repository.insert(a, { ...row, now: NOW });

    expect(await repository.get(b, row.id)).toBeNull();
    expect(await repository.listBelowVersion(b, 2, null, 10)).toEqual([]);
    expect(await repository.reseal(b, row.id, 1, sealed(9, 2), LATER)).toBe(false);
    expect(await repository.delete(b, row.id)).toBe(false);

    expect(await repository.get(a, row.id)).toEqual(row);
    expect((await repository.listBelowVersion(a, 2, null, 10)).map((entry) => entry.id)).toEqual([
      row.id,
    ]);
  });

  it('4b: insert stamps the context organization on the row', async () => {
    const repository = createCredentialRepository(executor);
    await repository.insert(b, { ...record(b, id(7)), now: NOW });
    expect(await rawRow(b.orgId, id(7))).toBeDefined();
    expect(await rawRow(a.orgId, id(7))).toBeUndefined();
  });

  it('delete removes the row once and reports whether one was removed', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(8));
    await repository.insert(a, { ...row, now: NOW });

    expect(await repository.delete(a, row.id)).toBe(true);
    expect(await repository.get(a, row.id)).toBeNull();
    expect(await repository.delete(a, row.id)).toBe(false);
  });

  it('5: every method makes exactly one executor call', async () => {
    const counted = countCalls(executor);
    const repository = createCredentialRepository(counted.executor);
    const row = record(a, id(9));
    const once = async (action: () => Promise<unknown>): Promise<void> => {
      const before = counted.counts();
      await action();
      const after = counted.counts();
      expect(after.all + after.batch - before.all - before.batch).toBe(1);
    };

    await once(() => repository.insert(a, { ...row, now: NOW }));
    await once(() => repository.get(a, row.id));
    await once(() => repository.listBelowVersion(a, 2, null, 10));
    await once(() => repository.reseal(a, row.id, 1, sealed(5, 2), LATER));
    await once(() => repository.reseal(a, row.id, 1, sealed(6, 2), LATER));
    await once(() => repository.delete(a, row.id));
    await once(() => repository.delete(a, row.id));
    expect(counted.counts().batch + counted.counts().all).toBe(7);

    const before = counted.counts();
    repository.insertStatement(a, { ...row, now: NOW });
    expect(counted.counts()).toEqual(before);
  });
});

async function seedProject(ctx: OrgContext, projectId: string): Promise<void> {
  await executor.all({
    sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
    params: [projectId, ctx.orgId, `slug-${projectId.slice(-4).toLowerCase()}`, 'Project'],
  });
}

const PROJECT_A = '01J0PROJECTA00000000000000';
const PROJECT_B = '01J0PROJECTB00000000000000';

describe('credential repository project guard', () => {
  it('6: insert with a project of the same organization stores the project id', async () => {
    await seedProject(a, PROJECT_A);
    const repository = createCredentialRepository(executor);
    const row = record(a, id(20), { projectId: PROJECT_A });

    await repository.insert(a, { ...row, now: NOW });

    expect(await repository.get(a, row.id)).toEqual(row);
  });

  it('6b: insert with a project of another organization throws DbError foreign_key and stores nothing', async () => {
    await seedProject(b, PROJECT_B);
    const counted = countCalls(executor);
    const repository = createCredentialRepository(counted.executor);
    const row = record(a, id(21), { projectId: PROJECT_B });

    const failure: unknown = await repository.insert(a, { ...row, now: NOW }).catch((e) => e);

    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).kind).toBe('foreign_key');
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    expect(await rawRow(a.orgId, row.id)).toBeUndefined();
    expect(await rawRow(b.orgId, row.id)).toBeUndefined();
  });

  it('6c: insert with an unknown project throws DbError foreign_key', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(22), { projectId: PROJECT_A });
    const failure: unknown = await repository.insert(a, { ...row, now: NOW }).catch((e) => e);
    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).kind).toBe('foreign_key');
  });

  it('6d: insertStatement with a project of another organization inserts no row in a batch', async () => {
    await seedProject(b, PROJECT_B);
    const repository = createCredentialRepository(executor);
    const row = record(a, id(23), { projectId: PROJECT_B });

    const [result] = await executor.batch([repository.insertStatement(a, { ...row, now: NOW })]);

    expect(result?.changes).toBe(0);
    expect(await rawRow(a.orgId, row.id)).toBeUndefined();
  });
});

describe('credential repository delete and source reference', () => {
  it('7: delete throws DbError foreign_key while a source references the credential', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(30));
    await repository.insert(a, { ...row, now: NOW });
    await executor.all({
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type, credential_id) VALUES (?, ?, 'upstream', 'npm', 'npmjs_proxy', ?)",
      params: ['01J0SOURCE0000000000000000', a.orgId, row.id],
    });

    const failure: unknown = await repository.delete(a, row.id).catch((e) => e);

    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).kind).toBe('foreign_key');
    expect(await repository.get(a, row.id)).toEqual(row);

    await executor.all({ sql: 'DELETE FROM source WHERE credential_id = ?', params: [row.id] });
    expect(await repository.delete(a, row.id)).toBe(true);
  });
});

describe('credential repository input validation', () => {
  async function expectRejectedWithoutSql(
    error: new (...args: never[]) => Error,
    action: (repository: ReturnType<typeof createCredentialRepository>) => Promise<unknown>,
  ): Promise<void> {
    const counted = countCalls(executor);
    await expect(action(createCredentialRepository(counted.executor))).rejects.toBeInstanceOf(
      error,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  }

  it('8: insert refuses a kind that fails the credential kind pattern', async () => {
    for (const kind of ['Bad Kind', '', '-leading', 'a'.repeat(65), 'with/slash']) {
      const row = { ...record(a, id(40)), kind, aad: 'credential/x/y/z' };
      await expectRejectedWithoutSql(TypeError, (repository) =>
        repository.insert(a, { ...row, now: NOW }),
      );
    }
  });

  it('8b: insert refuses an id that contains a slash', async () => {
    const row = { ...record(a, id(41)), id: '01J0/SLASH' };
    await expectRejectedWithoutSql(TypeError, (repository) =>
      repository.insert(a, { ...row, now: NOW }),
    );
  });

  it('8c: insert refuses a nonce that is not 12 bytes', async () => {
    for (const length of [0, 11, 13, 24]) {
      const row = record(a, id(42));
      const bad = { ...row, sealed: { ...row.sealed, nonce: bytes(length, 1) } };
      await expectRejectedWithoutSql(TypeError, (repository) =>
        repository.insert(a, { ...bad, now: NOW }),
      );
    }
  });

  it('8d: insert refuses an aad that differs from credentialAad of the row and context', async () => {
    const row = record(a, id(43));
    const otherOrg = { ...row, aad: credentialAad({ id: row.id, orgId: b.orgId, kind: row.kind }) };
    const otherKind = { ...row, aad: credentialAad({ id: row.id, orgId: a.orgId, kind: 'other' }) };
    const otherId = { ...row, aad: credentialAad({ id: id(44), orgId: a.orgId, kind: row.kind }) };
    for (const bad of [
      otherOrg,
      otherKind,
      otherId,
      { ...row, aad: '' },
      { ...row, aad: `${row.aad}x` },
    ]) {
      await expectRejectedWithoutSql(TypeError, (repository) =>
        repository.insert(a, { ...bad, now: NOW }),
      );
    }
  });

  it('8e: insertStatement throws synchronously on the same invalid input', () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(45));
    expect(() => repository.insertStatement(a, { ...row, aad: 'nope', now: NOW })).toThrow(
      TypeError,
    );
    expect(() =>
      repository.insertStatement(a, {
        ...row,
        sealed: { ...row.sealed, nonce: bytes(5, 1) },
        now: NOW,
      }),
    ).toThrow(TypeError);
    expect(() =>
      repository.insertStatement(a, { ...row, sealed: { ...row.sealed, keyVersion: 0 }, now: NOW }),
    ).toThrow(RangeError);
  });

  it('9: insert throws RangeError for a key version that is not a positive safe integer', async () => {
    for (const keyVersion of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      const row = record(a, id(46));
      await expectRejectedWithoutSql(RangeError, (repository) =>
        repository.insert(a, { ...row, sealed: { ...row.sealed, keyVersion }, now: NOW }),
      );
    }
  });

  it('9b: listBelowVersion throws RangeError for a version that is not a positive safe integer', async () => {
    for (const version of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expectRejectedWithoutSql(RangeError, (repository) =>
        repository.listBelowVersion(a, version, null, 10),
      );
    }
  });

  it('9c: reseal throws RangeError for an expected version that is not a positive safe integer', async () => {
    for (const expectedVersion of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expectRejectedWithoutSql(RangeError, (repository) =>
        repository.reseal(a, id(47), expectedVersion, sealed(1, 3), LATER),
      );
    }
  });

  it('9d: reseal throws RangeError for a new key version that is not a positive safe integer', async () => {
    for (const keyVersion of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expectRejectedWithoutSql(RangeError, (repository) =>
        repository.reseal(a, id(47), 1, sealed(1, keyVersion), LATER),
      );
    }
  });

  it('10: reseal throws RangeError for the same version or a downgrade and leaves the row alone', async () => {
    const repository = createCredentialRepository(executor);
    const row = record(a, id(48), { sealed: sealed(7, 3) });
    await repository.insert(a, { ...row, now: NOW });

    for (const keyVersion of [3, 2, 1]) {
      await expectRejectedWithoutSql(RangeError, (guarded) =>
        guarded.reseal(a, row.id, 3, sealed(9, keyVersion), LATER),
      );
    }
    expect(await repository.get(a, row.id)).toEqual(row);
  });

  it('10b: reseal throws TypeError for a nonce that is not 12 bytes', async () => {
    const bad = { ...sealed(1, 2), nonce: bytes(8, 1) };
    await expectRejectedWithoutSql(TypeError, (repository) =>
      repository.reseal(a, id(49), 1, bad, LATER),
    );
  });
});
