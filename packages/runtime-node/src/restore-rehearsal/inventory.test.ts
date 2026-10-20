import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  BackupIntegrityError,
  RestoreTargetNotEmptyError,
  backupDeployment,
  checkInventory,
  deploymentPaths,
  destroyDeployment,
  restoreDeployment,
} from './rehearsal.test.support.js';
import { archive, digest } from './fixture.test.support.js';

// This independent fixture leaves committed bytes in WAL while the backup is taken.
describe('listener-free backup inventory and preservation', () => {
  let root: string;
  let backup: string;
  const bytes = archive();
  const sha = digest(bytes);
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pb-restore-inventory-'));
    const source = deploymentPaths(join(root, 'source'));
    await mkdir(source.secrets, { recursive: true });
    await writeFile(join(source.secrets, 'master-key'), 'isolated fixture key');
    const db = new Database(source.database);
    try {
      db.pragma('journal_mode = WAL');
      db.exec(
        'CREATE TABLE blob (org_id TEXT, sha256 TEXT, size_bytes INTEGER, storage_key TEXT, media_type TEXT, deleted_at TEXT); CREATE TABLE committed (value TEXT)',
      );
      db.prepare("INSERT INTO blob VALUES (?, ?, ?, ?, 'application/octet-stream', NULL)").run(
        'org-a',
        sha,
        bytes.length,
        'org-a/' + sha,
      );
      db.exec("INSERT INTO committed VALUES ('in-WAL')");
      const object = source.blobObject('org-a', sha);
      await mkdir(join(object, '..'), { recursive: true });
      await writeFile(object, bytes);
      await writeFile(object + '.media', 'application/octet-stream');
      backup = join(root, 'backup');
      await backupDeployment(source, backup);
    } finally {
      db.close();
    }
    await destroyDeployment(source);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('restores a consistent snapshot including committed WAL data and exact inventory', async () => {
    const target = deploymentPaths(join(root, 'good'));
    const result = await restoreDeployment(backup, target);
    expect(result.missingBlobs).toEqual([]);
    const db = new Database(target.database, { readonly: true });
    try {
      expect(db.prepare('SELECT value FROM committed').get()).toEqual({ value: 'in-WAL' });
    } finally {
      db.close();
    }
    expect(await checkInventory(target)).toEqual({ missing: [], corrupt: [] });
    process.stdout.write(`inventory restore duration: ${result.durationMs.toFixed(2)} ms\n`);
  });
  it.each(['database', 'secrets', 'blobs'] as const)(
    'refuses non-empty %s before changing any target bytes',
    async (kind) => {
      const target = deploymentPaths(join(root, kind));
      const sentinel =
        kind === 'database'
          ? target.database
          : join(kind === 'secrets' ? target.secrets : target.blobRoot, 'sentinel');
      await mkdir(join(sentinel, '..'), { recursive: true });
      await writeFile(sentinel, 'preserve');
      await expect(restoreDeployment(backup, target)).rejects.toBeInstanceOf(
        RestoreTargetNotEmptyError,
      );
      expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    },
  );
  it.each(['-wal', '-shm', '-journal'])(
    'refuses an orphaned SQLite %s sidecar and preserves the whole target',
    async (suffix) => {
      const target = deploymentPaths(join(root, `orphan${suffix}`));
      await mkdir(target.root);
      const sidecar = target.database + suffix;
      const original = Buffer.from('preserve orphaned SQLite state');
      await writeFile(sidecar, original);
      const before = await readdir(target.root);
      await expect(restoreDeployment(backup, target)).rejects.toBeInstanceOf(
        RestoreTargetNotEmptyError,
      );
      expect(await readdir(target.root)).toEqual(before);
      expect(await readFile(sidecar)).toEqual(original);
    },
  );
  it('preserves a valid orphaned WAL capable of replaying stale rows over the backup', async () => {
    const donor = deploymentPaths(join(root, 'wal-donor'));
    await mkdir(donor.root);
    await cp(deploymentPaths(backup).database, donor.database);
    const db = new Database(donor.database);
    let wal: Buffer;
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.exec("UPDATE committed SET value = 'stale WAL rows'");
      wal = await readFile(donor.database + '-wal');
    } finally {
      db.close();
    }
    const target = deploymentPaths(join(root, 'valid-orphan-wal'));
    await mkdir(target.root);
    await writeFile(target.database + '-wal', wal);
    await expect(restoreDeployment(backup, target)).rejects.toBeInstanceOf(
      RestoreTargetNotEmptyError,
    );
    expect(await readdir(target.root)).toEqual(['broker.sqlite-wal']);
    expect(await readFile(target.database + '-wal')).toEqual(wal);
  });
  it.each(['missing', 'truncated', 'same-length corrupt'] as const)(
    'detects %s objects independently of the runtime',
    async (mutation) => {
      const target = deploymentPaths(join(root, mutation));
      await restoreDeployment(backup, target);
      const object = target.blobObject('org-a', sha);
      if (mutation === 'missing') await rm(object);
      else
        await writeFile(
          object,
          mutation === 'truncated' ? bytes.slice(0, -1) : Buffer.alloc(bytes.length, 9),
        );
      expect(await checkInventory(target)).toEqual(
        mutation === 'missing' ? { missing: [sha], corrupt: [] } : { missing: [], corrupt: [sha] },
      );
    },
  );
  it('reports missing filesystem media metadata as an incomplete object', async () => {
    const target = deploymentPaths(join(root, 'missing-media'));
    await restoreDeployment(backup, target);
    await rm(target.blobObject('org-a', sha) + '.media', { force: true });
    expect((await checkInventory(target)).corrupt).toEqual([sha]);
  });
  it('refuses a database checksum mismatch before target creation', async () => {
    const damaged = join(root, 'damaged');
    await cp(backup, damaged, { recursive: true });
    await writeFile(deploymentPaths(damaged).database, 'corrupt');
    await expect(
      restoreDeployment(damaged, deploymentPaths(join(root, 'checksum'))),
    ).rejects.toBeInstanceOf(BackupIntegrityError);
  });
});
