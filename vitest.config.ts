import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string, file: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

const alias = {
  '@package-broker/core/plugin': src('core', 'plugin.ts'),
  '@package-broker/core/config': src('core', 'config.ts'),
  '@package-broker/core': src('core', 'index.ts'),
};

const packages = [
  'core',
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
