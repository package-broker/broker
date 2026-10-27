import { describe, expect, it } from 'vitest';
import { collectRegistrations, KernelConfigError } from '../kernel/registry.js';
import { providerFieldProblems, SUPPORTED_PLUGIN_API, type PluginDefinition } from '../plugin.js';
import type { IdentityProvider } from './port.js';
import { buildIdentityProviders } from './providers.js';

const fields = {
  id: 'dex',
  kind: 'oidc',
  displayName: 'Example login',
  trustAnchor: 'oidc:https://dex.example.com',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
};
const displayProblem =
  'displayName must be 1 to 100 characters without control or format characters';

describe('providerFieldProblems', () => {
  it.each([
    ['oidc', fields.trustAnchor],
    ['cloudflare-access', `access:team.cloudflareaccess.com/${'a'.repeat(64)}`],
  ])('accepts valid %s fields', (kind, trustAnchor) => {
    expect(providerFieldProblems({ ...fields, kind, trustAnchor })).toEqual({
      policy: fields.policy,
      problems: [],
      byField: { id: [], kind: [], trustAnchor: [], displayName: [], kindPrefix: [], policy: [] },
    });
  });

  it.each([
    ['id', 'Bad id', 'id is not a valid provider id (type string)'],
    ['id', 'local', 'id "local" is reserved'],
    ['kind', 'bad-kind', 'kind must be "cloudflare-access" or "oidc"'],
    ['trustAnchor', 'bad-anchor', 'trustAnchor is not a valid trust anchor'],
    ['displayName', '', displayProblem],
    ['displayName', 'x'.repeat(101), displayProblem],
    ['displayName', 'hello\u0007world', displayProblem],
    ['displayName', 'hello\u200Eworld', displayProblem],
    ['kind', 'cloudflare-access', 'kind does not match the trustAnchor prefix'],
    [
      'policy',
      { verifiedDomains: [], autoJoin: false },
      'policy: verifiedDomains must list at least one domain',
    ],
    ['policy', null, 'policy: policy must be an object'],
  ])('reports only the failing %s field (%j)', (field, value, problem) => {
    expect(providerFieldProblems({ ...fields, [field]: value }).problems).toEqual([problem]);
  });

  it.each(['verifiedDomains', 'emailAuthoritativeDomains'])(
    'bounds %s before inspecting entries',
    (field) => {
      const domains = new Array<string>(101);
      Object.defineProperty(domains, 0, {
        get: () => {
          throw new Error('must not read');
        },
      });
      expect(
        providerFieldProblems({
          ...fields,
          policy: { ...fields.policy, [field]: domains },
        }).problems,
      ).toEqual([`policy: ${field} must be an array of at most 100 entries`]);
    },
  );

  it('returns a policy snapshot without changing the input', () => {
    const policy = { ...fields.policy, emailAuthoritativeDomains: ['example.com'] };
    const result = providerFieldProblems({ ...fields, policy });
    expect(result.policy).toEqual(policy);
    expect(result.policy).not.toBe(policy);
    expect(result.policy.verifiedDomains).not.toBe(policy.verifiedDomains);
    expect(result.policy.emailAuthoritativeDomains).not.toBe(policy.emailAuthoritativeDomains);
    expect(policy).toEqual({ ...fields.policy, emailAuthoritativeDomains: ['example.com'] });
  });

  it.each([
    null,
    'invalid',
    [],
    { verifiedDomains: [], autoJoin: false },
    { verifiedDomains: ['example.com'], autoJoin: 'invalid' },
    { verifiedDomains: new Array<string>(101), autoJoin: false },
    { verifiedDomains: ['example.com'], emailAuthoritativeDomains: ['other.com'], autoJoin: false },
  ])('returns a safe empty policy for invalid input %j', (policy) => {
    const result = providerFieldProblems({ ...fields, policy });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.policy).toEqual({
      verifiedDomains: [],
      emailAuthoritativeDomains: [],
      autoJoin: false,
    });
    expect(result.byField.policy).toEqual(result.problems);
  });

  it('groups field failures independently of their message text', () => {
    const result = providerFieldProblems({ ...fields, id: 'local', displayName: '' });
    expect(result.byField.id).toEqual(['id "local" is reserved']);
    expect(result.byField.displayName).toEqual([displayProblem]);
    expect(result.byField.kind).toEqual([]);
    expect(result.byField.trustAnchor).toEqual([]);
    expect(result.problems).toEqual(Object.values(result.byField).flat());
  });

  it('keeps field and policy problem ordering', () => {
    expect(
      providerFieldProblems({
        id: 'BAD',
        kind: 'bad',
        trustAnchor: 'bad',
        displayName: '',
        policy: null,
      }).problems,
    ).toEqual([
      'id is not a valid provider id (type string)',
      'kind must be "cloudflare-access" or "oidc"',
      'trustAnchor is not a valid trust anchor',
      displayProblem,
      'policy: policy must be an object',
    ]);
  });

  it.each(['', 'Dex'])('preserves kernel duplicate ordering with displayName %j', (displayName) => {
    const provider = {
      ...fields,
      supportsReauth: true,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: () => Promise.resolve({ ok: false, reason: 'missing_credentials' }),
    } as IdentityProvider;
    const plugin: PluginDefinition = {
      id: 'sso',
      package: '@test/sso',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
      binds: ['identity'],
      identityProviders: () => [
        provider,
        {
          ...provider,
          kind: 'cloudflare-access',
          displayName,
          policy: { verifiedDomains: [], autoJoin: false },
        },
      ],
    };
    let caught: unknown;
    try {
      buildIdentityProviders(collectRegistrations([plugin]), [plugin], {
        fetch: () => Promise.resolve(new Response(null)),
        clock: { now: () => new Date(0) },
        env: () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KernelConfigError);
    expect((caught as KernelConfigError).problems).toEqual(
      [
        'id "dex" duplicates provider[0]',
        'trustAnchor duplicates provider[0]',
        ...(displayName === '' ? [displayProblem] : []),
        'kind does not match the trustAnchor prefix',
        'policy: verifiedDomains must list at least one domain',
      ].map((problem) => `plugin "sso" identity provider[1] ${problem}`),
    );
  });

  it('never echoes display names, anchors or domains; only the reserved id is quoted', () => {
    const displayName = 'PRIVATE-DISPLAY\u0007';
    const trustAnchor = 'PRIVATE-ANCHOR';
    const domain = 'PRIVATE-DOMAIN';
    const { problems } = providerFieldProblems({
      ...fields,
      id: 'local',
      displayName,
      trustAnchor,
      policy: {
        verifiedDomains: [domain, domain],
        emailAuthoritativeDomains: ['PRIVATE-AUTHORITATIVE'],
        autoJoin: false,
      },
    });
    expect(problems.length).toBeGreaterThan(3);
    const text = problems.join('\n');
    for (const value of [displayName, trustAnchor, domain, 'PRIVATE-AUTHORITATIVE']) {
      expect(text).not.toContain(value);
    }
    expect(problems[0]).toBe('id "local" is reserved');
  });
});
