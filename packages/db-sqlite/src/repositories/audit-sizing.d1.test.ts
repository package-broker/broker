import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { seedTwoOrganizations } from '../contract/two-organizations.js';
import { migrate } from '../migrations/runner.js';
import { auditPendingStatement } from './audit-pending.js';
import { createAuditSealRepository } from './audit-seal.js';

interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  all(): Promise<unknown>;
}
interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

type Metrics = { rowsWritten: number; rowsRead: number; statements: number };
const emptyMetrics = (): Metrics => ({ rowsWritten: 0, rowsRead: 0, statements: 0 });

it('measures staging and sealing through Miniflare D1 result metadata', async () => {
  const require = createRequire(
    new URL('../../../runtime-cloudflare/package.json', import.meta.url),
  );
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['AUDIT_SIZING'],
    }),
  );
  try {
    const binding: D1Binding = await mf.getD1Database('AUDIT_SIZING');
    let phase: Metrics | null = null;
    let sizeAfter: number | null = null;
    const observe = (result: unknown) => {
      const { meta } = result as {
        meta?: { rows_written?: number; rows_read?: number; size_after?: number };
      };
      sizeAfter = typeof meta?.size_after === 'number' ? meta.size_after : null;
      if (phase === null) return;
      expect(meta?.rows_written).toBeTypeOf('number');
      expect(meta?.rows_read).toBeTypeOf('number');
      expect(Number.isSafeInteger(meta!.rows_written)).toBe(true);
      expect(Number.isSafeInteger(meta!.rows_read)).toBe(true);
      expect(meta!.rows_written).toBeGreaterThanOrEqual(0);
      expect(meta!.rows_read).toBeGreaterThanOrEqual(0);
      phase.rowsWritten += meta!.rows_written!;
      phase.rowsRead += meta!.rows_read!;
      phase.statements++;
    };
    const native = new WeakMap<D1Statement, D1Statement>();
    const module = '@package-broker/runtime-cloudflare/db/d1-executor';
    const { createD1Executor } = await import(module);
    const executor: SqlExecutor = createD1Executor({
      async batch(statements: readonly D1Statement[]) {
        const results = await binding.batch(statements.map((statement) => native.get(statement)!));
        results.forEach(observe);
        return results;
      },
      prepare(sql: string) {
        const track = (statement: D1Statement): D1Statement => {
          const wrapped: D1Statement = {
            bind: (...params) => track(statement.bind(...params)),
            async all() {
              const result = await statement.all();
              observe(result);
              return result;
            },
          };
          native.set(wrapped, statement);
          return wrapped;
        };
        return track(binding.prepare(sql));
      },
    });
    await migrate(executor, await discoveredMigrations(), { holder: 'audit-sizing' });
    const orgs = await seedTwoOrganizations(executor);
    const event = (n: number) => {
      const result = auditEvent({
        id: `01J${String(n).padStart(23, '0')}`,
        now: '2026-11-05T00:00:00.000Z',
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
        action: 'role.rename',
        target: { type: 'role', id: '01JZZZZZZZZZZZZZZZZZZZZZZY' },
        projectId: null,
        context: {
          opId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
          requestId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
          sourceIp: '203.0.113.7',
          tokenSelector: null,
        },
        changes: { name: { old: 'Developer', new: 'Release manager' } },
      });
      if (!result.ok) throw new Error('Invalid sizing fixture');
      return result.event;
    };
    await executor.batch([auditPendingStatement(orgs.b, event(999))]);
    const readCounts = async () => {
      const [row] = await executor.all<{ pending: number; sealed: number }>({
        sql: 'SELECT (SELECT count(*) FROM audit_pending WHERE org_id = ?) AS pending, (SELECT count(*) FROM audit_event WHERE org_id = ?) AS sealed',
        params: [orgs.a.orgId, orgs.a.orgId],
      });
      return row;
    };
    expect(await readCounts()).toEqual({ pending: 0, sealed: 0 });
    const before = sizeAfter;
    const count = 200;
    const staging = emptyMetrics();
    phase = staging;
    for (let n = 0; n < count; n++) {
      await executor.batch([auditPendingStatement(orgs.a, event(n))]);
    }
    phase = null;
    const pending = sizeAfter;
    expect(await readCounts()).toEqual({ pending: count, sealed: 0 });
    const sealing = emptyMetrics();
    const sealer = createAuditSealRepository(executor);
    for (let batch = 0; batch < 2; batch++) {
      phase = sealing;
      const result = await sealer.seal(orgs.a);
      phase = null;
      expect(result).toMatchObject({ outcome: 'sealed', sealed: 100 });
    }
    const sealed = sizeAfter;
    expect(await readCounts()).toEqual({ pending: 0, sealed: count });
    const [other] = await executor.all<{ n: number }>({
      sql: 'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
      params: [orgs.b.orgId],
    });
    expect(other!.n).toBe(1);
    for (const metrics of [staging, sealing]) {
      expect(metrics.statements).toBeGreaterThan(0);
      expect(metrics.rowsWritten).toBeGreaterThanOrEqual(count);
    }
    expect(sealing.rowsRead).toBeGreaterThan(0);
    const perRecord = (metrics: Metrics) => ({
      rowsWritten: metrics.rowsWritten / count,
      rowsRead: metrics.rowsRead / count,
    });
    console.log(
      JSON.stringify({
        backend: 'Miniflare D1 binding (not remote D1)',
        count,
        staging,
        sealing,
        perPendingRecord: perRecord(staging),
        perSealedRecord: perRecord(sealing),
        sizeAfter: { before, pending, sealed },
        pendingGrowthPerRecord:
          before === null || pending === null ? null : (pending - before) / count,
        sealedGrowthPerRecord:
          before === null || sealed === null ? null : (sealed - before) / count,
      }),
    );
  } finally {
    await mf.dispose();
  }
}, 120_000);
