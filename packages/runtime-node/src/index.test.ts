import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeServer } from './index.js';

describe('runtime-node', () => {
  const { server } = createNodeServer([]);
  afterEach(() => server.close());

  it('answers unknown routes with the error envelope', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });
});

describe('close order', () => {
  it('waits for HTTP server close before closing the database', async () => {
    const closeDatabase = vi.fn(() => Promise.resolve());
    const broker = createNodeServer([], { closeDatabase });
    await broker.ready();
    const listening = vi.spyOn(broker.server, 'listening', 'get').mockReturnValue(true);
    let finishHttp!: () => void;
    const close = vi.spyOn(broker.server, 'close').mockImplementation((callback) => {
      finishHttp = () => callback?.();
      return broker.server;
    });
    try {
      const closing = broker.close();
      await Promise.resolve();
      expect(close).toHaveBeenCalledTimes(1);
      expect(closeDatabase).not.toHaveBeenCalled();
      finishHttp();
      await closing;
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      listening.mockRestore();
    }
  });
});

it('masks hidden provenance uniformly and projects bounded states with an injected clock', async () => {
  const { openMigratedDatabase } =
    await import('@package-broker/db-sqlite/testing/migrated-database');
  const { createOrganizationBootstrap } =
    await import('@package-broker/db-sqlite/repositories/organization');
  const { createKeyring } = await import('@package-broker/core/secrets/keyring');
  const { parseMasterKey } = await import('@package-broker/core/secrets/master-key');
  const { systemClock, ulid } = await import('@package-broker/core/ids');
  const db = await openMigratedDatabase();
  let broker: ReturnType<typeof createNodeServer> | undefined;
  const time = new Date('2026-10-20T12:00:00.000Z');
  vi.spyOn(systemClock, 'now').mockImplementation(() => time);
  const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected egress'));
  try {
    const org = ulid(),
      source = ulid(),
      pkg = ulid(),
      version = ulid();
    const seed = async (
      sql: string,
      ...params: import('@package-broker/core/db/port').SqlValue[]
    ) => db.executor.batch([{ sql, params }]);
    await createOrganizationBootstrap(db.executor).bootstrap({
      id: org,
      slug: 'status',
      name: 'Status',
      now: time.toISOString(),
    });
    await seed(
      "INSERT INTO source (id,org_id,name,ecosystem,type,url,config_json) VALUES (?,?,'public','npm','npmjs_proxy','https://registry.npmjs.org','{}')",
      source,
      org,
    );
    await seed(
      "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES (?,?,?,'npm','public-control')",
      pkg,
      org,
      source,
    );
    await seed(
      "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json) VALUES (?,?,?,'1.2.3','1.2.3',?,'upstream','{}')",
      version,
      org,
      pkg,
      time.toISOString(),
    );
    broker = createNodeServer([], {
      executor: db.executor,
      auth: {
        keyring: createKeyring([
          parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
        ]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      authorization: {
        authorize: async () => ({
          allow: true,
          principal: { kind: 'user', id: 'reader' },
          projectId: null,
        }),
      },
      log: () => undefined,
    });
    const kernel = await broker.ready();
    const read = async () => {
      const response = await kernel.fetch(
        new Request(`https://broker.test/_pb/packages/${pkg}/versions?limit=100`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: {
          status: string;
          vulnerability: import('@package-broker/core/db/vulnerability').VulnerabilityStatus;
        }[];
      };
      expect(body.items[0]!.status).toBe('active');
      return body.items[0]!.vulnerability;
    };
    const mask = {
      status: 'unknown',
      reason: 'not_checked',
      source: null,
      fetchedAt: null,
      lastKnownStatus: null,
      advisoryCount: 0,
      advisories: [],
      detailsComplete: false,
      advisoriesTruncated: false,
    };
    expect(await read()).toEqual({ ...mask, reason: 'pending', source: 'osv' });
    await seed("UPDATE version SET version='dev-main' WHERE org_id=? AND id=?", org, version);
    expect(await read()).toEqual({ ...mask, reason: 'unsupported_version' });
    await seed("UPDATE version SET version='1.2.3' WHERE org_id=? AND id=?", org, version);
    await seed(
      "INSERT INTO vulnerability_result (org_id,version_id,package_id,ecosystem,package_key,version,query_version,mapping_version,attempted_at,next_attempt_at,generation,last_error_code) VALUES (?,?,?,'npm','public-control','1.2.3','1.2.3',1,?,?,0,'unavailable')",
      org,
      version,
      pkg,
      time.toISOString(),
      time.toISOString(),
    );
    expect(await read()).toEqual({ ...mask, reason: 'upstream_unavailable', source: 'osv' });
    await seed(
      "UPDATE vulnerability_result SET assessment='affected',fetched_at=?,last_error_code=NULL WHERE org_id=?",
      time.toISOString(),
      org,
    );
    await seed(
      "INSERT INTO vulnerability_match (org_id,version_id,advisory_id) VALUES (?,?,'GHSA-test')",
      org,
      version,
    );
    expect(await read()).toMatchObject({
      status: 'affected',
      reason: null,
      lastKnownStatus: 'affected',
      advisoryCount: 1,
      detailsComplete: false,
    });
    await seed(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20) INSERT INTO vulnerability_match(org_id,version_id,advisory_id) SELECT ?,?,'OSV-'||x FROM n",
      org,
      version,
    );
    const truncated = await read();
    expect(truncated.advisoryCount).toBe(21);
    expect(truncated.advisories).toHaveLength(20);
    expect(truncated.advisoriesTruncated).toBe(true);
    time.setTime(time.getTime() + 86400000);
    expect(await read()).toMatchObject({
      status: 'stale',
      reason: 'expired',
      lastKnownStatus: 'affected',
      advisoryCount: 21,
    });
    // All vetoes suppress the same previously cached positive result.
    await seed(
      "INSERT INTO source (id,org_id,name,ecosystem,type,status,config_json) VALUES ('hidden-source',?,'hidden','npm','hosted','paused','{}')",
      org,
    );
    await seed(
      "INSERT INTO package (id,org_id,source_id,ecosystem,name,status) VALUES ('hidden-holder',?,'hidden-source','npm','public-control','removed_upstream')",
      org,
    );
    expect(await read()).toEqual(mask);
    await seed("DELETE FROM package WHERE org_id=? AND id='hidden-holder'", org);
    await seed(
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('hidden-pattern',?,'hidden-source','npm','public-*')",
      org,
    );
    expect(await read()).toEqual(mask);
    await seed("DELETE FROM registered_name WHERE org_id=? AND id='hidden-pattern'", org);
    await seed(
      `UPDATE source SET type='vcs',config_json='{"provider":"git","repository":"https://git.example.test/repo.git","packageName":"public-control"}' WHERE org_id=? AND id='hidden-source'`,
      org,
    );
    expect(await read()).toEqual(mask);
    await seed(
      "UPDATE source SET type='hosted',config_json='{}' WHERE org_id=? AND id='hidden-source'",
      org,
    );
    await seed("UPDATE source SET config_json='[]' WHERE org_id=? AND id=?", org, source);
    expect(await read()).toEqual(mask);
    await seed("UPDATE source SET config_json='{}' WHERE org_id=? AND id=?", org, source);
    await seed(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO registered_name(id,org_id,source_id,ecosystem,pattern) SELECT 'budget-'||x,?,?,'npm','unrelated-'||x FROM n",
      org,
      source,
    );
    expect(await read()).toEqual(mask);
    expect(outbound).not.toHaveBeenCalled();
  } finally {
    await broker?.close();
    await db.close();
    vi.restoreAllMocks();
  }
});
