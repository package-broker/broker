import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import type { IdentityContext } from '@package-broker/core/identity/port';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { fixedClock } from '@package-broker/core/ids';
import { describe, expect, it, vi } from 'vitest';
import ssoOidc from './index.js';

const AUDIENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const access = {
  id: 'corp-access',
  kind: 'cloudflare-access',
  teamDomain: 'acme.cloudflareaccess.com',
  audience: AUDIENCE,
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
  trustEmailVerification: true,
} as const;

const oidc = {
  id: 'corp-oidc',
  kind: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'broker-client',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
} as const;

const ctx: IdentityContext = {
  fetch: () => Promise.resolve(new Response(null)),
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  env: () => undefined,
};

function messageOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as TypeError).message;
  }
  throw new Error('expected a TypeError');
}

describe('plugin-sso-oidc', () => {
  it('declares its plugin definition', () => {
    const plugin = ssoOidc();
    expect(plugin.id).toBe('sso-oidc');
    expect(plugin.apiVersion).toBe(3);
  });

  it('binds nothing without providers', () => {
    for (const plugin of [ssoOidc(), ssoOidc({}), ssoOidc({ providers: [] })]) {
      expect(plugin).toEqual({
        id: 'sso-oidc',
        package: '@package-broker/plugin-sso-oidc',
        apiVersion: 3,
        platforms: ['cloudflare', 'node'],
        capabilities: ['sso'],
      });
      expect('binds' in plugin).toBe(false);
      expect('identityProviders' in plugin).toBe(false);
    }
  });

  it('binds identity and builds both providers with their trust anchors', () => {
    const plugin = ssoOidc({ providers: [access, oidc] });
    expect(plugin.binds).toEqual(['identity']);
    expect(plugin.platforms).toEqual(['cloudflare', 'node']);

    const registration = collectRegistrations([plugin]);
    expect(registration.bindings.get('identity')).toBe('sso-oidc');

    const providers = buildIdentityProviders(registration, [plugin], ctx);
    expect(providers.size).toBe(2);
    expect(providers.get('corp-access')?.trustAnchor).toBe(
      `access:acme.cloudflareaccess.com/${AUDIENCE}`,
    );
    expect(providers.get('corp-oidc')?.trustAnchor).toBe('oidc:https://idp.example.com');
  });

  it('builds a lone cloudflare-access provider', () => {
    const plugin = ssoOidc({ providers: [access] });
    expect(buildIdentityProviders(collectRegistrations([plugin]), [plugin], ctx).size).toBe(1);
  });

  it('lists every configuration problem in one TypeError without secret values', () => {
    const secretish = 'sekrit-value-1234';
    const message = messageOf(() =>
      ssoOidc({
        providers: [
          { ...access, trustEmailVerification: undefined, groups: [secretish] },
          { ...oidc, issuer: `http://idp.example.com/${secretish}` },
        ] as never,
      }),
    );
    expect(message).toContain('trustEmailVerification must be a boolean');
    expect(message).toContain('groups are not supported');
    expect(message).toContain('issuer must be an https URL');
    expect(message).toContain('providers[0]');
    expect(message).toContain('providers[1]');
    expect(message).not.toContain(secretish);
    expect(message).not.toContain('idp.example.com');
  });

  it('rejects an unknown kind and a non-object entry', () => {
    const message = messageOf(() =>
      ssoOidc({ providers: [{ ...oidc, kind: 'saml' }, null, 'text'] as never }),
    );
    expect(message).toContain('providers[0]: kind must be "cloudflare-access" or "oidc"');
    expect(message).toContain('providers[1]: configuration must be an object');
    expect(message).toContain('providers[2]: configuration must be an object');
    expect(message).not.toContain('saml');
  });

  it('rejects a providers value that is not an array', () => {
    expect(messageOf(() => ssoOidc({ providers: 'oidc' as never }))).toContain(
      'providers must be an array',
    );
  });

  it('rejects a reserved provider id', () => {
    expect(messageOf(() => ssoOidc({ providers: [{ ...oidc, id: 'local' }] }))).toBe(
      'invalid sso-oidc configuration: providers[0]: id is reserved',
    );
  });

  it('labels each problem with its own provider index', () => {
    const message = messageOf(() =>
      ssoOidc({
        providers: [
          oidc,
          { ...oidc, id: 'second', issuer: 'https://second.example.com', clientId: '' },
        ],
      }),
    );
    expect(message).toMatch(/providers\[1\]: clientId must be/);
    expect(message).not.toContain('providers[0]');
  });

  it('reports duplicate ids', () => {
    const message = messageOf(() =>
      ssoOidc({ providers: [oidc, { ...oidc, issuer: 'https://other.example.com' }] }),
    );
    expect(message).toBe(
      'invalid sso-oidc configuration: providers[1]: id duplicates providers[0]',
    );
  });

  it('reports duplicate trust anchors by canonical form', () => {
    const message = messageOf(() =>
      ssoOidc({
        providers: [
          oidc,
          { ...oidc, id: 'copy', issuer: 'https://IDP.example.com' },
          access,
          { ...access, id: 'access-copy', teamDomain: 'acme.cloudflareaccess.com' },
        ],
      }),
    );
    expect(message).toContain('providers[1]: trust anchor duplicates providers[0]');
    expect(message).toContain('providers[3]: trust anchor duplicates providers[2]');
  });

  it('rejects more than 64 providers', () => {
    const many = Array.from({ length: 65 }, (_, index) => ({
      ...oidc,
      id: `idp-${index}`,
      issuer: `https://idp-${index}.example.com`,
    }));
    expect(messageOf(() => ssoOidc({ providers: many }))).toBe(
      'invalid sso-oidc configuration: providers must hold at most 64 entries',
    );
    expect(ssoOidc({ providers: many.slice(0, 64) }).binds).toEqual(['identity']);
  });

  it('is not affected by later mutation of the providers array', () => {
    const providers = [access];
    const plugin = ssoOidc({ providers });
    (providers as unknown[]).push({ kind: 'saml' });
    const registration = collectRegistrations([plugin]);
    expect(buildIdentityProviders(registration, [plugin], ctx).size).toBe(1);
  });

  it('is not affected by later mutation of a provider config', () => {
    const mutable = {
      ...oidc,
      policy: { verifiedDomains: ['example.com'], autoJoin: false },
      scopes: ['openid', 'email'],
    };
    const plugin = ssoOidc({ providers: [mutable] });
    (mutable as { issuer: string }).issuer = 'https://evil.example.com';
    (mutable as { id: string }).id = 'evil';
    mutable.policy.verifiedDomains.push('evil.example.com');
    mutable.policy.autoJoin = true;
    mutable.scopes.push('groups');
    const registration = collectRegistrations([plugin]);
    const providers = buildIdentityProviders(registration, [plugin], ctx);
    const built = providers.get('corp-oidc');
    expect(providers.size).toBe(1);
    expect(built?.trustAnchor).toBe('oidc:https://idp.example.com');
    expect(built?.policy.verifiedDomains).toEqual(['example.com']);
    expect(built?.policy.autoJoin).toBe(false);
  });

  it('turns a throwing getter or Proxy entry into a readable-object problem', () => {
    const throwing = Object.defineProperty({ ...oidc }, 'issuer', {
      enumerable: true,
      get() {
        throw new Error('sekrit-getter');
      },
    });
    const proxy = new Proxy(
      { ...oidc },
      {
        ownKeys() {
          throw new Error('sekrit-proxy');
        },
      },
    );
    const message = messageOf(() => ssoOidc({ providers: [throwing, access, proxy] as never }));
    expect(message).toContain('providers[0]: configuration must be a readable object');
    expect(message).toContain('providers[2]: configuration must be a readable object');
    expect(message).not.toContain('providers[1]');
    expect(message).not.toContain('sekrit');
  });

  it('turns a throwing array index into a readable-object problem', () => {
    const list: unknown[] = [oidc];
    Object.defineProperty(list, 1, {
      enumerable: true,
      get() {
        throw new Error('sekrit-index');
      },
    });
    const message = messageOf(() => ssoOidc({ providers: list as never }));
    expect(message).toBe(
      'invalid sso-oidc configuration: providers[1]: configuration must be a readable object',
    );
  });

  it.each([[null], ['text'], [42], [[]]])('rejects non-object options %j', (value) => {
    expect(messageOf(() => ssoOidc(value as never))).toBe(
      'invalid sso-oidc configuration: options must be an object',
    );
  });

  it('rejects options whose providers getter throws', () => {
    const options = {
      get providers(): never {
        throw new Error('sekrit-options');
      },
    };
    const message = messageOf(() => ssoOidc(options));
    expect(message).toBe('invalid sso-oidc configuration: providers must be readable');
  });

  it('returns frozen definitions with fresh arrays on every call', () => {
    for (const options of [undefined, { providers: [oidc] }]) {
      const first = ssoOidc(options);
      const second = ssoOidc(options);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.platforms)).toBe(true);
      expect(Object.isFrozen(first.capabilities)).toBe(true);
      expect(first.platforms).not.toBe(second.platforms);
      expect(first.capabilities).not.toBe(second.capabilities);
      if (first.binds !== undefined) {
        expect(Object.isFrozen(first.binds)).toBe(true);
      }
    }
  });
});

describe('plugin-sso-oidc config snapshot', () => {
  const UNREADABLE = 'providers[0]: configuration must be a readable object';

  function refused(config: unknown): string {
    return messageOf(() => ssoOidc({ providers: [config as never] }));
  }

  it('refuses a scopes list over the cap without copying it', () => {
    const scopes = Array.from({ length: 33 }, (_, index) => `scope${index}`);
    const spy = vi.spyOn(Array, 'from');
    try {
      const message = refused({ ...oidc, scopes });
      expect(message).toContain('providers[0]');
      expect(spy.mock.calls.some(([arg]) => arg === scopes)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a verifiedDomains list over the cap without copying it', () => {
    const verifiedDomains = Array.from({ length: 33 }, (_, index) => `d${index}.example.com`);
    const spy = vi.spyOn(Array, 'from');
    try {
      refused({ ...oidc, policy: { verifiedDomains, autoJoin: false } });
      expect(spy.mock.calls.some(([arg]) => arg === verifiedDomains)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a non-enumerable key', () => {
    const config = { ...oidc };
    Object.defineProperty(config, 'hidden', { value: 'x', enumerable: false });
    expect(refused(config)).toBe(`invalid sso-oidc configuration: ${UNREADABLE}`);
  });

  it('refuses a symbol key', () => {
    const config = { ...oidc, [Symbol('extra')]: 'x' };
    expect(refused(config)).toBe(`invalid sso-oidc configuration: ${UNREADABLE}`);
  });

  it('refuses a getter without invoking it', () => {
    const getter = vi.fn(() => 'x');
    const config = { ...oidc };
    Object.defineProperty(config, 'displayName', { get: getter, enumerable: true });
    expect(refused(config)).toBe(`invalid sso-oidc configuration: ${UNREADABLE}`);
    expect(getter).not.toHaveBeenCalled();
  });

  it('refuses a sparse list', () => {
    const scopes = ['openid', 'email', 'profile'];
    delete scopes[1];
    expect(refused({ ...oidc, scopes })).toBe(`invalid sso-oidc configuration: ${UNREADABLE}`);
  });

  it('refuses a list with an extra own property', () => {
    const scopes = Object.assign(['openid'], { extra: 'x' });
    expect(refused({ ...oidc, scopes })).toBe(`invalid sso-oidc configuration: ${UNREADABLE}`);
  });
});
