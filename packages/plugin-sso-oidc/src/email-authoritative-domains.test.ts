import {
  completeIdentityLogin,
  type IdentityLoginDeps,
} from '@package-broker/core/auth/identity-login';
import type { SessionService } from '@package-broker/core/auth/session';
import { orgContext } from '@package-broker/core/db/port';
import type { UserRepository, LoginWriter } from '@package-broker/core/db/users';
import { fixedClock } from '@package-broker/core/ids';
import type { DomainPolicy, IdentityContext } from '@package-broker/core/identity/port';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { describe, expect, it, vi } from 'vitest';
import { cloudflareAccessProblems, createCloudflareAccessProvider } from './cloudflare-access.js';
import ssoOidc from './index.js';
import { createOidcProvider, oidcProblems } from './oidc.js';

const NOW = '2026-10-24T12:00:00.000Z';
const ctx: IdentityContext = {
  clock: fixedClock(NOW),
  fetch: () => Promise.reject(new Error('unexpected fetch')),
  env: () => undefined,
};

const configs = [
  { id: 'oidc', kind: 'oidc', issuer: 'https://idp.example.test', clientId: 'broker' },
  {
    id: 'access',
    kind: 'cloudflare-access',
    teamDomain: 'team.cloudflareaccess.com',
    audience: 'ab12'.repeat(16),
    trustEmailVerification: true,
  },
] as const;

for (const config of configs) {
  const configured = (policy: DomainPolicy) => ({ ...config, policy });
  const direct = (policy: DomainPolicy) => {
    const source = configured(policy);
    return source.kind === 'oidc'
      ? createOidcProvider(source, ctx)
      : createCloudflareAccessProvider(source, ctx);
  };
  const built = (policy: DomainPolicy) => {
    const plugin = ssoOidc({ providers: [configured(policy)] });
    return () =>
      buildIdentityProviders(collectRegistrations([plugin]), [plugin], ctx).get(config.id)!;
  };
  const problems = (policy: DomainPolicy) => {
    const source = configured(policy);
    return source.kind === 'oidc' ? oidcProblems(source) : cloudflareAccessProblems(source);
  };

  describe(`${config.kind} email authority`, () => {
    it('exposes a frozen authoritative list and isolates the caller array', () => {
      const domains = ['acme.example'];
      const policy = {
        verifiedDomains: ['acme.example'],
        emailAuthoritativeDomains: domains,
        autoJoin: false,
      };
      expect(problems(policy)).toEqual([]);
      const provider = direct(policy);
      expect(provider.policy.emailAuthoritativeDomains).toEqual(['acme.example']);
      expect(Object.isFrozen(provider.policy)).toBe(true);
      expect(Object.isFrozen(provider.policy.emailAuthoritativeDomains)).toBe(true);
      domains[0] = 'other.example';
      expect(provider.policy.emailAuthoritativeDomains).toEqual(['acme.example']);
    });

    it('captures the array before the plugin builds its providers', () => {
      const domains = ['acme.example'];
      const build = built({
        verifiedDomains: ['acme.example'],
        emailAuthoritativeDomains: domains,
        autoJoin: false,
      });
      domains.length = 0;
      expect(build().policy.emailAuthoritativeDomains).toEqual(['acme.example']);
    });

    it('defaults absent authority to a frozen empty list', () => {
      const provider = direct({ verifiedDomains: ['acme.example'], autoJoin: false });
      expect(provider.policy.emailAuthoritativeDomains).toEqual([]);
      expect(Object.isFrozen(provider.policy.emailAuthoritativeDomains)).toBe(true);
    });

    it('rejects authority outside verifiedDomains using core validation', () => {
      const policy = {
        verifiedDomains: ['acme.example'],
        emailAuthoritativeDomains: ['other.example'],
        autoJoin: false,
      };
      expect(problems(policy)).toEqual([
        'policy: emailAuthoritativeDomains[0] must appear in verifiedDomains',
      ]);
      expect(() => direct(policy)).toThrow(RangeError);
      expect(() => built(policy)).toThrow(TypeError);
    });

    it.each([
      ['not an array', 'acme.example'],
      ['not a string', [42]],
      ['uppercase domain', ['ACME.example']],
      ['duplicate domain', ['acme.example', 'acme.example']],
      ['over the list cap', Array.from({ length: 33 }, () => 'acme.example')],
    ])('rejects authority that is %s', (_name, domains) => {
      const policy = {
        verifiedDomains: ['acme.example'],
        emailAuthoritativeDomains: domains,
        autoJoin: false,
      } as DomainPolicy;
      expect(problems(policy).join(' ')).toContain('emailAuthoritativeDomains');
      expect(() => direct(policy)).toThrow(RangeError);
    });

    it.each([
      ['inside the authority set', ['acme.example'], true],
      ['outside the authority set', ['other.example'], false],
      ['empty authority set', [], false],
      ['absent authority set', undefined, false],
    ] as const)('handles linking an existing local account %s', async (_name, domains, allowed) => {
      const provider = built({
        verifiedDomains: ['acme.example', 'other.example'],
        ...(domains === undefined ? {} : { emailAuthoritativeDomains: domains }),
        autoJoin: true,
      })();
      const lookupForLogin = vi.fn<UserRepository['lookupForLogin']>().mockResolvedValue({
        boundAnchor: null,
        identity: null,
        identityUser: null,
        invited: true,
        userByEmail: { id: 'existing-user', status: 'active', linkedAtProvider: false },
      });
      const commit = vi.fn<LoginWriter['commit']>().mockResolvedValue('created');
      const setCookies = vi.fn(() => ['session-cookie']);
      let sequence = 0;
      const deps: IdentityLoginDeps = {
        users: { lookupForLogin } as unknown as UserRepository,
        writer: { commit },
        sessions: { setCookies } as unknown as SessionService,
        hooks: { 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
        clock: ctx.clock,
        ids: { ulid: () => `01HZ${String(++sequence).padStart(22, '0')}` },
      };
      const org = orgContext('test-org');
      const outcome = await completeIdentityLogin(
        deps,
        org,
        provider,
        {
          provider: provider.id,
          subject: 'subject-1',
          email: 'user@acme.example',
          emailVerified: true,
          displayName: null,
          groups: [],
          issuedAt: NOW,
          authTime: null,
        },
        {
          requestId: '00000000-0000-4000-8000-000000000001',
          ip: null,
          userAgent: null,
          previousSecretHash: null,
        },
      );
      expect(lookupForLogin).toHaveBeenCalledWith(
        org,
        expect.objectContaining({ provider: provider.id }),
      );
      if (allowed) {
        expect(outcome).toMatchObject({ ok: true, userId: 'existing-user' });
        expect(commit).toHaveBeenCalledWith(
          org,
          expect.objectContaining({
            userId: 'existing-user',
            createUser: false,
            provider: provider.id,
          }),
        );
        expect(setCookies).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toEqual({ ok: false, reason: 'link_requires_admin' });
        expect(commit).not.toHaveBeenCalled();
        expect(setCookies).not.toHaveBeenCalled();
      }
    });
  });
}
