import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyChain, type AuditRow } from '@package-broker/core/audit/chain';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createAuditJournalReader } from '@package-broker/db-sqlite/repositories/audit-query';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { seedAuditList } from './audit-list-fixture.js';

it('seeds a visible project event with a consistent chain, including repeated seeding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-audit-list-'));
  const file = join(directory, 'db.sqlite');
  const database = await openMigratedDatabase({ file });
  try {
    const org = orgContext(ulid());
    await createOrganizationBootstrap(database.executor).bootstrap({
      id: org.orgId,
      slug: 'browser',
      name: 'Browser',
      now: new Date().toISOString(),
    });
    const projectId = ulid();
    const reader = createAuditJournalReader(database.executor, org);
    for (let count = 1; count <= 2; count++) {
      await seedAuditList(file, org.orgId, projectId);
      const page = await reader.list({ projectId, limit: 50 });
      expect(page.items).toHaveLength(count);
      expect(page.items.at(-1)).toMatchObject({
        kind: 'event',
        action: 'project.create',
        projectId,
        targetId: projectId,
      });
      const rows = await database.executor.all<AuditRow>({
        sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
        params: [org.orgId],
      });
      expect(await verifyChain(rows)).toBeNull();
      expect(await reader.head()).toMatchObject({
        headSeq: count,
        headHash: rows.at(-1)!.hash,
        pendingCount: 0,
      });
    }
    expect(await reader.list({ projectId: ulid(), limit: 50 })).toEqual({ items: [], next: null });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
