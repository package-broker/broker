import { defineConfig } from '@package-broker/core/config';
import { definePlugin } from '@package-broker/core/plugin';
import { resolvedPackageOf } from '@package-broker/core/kernel/package-context';

const packageRoute = definePlugin({
  id: 'package-route',
  package: '@package-broker/core',
  apiVersion: 3,
  platforms: ['cloudflare', 'node'],
  register(registry) {
    registry.route({
      method: 'GET',
      path: '/fixture/pkg/:project/:name',
      permission: 'project:packages:read',
      boundary: 'package',
      package: { ecosystem: 'npm', name: (params) => params['name'] ?? null },
      handler: (ctx) => Response.json(resolvedPackageOf(ctx)),
    });
  },
});

export default defineConfig({
  platform: 'cloudflare',
  plugins: [packageRoute],
  platformPorts: {
    cloudflare: {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
      cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
      observability: {
        adapter: 'workers',
        analyticsBinding: 'ANALYTICS',
        deploymentIdEnv: 'DEPLOYMENT_ID',
      },
    },
    node: {
      blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
      cache: { adapter: 'lru', maxBytes: 33554432 },
      jobs: { adapter: 'database', maxRunning: 2 },
      observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
  },
});
