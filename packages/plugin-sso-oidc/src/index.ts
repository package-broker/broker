import { definePlugin } from '@package-broker/core/plugin';

export default function ssoOidc() {
  return definePlugin({
    id: 'sso-oidc',
    package: '@package-broker/plugin-sso-oidc',
    apiVersion: 2,
    platforms: ['cloudflare', 'node'],
    capabilities: ['sso'],
  });
}
