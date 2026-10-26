import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = [
  {
    find: /^@package-broker\/([a-z0-9-]+)\/(?!package\.json$)(.+)$/,
    replacement: fileURLToPath(new URL('./packages/$1/src/$2.ts', import.meta.url)),
  },
  {
    find: /^@package-broker\/([a-z0-9-]+)$/,
    replacement: fileURLToPath(new URL('./packages/$1/src/index.ts', import.meta.url)),
  },
];

const packages = [
  'e2e',
  'core',
  'db-sqlite',
  'runtime-cloudflare',
  'runtime-node',
  'cli',
  'ui',
  'ui-assets',
  'plugin-sso-oidc',
  'plugin-github',
];

const loadTolerantProjects = new Set([
  'core',
  'db-sqlite',
  'runtime-cloudflare',
  'runtime-node',
  'cli',
  'plugin-sso-oidc',
  'plugin-github',
]);

const budgetGuardedProjects = new Set(['db-sqlite', 'runtime-cloudflare', 'runtime-node', 'cli']);

export default defineConfig({
  test: {
    reporters: [
      'default',
      fileURLToPath(
        new URL('./packages/db-sqlite/src/testing/statement-budget-trip-sites.ts', import.meta.url),
      ),
    ],
    projects: packages.map((name) => ({
      resolve: { alias },
      test: {
        name,
        root: fileURLToPath(new URL(`./packages/${name}`, import.meta.url)),
        include: ['src/**/*.test.ts', ...(name === 'ui' ? ['test-support/**/*.test.ts'] : [])],
        ...(name === 'ui'
          ? {
              globalSetup: [
                fileURLToPath(
                  new URL('./packages/ui/test-support/global-setup.ts', import.meta.url),
                ),
              ],
            }
          : {}),
        ...(budgetGuardedProjects.has(name)
          ? {
              setupFiles: [
                fileURLToPath(
                  new URL(
                    './packages/db-sqlite/src/testing/statement-budget-setup.ts',
                    import.meta.url,
                  ),
                ),
              ],
            }
          : {}),
        ...(loadTolerantProjects.has(name) ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
        ...(name === 'e2e'
          ? {
              globalSetup: [
                fileURLToPath(new URL('./packages/e2e/src/global-setup.ts', import.meta.url)),
              ],
            }
          : {}),
      },
    })),
  },
});
