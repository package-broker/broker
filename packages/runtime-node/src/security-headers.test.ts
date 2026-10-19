import { describe, expect, it } from 'vitest';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createNodeServer } from './index.js';

const keyring = createKeyring([
  parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
]);

describe('Node public origin security headers', () => {
  it.each([
    ['https://public.test', 'http://internal.test', 'max-age=31536000; includeSubDomains'],
    ['http://public.test', 'https://internal.test', null],
  ])('uses configured %s', async (publicOrigin, requestOrigin, expected) => {
    const broker = createNodeServer([], {
      auth: { keyring, publicOrigin, env: {} },
      log: () => undefined,
    });
    try {
      const response = await (
        await broker.ready()
      ).fetch(new Request(`${requestOrigin}/health/live`));
      expect(response.headers.get('strict-transport-security')).toBe(expected);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await broker.close();
    }
  });
});
