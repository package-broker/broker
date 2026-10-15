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
  'core',
  'db-sqlite',
  'runtime-cloudflare',
  'runtime-node',
  'cli',
  'ui',
  'plugin-sso-oidc',
  'plugin-github',
];

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      resolve: { alias },
      test: {
        name,
        root: fileURLToPath(new URL(`./packages/${name}`, import.meta.url)),
        include: ['src/**/*.test.ts'],
      },
    })),
  },
});
