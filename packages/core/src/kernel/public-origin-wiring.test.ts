import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from './kernel.js';
import { PublicOriginError } from './public-origin.js';
import { createUiRoutes } from './ui-routes.js';

describe('kernel public origin parsing', () => {
  it.each(['https://broker.test/path', 'https://broker.test/?', 'https://user@broker.test'])(
    'validates %s before selecting security headers',
    async (publicOrigin) => {
      await expect(
        createKernel({
          platform: 'node',
          plugins: [],
          publicOrigin,
          ports: {
            organizations: { get: () => Promise.resolve(null) },
            clock: fixedClock('2026-10-15T00:00:00.000Z'),
            ids: { ulid: () => '01JA0000000000000000000000' },
          },
          resolveOrg: () => Promise.resolve(orgContext('org-1')),
          health: () => Promise.resolve(true),
          log: () => undefined,
        }),
      ).rejects.toBeInstanceOf(PublicOriginError);
      expect(() =>
        createUiRoutes(
          {
            manifest: () => Promise.resolve(null),
            read: () => Promise.resolve(null),
          },
          { publicOrigin },
        ),
      ).toThrow(PublicOriginError);
    },
  );
});
