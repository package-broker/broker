import { describe, expect, it, vi } from 'vitest';
import { base32Encode, verifyTotp } from '@package-broker/core/auth/totp';
import { systemClock } from '@package-broker/core/ids';
import { archive, digest, setupFixtureIdentity, verifyRoutes } from './fixture.test.support.js';

describe('fixture TOTP window', () => {
  it('survives a one-millisecond setup boundary with distinct setup, reauth and login steps', async () => {
    const boundary = 1_800_000_000_000;
    const secret = new Uint8Array(20).fill(7);
    const used: number[] = [];
    const codes: string[] = [];
    const wall = vi.spyOn(Date, 'now').mockReturnValue(boundary - 1);
    const handlerClock = vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(boundary));
    const originalClock = systemClock.now;
    const bytes = archive();
    const request = async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/setup/start')) return Response.json({ secret: base32Encode(secret) });
      if (request.method === 'POST') {
        const { code } = (await request.json()) as { code: string };
        const checked = await verifyTotp(secret, code, systemClock.now().getTime(), used.at(-1));
        if (!checked.ok) return new Response(null, { status: 401 });
        used.push(checked.step);
        codes.push(code);
        return new Response(null, {
          status: 204,
          headers: path.endsWith('/setup/finish')
            ? {
                'set-cookie': '__Host-pb_csrf=fixture; Secure; Path=/',
              }
            : {},
        });
      }
      if (path === '/alpha/packages.json') return Response.json({});
      if (path === '/dist' && request.headers.has('authorization')) return new Response(bytes);
      return new Response(null, { status: 401 });
    };
    try {
      await expect(setupFixtureIdentity(request, 'fixture-setup')).resolves.toMatchObject({
        totp: secret,
      });
      expect(systemClock.now).toBe(originalClock);
      const result = await verifyRoutes(request, {
        orgId: 'org-a',
        foreignOrgId: 'org-b',
        bytes,
        sha256: digest(bytes),
        distPath: '/dist',
        foreignDistPath: '/foreign/dist',
        token: 'fixture-token',
        totp: secret,
      });
      expect(result.checks.signIn).toBe(true);
      const step = Math.floor((boundary - 1) / 30000);
      expect(used).toEqual([step - 1, step, step + 1]);
      expect(new Set(codes).size).toBe(3);
    } finally {
      wall.mockRestore();
      handlerClock.mockRestore();
    }
  });
  it('restores the handler clock after a refused setup request', async () => {
    const original = systemClock.now;
    await expect(
      setupFixtureIdentity(async () => new Response(null, { status: 401 }), 'fixture'),
    ).rejects.toThrow('fixture setup start refused');
    expect(systemClock.now).toBe(original);
  });
});
