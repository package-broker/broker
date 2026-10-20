import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  backupDeployment,
  candidateIdentity,
  checkInventory,
  createDeployment,
  destroyDeployment,
  installWorkerStreams,
  inventory,
  restoreDeployment,
  RestoreTargetNotEmptyError,
  seedDeployment,
  verifyDeployment,
  type Deployment,
  type SeededDeployment,
} from './rehearsal.test.support.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
describe('restore rehearsal on Cloudflare Miniflare D1/R2', () => {
  let root: string;
  let backup: string;
  let seeded: SeededDeployment;
  let cleanupStreams: () => void;
  const deployments: Deployment[] = [];
  async function target() {
    const deployment = await createDeployment();
    deployments.push(deployment);
    return deployment;
  }
  beforeAll(async () => {
    cleanupStreams = installWorkerStreams();
    root = await mkdtemp(join(tmpdir(), 'pb-cf-restore-'));
    backup = join(root, 'backup');
    const source = await createDeployment();
    try {
      seeded = await seedDeployment(source, KEY);
      await backupDeployment(source, backup);
    } finally {
      await destroyDeployment(source);
    }
    process.stdout.write(`cloudflare development candidate: ${await candidateIdentity()}\n`);
  }, 120000);
  afterAll(async () => {
    for (const deployment of deployments) await destroyDeployment(deployment);
    if (root) await rm(root, { recursive: true, force: true });
    cleanupStreams?.();
  });
  it('1: restored sign-in, scoped original PAT, foreign-organization denial and production dist digest', async () => {
    const deployment = await target();
    const restore = await restoreDeployment(backup, deployment);
    expect(restore.missing).toEqual([]);
    expect(restore.corrupt).toEqual([]);
    const outcome = await verifyDeployment(deployment, seeded);
    expect(outcome.started).toBe(true);
    expect(outcome.checks).toEqual({
      signIn: true,
      tokenAuthenticates: true,
      tokenScopeApplies: true,
      downloadMatches: true,
    });
    expect(outcome.downloadSha256).toBe(seeded.sha256);
    expect([401, 403, 404]).toContain(outcome.foreignStatus);
    expect(outcome.unauthenticatedStatus).toBe(401);
    process.stdout.write(
      `restore rehearsal (cloudflare): restore ${restore.durationMs.toFixed(2)} ms, start ${outcome.startDurationMs.toFixed(2)} ms\n`,
    );
  }, 120000);
  it.each([60_000, 262_000])(
    'backs up and restores %i-byte package descriptions on D1',
    async (size) => {
      const source = await target();
      await restoreDeployment(backup, source);
      const marker = "\0quote's\n漢字😀\0";
      const description = marker + 'x'.repeat(size - Buffer.byteLength(marker));
      const metadata = JSON.stringify({ name: 'restore-fixture', version: '1.0.0', description });
      expect(Buffer.byteLength(metadata)).toBeLessThan(262_144);
      await source.executor.batch([
        {
          sql: 'UPDATE package SET description = ? WHERE org_id = ?',
          params: [description, seeded.orgId],
        },
        {
          sql: 'UPDATE version SET metadata_json = ? WHERE org_id = ?',
          params: [metadata, seeded.orgId],
        },
      ]);
      const directory = join(root, `large-text-${size}`);
      await backupDeployment(source, directory);
      const deployment = await target();
      const outcome = await restoreDeployment(directory, deployment);
      expect(outcome.missing).toEqual([]);
      expect(outcome.corrupt).toEqual([]);
      const descriptions = await deployment.executor.all<{ bytes: string }>({
        sql: 'SELECT hex(description) AS bytes FROM package WHERE org_id = ?',
        params: [seeded.orgId],
      });
      expect(descriptions.length).toBeGreaterThan(0);
      for (const row of descriptions)
        expect(row.bytes).toBe(Buffer.from(description).toString('hex').toUpperCase());
      const versions = await deployment.executor.all<{ bytes: string }>({
        sql: 'SELECT hex(metadata_json) AS bytes FROM version WHERE org_id = ?',
        params: [seeded.orgId],
      });
      expect(versions.length).toBeGreaterThan(0);
      for (const row of versions)
        expect(row.bytes).toBe(Buffer.from(metadata).toString('hex').toUpperCase());
    },
    120000,
  );
  it('2a: wrong well-formed master key fails T707 before any application request is served', async () => {
    const deployment = await target();
    const wrong = formatMasterKey(generateMasterKey(1));
    await restoreDeployment(backup, deployment, { masterKey: wrong });
    const outcome = await verifyDeployment(deployment, seeded);
    expect(outcome.started).toBe(false);
    expect(outcome.download.status).toBe(503);
    expect(Object.values(outcome.checks)).toEqual([false, false, false, false]);
    expect(outcome.logs.join(' ')).toContain('KernelConfigError');
    expect(outcome.logs.join(' ')).toContain(
      'Master key version 1 does not match the stored keyring',
    );
    expect(outcome.logs.join(' ')).not.toContain(wrong.slice(8));
    expect(outcome.logs.join(' ')).not.toContain(KEY.slice(8));
  }, 120000);
  it('4: stripped key backup prevents startup and authentication', async () => {
    const deployment = await target();
    await restoreDeployment(backup, deployment, { skipKeys: true });
    const outcome = await verifyDeployment(deployment, seeded);
    expect(outcome.started).toBe(false);
    expect(outcome.download.status).toBe(503);
    expect(Object.values(outcome.checks)).toEqual([false, false, false, false]);
  }, 120000);
  it('3: omitting the blob restore step breaks the happy-path download oracle', async () => {
    const deployment = await target();
    const result = await restoreDeployment(backup, deployment, { skipBlobs: true });
    expect(result.missing).toEqual([seeded.sha256]);
    const outcome = await verifyDeployment(deployment, seeded);
    expect(outcome.checks.signIn).toBe(true);
    expect(outcome.checks.tokenAuthenticates).toBe(true);
    expect(outcome.checks.downloadMatches).toBe(false);
    expect(outcome.download.status).toBe(404);
  }, 120000);
  it.each(['missing', 'truncated', 'same-length corrupt'] as const)(
    '2b: detects %s R2 bytes and never verifies an incomplete download',
    async (mutation) => {
      const deployment = await target();
      await restoreDeployment(backup, deployment);
      const [entry] = (await inventory(deployment)).filter((entry) => entry.orgId === seeded.orgId);
      if (mutation === 'missing') await deployment.bucket.delete(entry!.storageKey);
      else
        await deployment.bucket.put(
          entry!.storageKey,
          mutation === 'truncated'
            ? seeded.bytes.slice(0, -1)
            : new Uint8Array(seeded.bytes.length).fill(9),
        );
      const checked = await checkInventory(deployment);
      expect(mutation === 'missing' ? checked.missing : checked.corrupt).toEqual([seeded.sha256]);
      const outcome = await verifyDeployment(deployment, seeded);
      expect(outcome.checks.downloadMatches).toBe(false);
      expect(outcome.download.completeBody).toBe(false);
      if (mutation !== 'same-length corrupt') expect(outcome.download.status).not.toBe(200);
    },
    120000,
  );
  it.each(['database', 'secrets', 'objects'] as const)(
    '5: refuses non-empty %s without changing it',
    async (kind) => {
      const deployment = await target();
      if (kind === 'database')
        await deployment.executor.batch([
          { sql: 'CREATE TABLE sentinel (value TEXT)', params: [] },
          { sql: "INSERT INTO sentinel VALUES ('preserve')", params: [] },
        ]);
      if (kind === 'secrets') deployment.secrets.set('sentinel', 'preserve');
      if (kind === 'objects')
        await deployment.bucket.put('sentinel', new TextEncoder().encode('preserve'));
      await expect(restoreDeployment(backup, deployment)).rejects.toBeInstanceOf(
        RestoreTargetNotEmptyError,
      );
      if (kind === 'database')
        expect(
          await deployment.executor.all({ sql: 'SELECT value FROM sentinel', params: [] }),
        ).toEqual([{ value: 'preserve' }]);
      if (kind === 'secrets') expect([...deployment.secrets]).toEqual([['sentinel', 'preserve']]);
      if (kind === 'objects')
        expect(await new Response((await deployment.bucket.get('sentinel'))!.body).text()).toBe(
          'preserve',
        );
      expect((await deployment.bucket.list()).objects.map((object) => object.key)).toEqual(
        kind === 'objects' ? ['sentinel'] : [],
      );
    },
    120000,
  );
  it('refuses a changed export checksum before writing the fresh target', async () => {
    const deployment = await target();
    const original = await readFile(join(backup, 'database.json'));
    try {
      await writeFile(join(backup, 'database.json'), '[]');
      await expect(restoreDeployment(backup, deployment)).rejects.toMatchObject({
        name: 'BackupIntegrityError',
      });
    } finally {
      await writeFile(join(backup, 'database.json'), original);
    }
    expect(
      await deployment.executor.all({
        sql: "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        params: [],
      }),
    ).toEqual([]);
  });
});
