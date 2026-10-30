import { setTimeout as realDelay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { hashRow, type AuditRow } from '@package-broker/core/audit/chain';
import { ulid } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { run } from '../cli.js';
import * as admin from './admin.js';
import { D1LostResponseError } from '../cloudflare/d1-http-executor.js';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { ScalarSqlExecutor, OrgContext } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { createAuditApiExportStore } from '@package-broker/db-sqlite/repositories/audit-api-export';

import { verifyAuditArtifact } from './audit-artifact.js';

let dir: string;
let output: string;
const org = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const chainId = 'a'.repeat(32);
const now = '2026-10-30T12:00:00.000Z';
const cookie = 'pb_session=credential-sentinel';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-audit-export-'));
  output = join(dir, 'export.jsonl');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('PB_TEST_AUDIT_COOKIE', cookie);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
let multipage: ReturnType<typeof makeRows> | undefined;
function rows(count = 1) {
  if (count === 2001) return (multipage ??= makeRows(count));
  return makeRows(count);
}
async function makeRows(count: number) {
  const result: (AuditRow & { kind: 'event'; chain_id: string; epoch: number })[] = [];
  let prev = '0'.repeat(64);
  for (let seq = 1; seq <= count; seq++) {
    const event = auditEvent({
      id: ulid(),
      now,
      action: 'project.update',
      actor: { type: 'user', id: actor },
      target: { type: 'organization', id: org },
      context: { opId: ulid(), requestId: ulid(), tokenSelector: null, sourceIp: null },
      changes: { name: { new: 'Registry' } },
    });
    if (!event.ok) throw new Error('Fixture invalid');
    const row: AuditRow & { kind: 'event'; chain_id: string; epoch: number } = {
      kind: 'event',
      chain_id: chainId,
      epoch: 0,
      id: event.event.id,
      org_id: org,
      seq,
      prev_hash: prev,
      hash: '',
      created_at: now,
      actor_type: 'user',
      actor_id: actor,
      token_selector: null,
      source_ip: null,
      action: 'project.update',
      target_type: 'organization',
      target_id: org,
      project_id: null,
      payload_json: event.event.payloadJson,
    };
    row.hash = await hashRow(prev, row);
    prev = row.hash;
    result.push(row);
  }
  return result;
}
function head(items: Awaited<ReturnType<typeof rows>>) {
  return {
    chainId,
    epoch: 0,
    boundarySeq: 1,
    boundaryPrevHash: '0'.repeat(64),
    headSeq: items.length,
    headHash: items.at(-1)?.hash ?? '0'.repeat(64),
  };
}
function page(items: Awaited<ReturnType<typeof rows>>, from = 1, to = items.length) {
  return {
    schema: 'audit-chain/1',
    snapshot: head(items),
    fromSeq: items.length ? from : 0,
    toSeq: to,
    next_from_seq: to < items.length ? to + 1 : null,
    items: items.slice(from - 1, to),
    dispositions: [],
  };
}
const args = () => [
  'audit',
  'export',
  '--broker',
  'https://broker.test',
  '--cookie-env',
  'PB_TEST_AUDIT_COOKIE',
  '--output',
  output,
  '--format',
  'jsonl',
];
async function artifact(items: Awaited<ReturnType<typeof rows>>) {
  const content =
    [{ kind: 'audit-export', version: 1, schema: 'audit-chain/1', snapshot: head(items) }, ...items]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n';
  return (
    content +
    JSON.stringify({
      kind: 'end',
      bodies: items.length,
      withheld: 0,
      sha256: createHash('sha256').update(content).digest('hex'),
    }) +
    '\n'
  );
}
it('writes a private verifiable artifact without the session credential or server extras', async () => {
  const items = await rows();
  const fetcher = vi.fn(async () =>
    Response.json({
      ...page(items),
      session: cookie,
      items: [{ ...items[0], credential: cookie }],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await run(args())).toBe(0);
  expect(await verifyAuditArtifact(output)).toMatchObject({
    ...head(items),
    orgId: org,
    bodies: 1,
    withheld: 0,
  });
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(await readFile(output, 'utf8')).not.toContain(cookie);
  expect(fetcher).toHaveBeenCalledWith(
    new URL('https://broker.test/_pb/audit/export'),
    expect.objectContaining({ headers: { cookie, accept: 'application/json' }, redirect: 'error' }),
  );
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(cookie);
});
it('follows 2,000-row cursor pages and pins the first head while new events arrive', async () => {
  const items = await rows(2001);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(page(items, 1, 2000)))
    .mockResolvedValueOnce(
      Response.json({
        ...page(items, 2001, 2001),
        snapshot: { ...head(items), headSeq: 2002, headHash: 'b'.repeat(64) },
        next_from_seq: 2002,
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  expect(await run(args())).toBe(0);
  expect(String(fetcher.mock.calls[1]![0])).toBe(
    'https://broker.test/_pb/audit/export?from_seq=2001&to_seq=2001',
  );
  expect(await verifyAuditArtifact(output)).toMatchObject({
    bodies: 2001,
    headSeq: 2001,
    headHash: items.at(-1)!.hash,
  });
});
it.each(['chainId', 'epoch', 'boundarySeq', 'boundaryPrevHash'])(
  'keeps the pinned partial artifact when %s changes between pages',
  async (field) => {
    const items = await rows(2001);
    const changed = {
      ...head(items),
      [field]:
        field === 'epoch'
          ? 1
          : field === 'boundarySeq'
            ? 2
            : 'b'.repeat(field === 'chainId' ? 32 : 64),
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page(items, 1, 2000)))
        .mockResolvedValueOnce(Response.json({ ...page(items, 2001, 2001), snapshot: changed })),
    );
    expect(await run(args())).toBe(1);
    expect(await readFile(output, 'utf8')).toContain('audit-export');
    expect(console.error).toHaveBeenLastCalledWith(
      `audit export: ${field === 'chainId' || field === 'epoch' ? 'chain_changed' : 'invalid_artifact'}`,
    );
  },
);
it('writes withheld markers without metadata or bodies and reports their limited verification', async () => {
  const items = await rows();
  const marker = {
    ...items[0],
    kind: 'withheld',
    marker_id: ulid(),
    reason_code: 'content_unavailable',
    payload_json: cookie,
    actor_id: 'held@example.test',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...page(items), items: [marker] })),
  );
  expect(await run(args())).toBe(0);
  const text = await readFile(output, 'utf8');
  expect(text).not.toContain(cookie);
  expect(text).not.toContain('held@example.test');
  expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 0, withheld: 1 });
});
it('exports an empty chain', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(page([]))),
  );
  expect(await run(args())).toBe(0);
  expect(await verifyAuditArtifact(output)).toMatchObject({ headSeq: 0, bodies: 0, withheld: 0 });
});
it.each([401, 403, 500, 302])(
  'refuses API status %s without echoing the response body',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(cookie, { status })),
    );
    expect(await run(args())).toBe(1);
    await expect(access(output)).rejects.toThrow();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(cookie);
  },
);
it('does not overwrite an existing export', async () => {
  await writeFile(output, 'existing');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await run(args())).toBe(1);
  expect(await readFile(output, 'utf8')).toBe('existing');
  expect(fetcher).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenLastCalledWith('audit export: output_exists');
});
it.each(['hash', 'missing', 'duplicate', 'payload', 'truncated', 'footer'])(
  'rejects corrupt artifacts: %s',
  async (change) => {
    const items = await rows(2);
    let content = await artifact(items);
    if (change === 'hash') content = content.replace(items[0]!.hash, 'b'.repeat(64));
    if (change === 'missing')
      content = content
        .split('\n')
        .filter((_, i) => i !== 1)
        .join('\n');
    if (change === 'duplicate')
      content = content.replace(JSON.stringify(items[1]), JSON.stringify(items[0]));
    if (change === 'payload') content = content.replace('Registry', 'Tampered');
    if (change === 'truncated') content = content.split('\n').slice(0, -2).join('\n');
    if (change === 'footer') content = content.replace('"bodies":2', '"bodies":1');
    await writeFile(output, content);
    await expect(verifyAuditArtifact(output)).rejects.toThrow();
  },
);
it('registers only a verified artifact whose final head matches and audits the registration', async () => {
  const items = await rows();
  await writeFile(output, await artifact(items));
  const file = join(dir, 'db.sqlite');
  const migrated = await openMigratedDatabase({ file });
  await migrated.close();
  const database = openBetterSqliteExecutor(file);
  try {
    await createOrganizationBootstrap(database.executor).bootstrap({
      id: org,
      slug: 'audit',
      name: 'Audit',
      now,
    });
    await database.executor.batch([
      {
        sql: "INSERT INTO user_account (org_id, id, email) VALUES (?, ?, 'operator@example.test')",
        params: [org, actor],
      },
      {
        sql: "UPDATE audit_chain SET mode = 'none', chain_id = ?, head_seq = ?, head_hash = ? WHERE org_id = ?",
        params: [chainId, 1, items[0]!.hash, org],
      },
    ]);
    const row = items[0]!;
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
    ] as const;
    await database.executor.batch([
      {
        sql: `INSERT INTO audit_event (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        params: columns.map((key) => row[key]),
      },
    ]);
    await seedExportAdmin(database.executor, orgContext(org));
    const store = createAuditApiExportStore(database.executor, EXPORT_PROVIDERS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const snapshot = await store.snapshot(orgContext(org));
        const event = auditEvent({
          id: ulid(),
          now: new Date().toISOString(),
          action: 'audit.export',
          actor: { type: 'user', id: EXPORT_USER },
          target: { type: 'organization', id: org },
          context: { opId: ulid(), requestId: ulid(), tokenSelector: null, sourceIp: null },
          changes: {
            from_seq: { new: 1 },
            to_seq: { new: 1 },
            count: { new: 1 },
            format: { new: 'api' },
          },
        });
        if (!event.ok) throw new Error('Invalid fixture');
        expect(
          await store.record(orgContext(org), exportFence(), snapshot, event.event, [
            {
              id: ulid(),
              kind: 'export',
              reasonCode: 'api_export',
              chainId,
              epoch: 0,
              fromSeq: 1,
              toSeq: 1,
              count: 1,
              sinkId: null,
              policy: snapshot.policy,
              modeGeneration: snapshot.modeGeneration,
              actorType: 'user',
              actorId: EXPORT_USER,
              createdAt: new Date().toISOString(),
            },
          ]),
        ).toBe('recorded');
        return Response.json(page(items));
      }),
    );
    await rm(output);
    expect(await run(args())).toBe(0);
    expect(await createAuditSealRepository(database.executor).seal(orgContext(org))).toMatchObject({
      outcome: 'sealed',
    });
    expect(
      await database.executor.all({
        sql: 'SELECT head_seq FROM audit_chain WHERE org_id = ?',
        params: [org],
      }),
    ).toEqual([{ head_seq: 2 }]);
    const command = [
      'audit',
      'cutover',
      '--org-id',
      org,
      '--register',
      output,
      '--sqlite',
      file,
      '--generation',
      '0',
      '--actor-type',
      'user',
      '--actor-id',
      actor,
    ];
    expect(
      await run(
        command.filter((value, index) => value !== '--org-id' && command[index - 1] !== '--org-id'),
      ),
    ).toBe(0);
    expect(
      await database.executor.all({
        sql: 'SELECT reason_code FROM audit_ledger WHERE org_id = ?',
        params: [org],
      }),
    ).toEqual([{ reason_code: 'api_export' }, { reason_code: 'verified_export' }]);
    expect(
      await database.executor.all({
        sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
        params: [org],
      }),
    ).toEqual([{ action: 'audit.export' }]);
    await database.executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [org] },
    ]);
    expect(await run(command)).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith('audit cutover: head_mismatch');
    expect(
      await database.executor.all({
        sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
        params: [org],
      }),
    ).toEqual([{ n: 2 }]);
    await writeFile(output, (await artifact(items)).replace('Registry', 'Tampered'));
    expect(await run(command)).toBe(1);
    expect(
      await database.executor.all({
        sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
        params: [org],
      }),
    ).toEqual([{ n: 2 }]);
  } finally {
    await database.close();
  }
});
it.each([
  ['audit', 'export'],
  ['audit', 'cutover'],
  [
    'audit',
    'export',
    '--broker',
    'https://user:secret@example.test',
    '--cookie-env',
    'PB_TEST_AUDIT_COOKIE',
    '--output',
    'unused',
    '--format',
    'jsonl',
  ],
])('refuses invalid invocation with fixed diagnostics: %j', async (...command) => {
  expect(await run(command)).toBe(2);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');
});

it('verifies a retained suffix from its pinned boundary', async () => {
  const items = await rows(3);
  const snapshot = { ...head(items), boundarySeq: 3, boundaryPrevHash: items[1]!.hash };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...page(items, 3, 3), snapshot })),
  );
  expect(await run(args())).toBe(0);
  expect(await verifyAuditArtifact(output)).toMatchObject({
    boundarySeq: 3,
    headSeq: 3,
    bodies: 1,
  });
});
it.each(['missing', 'cursor', 'unsafe', 'hash'])(
  'refuses malformed API evidence without unsafe content in the partial file: %s',
  async (change) => {
    const items = await rows(2);
    const body = page(items);
    if (change === 'missing') body.items = [items[1]!];
    if (change === 'cursor') body.next_from_seq = 1;
    if (change === 'unsafe') {
      body.items[0] = { ...items[0]!, payload_json: '{"email":"private@example.test"}' };
      body.items[0].hash = await hashRow(body.items[0].prev_hash, body.items[0]);
      body.items[1]!.prev_hash = body.items[0].hash;
      body.items[1]!.hash = await hashRow(body.items[1]!.prev_hash, body.items[1]!);
      body.snapshot = head(body.items);
    }
    if (change === 'hash') body.items[0] = { ...items[0]!, hash: 'b'.repeat(64) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
    expect(await run(args())).toBe(1);
    const partial = await readFile(output, 'utf8');
    expect(partial).not.toContain('private@example.test');
    expect(partial).not.toContain('"kind":"end"');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private@example.test',
    );
  },
);

it('rejects an invalid artifact before opening a registration target', async () => {
  await writeFile(output, 'invalid-artifact');
  const opened = vi.spyOn(admin, 'openTarget');
  expect(
    await run([
      'audit',
      'cutover',
      '--org-id',
      org,
      '--register',
      output,
      '--sqlite',
      'unused',
      '--generation',
      '0',
      '--actor-type',
      'user',
      '--actor-id',
      actor,
    ]),
  ).toBe(1);
  expect(opened).not.toHaveBeenCalled();
});
it('reports unknown registration outcomes without credentials or database error details', async () => {
  await writeFile(output, await artifact(await rows()));
  vi.spyOn(admin, 'openTarget').mockImplementation(() => {
    throw new D1LostResponseError('unknown', cookie);
  });
  expect(
    await run([
      'audit',
      'cutover',
      '--org-id',
      org,
      '--register',
      output,
      '--sqlite',
      'unused',
      '--generation',
      '0',
      '--actor-type',
      'user',
      '--actor-id',
      actor,
    ]),
  ).toBe(7);
  expect(console.error).toHaveBeenLastCalledWith(
    'audit cutover: outcome_unknown; inspect the ledger before retrying',
  );
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(cookie);
});

it.each([401, 429])(
  'resumes after mid-export refusal %s with fresh authentication and no duplicates',
  async (status) => {
    const items = await rows(2001);
    if (status === 429) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page(items, 1, 2000)));
    for (let i = 0; i < (status === 429 ? 4 : 1); i++)
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
    fetcher.mockResolvedValueOnce(Response.json(page(items, 2001, 2001)));
    vi.stubGlobal('fetch', fetcher);
    const pending = run(args());
    if (status === 429) {
      await until(() => vi.getTimerCount() > 0);
      await vi.advanceTimersByTimeAsync(180000);
    }
    expect(await pending).toBe(1);
    expect(
      (await readFile(output, 'utf8'))
        .split('\n')
        .filter((line) => line.includes('"kind":"event"')),
    ).toHaveLength(2000);
    vi.stubEnv('PB_TEST_AUDIT_COOKIE', 'pb_session=fresh');
    expect(await run(args().map((value) => (value === '--output' ? '--resume' : value)))).toBe(0);
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain('from_seq=2001&to_seq=2001');
    expect(fetcher.mock.calls.at(-1)![1].headers.cookie).toBe('pb_session=fresh');
    expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 2001 });
  },
);
it('maps a thrown fetch TypeError to request_failed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(cookie)));
  expect(await run(args())).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit export: request_failed');
});
it('maps 403 to forbidden', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  expect(await run(args())).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit export: forbidden');
});
it('exports a fully pruned chain as an empty valid artifact', async () => {
  const snapshot = {
    ...head([]),
    boundarySeq: 4,
    headSeq: 3,
    headHash: 'b'.repeat(64),
    boundaryPrevHash: 'b'.repeat(64),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...page([]), snapshot, fromSeq: 4, toSeq: 4 })),
  );
  expect(await run(args())).toBe(0);
  expect(await verifyAuditArtifact(output)).toMatchObject({
    headSeq: 3,
    boundarySeq: 4,
    bodies: 0,
  });
});
it.each([true, false])(
  'retries the same page with bounded Retry-After (header: %s)',
  async (header) => {
    const items = await rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: header ? { 'Retry-After': '999999' } : {} }),
      )
      .mockResolvedValueOnce(Response.json(page(items)));
    vi.stubGlobal('fetch', fetcher);
    const pending = run(args());
    await until(() => vi.getTimerCount() > 0);
    await vi.advanceTimersByTimeAsync(59999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(0);
    expect(String(fetcher.mock.calls[0]![0])).toBe(String(fetcher.mock.calls[1]![0]));
  },
);
it('pauses before request eleven during a long export', async () => {
  // Withheld markers exercise pagination without spending time hashing 20,001 bodies.
  const count = 20001;
  const snapshot = { ...head([]), headSeq: count, headHash: 'a'.repeat(64) };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn(async (url: URL) => {
    const from = Number(url.searchParams.get('from_seq') ?? 1);
    const to = Math.min(count, from + 1999);
    return Response.json({
      schema: 'audit-chain/1',
      snapshot,
      fromSeq: from,
      toSeq: to,
      next_from_seq: to < count ? to + 1 : null,
      dispositions: [],
      items: Array.from({ length: to - from + 1 }, (_, i) => ({
        kind: 'withheld',
        chain_id: chainId,
        epoch: 0,
        org_id: org,
        seq: from + i,
        prev_hash: from + i === 1 ? '0'.repeat(64) : 'a'.repeat(64),
        hash: 'a'.repeat(64),
        marker_id: actor,
        reason_code: 'unreadable',
      })),
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const pending = run(args());
  await until(() => vi.getTimerCount() > 0);
  expect(fetcher).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetcher).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(11);
  expect(await verifyAuditArtifact(output)).toMatchObject({ withheld: count });
}, 30000);
it.each(['withheld_present', 'org_mismatch'])(
  'refuses %s before opening a database',
  async (code) => {
    const items = await rows();
    if (code === 'withheld_present') {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            ...page(items),
            items: [{ ...items[0], kind: 'withheld', marker_id: actor, reason_code: 'unreadable' }],
          }),
        ),
      );
      expect(await run(args())).toBe(0);
    } else await writeFile(output, await artifact(items));
    const opened = vi.spyOn(admin, 'openTarget');
    expect(
      await run([
        'audit',
        'cutover',
        '--register',
        output,
        '--org-id',
        code === 'org_mismatch' ? actor : org,
        '--sqlite',
        'unused',
        '--generation',
        '0',
        '--actor-type',
        'user',
        '--actor-id',
        actor,
      ]),
    ).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenLastCalledWith(`audit cutover: ${code}`);
  },
);

const EXPORT_USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const EXPORT_PROVIDERS = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const exportFence = () =>
  mutationFence({ userId: EXPORT_USER, sessionId: 'export-session' } as AuthenticatedActor, {});
async function seedExportAdmin(executor: ScalarSqlExecutor, org: OrgContext) {
  const now = new Date().toISOString();
  await executor.batch([
    {
      sql: "INSERT INTO user_account (id, org_id, email) VALUES (?, ?, 'exporter@example.test')",
      params: [EXPORT_USER, org.orgId],
    },
    {
      sql: "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.test')",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('export-identity', ?, ?, 'oidc', 'subject', 'exporter@example.test', 1, ?)",
      params: [org.orgId, EXPORT_USER, now],
    },
    {
      sql: "INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, reauth_at) VALUES ('export-session', ?, ?, 'export-identity', ?, ?, ?, ?, ?)",
      params: [
        org.orgId,
        EXPORT_USER,
        'a'.repeat(64),
        'b'.repeat(64),
        now,
        new Date(Date.now() + 3600000).toISOString(),
        now,
      ],
    },
    {
      sql: "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('export-role', ?, 'export-admin', 'Admin', 'organization', 1)",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'export-role', 'org:audit:export')",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('export-grant', ?, 'email', 'exporter@example.test', 'organization', 'export-role')",
      params: [org.orgId],
    },
  ]);
}

async function until(condition: () => boolean) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > 20000) throw new Error('Wait timed out');
    await realDelay(5);
  }
}
it('deduplicates dispositions by id across pages and resume', async () => {
  const items = await rows(2001);
  const entry = {
    id: ulid(),
    kind: 'withheld',
    reasonCode: 'content_unavailable',
    chainId,
    epoch: 0,
    fromSeq: 1,
    toSeq: 2001,
    count: 2001,
    sinkId: null,
    policy: 'availability',
    modeGeneration: 0,
    actorType: 'system',
    actorId: null,
    createdAt: now,
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...page(items, 1, 2000), dispositions: [entry] }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ...page(items, 2001, 2001), dispositions: [entry] })),
  );
  expect(await run(args())).toBe(1);
  expect(await run(args().map((value) => (value === '--output' ? '--resume' : value)))).toBe(0);
  expect(
    (await readFile(output, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"kind":"disposition"')),
  ).toHaveLength(1);
  expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 2001 });
});
it('validates the resume header before requesting or modifying anything', async () => {
  const items = await rows(2001);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(page(items, 1, 2000)))
      .mockResolvedValueOnce(new Response(null, { status: 401 })),
  );
  expect(await run(args())).toBe(1);
  const content = await readFile(output, 'utf8');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(
    await run(
      args().map((value) =>
        value === '--output'
          ? '--resume'
          : value === 'https://broker.test'
            ? 'https://other.test'
            : value,
      ),
    ),
  ).toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readFile(output, 'utf8')).toBe(content);
});
it('recognizes the API reauth_required envelope on status 403 and resumes', async () => {
  const items = await rows(2001);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(page(items, 1, 2000)))
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'reauth_required', message: cookie } }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json(page(items, 2001, 2001))),
  );
  expect(await run(args())).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit export: reauth_required');
  vi.stubEnv('PB_TEST_AUDIT_COOKIE', 'pb_session=fresh');
  expect(await run(args().map((value) => (value === '--output' ? '--resume' : value)))).toBe(0);
  expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 2001 });
});

it('resumes a pinned empty-chain header without explicit zero sequence parameters', async () => {
  await writeFile(
    output,
    JSON.stringify({
      kind: 'audit-export',
      version: 1,
      schema: 'audit-chain/1',
      snapshot: head([]),
      broker: 'https://broker.test',
    }) + '\n',
  );
  const fetcher = vi.fn<(url: URL) => Promise<Response>>(async () => Response.json(page([])));
  vi.stubGlobal('fetch', fetcher);
  expect(await run(args().map((value) => (value === '--output' ? '--resume' : value)))).toBe(0);
  expect(String(fetcher.mock.calls[0]![0])).toBe('https://broker.test/_pb/audit/export');
  expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 0, headSeq: 0 });
});

it('bounds retries without Retry-After before reporting rate_limited', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const pending = run(args());
  await until(() => vi.getTimerCount() > 0);
  await vi.advanceTimersByTimeAsync(180000);
  expect(await pending).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(console.error).toHaveBeenLastCalledWith('audit export: rate_limited');
});

it('truncates unfinished resume records at the checkpoint byte offset', async () => {
  const items = await rows();
  items[0]!.payload_json = items[0]!.payload_json.replace('Registry', 'Żółć');
  items[0]!.hash = await hashRow(items[0]!.prev_hash, items[0]!);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(page(items))),
  );
  expect(await run(args())).toBe(0);
  const complete = await readFile(output, 'utf8');
  const partial = complete.slice(0, complete.lastIndexOf('{"kind":"end"'));
  await writeFile(output, partial + '{"kind":"event","unfinished":"Ż');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await run(args().map((value) => (value === '--output' ? '--resume' : value)))).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await verifyAuditArtifact(output)).toMatchObject({ bodies: 1 });
  expect(await readFile(output, 'utf8')).toBe(complete);
});

it('checks the opened organization when cutover omits --org-id', async () => {
  await writeFile(output, await artifact(await rows()));
  const file = join(dir, 'other.sqlite');
  const database = await openMigratedDatabase({ file });
  try {
    await createOrganizationBootstrap(database.executor).bootstrap({
      id: actor,
      slug: 'other',
      name: 'Other',
      now,
    });
  } finally {
    await database.close();
  }
  expect(
    await run([
      'audit',
      'cutover',
      '--register',
      output,
      '--sqlite',
      file,
      '--generation',
      '0',
      '--actor-type',
      'user',
      '--actor-id',
      actor,
    ]),
  ).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith('audit cutover: org_mismatch');
});
