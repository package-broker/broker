import { defineConfig } from '@package-broker/core/config';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import base from './observability-base.config.js';

export default defineConfig({
  ...base,
  platformPorts: {
    ...base.platformPorts,
    cloudflare: {
      ...base.platformPorts!.cloudflare!,
      blob: {
        adapter: 'r2',
        binding: 'STORAGE',
        maxBytes: resolveRegistryConfig(base.registry, 'cloudflare', 'https://build.invalid').caps
          .publishTarballBytes,
      },
    },
  },
});
