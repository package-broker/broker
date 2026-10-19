import { defineConfig } from '@package-broker/core/config';

export default defineConfig({
  platform: 'cloudflare',
  plugins: [],
  platformPorts: {
    node: {
      blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
      cache: { adapter: 'lru', maxBytes: 1024 },
      jobs: { adapter: 'database', maxRunning: 1 },
      observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
    cloudflare: {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
      cache: { adapter: 'cache-api', namespace: 't749' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 1 },
      observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
  },
});
