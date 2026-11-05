import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, until } from './local.js';
import type { LocalBroker, Runtime } from './local.js';
import { requireStatus, securityScenario } from './evidence.js';

export interface AuditRecord extends Record<string, unknown> {
  seq: number;
  org_id: string;
  prev_hash: string;
  hash: string;
}
export interface HeadAnchor {
  orgId: string;
  seq: number;
  hash: string;
}
export interface InvalidPosition {
  seq: number;
  reason: 'seq_gap' | 'prev_hash' | 'hash' | 'anchor';
}

export function auditHash(row: AuditRecord): string {
  const columns = [
    'action',
    'actor_id',
    'actor_type',
    'created_at',
    'id',
    'org_id',
    'payload_json',
    'prev_hash',
    'project_id',
    'seq',
    'target_id',
    'target_type',
    'token_selector',
  ];
  const canonical = Object.fromEntries(
    columns.map((column) => {
      assert(Object.hasOwn(row, column), 'IncompleteAuditRecord');
      return [column, row[column]];
    }),
  );
  return createHash('sha256')
    .update(row.prev_hash + JSON.stringify(canonical))
    .digest('hex');
}

export function anchoredBreak(rows: AuditRecord[], anchor: HeadAnchor): InvalidPosition | null {
  assert(
    Number.isSafeInteger(anchor.seq) && anchor.seq > 0 && /^[a-f0-9]{64}$/.test(anchor.hash),
    'InvalidHeadAnchor',
  );
  let expectedSeq = 1;
  let previous = '0'.repeat(64);
  for (const row of rows) {
    assert(
      Number.isSafeInteger(row.seq) && row.seq > 0 && row.org_id === anchor.orgId,
      'InvalidAuditRecord',
    );
    if (row.seq !== expectedSeq) return { seq: row.seq, reason: 'seq_gap' };
    if (row.prev_hash !== previous) return { seq: row.seq, reason: 'prev_hash' };
    if (auditHash(row) !== row.hash) return { seq: row.seq, reason: 'hash' };
    if (row.seq === anchor.seq && row.hash !== anchor.hash)
      return { seq: row.seq, reason: 'anchor' };
    previous = row.hash;
    expectedSeq++;
  }
  if (expectedSeq <= anchor.seq) return { seq: expectedSeq, reason: 'anchor' };
  return null;
}

export function auditLogs(output: string): Record<string, unknown>[] {
  const records = output.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  // Workerd hands console objects over in inspected JavaScript form, one multi-line block each.
  for (const [block] of output.matchAll(/\{\n(?: {2}\w+: [^\n]*\n)+\}/g)) {
    const value: Record<string, unknown> = {};
    for (const match of block.matchAll(/^ {2}(event|job_id|head_hash|reason): '([^'\n]+)',?$/gm))
      value[match[1]!] = match[2];
    for (const match of block.matchAll(/^ {2}(seq|head_seq): (\d+),?$/gm))
      value[match[1]!] = Number(match[2]);
    records.push(value);
  }
  return records.filter(
    (value) => typeof value['event'] === 'string' && value['event'].startsWith('audit.'),
  );
}

export async function verifierLogs(readLogs: () => string, jobId: string) {
  const logs = () => auditLogs(readLogs()).filter((log) => log['job_id'] === jobId);
  // Health alerts precede the verdict and can arrive in a separate stdout chunk.
  await until(
    async () =>
      logs().some((log) =>
        [
          'audit.verified',
          'audit.chain_broken',
          'audit.verify_partial',
          'audit.verify_continued',
        ].includes(String(log['event'])),
      ),
    'audit-verifier-log',
    10_000,
  ).catch((error: unknown) => {
    throw new Error('MissingRuntimeVerifierEvidence', { cause: error });
  });
  return logs();
}

function dispatcher(broker: LocalBroker, orgId: string, deadline: number) {
  return async (kind: 'seal' | 'verify') => {
    const id = await broker.jobs.enqueue(`core:audit-${kind}:v1`);
    let state = 'missing';
    try {
      await until(
        async () => {
          await broker.tick();
          const [job] = await broker.read<{ state: string }>(
            // eslint-disable-next-line no-restricted-syntax -- Observe completion of the scoped infrastructure dispatch.
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          state = job?.state ?? 'missing';
          assert.notEqual(state, 'dead', 'AuditJobFailed');
          return state === 'succeeded';
        },
        `audit-${kind}`,
        Math.max(1_000, Math.min(90_000, deadline - Date.now() - 5_000)),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('LocalTimeout'))
        throw new Error(`AuditJobTimeout:${kind}:${state}`, { cause: error });
      throw error;
    }
    return id;
  };
}

export async function auditScenario(runtime: Runtime) {
  return securityScenario(
    runtime,
    'audit-tampering',
    async ({ broker, admin, orgId, check, deadline }) => {
      const job = dispatcher(broker, orgId, deadline);
      for (const slug of ['alpha', 'beta', 'audit-control', 'audit-tail'])
        requireStatus(await admin.request('/_pb/projects', { slug, name: slug }), 201);
      await job('seal');
      const head = async () =>
        (await requireStatus(
          await admin.request('/_pb/audit/head', undefined, 'GET'),
          200,
        ).json()) as { seq: number; hash: string; pendingCount: number };
      const before = await head();
      assert(before.seq >= 4 && before.pendingCount === 0, 'IncompleteSealedFixture');
      const directory = await mkdtemp(join(repository, '.pb/e2e-independent-anchor-'));
      try {
        const path = join(directory, 'head.json');
        const saved: HeadAnchor = { orgId, seq: before.seq, hash: before.hash };
        await writeFile(path, JSON.stringify(saved), { flag: 'wx', mode: 0o400 });
        const anchor = JSON.parse(await readFile(path, 'utf8')) as HeadAnchor;
        const rows = () =>
          broker.read<AuditRecord>(
            // eslint-disable-next-line no-restricted-syntax -- External, organization-scoped observation of rows written by the assembled runtime.
            'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
            [orgId],
          );
        const snapshot = await rows();
        assert.equal(snapshot.length, before.seq, 'IncompleteAuditSnapshot');
        assert.equal(anchoredBreak(snapshot, anchor), null, 'InvalidBaseline');
        const stored = await broker.audit.snapshot();
        assert.equal(stored.length, snapshot.length, 'IncompleteAuditSnapshot');
        const restore = async () => {
          await broker.audit.restore(stored);
          assert.equal((await head()).pendingCount, 0, 'PendingAuditRows');
        };
        const verify = async () => {
          const offset = broker.logs().length;
          const jobId = await job('verify');
          // The Node child's stdout can trail the job row reaching its settled state.
          return verifierLogs(() => broker.logs().slice(offset), jobId);
        };
        const baseline = await verify();
        assert(
          baseline.some(
            (log) =>
              log['event'] === 'audit.verified' &&
              log['head_seq'] === anchor.seq &&
              log['head_hash'] === anchor.hash,
          ),
          'RuntimeBaselineNotVerified',
        );
        const mutations: { kind: string; apply(): Promise<void>; expected: InvalidPosition }[] = [
          {
            kind: 'alter',
            apply: () => broker.audit.alter(2, 'action', 'project.delete'),
            expected: { seq: 2, reason: 'hash' },
          },
          {
            kind: 'delete',
            apply: () => broker.audit.delete(2),
            expected: { seq: 3, reason: 'seq_gap' },
          },
          {
            kind: 'reorder',
            apply: () => broker.audit.reorder(2, 3),
            expected: { seq: 2, reason: 'prev_hash' },
          },
        ];
        for (const mutation of mutations) {
          await check(`audit:${mutation.kind}:first-invalid-position`, async () => {
            await restore();
            await mutation.apply();
            assert.deepEqual(anchoredBreak(await rows(), anchor), mutation.expected);
            const logs = await verify();
            assert(
              logs.some(
                (log) =>
                  log['event'] === 'audit.chain_broken' &&
                  log['seq'] === mutation.expected.seq &&
                  log['reason'] === mutation.expected.reason,
              ),
              'RuntimeTamperPositionMismatch',
            );
            assert(
              !logs.some((log) => log['event'] === 'audit.verified'),
              'BrokenChainMarkedVerified',
            );
          });
        }
        const sealRecordsTail = async (from: number) => {
          const offset = broker.logs().length;
          const jobId = await job('seal');
          await until(
            async () =>
              auditLogs(broker.logs().slice(offset)).some(
                (log) =>
                  log['job_id'] === jobId &&
                  log['event'] === 'audit.chain_integrity' &&
                  log['reason'] === 'seq_gap',
              ),
            'audit-seal-integrity-log',
            10_000,
          ).catch((error: unknown) => {
            throw new Error('MissingSealerIntegrityAlert', { cause: error });
          });
          const chain = await broker.read<{ head_seq: number; head_hash: string }>(
            // eslint-disable-next-line no-restricted-syntax -- External, organization-scoped observation of the stored chain head.
            'SELECT head_seq, head_hash FROM audit_chain WHERE org_id = ?',
            [orgId],
          );
          assert.deepEqual(
            chain.map((row) => ({ seq: Number(row.head_seq), hash: row.head_hash })),
            [{ seq: anchor.seq, hash: anchor.hash }],
            'SealerMovedHeadBack',
          );
          const gaps = await broker.read<{ from_seq: number; to_seq: number; count: number }>(
            // eslint-disable-next-line no-restricted-syntax -- External, organization-scoped observation of the visible gap evidence.
            "SELECT from_seq, to_seq, count FROM audit_ledger WHERE org_id = ? AND kind = 'gap' AND reason_code = 'seq_gap' AND superseded_by IS NULL",
            [orgId],
          );
          assert(
            gaps.some(
              (gap) =>
                Number(gap.from_seq) <= from &&
                Number(gap.to_seq) === anchor.seq &&
                Number(gap.count) === Number(gap.to_seq) - Number(gap.from_seq) + 1,
            ),
            'LostTailNotRecorded',
          );
        };
        // The stored head anchors the runtime verifier too: a lost tail is a break after the
        // last retained row, never a verified shorter chain.
        await check('audit:truncate:external-anchor-first-missing-position', async () => {
          await restore();
          await broker.audit.truncateFrom(anchor.seq - 1);
          assert.deepEqual(anchoredBreak(await rows(), anchor), {
            seq: anchor.seq - 1,
            reason: 'anchor',
          });
          const logs = await verify();
          assert(
            logs.some(
              (log) =>
                log['event'] === 'audit.chain_broken' &&
                log['seq'] === anchor.seq - 2 &&
                log['reason'] === 'seq_gap',
            ),
            'TruncatedTailNotReported',
          );
          assert(
            !logs.some((log) => log['event'] === 'audit.verified'),
            'TruncatedChainMarkedVerified',
          );
          await sealRecordsTail(anchor.seq - 1);
          assert.equal(
            JSON.parse(await readFile(path, 'utf8')).hash,
            anchor.hash,
            'ExternalAnchorChanged',
          );
        });
        await check('audit:truncate-all:external-anchor-position-one', async () => {
          await restore();
          await broker.audit.truncateFrom(1);
          assert.deepEqual(anchoredBreak(await rows(), anchor), { seq: 1, reason: 'anchor' });
          const logs = await verify();
          assert(
            logs.some(
              (log) =>
                log['event'] === 'audit.chain_broken' &&
                log['seq'] === 0 &&
                log['reason'] === 'seq_gap',
            ),
            'EmptyJournalNotReported',
          );
          assert(
            !logs.some((log) => log['event'] === 'audit.verified'),
            'EmptyJournalMarkedVerified',
          );
          await sealRecordsTail(1);
        });
        await broker.audit.restore(stored);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
