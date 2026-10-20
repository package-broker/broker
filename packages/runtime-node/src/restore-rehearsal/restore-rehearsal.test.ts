import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';
import {
  bindSnapshot,
  exportDatabase,
  type SnapshotStatement,
} from './sql-snapshot.test.support.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyringMismatchError } from '@package-broker/core/secrets/keyring-verifier';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  RestoreTargetNotEmptyError,
  backupDeployment,
  deploymentPaths,
  destroyDeployment,
  restoreDeployment,
  seedDeployment,
  startDeployment,
  verifyDeployment,
  type BackupManifest,
  type DeploymentPaths,
  type SeededDeployment,
} from './rehearsal.test.support.js';

const MASTER_KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('restore rehearsal on the Node runtime', () => {
  let workspace: string;
  let backupDirectory: string;
  let seeded: SeededDeployment;
  let manifest: BackupManifest;
  let counter = 0;

  function target(): DeploymentPaths {
    counter += 1;
    return deploymentPaths(join(workspace, `restored-${String(counter)}`));
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'pb-restore-rehearsal-'));
    const source = deploymentPaths(join(workspace, 'source'));
    seeded = await seedDeployment(source, MASTER_KEY);
    backupDirectory = join(workspace, 'backup');
    manifest = await backupDeployment(source, backupDirectory);
    await destroyDeployment(source);
  }, 60_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('backs up the database, the keys and the blob bytes as three separate sets', () => {
    expect(manifest.blobs).toEqual([{ sha256: seeded.sha256, size: seeded.bytes.length }]);
    expect(manifest.keys).toEqual(['master-key']);
    expect(manifest.database).toMatch(/^[0-9a-f]{64}$/);
  });

  it('1: sign-in, personal token use with its scope, and a matching download pass after a restore', async () => {
    const paths = target();
    const restore = await restoreDeployment(backupDirectory, paths);
    expect(restore.missingBlobs).toEqual([]);
    expect(restore.corruptBlobs).toEqual([]);

    const outcome = await verifyDeployment(paths, seeded);

    expect(outcome.started).toBe(true);
    expect(outcome.checks).toEqual({
      signIn: true,
      tokenAuthenticates: true,
      tokenScopeApplies: true,
      downloadMatches: true,
    });
    expect(outcome.downloadSha256).toBe(seeded.sha256);
    expect(restore.durationMs + outcome.startDurationMs).toBeGreaterThan(0);
    process.stdout.write(
      `restore rehearsal (node): restore ${restore.durationMs.toFixed(0)} ms, start ${outcome.startDurationMs.toFixed(0)} ms\n`,
    );
  }, 60_000);

  it('2a: a well-formed wrong PB_MASTER_KEY fails closed at start with the keyring error and no key material', async () => {
    const wrong = formatMasterKey(generateMasterKey(1));
    const paths = target();
    await restoreDeployment(backupDirectory, paths, { masterKey: wrong });

    const failure = await startDeployment(paths, seeded).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KeyringMismatchError);
    expect(String((failure as Error).message)).not.toContain(wrong.slice(8));
    expect(String((failure as Error).message)).not.toContain(MASTER_KEY.slice(8));
    const outcome = await verifyDeployment(paths, seeded);
    expect(outcome.started).toBe(false);
    expect(outcome.startFailure).toBe('KeyringMismatchError');
    expect(outcome.checks).toEqual({
      signIn: false,
      tokenAuthenticates: false,
      tokenScopeApplies: false,
      downloadMatches: false,
    });
  }, 60_000);

  it('2b: restoring without the blob step reports the missing blobs and never serves a partial download as complete', async () => {
    const paths = target();
    const restore = await restoreDeployment(backupDirectory, paths, { skipBlobs: true });

    expect(restore.missingBlobs).toEqual([seeded.sha256]);
    const outcome = await verifyDeployment(paths, seeded);

    expect(outcome.started).toBe(true);
    expect(outcome.checks.signIn).toBe(true);
    expect(outcome.checks.tokenAuthenticates).toBe(true);
    expect(outcome.download.status).toBe(404);
    expect(outcome.download.completeBody).toBe(false);
  }, 60_000);

  it('2c: a truncated blob is reported as corrupt and the download is refused, never a short 200', async () => {
    const paths = target();
    const restore = await restoreDeployment(backupDirectory, paths);
    expect(restore.corruptBlobs).toEqual([]);
    await truncate(paths.blobObject(seeded.orgId, seeded.sha256), seeded.bytes.length - 100);

    const outcome = await verifyDeployment(paths, seeded);

    expect(outcome.checks.downloadMatches).toBe(false);
    expect(outcome.download.status).not.toBe(200);
    expect(outcome.download.completeBody).toBe(false);
    expect(outcome.blobs.corrupt).toEqual([seeded.sha256]);
  }, 60_000);

  it('3: a restore that skips the blob step makes the download check fail', async () => {
    const withBlobs = target();
    await restoreDeployment(backupDirectory, withBlobs);
    const without = target();
    await restoreDeployment(backupDirectory, without, { skipBlobs: true });

    const passing = await verifyDeployment(withBlobs, seeded);
    const failing = await verifyDeployment(without, seeded);

    expect(passing.checks.downloadMatches).toBe(true);
    expect(failing.checks.downloadMatches).toBe(false);
  }, 60_000);

  it('4: a restore without the keys fails to start, so no sign-in or token check can pass', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths, { skipKeys: true });

    const outcome = await verifyDeployment(paths, seeded);

    expect(outcome.started).toBe(false);
    expect(outcome.startFailure).toBe('StartupConfigError');
    expect(Object.values(outcome.checks)).toEqual([false, false, false, false]);
  }, 60_000);

  it('5: a restore into a non-empty target refuses and leaves the target untouched', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths);
    const before = await readFile(paths.database);

    const refusal = await restoreDeployment(backupDirectory, paths).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(RestoreTargetNotEmptyError);
    expect(Buffer.compare(before, await readFile(paths.database))).toBe(0);
  }, 60_000);

  it('5b: a non-empty blob namespace refuses without changing any bytes', async () => {
    const paths = target();
    await mkdir(paths.blobRoot, { recursive: true });
    const sentinel = join(paths.blobRoot, 'stray');
    await writeFile(sentinel, 'x');
    await expect(restoreDeployment(backupDirectory, paths)).rejects.toBeInstanceOf(
      RestoreTargetNotEmptyError,
    );
    expect(await readFile(sentinel, 'utf8')).toBe('x');
  });

  it('5c: a non-empty secret destination refuses without changing the key', async () => {
    const paths = target();
    await mkdir(paths.secrets, { recursive: true });
    const sentinel = join(paths.secrets, 'master-key');
    await writeFile(sentinel, MASTER_KEY);
    await expect(restoreDeployment(backupDirectory, paths)).rejects.toBeInstanceOf(
      RestoreTargetNotEmptyError,
    );
    expect(Buffer.compare(await readFile(sentinel), Buffer.from(MASTER_KEY))).toBe(0);
  });

  it('2d: same-length corrupt bytes fail the original download digest', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths);
    await writeFile(
      paths.blobObject(seeded.orgId, seeded.sha256),
      new Uint8Array(seeded.bytes.length).fill(9),
    );
    const outcome = await verifyDeployment(paths, seeded);
    expect(outcome.blobs.corrupt).toEqual([seeded.sha256]);
    expect(outcome.checks.downloadMatches).toBe(false);
    expect(outcome.download.completeBody).toBe(false);
  }, 60000);

  it('2e: deleted bytes are reported and the production dist refuses the download', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths);
    await rm(paths.blobObject(seeded.orgId, seeded.sha256));
    const outcome = await verifyDeployment(paths, seeded);
    expect(outcome.blobs.missing).toEqual([seeded.sha256]);
    expect(outcome.download.status).toBe(404);
    expect(outcome.download.completeBody).toBe(false);
  }, 60000);

  it('a D1-compatible logical export preserves authentication, catalogue references and bytes', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths);
    const opened = openBetterSqliteExecutor(paths.database);
    let statements: SnapshotStatement[];
    try {
      statements = await exportDatabase(opened.executor);
    } finally {
      await opened.close();
    }
    await rm(paths.database);
    const db = new Database(paths.database);
    try {
      db.pragma('foreign_keys = ON');
      db.exec('BEGIN');
      for (const { sql, params } of bindSnapshot(statements)) db.prepare(sql).run(...params);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const result = await verifyDeployment(paths, seeded);
    expect(result.checks).toEqual({
      signIn: true,
      tokenAuthenticates: true,
      tokenScopeApplies: true,
      downloadMatches: true,
    });
  }, 60000);

  it('denies foreign-organization and unauthenticated downloads despite the shared digest', async () => {
    const paths = target();
    await restoreDeployment(backupDirectory, paths);
    const outcome = await verifyDeployment(paths, seeded);
    expect([401, 403, 404]).toContain(outcome.foreignStatus);
    expect(outcome.unauthenticatedStatus).toBe(401);
  }, 60000);
});
