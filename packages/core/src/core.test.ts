import { describe, expect, it } from 'vitest';
import { defineConfig } from './config.js';
import { errorEnvelope } from './envelope.js';
import { SUPPORTED_PLUGIN_API, definePlugin } from './plugin.js';

describe('core API', () => {
  it('returns plugin and config definitions unchanged', () => {
    const plugin = definePlugin({
      id: 'x',
      package: '@package-broker/plugin-x',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
    });
    expect(defineConfig({ platform: 'node', plugins: [plugin] }).plugins).toEqual([plugin]);
  });

  it('builds the error envelope', () => {
    expect(errorEnvelope('not_found', 'Not found', 'r1')).toEqual({
      error: { code: 'not_found', message: 'Not found', requestId: 'r1' },
    });
  });
});
