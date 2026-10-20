import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  candidateIdentity,
  backupDeployment,
  deploymentPaths,
  destroyDeployment,
  restoreDeployment,
  seedDeployment,
  verifyDeployment,
} from './rehearsal.test.support.js';
import { ORIGIN, verifyRoutes, type SeededDeployment } from './fixture.test.support.js';
import { exportDatabase } from './sql-snapshot.test.support.js';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';

export async function runNodeRehearsal() {
  const root = await mkdtemp(join(tmpdir(), 'pb-native-restore-'));
  try {
    const source = deploymentPaths(join(root, 'source'));
    const seeded = await seedDeployment(source, formatMasterKey(generateMasterKey(1)));
    const backup = join(root, 'backup');
    const manifest = await backupDeployment(source, backup);
    await destroyDeployment(source);
    const target = deploymentPaths(join(root, 'restored'));
    const restore = await restoreDeployment(backup, target);
    const outcome = await verifyDeployment(target, seeded);
    assert.deepEqual(outcome.checks, {
      signIn: true,
      tokenAuthenticates: true,
      tokenScopeApplies: true,
      downloadMatches: true,
    });
    assert.equal(outcome.downloadSha256, seeded.sha256);
    const wrong = deploymentPaths(join(root, 'wrong'));
    await restoreDeployment(backup, wrong, { masterKey: formatMasterKey(generateMasterKey(1)) });
    const failed = await verifyDeployment(wrong, seeded);
    assert.equal(failed.started, false);
    assert.equal(failed.startFailure, 'KeyringMismatchError');
    const missing = deploymentPaths(join(root, 'missing'));
    await restoreDeployment(backup, missing, { skipBlobs: true });
    assert.equal((await verifyDeployment(missing, seeded)).checks.downloadMatches, false);
    process.stdout.write(
      JSON.stringify({
        candidate: manifest.candidate,
        checks: outcome.checks,
        sha256: seeded.sha256,
        length: seeded.bytes.length,
        restoreMs: restore.durationMs,
        startMs: outcome.startDurationMs,
        wrongKey: failed.startFailure,
        omittedBlobs: 'refused',
      }) + '\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function prepareManualFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pb-rehearsal-manual-'));
  const source = deploymentPaths(join(root, 'source'));
  const masterKey = formatMasterKey(generateMasterKey(1));
  const seeded = await seedDeployment(source, masterKey);
  const backup = join(root, 'backup');
  const manifest = await backupDeployment(source, backup);
  const db = openBetterSqliteExecutor(source.database);
  try {
    await writeFile(
      join(root, 'seed.sql'),
      (await exportDatabase(db.executor))
        .map(({ sql, params }) => {
          let parameterIndex = 0;
          const literal =
            params.length === 0
              ? sql
              : sql.replace(/\?/g, () => {
                  const value = params[parameterIndex++]!;
                  if (value === null) return 'NULL';
                  if (typeof value === 'object') return `X'${value.hex}'`;
                  if (typeof value === 'number') return String(value);
                  return `'${value.replaceAll("'", "''")}'`;
                });
          if (Buffer.byteLength(literal) >= 100_000)
            throw new Error('manual seed fixture exceeds D1 SQL statement limit');
          return literal + ';';
        })
        .join('\n'),
      { mode: 0o600 },
    );
  } finally {
    await db.close();
  }
  await destroyDeployment(source);
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await writeFile(
    join(root, 'private', 'oracle.json'),
    JSON.stringify({
      ...seeded,
      bytes: [...seeded.bytes],
      totp: [...seeded.totp],
      candidate: manifest.candidate,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, 'private', 'secrets.json'),
    JSON.stringify({ PB_MASTER_KEY: masterKey }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, 'private', 'wrong-secrets.json'),
    JSON.stringify({ PB_MASTER_KEY: formatMasterKey(generateMasterKey(1)) }),
    { mode: 0o600 },
  );
  await writeFile(join(root, 'candidate.txt'), manifest.candidate + '\n', { mode: 0o600 });
  process.stdout.write(root + '\n');
}

export async function verifyRemote(root: string, origin: string, mode: string) {
  assert.equal(new URL(origin).origin, origin);
  assert.equal(new URL(origin).protocol, 'https:');
  const raw = JSON.parse(await readFile(join(root, 'private', 'oracle.json'), 'utf8')) as Omit<
    SeededDeployment,
    'bytes' | 'totp'
  > & { bytes: number[]; totp: number[]; candidate: string };
  assert.equal(raw.candidate, await candidateIdentity());
  const seeded: SeededDeployment = {
    ...raw,
    bytes: Uint8Array.from(raw.bytes),
    totp: Uint8Array.from(raw.totp),
  };
  const request = (request: Request) => {
    const headers = new Headers(request.headers);
    if (headers.has('origin')) headers.set('origin', origin);
    return fetch(
      new Request(request.url.replace(ORIGIN, origin), {
        method: request.method,
        headers,
        body: request.body,
        duplex: 'half',
      } as RequestInit),
    );
  };
  if (mode === 'wrong-key' || mode === 'missing-keys') {
    const ready = await request(new Request(`${ORIGIN}/_pb/auth/providers`));
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { error: { code: string } }).error.code, 'misconfigured');
    const dist = await request(
      new Request(`${ORIGIN}${seeded.distPath}`, {
        headers: { authorization: `Bearer ${seeded.token}` },
      }),
    );
    assert.equal(dist.status, 503);
    assert.equal(((await dist.json()) as { error: { code: string } }).error.code, 'misconfigured');
  } else {
    const result = await verifyRoutes(request, seeded);
    assert.equal(result.checks.signIn, true);
    assert.equal(result.checks.tokenAuthenticates, true);
    assert.equal(result.checks.tokenScopeApplies, true);
    assert.equal(result.unauthenticatedStatus, 401);
    assert.equal(result.checks.downloadMatches, mode === 'happy');
    if (mode === 'missing-blobs') assert.equal(result.download.status, 404);
  }
  process.stdout.write(`remote restore verification: ${mode} PASS\n`);
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const command = process.argv[2];
  if (command === 'node') await runNodeRehearsal();
  else if (command === 'prepare') await prepareManualFixture();
  else if (
    command === 'verify' &&
    process.argv[3] &&
    process.argv[4] &&
    ['happy', 'missing-blobs', 'corrupt-blobs', 'wrong-key', 'missing-keys'].includes(
      process.argv[5] ?? '',
    )
  )
    await verifyRemote(process.argv[3], process.argv[4], process.argv[5]!);
  else if (command === 'identity') process.stdout.write((await candidateIdentity()) + '\n');
  else throw new Error('expected node, prepare, identity, or verify DIRECTORY ORIGIN MODE');
}
