import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type {
  TokenListItem,
  TokenListPage,
  TokenReader,
} from '@package-broker/core/authz/token-read';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createTokenReader } from './token-read.js';

const USER = '01J0USER000000000000000001';
const OTHER_USER = '01J0USER000000000000000002';
const SP1 = '01J0SERVICE00000000000000P1';
const SP2 = '01J0SERVICE00000000000000P2';
const P1 = '01J0PROJECT0000000000000001';
const P2 = '01J0PROJECT0000000000000002';
const NOW = '2026-06-01T12:00:00.000Z';
const HASH_SENTINEL = 'f'.repeat(64);
const SELECTOR_SENTINEL = 'zzzzzzzzzzzz';
const KEYS = [
  'createdAt',
  'expiresAt',
  'id',
  'kind',
  'lastUsedAt',
  'name',
  'projectCount',
  'projectId',
  'projectMode',
  'readOnly',
  'revokedAt',
  'scope',
  'servicePrincipalId',
  'status',
  'userId',
];

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let reader: TokenReader;
let counter = 0;

async function run(sql: string, ...params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

function tid(n: number): string {
  return `01J0TOKEN${String(n).padStart(17, '0')}`;
}

interface Seed {
  id?: string;
  org?: OrgContext;
  kind?: 'pat' | 'svc' | 'cst';
  scopes?: string;
  readOnly?: number;
  user?: string;
  sp?: string;
  project?: string | null;
  mode?: 'all' | 'selected';
  expiresAt?: string | null;
  revokedAt?: string | null;
  selects?: string[];
  selector?: string;
  hash?: string;
}

async function seed(options: Seed = {}): Promise<string> {
  counter += 1;
  const id = options.id ?? tid(counter);
  const kind = options.kind ?? 'pat';
  const org = options.org ?? a;
  const selector = options.selector ?? `a${String(counter).padStart(11, '2')}`;
  const customer = kind === 'cst' ? 'cust' : null;
  await run(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
       user_id, service_principal_id, customer_id, project_id, created_by_user_id, expires_at, revoked_at,
       project_mode, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-05-01T00:00:00.000Z')`,
    id,
    org.orgId,
    kind,
    selector,
    options.hash ?? 'a'.repeat(64),
    `name-${id.slice(-3)}`,
    options.scopes ?? '["write"]',
    options.readOnly ?? 0,
    kind === 'pat' ? (options.user ?? USER) : null,
    kind === 'svc' ? (options.sp ?? SP1) : null,
    customer,
    options.project ?? null,
    USER,
    kind === 'cst'
      ? null
      : options.expiresAt === undefined
        ? '2026-12-01T00:00:00.000Z'
        : options.expiresAt,
    options.revokedAt ?? null,
    options.mode ?? 'selected',
  );
  for (const project of options.selects ?? []) {
    await run(
      'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
      org.orgId,
      id,
      project,
    );
  }
  return id;
}

function page(overrides: Partial<TokenListPage> = {}): TokenListPage {
  return { after: null, limit: 100, now: NOW, ...overrides };
}

function ids(items: readonly TokenListItem[]): string[] {
  return items.map((item) => item.id);
}

beforeEach(async () => {
  counter = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  executor = database.executor;
  a = database.orgs!.a;
  b = database.orgs!.b;
  reader = createTokenReader(executor);
  for (const [id, org, email] of [
    [USER, a, 'u1@example.test'],
    [OTHER_USER, a, 'u2@example.test'],
  ] as const) {
    await run(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'active')",
      id,
      org.orgId,
      email,
    );
  }
  for (const [id, slug] of [
    [P1, 'one'],
    [P2, 'two'],
  ]) {
    await run(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, 'p')",
      id!,
      a.orgId,
      slug!,
    );
  }
  for (const [id, project] of [
    [SP1, P1],
    [SP2, P2],
  ]) {
    await run(
      'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
      id!,
      a.orgId,
      `sp-${id!.slice(-2)}`,
      project!,
      USER,
    );
  }
  await run("INSERT INTO customer (id, org_id, name) VALUES ('cust', ?, 'c')", a.orgId);
});

afterEach(async () => {
  await database.close();
});

describe('token reader shape and secrets', () => {
  it('listOwn returns exactly the documented keys and never a hash or selector', async () => {
    await seed({ hash: HASH_SENTINEL, selector: SELECTOR_SENTINEL, selects: [P1, P2] });
    const result = await reader.listOwn(a, USER, page());
    expect(result.items).toHaveLength(1);
    expect(Object.keys(result.items[0]!).sort()).toEqual(KEYS);
    expect(result.items[0]).toMatchObject({
      kind: 'pat',
      scope: 'write',
      readOnly: false,
      projectMode: 'selected',
      projectCount: 2,
      projectId: null,
      userId: USER,
      servicePrincipalId: null,
      status: 'active',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(HASH_SENTINEL);
    expect(text).not.toContain(SELECTOR_SENTINEL);
  });

  it('listProject returns exactly the documented keys and never a hash or selector', async () => {
    await seed({
      kind: 'svc',
      project: P1,
      hash: HASH_SENTINEL,
      selector: SELECTOR_SENTINEL,
      scopes: '["read"]',
      readOnly: 1,
    });
    const result = await reader.listProject(a, P1, page());
    expect(result.items).toHaveLength(1);
    expect(Object.keys(result.items[0]!).sort()).toEqual(KEYS);
    expect(result.items[0]).toMatchObject({
      kind: 'svc',
      scope: 'read',
      readOnly: true,
      projectId: P1,
      servicePrincipalId: SP1,
      userId: null,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(HASH_SENTINEL);
    expect(text).not.toContain(SELECTOR_SENTINEL);
  });

  it('listOrganization returns exactly the documented keys and never a hash or selector', async () => {
    await seed({ hash: HASH_SENTINEL, selector: SELECTOR_SENTINEL });
    await seed({ kind: 'svc', project: P1 });
    const result = await reader.listOrganization(a, page());
    expect(result.items).toHaveLength(2);
    for (const item of result.items) expect(Object.keys(item).sort()).toEqual(KEYS);
    const text = JSON.stringify(result);
    expect(text).not.toContain(HASH_SENTINEL);
    expect(text).not.toContain(SELECTOR_SENTINEL);
  });
});

describe('token reader selection', () => {
  it('listOwn omits tokens of another user', async () => {
    await seed();
    await seed({ user: OTHER_USER });
    expect(ids((await reader.listOwn(a, USER, page())).items)).toEqual([tid(1)]);
  });

  it('listOwn omits service tokens', async () => {
    await seed({ kind: 'svc', project: P1 });
    expect((await reader.listOwn(a, USER, page())).items).toEqual([]);
  });

  it('never returns a token of another organization from listOwn', async () => {
    await seed({ org: b });
    expect((await reader.listOwn(a, USER, page())).items).toEqual([]);
  });

  it('never returns a token of another organization from listProject', async () => {
    await seed({ kind: 'svc', project: P1, org: b });
    expect((await reader.listProject(a, P1, page())).items).toEqual([]);
  });

  it('never returns a token of another organization from listOrganization', async () => {
    await seed({ org: b });
    expect((await reader.listOrganization(a, page())).items).toEqual([]);
  });

  it('listProject omits a PAT that selects the project', async () => {
    await seed({ project: P1, selects: [P1] });
    expect((await reader.listProject(a, P1, page())).items).toEqual([]);
  });

  it('listProject omits a service token of another project', async () => {
    await seed({ kind: 'svc', project: P2, sp: SP2 });
    expect((await reader.listProject(a, P1, page())).items).toEqual([]);
  });

  it('listOrganization never returns customer tokens', async () => {
    await seed({ kind: 'cst' });
    expect((await reader.listOrganization(a, page())).items).toEqual([]);
  });

  it('rejects a customer kind filter before SQL even when a customer token exists', async () => {
    await seed({ kind: 'cst' });
    const all = vi.spyOn(executor, 'all');
    await expect(reader.listOrganization(a, { ...page(), kind: 'cst' as 'pat' })).rejects.toThrow(
      TypeError,
    );
    expect(all).not.toHaveBeenCalled();
  });

  it.each(['', 'PAT', null, 1])('rejects invalid kind %j before SQL', async (kind) => {
    const all = vi.spyOn(executor, 'all');
    await expect(reader.listOrganization(a, { ...page(), kind: kind as 'pat' })).rejects.toThrow(
      TypeError,
    );
    expect(all).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'selected', 'all'],
    [P1, 'all', 'selected'],
  ] as const)(
    'derives service project mode from principal project %j despite stored mode %s',
    async (principalProject, stored, expected) => {
      await run(
        'UPDATE service_principal SET project_id = ? WHERE org_id = ? AND id = ?',
        principalProject,
        a.orgId,
        SP1,
      );
      await seed({ kind: 'svc', project: P1, mode: stored });
      expect((await reader.listProject(a, P1, page())).items[0]?.projectMode).toBe(expected);
      expect((await reader.listOrganization(a, page())).items[0]?.projectMode).toBe(expected);
    },
  );

  it('listOrganization filters by kind', async () => {
    await seed();
    await seed({ kind: 'svc', project: P1 });
    expect(ids((await reader.listOrganization(a, { ...page(), kind: 'svc' })).items)).toEqual([
      tid(2),
    ]);
    expect(ids((await reader.listOrganization(a, { ...page(), kind: 'pat' })).items)).toEqual([
      tid(1),
    ]);
  });
});

describe('token status', () => {
  const rows: [string, Seed, string][] = [
    ['revoked', { revokedAt: '2026-05-02T00:00:00.000Z' }, 'revoked'],
    [
      'revoked and expired',
      { revokedAt: '2026-05-02T00:00:00.000Z', expiresAt: '2026-05-03T00:00:00.000Z' },
      'revoked',
    ],
    ['expired in the past', { expiresAt: '2026-05-03T00:00:00.000Z' }, 'expired'],
    ['expiring exactly now', { expiresAt: NOW }, 'expired'],
    ['expiring a millisecond later', { expiresAt: '2026-06-01T12:00:00.001Z' }, 'active'],
    ['live', { expiresAt: '2026-12-01T00:00:00.000Z' }, 'active'],
  ];

  it.each(rows)('classifies %s', async (_label, options, expected) => {
    await seed(options);
    const result = await reader.listOwn(a, USER, page());
    expect(result.items[0]?.status).toBe(expected);
  });

  it('the status filter returns only matching rows', async () => {
    for (const [, options] of rows) await seed(options);
    const byStatus = async (status: 'active' | 'expired' | 'revoked') =>
      ids((await reader.listOwn(a, USER, page({ status }))).items);
    expect(await byStatus('revoked')).toEqual([tid(1), tid(2)]);
    expect(await byStatus('expired')).toEqual([tid(3), tid(4)]);
    expect(await byStatus('active')).toEqual([tid(5), tid(6)]);
  });
});

describe('token paging', () => {
  it('returns every token once in id order', async () => {
    for (const index of [7, 2, 5, 1, 6, 3, 4]) await seed({ id: tid(index) });
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const result: Awaited<ReturnType<TokenReader['listOwn']>> = await reader.listOwn(
        a,
        USER,
        page({ after, limit: 3 }),
      );
      expect(result.items.length).toBeLessThanOrEqual(3);
      seen.push(...ids(result.items));
      after = result.next;
      pages += 1;
    } while (after !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7].map(tid));
  });

  it('next is null when the page is exactly full and nothing follows', async () => {
    await seed();
    await seed();
    const result = await reader.listOwn(a, USER, page({ limit: 2 }));
    expect(result.next).toBeNull();
  });

  it.each([0, 101])('limit %i throws RangeError', async (limit) => {
    await expect(reader.listOwn(a, USER, page({ limit }))).rejects.toThrow(RangeError);
  });
});

describe('token reader validation', () => {
  it('rejects an empty user id', async () => {
    await expect(reader.listOwn(a, '', page())).rejects.toThrow(TypeError);
  });

  it('rejects an empty project id', async () => {
    await expect(reader.listProject(a, '', page())).rejects.toThrow(TypeError);
  });

  it('rejects an empty after cursor', async () => {
    await expect(reader.listOrganization(a, page({ after: '' }))).rejects.toThrow(TypeError);
  });

  it.each([
    '2026-06-01T12:00:00Z',
    '2026-06-01 12:00:00.000',
    '2026-02-30T12:00:00.000Z',
    '2026-02-29T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    'now',
    '',
  ])('rejects now %j', async (now) => {
    const all = vi.spyOn(executor, 'all');
    await expect(reader.listOwn(a, USER, page({ now }))).rejects.toThrow(TypeError);
    await expect(reader.listProject(a, P1, page({ now }))).rejects.toThrow(TypeError);
    await expect(reader.listOrganization(a, page({ now }))).rejects.toThrow(TypeError);
    expect(all).not.toHaveBeenCalled();
  });
});
