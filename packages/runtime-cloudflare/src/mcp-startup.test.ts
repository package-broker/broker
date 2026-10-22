import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import * as d1 from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';
const SELECTOR = 'abcdefghijkl';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const database = await openMigratedDatabase();
  const { executor } = database;
  vi.spyOn(d1, 'createD1Executor').mockReturnValue(executor);
  const orgId = ulid();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const limit = vi
    .fn<(input: { key: string }) => Promise<{ success: boolean }>>()
    .mockResolvedValue({ success: true });
  const env: Env = {
    DB: {
      prepare() {
        throw new Error('D1 access must use the local SQLite executor');
      },
      batch() {
        throw new Error('D1 access must use the local SQLite executor');
      },
    },
    PB_PUBLIC_URL: ORIGIN,
    PB_MASTER_KEY: KEY,
    MCP_RATE_LIMIT: { limit },
  };
  const worker = () => createWorker([], { mcp: { enabled: true }, log: () => undefined });
  const token = formatToken('svc', SELECTOR, new Uint8Array(32).fill(7));
  const seedToken = async () => {
    const hash = await hashToken(createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]), 1, token);
    await executor.batch([
      {
        sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        params: ['mcp-user', orgId, 'reader@example.test'],
      },
      {
        sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
        params: ['mcp-service', orgId, 'MCP reader', 'mcp-user'],
      },
      {
        sql: `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name,
          scopes_json, read_only, service_principal_id, expires_at, project_mode)
          VALUES (?, ?, 'svc', ?, ?, 1, 'MCP reader', '["read"]', 1, ?, ?, 'all')`,
        params: [
          'mcp-token',
          orgId,
          SELECTOR,
          hash,
          'mcp-service',
          new Date(Date.now() + 3_600_000).toISOString(),
        ],
      },
    ]);
  };
  const request = () =>
    new Request(`${ORIGIN}/_pb/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
  return { ...database, worker, env, limit, seedToken, request };
}

describe('Worker MCP startup with a local SQLite executor', () => {
  it('refuses a preseeded token without a keyring verifier before calling the limiter', async () => {
    const f = await fixture();
    try {
      await f.seedToken();
      const worker = f.worker();
      await expect(worker.services(f.env)).rejects.toThrow('No keyring verifier is stored');
      const response = await worker.fetch(f.request(), f.env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'misconfigured', message: 'Server is not configured' },
      });
      expect(f.limit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('enrolls before seeding a token and preserves MCP initialization and limiting after restart', async () => {
    const f = await fixture();
    try {
      await f.worker().services(f.env);
      await f.seedToken();
      const worker = f.worker();
      const initialized = await worker.fetch(f.request(), f.env);
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: { tools: {} } },
      });
      f.limit.mockResolvedValue({ success: false });
      const limited = await worker.fetch(f.request(), f.env);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.json()).toEqual({
        error: {
          code: 'rate_limited',
          message: 'Rate limit exceeded',
          requestId: limited.headers.get('x-request-id'),
        },
      });
      expect(f.limit.mock.calls).toEqual([[{ key: SELECTOR }], [{ key: SELECTOR }]]);
    } finally {
      await f.close();
    }
  });
});
