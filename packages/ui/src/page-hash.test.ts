import { describe, expect, it, vi } from 'vitest';
import {
  createReauthFlow,
  reauthReturnHash,
  safePageHash,
  startSso,
  type AuthClient,
} from './auth.js';
import { buildListFilterHash } from './page-hash.js';

describe('list filter hashes', () => {
  const filters = {
    project: 'acme.web',
    status: 'active',
    q: '@scope/pkg & tool',
    after: 'opaque/+=',
  };

  it('round trips every filter through reauth and SSO', async () => {
    const pageHash = buildListFilterHash('packages', filters);
    const navigate = vi.fn();
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { location: 'https://idp.test/auth' },
    });
    const client = { request } as unknown as AuthClient;
    const flow = createReauthFlow({
      client,
      storage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
      now: Date.now,
      navigate,
    });
    flow.requireReauth(
      { method: 'PATCH', path: '/_pb/projects/acme.web', headers: { 'If-Match': '"r7"' } },
      { credential: false, secretFields: [] },
      pageHash,
    );
    const reauthHash = navigate.mock.calls[0]![0] as string;
    expect(reauthReturnHash(reauthHash)).toBe(pageHash);
    await startSso(client, 'corp', 'reauth', vi.fn(), reauthHash);
    const returnTo = request.mock.calls[0]![2].body.returnTo as string;
    expect(returnTo).toContain('&sso=complete');
    expect(reauthReturnHash(returnTo.slice(returnTo.indexOf('#')))).toBe(pageHash);
    const restored = new URLSearchParams(pageHash.split('?')[1]);
    expect(Object.fromEntries(restored)).toEqual(filters);
  });

  it('keeps all filters through the SSO login return', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, data: { location: '/idp' } });
    const hash = buildListFilterHash('packages', filters);
    await startSso({ request } as unknown as AuthClient, 'corp', 'login', vi.fn(), hash);
    expect(request.mock.calls[0]![2].body.returnTo).toBe(`/_pb/ui${hash}`);
  });

  it('drops unknown keys while retaining the page and known filters', () => {
    expect(safePageHash('#/packages?next=https://evil.test&project=acme&q=foo&extra=1')).toBe(
      '#/packages?project=acme&q=foo',
    );
    expect(safePageHash('#/packages?unknown=value')).toBe('#/packages');
  });

  it.each(['project=%3Cbad%3E', 'next=https://evil.test'])(
    'drops an invalid or unknown filter during SSO: %s',
    async (query) => {
      const request = vi.fn().mockResolvedValue({ ok: true, data: { location: '/idp' } });
      await startSso(
        { request } as unknown as AuthClient,
        'corp',
        'login',
        vi.fn(),
        `#/tokens?${query}`,
      );
      expect(request.mock.calls[0]![2].body.returnTo).toBe('/_pb/ui#/tokens');
    },
  );

  it.each([
    ['project', 64],
    ['status', 64],
    ['q', 200],
    ['after', 4096],
  ] as const)('keeps a boundary-length %s and drops an oversized value', (name, limit) => {
    const boundary = buildListFilterHash('packages', { [name]: 'x'.repeat(limit) });
    expect(new URLSearchParams(boundary.split('?')[1]).get(name)).toBe('x'.repeat(limit));
    expect(safePageHash(`#/packages?${name}=${'x'.repeat(limit + 1)}`)).toBe('#/packages');
  });

  it('escapes injection characters without turning them into query keys or markup', () => {
    const value = '<img src=x onerror=alert(1)>&project=evil#/?%+\n';
    const hash = safePageHash(`#/packages?project=acme&q=${encodeURIComponent(value)}`);
    expect(hash).toBe(`#/packages?project=acme&q=${encodeURIComponent(value)}`);
    expect(hash).not.toContain('<');
    expect([...new URLSearchParams(hash.split('?')[1])]).toEqual([
      ['project', 'acme'],
      ['q', value],
    ]);
    expect(safePageHash(hash)).toBe(hash);
  });

  it('drops invalid project slugs and unencodable values', () => {
    expect(safePageHash('#/packages?project=%3Cbad%3E&status=active')).toBe(
      '#/packages?status=active',
    );
    expect(buildListFilterHash('packages', { q: '\ud800' })).toBe('#/packages');
    expect(safePageHash('#/packages?project=acme%0A&status=active')).toBe(
      '#/packages?status=active',
    );
  });
});
