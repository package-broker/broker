import { describe, expect, it } from 'vitest';
import type { OrgContext } from '../db/port.js';
import type { DomainPolicy, IdentityProvider } from './port.js';
import { createProviderAnchorReader, providerAnchorsOf } from './provider-anchors.js';
import type { ProviderMap } from './providers.js';

const CTX = { orgId: '01J0ORG0000000000000000001' } as OrgContext;

function provider(id: string, policy: DomainPolicy): IdentityProvider {
  return {
    id,
    kind: 'oidc',
    displayName: id,
    trustAnchor: `oidc:https://${id}.example.test`,
    policy,
    supportsReauth: false,
    start: () => Promise.resolve({ kind: 'direct' }),
    finish: () => Promise.resolve({ ok: false, reason: 'provider_error' }),
  };
}

function mapOf(...providers: IdentityProvider[]): ProviderMap {
  const entries = new Map(providers.map((entry) => [entry.id, entry]));
  return {
    get: (id) => entries.get(id),
    has: (id) => entries.has(id),
    keys: () => entries.keys(),
    values: () => entries.values(),
    size: entries.size,
  };
}

describe('providerAnchorsOf', () => {
  it('gives each configured provider its id, trust anchor and e-mail authoritative domains', () => {
    const anchors = providerAnchorsOf(
      mapOf(
        provider('corp', {
          verifiedDomains: ['example.test', 'other.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: false,
        }),
      ),
    );

    expect(anchors).toEqual([
      {
        provider: 'corp',
        anchor: 'oidc:https://corp.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ]);
  });

  it('marks a provider without emailAuthoritativeDomains as not e-mail authoritative', () => {
    const anchors = providerAnchorsOf(
      mapOf(
        provider('absent', { verifiedDomains: ['example.test'], autoJoin: true }),
        provider('empty', {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: [],
          autoJoin: true,
        }),
      ),
    );

    expect(
      anchors.map((entry) => [entry.emailAuthoritative, entry.emailAuthoritativeDomains]),
    ).toEqual([
      [false, []],
      [false, []],
    ]);
  });

  it('refuses a domain that is not already lowercase ASCII instead of folding it', () => {
    for (const domain of ['Example.TEST', 'exämple.test', 'example.test.', '']) {
      expect(() =>
        providerAnchorsOf(
          mapOf(
            provider('corp', {
              verifiedDomains: ['example.test'],
              emailAuthoritativeDomains: [domain],
              autoJoin: false,
            }),
          ),
        ),
      ).toThrow(TypeError);
    }
  });

  it('gives no anchors when no provider is configured', () => {
    expect(providerAnchorsOf(mapOf())).toEqual([]);
  });
});

describe('createProviderAnchorReader', () => {
  it('answers every organization context with the same frozen entries', async () => {
    const reader = createProviderAnchorReader(
      mapOf(
        provider('corp', {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: false,
        }),
      ),
    );

    const first = await reader.anchors(CTX);
    const second = await reader.anchors(CTX);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.emailAuthoritativeDomains)).toBe(true);
  });
});
