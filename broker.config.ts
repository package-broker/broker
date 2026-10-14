import { defineConfig } from '@package-broker/core/config';
import github from '@package-broker/plugin-github';
import ssoOidc from '@package-broker/plugin-sso-oidc';

export default defineConfig({
  platform: 'cloudflare',
  plugins: [ssoOidc(), github()],
});
