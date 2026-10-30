import { describe, expect, it, vi } from 'vitest';
import { isNpmClaim, probeNpmClaim } from './claim-admission.js';

describe('npm claim grammar', () => {
  it.each(['widget', '@scope/widget', '@scope/*', 'a'.repeat(214)])('accepts %s', (name) => {
    expect(isNpmClaim(name)).toBe(true);
  });
  it.each([
    '*',
    'widget*',
    '@*/widget',
    '@scope/pre*',
    'Widget',
    '_widget',
    'node_modules',
    'a'.repeat(215),
  ])('refuses %s', (name) => {
    expect(isNpmClaim(name)).toBe(false);
  });
});

describe('npm claim upstream probe', () => {
  it.each([
    [200, 'name_public'],
    [404, null],
    [401, 'name_public_unverified'],
    [429, 'name_public_unverified'],
    [500, 'name_public_unverified'],
    [204, 'name_public_unverified'],
  ] as const)('classifies HTTP %s', async (status, expected) => {
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ status, headers: new Headers(), body: { cancel } });
    expect(await probeNpmClaim(fetch, '@scope/widget')).toBe(expected);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: 'https://registry.npmjs.org/@scope%2Fwidget',
        method: 'HEAD',
        maxBytes: 1024,
        timeoutMs: 5000,
        redirects: 'error',
        destinations: ['https://registry.npmjs.org'],
      }),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('fails closed without returning upstream errors', async () => {
    expect(
      await probeNpmClaim(
        vi.fn().mockRejectedValue(new Error('sensitive upstream data')),
        'widget',
      ),
    ).toBe('name_public_unverified');
  });
});

it('forwards the claim probe abort signal', async () => {
  const signal = new AbortController().signal;
  const fetch = vi.fn().mockResolvedValue({ status: 404, body: null });
  await probeNpmClaim(fetch, 'widget', signal);
  expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ signal }));
});
