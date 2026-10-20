import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  backupDeployment,
  deploymentPaths,
  destroyDeployment,
  restoreDeployment,
  seedDeployment,
  startDeployment,
} from './rehearsal.test.support.js';
import { ORIGIN, verifyRoutes } from './fixture.test.support.js';

it('host HTTP: verifies the restored Node server through its shipped request listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-restore-http-'));
  try {
    const source = deploymentPaths(join(root, 'source'));
    const seeded = await seedDeployment(source, formatMasterKey(generateMasterKey(1)));
    const backup = join(root, 'backup');
    await backupDeployment(source, backup);
    await destroyDeployment(source);
    const restored = deploymentPaths(join(root, 'restored'));
    await restoreDeployment(backup, restored);
    const broker = await startDeployment(restored, seeded);
    try {
      broker.server.listen(0, '127.0.0.1');
      await once(broker.server, 'listening');
      const port = (broker.server.address() as AddressInfo).port;
      const outcome = await verifyRoutes(
        (request) =>
          fetch(
            new Request(request.url.replace(ORIGIN, `http://127.0.0.1:${String(port)}`), request),
          ),
        seeded,
      );
      expect(outcome.checks).toEqual({
        signIn: true,
        tokenAuthenticates: true,
        tokenScopeApplies: true,
        downloadMatches: true,
      });
      expect(outcome.downloadSha256).toBe(seeded.sha256);
    } finally {
      await broker.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
