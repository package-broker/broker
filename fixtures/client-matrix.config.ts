import { defineConfig } from '@package-broker/core/config';
import base from './observability-base.config.js';

export default defineConfig({
  ...base,
  platformPorts: {
    ...base.platformPorts,
    cloudflare: {
      ...base.platformPorts!.cloudflare!,
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1_048_576 },
    },
  },
});
