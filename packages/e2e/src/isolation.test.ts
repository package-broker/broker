import { beforeAll, describe, expect, it, vi } from 'vitest';
import { anchoredBreak, auditHash, auditLogs, auditScenario } from './audit.spec.js';
import type { AuditRecord, HeadAnchor } from './audit.spec.js';
import {
  archiveBytes,
  composerRepositories,
  digest,
  errorShape,
  fixtureResponse,
  githubResponse,
  truth,
} from './evidence.js';
import { isolationScenario, readPages } from './isolation.spec.js';
import { DatabaseSync } from 'node:sqlite';
import { LocalUnavailable, infrastructureOperations } from './local.js';
import type { AuditRow, InfrastructureOperations, SqlPort } from './local.js';
import * as local from './local.js';

function chain() {
  let previous = '0'.repeat(64);
  return Array.from({ length: 4 }, (_, index) => {
    const row: AuditRecord = {
      id: `event-${index + 1}`,
      org_id: 'org-a',
      seq: index + 1,
      prev_hash: previous,
      hash: '',
      action: 'project.create',
      actor_id: null,
      actor_type: 'system',
      created_at: '2026-01-01T00:00:00.000Z',
      payload_json: '{}',
      project_id: null,
      target_id: null,
      target_type: 'project',
      token_selector: null,
    };
    previous = row.hash = auditHash(row);
    return row;
  });
}
const anchorFor = (rows: AuditRecord[]): HeadAnchor => ({
  orgId: 'org-a',
  seq: rows.at(-1)!.seq,
  hash: rows.at(-1)!.hash,
});

describe('external audit oracle controls', () => {
  it('matches the published audit hash vector independently of the broker hasher', () => {
    const row: AuditRecord = {
      id: '01J0AUDIT000000000000000A',
      org_id: '01J0ACME000000000000000000',
      seq: 1,
      prev_hash: '0'.repeat(64),
      hash: '',
      created_at: '2026-10-16T09:00:00.000Z',
      actor_type: 'user',
      actor_id: '01J0USER000000000000000000',
      token_selector: null,
      action: 'role.create',
      target_type: 'role',
      target_id: '01J0ROLE000000000000000000',
      project_id: null,
      payload_json:
        '{"changes":{"name":{"new":"Auditor"}},"op_id":"01J0OPID000000000000000000","request_id":"req-1"}',
    };
    expect(auditHash(row)).toBe('15bd66283f29e8842c2e4298547005f431ad62c3d20aacc58a3090abfabbb7e4');
  });
  it('reads bounded Node and Workerd verifier records without evaluating log text', () => {
    const record = { event: 'audit.chain_broken', job_id: 'job', seq: 2, reason: 'hash' };
    expect(auditLogs(JSON.stringify(record))).toEqual([record]);
    const inspected =
      "{\n  level: 'info',\n  event: 'audit.chain_broken',\n  job_id: 'job',\n  seq: 2,\n  reason: 'hash'\n}" +
      "{\n  level: 'info',\n  event: 'job.settle',\n  job_id: 'job'\n}";
    expect(auditLogs(inspected)).toEqual([record]);
    expect(auditLogs('garbage\n' + JSON.stringify({ event: 'job.settle' }))).toEqual([]);
  });
  it('accepts an intact chain and a valid extension beyond the independent head', () => {
    const rows = chain();
    expect(anchoredBreak(rows, anchorFor(rows))).toBeNull();
    expect(anchoredBreak(rows, anchorFor(rows.slice(0, 2)))).toBeNull();
  });

  it.each([
    ['alter', 2, 'hash'],
    ['delete', 3, 'seq_gap'],
    ['reorder', 2, 'prev_hash'],
    ['truncate', 3, 'anchor'],
    ['truncate-all', 1, 'anchor'],
    ['delete-first', 2, 'seq_gap'],
  ] as const)('detects %s at its first invalid position', (kind, seq, reason) => {
    const rows = chain();
    const anchor = anchorFor(rows);
    if (kind === 'alter') rows[1]!['action'] = 'project.delete';
    if (kind === 'delete') rows.splice(1, 1);
    if (kind === 'delete-first') rows.shift();
    if (kind === 'reorder') {
      [rows[1], rows[2]] = [rows[2]!, rows[1]!];
      rows[1]!.seq = 2;
      rows[2]!.seq = 3;
    }
    if (kind === 'truncate') rows.splice(2);
    if (kind === 'truncate-all') rows.splice(0);
    expect(anchoredBreak(rows, anchor)).toEqual({ seq, reason });
  });

  it('uses the saved head to reject a fully recomputed chain', () => {
    const rows = chain();
    const anchor = anchorFor(rows);
    rows[0]!['action'] = 'project.delete';
    let previous = '0'.repeat(64);
    for (const row of rows) {
      row.prev_hash = previous;
      previous = row.hash = auditHash(row);
    }
    expect(anchoredBreak(rows, anchor)).toEqual({ seq: 4, reason: 'anchor' });
  });

  it('rejects foreign organization rows and incomplete hash input', () => {
    const rows = chain();
    const anchor = anchorFor(rows);
    rows[0]!.org_id = 'org-b';
    expect(() => anchoredBreak(rows, anchor)).toThrow('InvalidAuditRecord');
    delete rows[0]!['action'];
    expect(() => auditHash(rows[0]!)).toThrow('IncompleteAuditRecord');
  });
});

describe('typed infrastructure operations', () => {
  const pinned = '01PINNED';
  const other = '01OTHER';
  const columns = [
    'id',
    'org_id',
    'seq',
    'prev_hash',
    'hash',
    'created_at',
    'actor_type',
    'actor_id',
    'token_selector',
    'source_ip',
    'action',
    'target_type',
    'target_id',
    'project_id',
    'payload_json',
  ];
  function database() {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE audit_event (${columns.join(', ')}, UNIQUE (org_id, seq));` +
        'CREATE TABLE job (id, org_id, type);',
    );
    for (const org of [pinned, other])
      for (let seq = 1; seq <= 4; seq++)
        db.prepare(
          `INSERT INTO audit_event (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ).run(
          ...columns.map((column) =>
            column === 'org_id'
              ? org
              : column === 'seq'
                ? seq
                : column === 'id'
                  ? `${org}-${seq}`
                  : `${column}-${seq}`,
          ),
        );
    const port: SqlPort = {
      async run(sql, params) {
        db.prepare(sql).run(...params);
      },
      async all<T extends Record<string, unknown>>(
        sql: string,
        params: (string | number | null)[],
      ) {
        return db.prepare(sql).all(...params) as T[];
      },
    };
    const rows = (org: string) =>
      db.prepare('SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq').all(org);
    return { db, operations: infrastructureOperations(port, pinned), rows };
  }

  it.each([
    ['alter', (ops: InfrastructureOperations) => ops.audit.alter(2, 'action', 'changed')],
    ['delete', (ops: InfrastructureOperations) => ops.audit.delete(2)],
    ['reorder', (ops: InfrastructureOperations) => ops.audit.reorder(2, 3)],
    ['truncate', (ops: InfrastructureOperations) => ops.audit.truncateFrom(3)],
    ['truncate-all', (ops: InfrastructureOperations) => ops.audit.truncateFrom(1)],
    [
      'restore',
      async (ops: InfrastructureOperations) => ops.audit.restore(await ops.audit.snapshot()),
    ],
  ] as const)('%s changes only the pinned organization', async (_kind, apply) => {
    const { operations, rows } = database();
    const untouched = rows(other);
    const before = rows(pinned);
    await apply(operations);
    expect(rows(other)).toEqual(untouched);
    if (_kind === 'restore') expect(rows(pinned)).toEqual(before);
    else expect(rows(pinned)).not.toEqual(before);
  });

  it('enqueues jobs for the pinned organization only', async () => {
    const { db, operations } = database();
    await operations.jobs.enqueue('core:audit-verify:v1');
    expect(db.prepare('SELECT org_id, type FROM job').all()).toEqual([
      { org_id: pinned, type: 'core:audit-verify:v1' },
    ]);
  });

  it('refuses foreign snapshots, unlisted fields, unlisted jobs and invalid positions', async () => {
    const { operations, rows } = database();
    const foreign = rows(other) as AuditRow[];
    await expect(operations.audit.restore(foreign)).rejects.toThrow('ForeignAuditSnapshot');
    await expect(operations.audit.alter(2, 'org_id' as unknown as 'action', other)).rejects.toThrow(
      'AuditFieldNotAlterable',
    );
    await expect(
      operations.jobs.enqueue('core:source-poll:v1' as unknown as 'core:audit-verify:v1'),
    ).rejects.toThrow('JobTypeNotEnqueueable');
    await expect(operations.audit.delete(0)).rejects.toThrow('InvalidAuditSeq');
    expect(rows(other)).toHaveLength(4);
  });
});

describe('isolation oracle controls', () => {
  it('requires the exact error envelope apart from the per-request identifier', async () => {
    const response = (requestId: string, message = 'Route not found') =>
      Response.json({ error: { code: 'not_found', message, requestId } }, { status: 404 });
    expect(await errorShape(response('first'))).toEqual(await errorShape(response('second')));
    expect(await errorShape(response('third', 'different'))).not.toEqual(
      await errorShape(response('fourth')),
    );
    await expect(
      errorShape(Response.json({ error: { code: 'forbidden' } }, { status: 403 })),
    ).rejects.toThrow();
    await expect(
      errorShape(
        Response.json(
          {
            error: { code: 'not_found', message: 'Route not found', requestId: 'id', fact: 'beta' },
          },
          { status: 404 },
        ),
      ),
    ).rejects.toThrow();
  });

  it('walks every page and refuses a repeating cursor', async () => {
    const pages = vi
      .fn()
      .mockResolvedValueOnce({ items: ['alpha-one'], next: 'second' })
      .mockResolvedValueOnce({ items: ['alpha-two'], next: null });
    expect(await readPages(pages)).toEqual(['alpha-one', 'alpha-two']);
    expect(pages.mock.calls).toEqual([[null], ['second']]);
    await expect(readPages(async () => ({ items: ['beta'], next: 'same' }))).rejects.toThrow(
      'PaginationCycle',
    );
    await expect(readPages(async () => ({ items: ['alpha', 'beta'], next: null }))).rejects.toThrow(
      'PageLimitIgnored',
    );
  });

  it('serves every npm archive exactly as its fixture metadata promises', async () => {
    for (const item of truth.filter((entry) => entry.ecosystem === 'npm')) {
      const metadata = (await fixtureResponse(
        new URL(`http://127.0.0.1/__upstream/registry.npmjs.org/${encodeURIComponent(item.name)}`),
      ).json()) as { versions: Record<string, { dist: { tarball: string; integrity: string } }> };
      for (const [version, value] of Object.entries(metadata.versions)) {
        const url = new URL(value.dist.tarball);
        const response = fixtureResponse(
          new URL(`http://127.0.0.1/__upstream/${url.host}${url.pathname}`),
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes).toEqual(archiveBytes(item.name, version));
        expect(value.dist.integrity).toBe(
          'sha512-' + Buffer.from(digest(bytes, 'sha512'), 'hex').toString('base64'),
        );
      }
    }
  });

  it('has distinct bytes and closed metadata truth sets for each project', async () => {
    expect(
      new Set(truth.map((item) => Buffer.from(archiveBytes(item.name, '2.0.0')).toString('hex')))
        .size,
    ).toBe(truth.length);
    for (const project of ['alpha', 'beta']) {
      const repositories = composerRepositories.filter((item) => item.project === project);
      expect(repositories.map((item) => item.name)).toEqual([`${project}/one`, `${project}/two`]);
      for (const item of repositories) {
        const response = await githubResponse(
          new Request(`https://api.github.com/repos/${item.repository}/contents/composer.json`),
        );
        expect(await response.json()).toEqual({ name: item.name });
      }
    }
    expect(
      fixtureResponse(new URL('http://127.0.0.1/__upstream/registry.npmjs.org/@absent/none'))
        .status,
    ).toBe(404);
  });
});

describe('security scenario availability', () => {
  it.each([
    ['authz-project-isolation', isolationScenario],
    ['audit-integrity', auditScenario],
  ] as const)('%s reports unavailable listeners as NOT RUN', async (_id, run) => {
    const probe = vi
      .spyOn(local, 'reserveLoopbackPort')
      .mockRejectedValueOnce(new LocalUnavailable('Loopback listeners are unavailable.'));
    try {
      expect((await run('node')).status).toBe('NOT RUN');
    } finally {
      probe.mockRestore();
    }
  });
});

describe('security oracles on production bundles', () => {
  beforeAll(() => local.buildBundles(), 600_000);

  for (const runtime of ['node', 'cloudflare'] as const) {
    it(`${runtime}: project isolation and next-request revocation`, async () => {
      const result = await isolationScenario(runtime);
      expect({ status: result.status, reason: result.reason }).toEqual({
        status: 'NOT RUN',
        reason:
          `${runtime}: project-isolation: other oracles passed; NOT RUN: ` +
          'project-scope-and-non-admin-grant-revocation ' +
          '(needs an SSO identity; local accounts hold only the organization admin role).',
      });
    }, 300_000);
    it(`${runtime}: audit tamper positions and external head anchor`, async () => {
      const result = await auditScenario(runtime);
      expect(result.status, result.reason).toBe('PASS');
    }, 300_000);
  }
});
