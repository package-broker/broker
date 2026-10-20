import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  backupDeployment,
  candidateIdentity,
  createDeployment,
  destroyDeployment,
  installWorkerStreams,
  restoreDeployment,
  seedDeployment,
  verifyDeployment,
  type Deployment,
} from './rehearsal.test.support.js';

const restoreStreams = installWorkerStreams();
const root = await mkdtemp(join(tmpdir(), 'pb-native-cf-restore-'));
const deployments: Deployment[] = [];
async function target() {
  const deployment = await createDeployment();
  deployments.push(deployment);
  return deployment;
}
try {
  const source = await createDeployment();
  let seeded;
  const directory = join(root, 'backup');
  try {
    seeded = await seedDeployment(source, formatMasterKey(generateMasterKey(1)));
    await backupDeployment(source, directory);
  } finally {
    await destroyDeployment(source);
  }
  const restored = await target();
  const restoration = await restoreDeployment(directory, restored);
  const outcome = await verifyDeployment(restored, seeded);
  assert.deepEqual(outcome.checks, {
    signIn: true,
    tokenAuthenticates: true,
    tokenScopeApplies: true,
    downloadMatches: true,
  });
  assert.equal(outcome.downloadSha256, seeded.sha256);
  const wrong = await target();
  await restoreDeployment(directory, wrong, { masterKey: formatMasterKey(generateMasterKey(1)) });
  const refused = await verifyDeployment(wrong, seeded);
  assert.equal(refused.started, false);
  assert.equal(refused.download.status, 503);
  assert.match(refused.logs.join(' '), /Master key version 1 does not match the stored keyring/);
  const missing = await target();
  await restoreDeployment(directory, missing, { skipBlobs: true });
  assert.equal((await verifyDeployment(missing, seeded)).checks.downloadMatches, false);
  process.stdout.write(
    JSON.stringify({
      candidate: await candidateIdentity(),
      checks: outcome.checks,
      sha256: seeded.sha256,
      length: seeded.bytes.length,
      restoreMs: restoration.durationMs,
      startMs: outcome.startDurationMs,
      wrongKey: 'KeyringMismatchError',
      omittedBlobs: 'refused',
    }) + '\n',
  );
} finally {
  for (const deployment of deployments) await destroyDeployment(deployment);
  await rm(root, { recursive: true, force: true });
  restoreStreams();
}
