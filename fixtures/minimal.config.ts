import { defineConfig } from '@package-broker/core/config';

export default defineConfig({
  platform: 'cloudflare',
  audit: { acceptNoDurableAudit: true },
  plugins: [],
});
