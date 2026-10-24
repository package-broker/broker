import { inspect } from 'node:util';
import { DbError } from '@package-broker/core/db/errors';
import type {
  ScalarSqlExecutor,
  ScalarStatement,
  StatementResult,
} from '@package-broker/core/db/port';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createD1HttpExecutor, isLostResponse, type D1HttpOptions } from './d1-http-executor.js';

const ACCOUNT_ID = 'acct0f3e9b7c2d14a6';
const DATABASE_ID = 'dbid-5c1a-77e2-9f40';
const API_TOKEN = 'tok_Zq8vLk2NwX4pRt7Y';
const SECRETS = [API_TOKEN, ACCOUNT_ID, DATABASE_ID];
const QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

interface SentRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly redirect: RequestInit['redirect'];
  readonly signal: boolean;
  readonly body: unknown;
}

type Responder = (body: unknown, init?: RequestInit) => Promise<Response>;

interface Harness {
  readonly executor: ScalarSqlExecutor;
  readonly requests: SentRequest[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function d1Success(results: readonly StatementResult[]): Response {
  return json(200, {
    result: results.map((result) => ({
      results: result.rows,
      success: true,
      meta: { changes: result.changes, last_row_id: 0, duration: 0.1 },
    })),
    errors: [],
    messages: [],
    success: true,
  });
}

function d1Failure(message: string): Response {
  return json(400, { result: [], success: false, errors: [{ code: 7500, message }], messages: [] });
}

function sqliteText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

async function withHarness(
  body: (h: Harness) => Promise<void>,
  respond?: Responder,
  options: Partial<D1HttpOptions> = {},
): Promise<void> {
  const opened = openNodeSqliteExecutor();
  try {
    const requests: SentRequest[] = [];

    const sqlite: Responder = async (request) => {
      const parsed = request as { sql?: string; params?: []; batch?: ScalarStatement[] };
      const statements = parsed.batch ?? [{ sql: parsed.sql ?? '', params: parsed.params ?? [] }];
      try {
        return d1Success(await opened.executor.batch(statements));
      } catch (error) {
        return d1Failure(sqliteText(error));
      }
    };

    const fakeFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const sent: unknown = JSON.parse(String(init?.body));
      requests.push({
        url: String(input),
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        redirect: init?.redirect,
        signal: init?.signal instanceof AbortSignal,
        body: sent,
      });
      return (respond ?? sqlite)(sent, init);
    };

    const executor = createD1HttpExecutor({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: API_TOKEN,
      fetch: fakeFetch as typeof fetch,
      ...options,
    });
    await body({ executor, requests });
  } finally {
    await opened.close();
  }
}

function hangUntilAborted(_body: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
}

function respondAfter(ms: number): Responder {
  return (_body, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(d1Success([{ rows: [{ ok: 1 }], changes: 0 }])), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function dbError(promise: Promise<unknown>, kind: DbError['kind']): Promise<DbError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).kind).toBe(kind);
  return error as DbError;
}

async function createTables(executor: ScalarSqlExecutor, ...ddl: string[]): Promise<void> {
  await executor.batch(ddl.map((sql) => ({ sql, params: [] })));
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('D1 HTTP executor: scalar executor contract', () => {
  it('1. all() returns plain objects keyed by alias', async () => {
    await withHarness(async ({ executor }) => {
      const rows = await executor.all({ sql: 'SELECT 1 AS one, ? AS word', params: ['x'] });

      expect(rows).toEqual([{ one: 1, word: 'x' }]);
      expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    });
  });

  it('3. batch() returns one result per statement with rows and changes', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');

      const results = await executor.batch([
        { sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id', params: [1, 'a'] },
        { sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id', params: [2, 'b'] },
        { sql: 'UPDATE item SET label = ?', params: ['z'] },
        { sql: 'SELECT id, label FROM item ORDER BY id', params: [] },
      ]);

      expect(results).toHaveLength(4);
      expect(results[0]).toEqual({ changes: 1, rows: [{ id: 1 }] });
      expect(results[1]).toEqual({ changes: 1, rows: [{ id: 2 }] });
      expect(results[2]?.changes).toBe(2);
      expect(results[3]?.changes).toBe(0);
      expect(results[3]?.rows).toEqual([
        { id: 1, label: 'z' },
        { id: 2, label: 'z' },
      ]);
    });
  });

  it('4. all() of an UPDATE without RETURNING resolves to [] and changes the row', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');
      await executor.all({ sql: 'INSERT INTO item (id, label) VALUES (?, ?)', params: [1, 'a'] });

      const result = await executor.all({
        sql: 'UPDATE item SET label = ? WHERE id = ?',
        params: ['b', 1],
      });
      const rows = await executor.all({ sql: 'SELECT label FROM item WHERE id = ?', params: [1] });

      expect(result).toEqual([]);
      expect(rows).toEqual([{ label: 'b' }]);
    });
  });

  it('5. a failing statement rolls the whole batch back', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, code TEXT UNIQUE)');

      await dbError(
        executor.batch([
          { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [1, 'a'] },
          { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [2, 'b'] },
          { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [3, 'c'] },
          { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [4, 'a'] },
        ]),
        'unique',
      );

      expect(await executor.all({ sql: 'SELECT id FROM item', params: [] })).toEqual([]);
    });
  });

  it('6. classifies foreign_key, not_null and check violations', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(
        executor,
        'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id), req TEXT NOT NULL DEFAULT 'x', qty INTEGER CHECK (qty >= 0))",
      );

      await dbError(
        executor.all({ sql: 'INSERT INTO child (id, parent_id) VALUES (?, ?)', params: [1, 99] }),
        'foreign_key',
      );
      await dbError(
        executor.all({ sql: 'INSERT INTO child (id, req) VALUES (?, ?)', params: [2, null] }),
        'not_null',
      );
      await dbError(
        executor.all({ sql: 'INSERT INTO child (id, qty) VALUES (?, ?)', params: [3, -1] }),
        'check',
      );
    });
  });

  it('7. a batch sees its own earlier writes', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');

      const results = await executor.batch([
        { sql: 'INSERT INTO item (id, label) VALUES (?, ?)', params: [1, 'a'] },
        { sql: 'SELECT label FROM item WHERE id = ?', params: [1] },
      ]);

      expect(results[1]?.rows).toEqual([{ label: 'a' }]);
    });
  });

  it('8. batch([]) resolves to [] without a request', async () => {
    await withHarness(async ({ executor, requests }) => {
      expect(await executor.batch([])).toEqual([]);
      expect(requests).toHaveLength(0);
    });
  });

  it('9. an unsafe integer parameter rejects with TypeError', async () => {
    await withHarness(async ({ executor, requests }) => {
      const unsafe = 2 ** 53;

      expect(
        await rejection(executor.all({ sql: 'SELECT ? AS n', params: [unsafe] })),
      ).toBeInstanceOf(TypeError);
      expect(
        await rejection(executor.batch([{ sql: 'SELECT ? AS n', params: [unsafe] }])),
      ).toBeInstanceOf(TypeError);
      expect(requests).toHaveLength(0);
    });
  });
});

describe('D1 HTTP executor: atomic batch', () => {
  it('a batch whose second statement violates UNIQUE leaves nothing behind', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, code TEXT UNIQUE)');
      await executor.all({
        sql: 'INSERT INTO item (id, code) VALUES (?, ?)',
        params: [1, 'taken'],
      });

      const error = await dbError(
        executor.batch([
          { sql: 'CREATE TABLE side (id INTEGER PRIMARY KEY)', params: [] },
          { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [2, 'taken'] },
        ]),
        'unique',
      );

      expect(error.constraint).toBe('item.code');
      expect(await executor.all({ sql: 'SELECT id FROM item', params: [] })).toEqual([{ id: 1 }]);
      expect(
        await executor.all({
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          params: ['side'],
        }),
      ).toEqual([]);
    });
  });
});

describe('D1 HTTP executor: request shape', () => {
  it('all() posts { sql, params } to the query route with bearer auth', async () => {
    await withHarness(async ({ executor, requests }) => {
      await executor.all({ sql: 'SELECT ? AS word, ? AS n', params: ['secret-value', 42] });

      expect(requests).toEqual([
        {
          url: QUERY_URL,
          method: 'POST',
          headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
          redirect: 'error',
          signal: true,
          body: { sql: 'SELECT ? AS word, ? AS n', params: ['secret-value', 42] },
        },
      ]);
    });
  });

  it('batch() posts the batch form, each statement with its own params', async () => {
    await withHarness(async ({ executor, requests }) => {
      await executor.batch([
        { sql: 'SELECT ? AS a', params: ['first-value'] },
        { sql: 'SELECT ? AS b, ? AS c', params: [7, null] },
        { sql: 'SELECT 1 AS d', params: [] },
      ]);

      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.url).toBe(QUERY_URL);
      expect(request?.method).toBe('POST');
      expect(request?.redirect).toBe('error');
      expect(request?.signal).toBe(true);
      expect(request?.headers).toEqual({
        authorization: `Bearer ${API_TOKEN}`,
        'content-type': 'application/json',
      });
      expect(request?.body).toEqual({
        batch: [
          { sql: 'SELECT ? AS a', params: ['first-value'] },
          { sql: 'SELECT ? AS b, ? AS c', params: [7, null] },
          { sql: 'SELECT 1 AS d', params: [] },
        ],
      });
      const sqlTexts = (request?.body as { batch: { sql: string }[] }).batch.map((s) => s.sql);
      for (const sql of sqlTexts) {
        expect(sql).not.toContain('first-value');
        expect(sql).not.toContain('7');
      }
    });
  });

  it('uses a custom baseUrl and never puts the token in the URL or body', async () => {
    await withHarness(
      async ({ executor, requests }) => {
        await executor.all({ sql: 'SELECT 1 AS one', params: [] });

        expect(requests[0]?.url).toBe(
          `https://d1.example.test/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
        );
        expect(requests[0]?.url).not.toContain(API_TOKEN);
        expect(JSON.stringify(requests[0]?.body)).not.toContain(API_TOKEN);
      },
      undefined,
      { baseUrl: 'https://d1.example.test/v4/' },
    );
  });

  it.each(['http://127.0.0.1:8787/v4', 'http://localhost:8787', 'http://[::1]:8787/client/v4'])(
    'accepts loopback http baseUrl %s',
    async (baseUrl) => {
      await withHarness(
        async ({ executor, requests }) => {
          await executor.all({ sql: 'SELECT 1 AS one', params: [] });

          expect(requests[0]?.url.startsWith(baseUrl)).toBe(true);
        },
        undefined,
        { baseUrl },
      );
    },
  );

  it('treats a 3xx response as a failure', async () => {
    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');

        expect(error.message).toBe('d1 http 302');
      },
      async () =>
        new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    );
  });

  it('round-trips the T124 parameter domain: null, safe integers, finite reals and text', async () => {
    await withHarness(async ({ executor }) => {
      const rows = await executor.all({
        sql: 'SELECT ? AS nul, ? AS int, ? AS real, ? AS txt, typeof(?) AS t',
        params: [null, -9007199254740991, 1.5, '007', '007'],
      });

      expect(rows).toEqual([
        { nul: null, int: -9007199254740991, real: 1.5, txt: '007', t: 'text' },
      ]);
    });
  });
});

describe('D1 HTTP executor: batch statement budget', () => {
  it('rejects a batch above 200 statements before reading it or sending a request', async () => {
    await withHarness(async ({ executor, requests }) => {
      const unreadable = {
        get sql(): string {
          throw new Error('SQL was read');
        },
        get params(): readonly [] {
          throw new Error('parameters were read');
        },
      };
      const error = await rejection(executor.batch(Array.from({ length: 201 }, () => unreadable)));
      expect(error).toMatchObject({ name: 'DbError', kind: 'too_big' });
      expect(requests).toHaveLength(0);
    });
  });

  it('sends a batch of exactly 200 statements', async () => {
    await withHarness(async ({ executor, requests }) => {
      await executor.batch(Array.from({ length: 200 }, () => ({ sql: 'SELECT 1', params: [] })));
      expect(requests).toHaveLength(1);
    });
  });
});

describe('D1 HTTP executor: per-statement limits', () => {
  const rejectsWithoutRequest = async (statement: ScalarStatement): Promise<void> => {
    await withHarness(async ({ executor, requests }) => {
      expect(await rejection(executor.all(statement))).toBeInstanceOf(TypeError);
      expect(
        await rejection(executor.batch([{ sql: 'SELECT 1', params: [] }, statement])),
      ).toBeInstanceOf(TypeError);
      expect(requests).toHaveLength(0);
    });
  };

  it('rejects a code-level ; between two statements', async () => {
    await rejectsWithoutRequest({ sql: 'SELECT 1; SELECT 2', params: [] });
    await rejectsWithoutRequest({ sql: 'SELECT 1;;', params: [] });
    await rejectsWithoutRequest({ sql: 'DELETE FROM t; -- trailing comment', params: [] });
  });

  it('rejects SQL the lexer cannot scan', async () => {
    await rejectsWithoutRequest({ sql: "SELECT 'unterminated", params: [] });
  });

  it('executes a complete trigger as one statement and enforces its guard', async () => {
    await withHarness(async ({ executor }) => {
      await createTables(executor, 'CREATE TABLE item (value TEXT)');
      await executor.batch([
        {
          sql: `/* migration */ CREATE TRIGGER guard BEFORE INSERT ON item
                WHEN NEW.value != 'allowed; END'
                BEGIN SELECT RAISE(ABORT, 'guard refused; END'); END;`,
          params: [],
        },
      ]);
      await executor.all({ sql: 'INSERT INTO item VALUES (?)', params: ['allowed; END'] });
      await expect(
        executor.all({ sql: 'INSERT INTO item VALUES (?)', params: ['denied'] }),
      ).rejects.toBeInstanceOf(DbError);
      expect(await executor.all({ sql: 'SELECT value FROM item', params: [] })).toEqual([
        { value: 'allowed; END' },
      ]);
    });
  });

  it.each([
    'CREATE TRIGGER guard AFTER INSERT ON item BEGIN SELECT 1; END; SELECT 2',
    'CREATE TRIGGER guard AFTER INSERT ON item BEGIN SELECT 1;',
  ])('rejects incomplete or multiple trigger statements before sending: %s', async (sql) => {
    await rejectsWithoutRequest({ sql, params: [] });
  });

  it.each(['', '   \n\t', ';', ' ; \n', '-- only a comment', '/* c */ ;'])(
    'rejects the empty statement %j',
    async (sql) => {
      await rejectsWithoutRequest({ sql, params: [] });
    },
  );

  it('accepts ; inside strings, identifiers and comments', async () => {
    await withHarness(async ({ executor, requests }) => {
      const rows = await executor.all({
        sql: 'SELECT \';\' AS "a;b" /* ; */ -- ;\n',
        params: [],
      });

      expect(rows).toEqual([{ 'a;b': ';' }]);
      expect(requests).toHaveLength(1);
    });
  });

  it('accepts one trailing ; and strips it', async () => {
    await withHarness(async ({ executor, requests }) => {
      expect(await executor.all({ sql: 'SELECT ? AS v; \n', params: [1] })).toEqual([{ v: 1 }]);
      await executor.batch([{ sql: 'SELECT 2 AS w;', params: [] }]);

      expect(requests.map((request) => request.body)).toEqual([
        { sql: 'SELECT ? AS v', params: [1] },
        { batch: [{ sql: 'SELECT 2 AS w', params: [] }] },
      ]);
    });
  });

  it('rejects 101 parameters and accepts 100', async () => {
    const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    await rejectsWithoutRequest({
      sql: `SELECT ${placeholders(101)}`,
      params: Array.from({ length: 101 }, (_, i) => i),
    });

    await withHarness(async ({ executor }) => {
      const rows = await executor.all({
        sql: `SELECT max(${placeholders(100)}) AS m`,
        params: Array.from({ length: 100 }, (_, i) => i),
      });
      expect(rows).toEqual([{ m: 99 }]);
    });
  });

  it('rejects 100 001 bytes of UTF-8 SQL and accepts 100 000', async () => {
    const statementOfBytes = (bytes: number): string => {
      const head = "SELECT '";
      const tail = "' AS v";
      const fill = bytes - head.length - tail.length;
      return `${head}${'ż'.repeat(Math.floor(fill / 2))}${'a'.repeat(fill % 2)}${tail}`;
    };
    const tooBig = statementOfBytes(100_001);
    expect(new TextEncoder().encode(tooBig).length).toBe(100_001);
    expect(tooBig.length).toBeLessThan(100_000);
    await rejectsWithoutRequest({ sql: tooBig, params: [] });

    await withHarness(async ({ executor }) => {
      const fits = statementOfBytes(100_000);
      expect(new TextEncoder().encode(fits).length).toBe(100_000);
      const rows = await executor.all<{ v: string }>({ sql: fits, params: [] });
      expect(rows[0]?.v.length).toBeGreaterThan(0);
    });
  });
});

describe('D1 HTTP executor: parameter domain', () => {
  const outside: [string, unknown][] = [
    ['array', [1, 2, 255]],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['boolean', true],
    ['bigint', 1n],
    ['undefined', undefined],
    ['object', { a: 1 }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', -(2 ** 53)],
  ];

  it.each(outside)('rejects %s with TypeError before any request', async (_name, value) => {
    await withHarness(async ({ executor, requests }) => {
      const statement = { sql: 'SELECT ? AS v', params: [value] } as unknown as ScalarStatement;

      expect(await rejection(executor.all(statement))).toBeInstanceOf(TypeError);
      expect(await rejection(executor.batch([statement]))).toBeInstanceOf(TypeError);
      expect(requests).toHaveLength(0);
    });
  });

  it('names the offending type', async () => {
    await withHarness(async ({ executor }) => {
      const statement = { sql: 'SELECT ? AS v', params: [[1, 2]] } as unknown as ScalarStatement;
      const error = await rejection(executor.all(statement));

      expect((error as Error).message).toMatch(/array/);
    });
  });

  it('rejects sparse parameter arrays', async () => {
    const holeFirst = new Array<ScalarStatement['params'][number]>(1);
    // eslint-disable-next-line no-sparse-arrays
    const holeLeading = [, 1] as unknown as ScalarStatement['params'];
    for (const params of [holeFirst, holeLeading]) {
      await withHarness(async ({ executor, requests }) => {
        const statement = { sql: 'SELECT ? AS a', params };

        expect(await rejection(executor.all(statement))).toBeInstanceOf(TypeError);
        expect(await rejection(executor.batch([statement]))).toBeInstanceOf(TypeError);
        expect(requests).toHaveLength(0);
      });
    }
  });

  it('labels types without reading caller-controlled properties', async () => {
    const spoofed = { constructor: { name: API_TOKEN } };
    const throwing = {
      get constructor(): never {
        throw new Error(`getter ran ${API_TOKEN}`);
      },
    };
    for (const value of [spoofed, throwing]) {
      await withHarness(async ({ executor, requests }) => {
        const statement = { sql: 'SELECT ? AS v', params: [value] } as unknown as ScalarStatement;

        for (const error of [
          await rejection(executor.all(statement)),
          await rejection(executor.batch([statement])),
        ]) {
          expect(error).toBeInstanceOf(TypeError);
          expect((error as Error).message).toMatch(
            /^statement (0 )?parameter 0 has unsupported type object$/,
          );
        }
        expect(requests).toHaveLength(0);
      });
    }
  });
});

describe('D1 HTTP executor: options', () => {
  it.each([
    ['accountId', 'a/../b'],
    ['accountId', ''],
    ['accountId', 'a'.repeat(65)],
    ['databaseId', 'db?x=1'],
    ['databaseId', 'db id'],
    ['baseUrl', 'http://api.cloudflare.com/client/v4'],
    ['baseUrl', 'http://127.0.0.1.example.test/v4'],
    ['baseUrl', 'ftp://127.0.0.1/v4'],
    ['baseUrl', 'not a url'],
    ['baseUrl', 'https://user:pass@d1.example.test/v4'],
    ['baseUrl', 'https://d1.example.test/v4?x=1'],
    ['baseUrl', 'https://d1.example.test/v4#frag'],
  ])('rejects %s %j with TypeError', (key, value) => {
    expect(() =>
      createD1HttpExecutor({
        accountId: ACCOUNT_ID,
        databaseId: DATABASE_ID,
        apiToken: API_TOKEN,
        [key]: value,
      }),
    ).toThrow(TypeError);
  });

  it('rejects an empty or header-unsafe token without echoing it', () => {
    for (const apiToken of ['', `${API_TOKEN}\r\nx-injected: 1`]) {
      let error: unknown;
      try {
        createD1HttpExecutor({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expectNoSecret((error as Error).message);
    }
  });

  it('reports driver d1-http and keeps the token out of serialisation', async () => {
    await withHarness(async ({ executor }) => {
      expect(executor.driver).toBe('d1-http');
      expectNoSecret(JSON.stringify(executor));
      expect(inspect(executor, { depth: Infinity, showHidden: true })).not.toContain(API_TOKEN);
    });
  });

  it('aborts a request that outlives timeoutMs', async () => {
    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');

        expect(error.message).toBe('d1 http request failed');
        expect(error.cause).toBeNull();
      },
      hangUntilAborted,
      { timeoutMs: 20 },
    );
  });

  it.each([0, -1, 1.5, 600_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5e9])(
    'falls back to the default timeout for timeoutMs %s',
    async (timeoutMs) => {
      await withHarness(
        async ({ executor }) => {
          expect(await executor.all({ sql: 'SELECT 1', params: [] })).toEqual([{ ok: 1 }]);
        },
        respondAfter(30),
        { timeoutMs },
      );
    },
  );
});

describe('D1 HTTP executor: secrets and network failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => inspect(arg, { depth: Infinity })).join(' '));
      });
    }
    return lines;
  }

  function expectClean(error: DbError, logs: readonly string[]): void {
    expectNoSecret(error.message);
    expectNoSecret(String(error.stack));
    expectNoSecret(inspect(error, { depth: Infinity, showHidden: true }));
    expect(error.cause).toBeNull();
    for (const line of logs) expectNoSecret(line);
    expectNoSecret(process.argv.join(' '));
  }

  it('removes token, account id and database id echoed by Cloudflare', async () => {
    const logs = captureLogs();
    const echo = `Authentication error for token ${API_TOKEN} on /accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query (account ${ACCOUNT_ID}, database ${DATABASE_ID})`;

    await withHarness(
      async ({ executor }) => {
        const fromAll = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');
        const fromBatch = await dbError(
          executor.batch([{ sql: 'SELECT 1', params: [] }]),
          'unknown',
        );

        for (const error of [fromAll, fromBatch]) {
          expect(error.message).toContain('Authentication error');
          expectClean(error, logs);
        }
      },
      async () =>
        json(403, { result: null, success: false, errors: [{ code: 10000, message: echo }] }),
    );
  });

  it('wraps a fetch rejection that carries the URL and token', async () => {
    const logs = captureLogs();

    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');

        expect(error.message).toBe('d1 http request failed');
        expectClean(error, logs);
      },
      async () => {
        throw new TypeError(`fetch failed: POST ${QUERY_URL} with Bearer ${API_TOKEN}`, {
          cause: new Error(`connect ECONNREFUSED ${QUERY_URL}`),
        });
      },
    );
  });

  it.each([
    ['abort', () => new DOMException(`aborted ${QUERY_URL}`, 'AbortError')],
    ['timeout', () => new DOMException(`timed out ${API_TOKEN}`, 'TimeoutError')],
    ['redirect', () => new TypeError(`fetch failed: redirect to ${QUERY_URL}?t=${API_TOKEN}`)],
    ['non-error', () => `${API_TOKEN}`],
  ])('wraps a %s before a response the same way', async (_name, reason) => {
    const logs = captureLogs();

    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.batch([{ sql: 'SELECT 1', params: [] }]), 'unknown');

        expect(error.message).toBe('d1 http request failed');
        expectClean(error, logs);
      },
      () => Promise.reject(reason()),
    );
  });

  it('reports a body read failure as an indeterminate response read failure', async () => {
    const logs = captureLogs();

    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');

        expect(error.message).toBe('d1 http response read failed');
        expectClean(error, logs);
      },
      async () => {
        const response = new Response('{}', { status: 200 });
        vi.spyOn(response, 'text').mockRejectedValue(new Error(`socket closed ${QUERY_URL}`));
        return response;
      },
    );
  });

  it('maps a non-JSON error page to a bare status error', async () => {
    await withHarness(
      async ({ executor }) => {
        const error = await dbError(executor.all({ sql: 'SELECT 1', params: [] }), 'unknown');

        expect(error.message).toBe('d1 http 502');
      },
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
  });

  it('rejects a success with the wrong number of results as malformed', async () => {
    await withHarness(
      async ({ executor }) => {
        const error = await dbError(
          executor.batch([
            { sql: 'SELECT 1', params: [] },
            { sql: 'SELECT 2', params: [] },
          ]),
          'unknown',
        );

        expect(error.message).toBe('d1 http malformed response');
      },
      async () => d1Success([{ rows: [], changes: 0 }]),
    );
  });
});

describe('D1 HTTP executor: lost-response marker', () => {
  it('marks a fetch rejection and a body read failure as lost, and a validation error as not sent', async () => {
    await withHarness(
      async ({ executor }) => {
        const rejected = await rejection(executor.all({ sql: 'SELECT 1', params: [] }));
        expect(isLostResponse(rejected)).toBe(true);
        const invalid = await rejection(executor.all({ sql: 'SELECT 1; SELECT 2', params: [] }));
        expect(invalid).toBeInstanceOf(TypeError);
        expect(isLostResponse(invalid)).toBe(false);
      },
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );
    await withHarness(
      async ({ executor }) => {
        expect(isLostResponse(await rejection(executor.all({ sql: 'SELECT 1', params: [] })))).toBe(
          true,
        );
      },
      async () => {
        const response = new Response('{}', { status: 200 });
        vi.spyOn(response, 'text').mockRejectedValue(new Error('closed'));
        return response;
      },
    );
  });

  it('does not treat a plain DbError with the same message as lost', () => {
    expect(isLostResponse(new DbError('unknown', 'd1 http response read failed'))).toBe(false);
  });
});
