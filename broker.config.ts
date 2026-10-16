import { defineConfig } from '@package-broker/core/config';
import github from '@package-broker/plugin-github';
import ssoOidc from '@package-broker/plugin-sso-oidc';

export default defineConfig({
  platform: 'cloudflare',
  plugins: [ssoOidc(), github()],
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
