import { describe, expect, it } from 'vitest';
import ssoOidc from './index.js';

describe('plugin-sso-oidc', () => {
  it('declares its plugin definition', () => {
    const plugin = ssoOidc();
    expect(plugin.id).toBe('sso-oidc');
    expect(plugin.apiVersion).toBe(2);
  });
});
