import { expect, it } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditPendingStatement } from './audit-pending.js';
import { createAuditSealRepository } from './audit-seal.js';

it('measures repository-written journal bytes and allocated SQLite pages', async () => {
  for (const d1PatternLimit of [false, true]) {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit });
    try {
      const org = database.orgs!.a;
      const scalar = async (sql: string, params: readonly string[] = []) => {
        const [row] = await database.executor.all<{ n: number }>({ sql, params });
        return row!.n;
      };
      const allocated = async () =>
        (await scalar('SELECT page_count AS n FROM pragma_page_count')) *
        (await scalar('SELECT page_size AS n FROM pragma_page_size'));
      const before = await allocated();
      const count = 1000;
      for (let n = 0; n < count; n++) {
        const event = auditEvent({
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
        if (!event.ok) throw new Error('Invalid sizing fixture');
        await database.executor.batch([auditPendingStatement(org, event.event)]);
        if ((n + 1) % 100 === 0) {
          const sealed = await createAuditSealRepository(database.executor).seal(org);
          expect(sealed).toMatchObject({ outcome: 'sealed', sealed: 100 });
        }
      }
      const [chain] = await database.executor.all<{ journal_rows: number; journal_bytes: number }>({
        sql: 'SELECT journal_rows, journal_bytes FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      });
      const [stored] = await database.executor.all<{ rows: number; payload_bytes: number }>({
        sql: 'SELECT count(*) AS rows, sum(length(CAST(payload_json AS BLOB))) AS payload_bytes FROM audit_event WHERE org_id = ?',
        params: [org.orgId],
      });
      expect(chain!.journal_rows).toBe(count);
      expect(stored!.rows).toBe(count);
      expect(
        await scalar('SELECT count(*) AS n FROM audit_pending WHERE org_id = ?', [org.orgId]),
      ).toBe(0);
      expect(chain!.journal_bytes).toBeGreaterThan(stored!.payload_bytes);
      const after = await allocated();
      expect(after).toBeGreaterThan(before);
      console.log(
        JSON.stringify({
          backend: d1PatternLimit ? 'SQLite with D1 SQL limits (not remote D1)' : 'SQLite',
          count,
          payloadBytesPerRecord: stored!.payload_bytes / count,
          journalBytes: chain!.journal_bytes,
          journalBytesPerRecord: chain!.journal_bytes / count,
          before,
          after,
          allocatedBytesPerRecord: (after - before) / count,
        }),
      );
    } finally {
      await database.close();
    }
  }
});
