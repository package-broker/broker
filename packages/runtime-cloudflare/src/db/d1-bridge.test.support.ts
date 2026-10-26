import type { SqlValue } from '@package-broker/core/db/port';
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from './d1-executor.js';

export const D1_BRIDGE_SCRIPT = `
const decode = (value) =>
  value !== null && typeof value === 'object'
    ? Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0))
    : value;
export default {
  async fetch(request, env) {
    const { binding, mode, statements } = await request.json();
    try {
      const prepared = statements.map(({ sql, params }) =>
        env[binding].prepare(sql).bind(...params.map(decode)),
      );
      const result = mode === 'all'
        ? [await prepared[0].all()]
        : await env[binding].batch(prepared);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({
        ok: false,
        message: String(error && error.message),
        cause: error && error.cause ? String(error.cause.message) : null,
      });
    }
  },
};
`;

interface BridgeResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

type Dispatch = (body: string) => Promise<BridgeResponse>;
type Reply =
  | { readonly ok: true; readonly result: D1Result[] }
  | { readonly ok: false; readonly message: string; readonly cause: string | null };

// Keep prepare/bind inside workerd: getD1Database() proxies these synchronous
// calls through Miniflare's blocking worker-thread transport.
export function bridgedD1Database(binding: string, dispatch: Dispatch): D1DatabaseLike {
  const statements = new WeakMap<D1PreparedStatementLike, { sql: string; params: unknown[] }>();
  const send = async (mode: 'all' | 'batch', prepared: D1PreparedStatementLike[]) => {
    const response = await dispatch(
      JSON.stringify({
        binding,
        mode,
        statements: prepared.map((statement) => {
          const data = statements.get(statement);
          if (data === undefined) throw new TypeError('foreign D1 bridge statement');
          return data;
        }),
      }),
    );
    if (!response.ok) throw new Error('D1 test bridge request failed');
    const reply = (await response.json()) as Reply;
    if (reply.ok) return reply.result;
    throw new Error(reply.message, {
      cause: reply.cause === null ? undefined : new Error(reply.cause),
    });
  };
  const prepare = (sql: string, params: SqlValue[] = []): D1PreparedStatementLike => {
    const statement: D1PreparedStatementLike = {
      bind: (...values) => prepare(sql, values as SqlValue[]),
      all: async () => (await send('all', [statement]))[0]!,
    };
    statements.set(statement, {
      sql,
      params: params.map((value) =>
        value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value,
      ),
    });
    return statement;
  };
  return { prepare, batch: (prepared) => send('batch', prepared) };
}
