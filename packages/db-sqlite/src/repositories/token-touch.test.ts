import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAccessRepository } from './access.js';

const USER = '01J0USER000000000000000001';
const SP = '01J0SERVICE00000000000000P1';
const HASH = 'a'.repeat(64);

let database: MigratedDatabase;
let directory: string;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

function minutes(offset: number): string {
  return new Date(Date.now() + offset * 60_000).toISOString();
}

async function run(sql: string, ...params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function token(
  id: string,
  options: {
    kind?: 'pat' | 'svc';
    expiresAt?: string;
    revokedAt?: string | null;
    lastUsedAt?: string | null;
  } = {},
): Promise<void> {
  const kind = options.kind ?? 'pat';
  await run(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json,
       user_id, service_principal_id, created_by_user_id, expires_at, revoked_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, 1, 'n', '[]', ?, ?, ?, ?, ?, ?)`,
    id,
    a.orgId,
    kind,
    id
      .slice(-12)
      .toLowerCase()
      .replace(/[018-9]/g, 'a'),
    HASH,
    kind === 'pat' ? USER : null,
    kind === 'svc' ? SP : null,
    USER,
    options.expiresAt ?? minutes(60 * 24),
    options.revokedAt ?? null,
    options.lastUsedAt ?? null,
  );
}

async function lastUsed(id: string): Promise<string | null> {
  const rows = await executor.all<{ v: string | null }>({
    sql: 'SELECT last_used_at AS v FROM token WHERE id = ?',
    params: [id],
  });
  return rows[0]?.v ?? null;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'token-touch-'));
  database = await openMigratedDatabase({
    twoOrganizations: true,
    file: join(directory, 'db.sqlite'),
  });
  executor = database.executor;
  a = database.orgs!.a;
  b = database.orgs!.b;
  await run(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u1@example.test', 'active')",
    USER,
    a.orgId,
  );
  await run(
    "INSERT INTO service_principal (id, org_id, name, created_by_user_id, status) VALUES (?, ?, 'sp', ?, 'active')",
    SP,
    a.orgId,
    USER,
  );
});

afterEach(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

describe('touchToken', () => {
  it('sets last_used_at from database time when NULL or older than five minutes', async () => {
    const repo = createAccessRepository(executor);
    await token('01J0TOKEN00000000000000001');
    await token('01J0TOKEN00000000000000002', { lastUsedAt: minutes(-6) });
    await token('01J0TOKEN00000000000000003', { kind: 'svc', lastUsedAt: minutes(-60) });
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000001', 'pat')).toBe(true);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000002', 'pat')).toBe(true);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000003', 'svc')).toBe(true);
    for (const id of ['1', '2', '3']) {
      const value = await lastUsed(`01J0TOKEN0000000000000000${id}`);
      expect(Math.abs(Date.parse(value ?? '') - Date.now())).toBeLessThan(5000);
    }
  });

  it('changes nothing inside the window, so serial calls update once', async () => {
    const repo = createAccessRepository(executor);
    await token('01J0TOKEN00000000000000001');
    const results: boolean[] = [];
    for (let index = 0; index < 100; index += 1) {
      results.push(await repo.touchToken(a, '01J0TOKEN00000000000000001', 'pat'));
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    const recent = minutes(-2);
    await token('01J0TOKEN00000000000000002', { lastUsedAt: recent });
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000002', 'pat')).toBe(false);
    expect(await lastUsed('01J0TOKEN00000000000000002')).toBe(recent);
  });

  it('refuses revoked, expired, wrong-kind, wrong-org and suspended-principal tokens', async () => {
    const repo = createAccessRepository(executor);
    await token('01J0TOKEN00000000000000001', { revokedAt: minutes(-10) });
    await token('01J0TOKEN00000000000000002', { expiresAt: minutes(-1) });
    await token('01J0TOKEN00000000000000003');
    await token('01J0TOKEN00000000000000004', { kind: 'svc' });
    await run("UPDATE service_principal SET status = 'suspended'");
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000001', 'pat')).toBe(false);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000002', 'pat')).toBe(false);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000003', 'svc')).toBe(false);
    expect(await repo.touchToken(b, '01J0TOKEN00000000000000003', 'pat')).toBe(false);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000004', 'svc')).toBe(false);
    await run("UPDATE user_account SET status = 'suspended'");
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000003', 'pat')).toBe(false);
    for (const id of ['1', '2', '3', '4']) {
      expect(await lastUsed(`01J0TOKEN0000000000000000${id}`)).toBeNull();
    }
  });

  it('does not touch a token that expired or was revoked after its lookup', async () => {
    const repo = createAccessRepository(executor);
    await token('01J0TOKEN00000000000000001', { expiresAt: minutes(-1) });
    await token('01J0TOKEN00000000000000002');
    await run(
      'UPDATE token SET revoked_at = ? WHERE id = ?',
      minutes(0),
      '01J0TOKEN00000000000000002',
    );
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000001', 'pat')).toBe(false);
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000002', 'pat')).toBe(false);
    expect(await lastUsed('01J0TOKEN00000000000000001')).toBeNull();
    expect(await lastUsed('01J0TOKEN00000000000000002')).toBeNull();
  });

  it('touches when last_used_at is not a canonical timestamp', async () => {
    const repo = createAccessRepository(executor);
    await token('01J0TOKEN00000000000000001', { lastUsedAt: 'garbage' });
    expect(await repo.touchToken(a, '01J0TOKEN00000000000000001', 'pat')).toBe(true);
    expect(await lastUsed('01J0TOKEN00000000000000001')).not.toBe('garbage');
  });

  it('lets one of two stale readers on separate connections change the row', async () => {
    await token('01J0TOKEN00000000000000001', { lastUsedAt: minutes(-30) });
    const other = await database.second();
    const staleRead = (connection: SqlExecutor) =>
      connection.all<{ v: string }>({
        sql: 'SELECT last_used_at AS v FROM token WHERE id = ?',
        params: ['01J0TOKEN00000000000000001'],
      });
    const [readA, readB] = [await staleRead(executor), await staleRead(other)];
    expect(readA[0]?.v).toBe(readB[0]?.v);
    expect(
      await createAccessRepository(other).touchToken(a, '01J0TOKEN00000000000000001', 'pat'),
    ).toBe(true);
    expect(
      await createAccessRepository(executor).touchToken(a, '01J0TOKEN00000000000000001', 'pat'),
    ).toBe(false);
  });

  it('leaves no touch when another connection revokes between lookup and touch', async () => {
    await token('01J0TOKEN00000000000000001', { lastUsedAt: minutes(-30) });
    const other = await database.second();
    const before = await lastUsed('01J0TOKEN00000000000000001');
    await other.batch([
      {
        sql: 'UPDATE token SET revoked_at = ? WHERE id = ?',
        params: [minutes(0), '01J0TOKEN00000000000000001'],
      },
    ]);
    expect(
      await createAccessRepository(executor).touchToken(a, '01J0TOKEN00000000000000001', 'pat'),
    ).toBe(false);
    expect(await lastUsed('01J0TOKEN00000000000000001')).toBe(before);
  });
});
