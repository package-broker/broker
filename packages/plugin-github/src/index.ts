import { definePlugin } from '@package-broker/core/plugin';

export default function github() {
  return definePlugin({
    id: 'github',
    package: '@package-broker/plugin-github',
    apiVersion: 3,
    platforms: ['cloudflare', 'node'],
    capabilities: ['source'],
  });
}
