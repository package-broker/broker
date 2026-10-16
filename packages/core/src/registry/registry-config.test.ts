import { describe, expect, it } from 'vitest';
import { defineConfig } from '../config.js';
import { classifyUrl, createOutboundPolicy } from '../sources/url-policy.js';
import {
  REGISTRY_DEFAULTS,
  RegistryConfigError,
  resolveRegistryConfig,
  validateRegistryConfig,
} from './registry-config.js';

const PUBLIC_URL = 'https://broker.example.com';

describe('validateRegistryConfig', () => {
  it('accepts a missing config on both targets', () => {
    expect(validateRegistryConfig(undefined, 'cloudflare')).toEqual([]);
    expect(validateRegistryConfig(undefined, 'node')).toEqual([]);
  });

  it('accepts an allowlist on node', () => {
    const input = { outbound: { allowPrivateHosts: ['registry.internal', '10.0.0.5:8080'] } };
    expect(validateRegistryConfig(input, 'node')).toEqual([]);
  });

  it('refuses a non-empty allowlist on cloudflare', () => {
    const problems = validateRegistryConfig(
      { outbound: { allowPrivateHosts: ['registry.internal'] } },
      'cloudflare',
    );
    expect(problems).toEqual(['registry.outbound.allowPrivateHosts: not available on cloudflare']);
  });

  it('accepts an empty allowlist on cloudflare', () => {
    expect(validateRegistryConfig({ outbound: { allowPrivateHosts: [] } }, 'cloudflare')).toEqual(
      [],
    );
  });

  it.each([
    '*.internal',
    'https://registry.internal',
    'registry.internal/path',
    'user@registry.internal',
    'registry.internal:0',
    'registry.internal:99999',
    'registry.internal:',
    '',
    'fe80::1%eth0',
    'Registry Internal',
  ])('refuses the allowlist entry %j', (entry) => {
    const problems = validateRegistryConfig({ outbound: { allowPrivateHosts: [entry] } }, 'node');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^registry\.outbound\.allowPrivateHosts\[0\]: /);
  });

  it('refuses non-string and duplicate entries and a non-array', () => {
    expect(validateRegistryConfig({ outbound: { allowPrivateHosts: [1] } }, 'node')).toHaveLength(
      1,
    );
    expect(
      validateRegistryConfig(
        { outbound: { allowPrivateHosts: ['a.internal', 'A.internal'] } },
        'node',
      ),
    ).toEqual(['registry.outbound.allowPrivateHosts[1]: duplicate entry']);
    expect(
      validateRegistryConfig({ outbound: { allowPrivateHosts: 'a.internal' } }, 'node'),
    ).toEqual(['registry.outbound.allowPrivateHosts: must be an array']);
  });

  it('refuses unknown keys without echoing a credential-looking key', () => {
    const secretKey = 'AKIAABCDEFGHIJKLMNOP';
    const problems = validateRegistryConfig(
      { extra: 1, [secretKey]: 'x', outbound: { selfOrigins: [], nope: 1 }, timers: { x: 1 } },
      'node',
    );
    expect(problems).toContain('registry.extra: unknown key');
    expect(problems).toContain('registry.<redacted>: unknown key');
    expect(problems).toContain('registry.outbound.selfOrigins: unknown key');
    expect(problems).toContain('registry.outbound.nope: unknown key');
    expect(problems).toContain('registry.timers.x: unknown key');
    expect(problems.join('\n')).not.toContain(secretKey);
  });

  it('refuses a non-object registry and sections', () => {
    expect(validateRegistryConfig('x', 'node')).toEqual(['registry: must be an object']);
    expect(validateRegistryConfig([], 'node')).toEqual(['registry: must be an object']);
    expect(validateRegistryConfig({ timers: 3 }, 'node')).toEqual([
      'registry.timers: must be an object',
    ]);
  });

  it('refuses an unknown platform', () => {
    expect(validateRegistryConfig({}, 'deno' as never)).toEqual(['target: unknown platform']);
  });

  it.each(['mailto:ops@example.com', 'https://example.com/contact'])('accepts contact %s', (c) => {
    expect(validateRegistryConfig({ upstreamContact: c }, 'node')).toEqual([]);
  });

  it.each([
    'ops@example.com',
    'http://example.com',
    'https://user:pw@example.com',
    'https://example.com/?token=abc',
    'mailto:',
    'mailto:a@b.c?cc=d@e.f',
    'mailto:a b@example.com',
    'https://example.com/\r\nX: y',
    42,
  ])('refuses contact %j without echoing it', (contact) => {
    const problems = validateRegistryConfig({ upstreamContact: contact }, 'node');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^registry\.upstreamContact: /);
    if (typeof contact === 'string' && contact.length > 8) {
      expect(problems[0]).not.toContain(contact);
    }
  });

  it('refuses bad user-agent strings', () => {
    for (const value of [
      '',
      'a\r\nb',
      'ünï',
      'x'.repeat(201),
      'tok_0123456789abcdef0123456789abcdef',
      7,
    ]) {
      const problems = validateRegistryConfig({ userAgent: { default: value } }, 'node');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^registry\.userAgent\.default: /);
    }
    expect(
      validateRegistryConfig({ userAgent: { composerStyle: 'bad\nagent' } }, 'node'),
    ).toHaveLength(1);
    expect(
      validateRegistryConfig(
        { userAgent: { default: 'Broker/2', composerStyle: 'Composer/2.8' } },
        'node',
      ),
    ).toEqual([]);
  });

  it('bounds timers and caps', () => {
    const bad = {
      timers: { metadataTtlSeconds: 0, negativeTtlSeconds: 1.5, waitBudgetMs: -1 },
      caps: { metadataBytes: 32 * 1024 * 1024 + 1, archiveBytes: 64 * 1024 * 1024 + 1 },
    };
    expect(validateRegistryConfig(bad, 'node')).toEqual([
      'registry.timers.metadataTtlSeconds: must be a positive integer',
      'registry.timers.negativeTtlSeconds: must be a positive integer',
      'registry.timers.waitBudgetMs: must be a positive integer',
      'registry.caps.metadataBytes: exceeds the product cap',
      'registry.caps.archiveBytes: exceeds the product cap',
    ]);
    expect(
      validateRegistryConfig({ caps: { metadataBytes: 1024, archiveBytes: 1024 } }, 'node'),
    ).toEqual([]);
  });
});

describe('resolveRegistryConfig', () => {
  it('yields the defaults for a missing config', () => {
    const expected = {
      outbound: { allowPrivateHosts: [], selfOrigins: [PUBLIC_URL] },
      userAgent: { default: 'PackageBroker/2', composerStyle: 'Composer/2.8.0' },
      upstreamContact: 'https://github.com/package-broker/broker',
      timers: { metadataTtlSeconds: 300, negativeTtlSeconds: 30, waitBudgetMs: 8000 },
      caps: { metadataBytes: 33554432, archiveBytes: 67108864 },
    };
    expect(resolveRegistryConfig(undefined, 'node', PUBLIC_URL)).toEqual(expected);
    expect(resolveRegistryConfig({}, 'cloudflare', PUBLIC_URL)).toEqual(expected);
  });

  it('exposes deep-frozen input defaults without an outbound section', () => {
    expect('outbound' in REGISTRY_DEFAULTS).toBe(false);
    expect(Object.isFrozen(REGISTRY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(REGISTRY_DEFAULTS.timers)).toBe(true);
    expect(Object.isFrozen(REGISTRY_DEFAULTS.caps)).toBe(true);
    expect(Object.isFrozen(REGISTRY_DEFAULTS.userAgent)).toBe(true);
  });

  it('keeps defaults when an own key is set to undefined', () => {
    const resolved = resolveRegistryConfig(
      {
        timers: { waitBudgetMs: undefined, metadataTtlSeconds: 10 },
        userAgent: { default: undefined },
        caps: { metadataBytes: undefined },
        upstreamContact: undefined,
      },
      'node',
      PUBLIC_URL,
    );
    expect(resolved.timers).toEqual({
      metadataTtlSeconds: 10,
      negativeTtlSeconds: 30,
      waitBudgetMs: 8000,
    });
    expect(resolved.userAgent.default).toBe('PackageBroker/2');
    expect(resolved.caps.metadataBytes).toBe(33554432);
    expect(resolved.upstreamContact).toBe('https://github.com/package-broker/broker');
  });

  it('accepts timers at the bound and refuses bound+1', () => {
    const at = { metadataTtlSeconds: 86400, negativeTtlSeconds: 86400, waitBudgetMs: 25000 };
    expect(validateRegistryConfig({ timers: at }, 'node')).toEqual([]);
    for (const key of Object.keys(at) as (keyof typeof at)[]) {
      expect(validateRegistryConfig({ timers: { [key]: at[key] + 1 } }, 'node')).toEqual([
        `registry.timers.${key}: exceeds the maximum`,
      ]);
    }
  });

  it('throws RegistryConfigError, never a TypeError, for malformed input', () => {
    for (const input of [
      { outbound: { allowPrivateHosts: [1, null] } },
      { outbound: { allowPrivateHosts: 'a.internal' } },
      { outbound: { extraSelfOrigins: [3] } },
      'x',
      [],
      42,
    ]) {
      expect(() => resolveRegistryConfig(input as never, 'node', PUBLIC_URL)).toThrow(
        RegistryConfigError,
      );
    }
    expect(() => resolveRegistryConfig(undefined, 'node', 5 as never)).toThrow(RegistryConfigError);
  });

  it('refuses an allowlist entry on the public hostname on any port, trailing dot included', () => {
    for (const entry of [
      'broker.example.com',
      'broker.example.com:8443',
      'broker.example.com.',
      'BROKER.example.com:80',
    ]) {
      expect(() =>
        resolveRegistryConfig({ outbound: { allowPrivateHosts: [entry] } }, 'node', PUBLIC_URL),
      ).toThrow(RegistryConfigError);
    }
    expect(() =>
      resolveRegistryConfig(
        { outbound: { allowPrivateHosts: ['x.internal'] } },
        'node',
        'https://broker.example.com.:8443/',
      ),
    ).not.toThrow();
    expect(() =>
      resolveRegistryConfig(
        { outbound: { allowPrivateHosts: ['broker.example.com'] } },
        'node',
        'https://broker.example.com.:8443/',
      ),
    ).toThrow(RegistryConfigError);
  });

  it('refuses a public URL with userinfo', () => {
    expect(() =>
      resolveRegistryConfig(undefined, 'node', 'https://u:p@broker.example.com'),
    ).toThrow(RegistryConfigError);
    expect(() => resolveRegistryConfig(undefined, 'node', 'https://u@broker.example.com')).toThrow(
      RegistryConfigError,
    );
  });

  it('adds normalized extra self origins and refuses allowlisting them', () => {
    const resolved = resolveRegistryConfig(
      {
        outbound: {
          extraSelfOrigins: [
            'http://127.0.0.1:8787/x',
            'http://Broker.Internal.:8080',
            'https://broker.example.com',
          ],
        },
      },
      'node',
      PUBLIC_URL,
    );
    expect(resolved.outbound.selfOrigins).toEqual([
      PUBLIC_URL,
      'http://127.0.0.1:8787',
      'http://broker.internal:8080',
    ]);
    expect(
      validateRegistryConfig(
        {
          outbound: {
            extraSelfOrigins: ['ftp://x.example.com', 'https://u@x.example.com', 'nope'],
          },
        },
        'node',
      ),
    ).toHaveLength(3);
    expect(() =>
      resolveRegistryConfig(
        {
          outbound: {
            allowPrivateHosts: ['127.0.0.1:8787'],
            extraSelfOrigins: ['http://127.0.0.1:8787'],
          },
        },
        'node',
        PUBLIC_URL,
      ),
    ).toThrow(RegistryConfigError);
  });

  it.each([
    'a..b',
    '-a.internal',
    'a-.internal',
    '[1.2.3.4]',
    '[:]',
    '010.0.0.1',
    '[0:0:0:0:0:0:0:1]',
    '1',
    '0x7f.1',
    'a_b.internal',
  ])('refuses the non-canonical or malformed host %j', (entry) => {
    expect(
      validateRegistryConfig({ outbound: { allowPrivateHosts: [entry] } }, 'node'),
    ).toHaveLength(1);
  });

  it('treats host, host:80 and host:443 as distinct entries', () => {
    expect(
      validateRegistryConfig(
        { outbound: { allowPrivateHosts: ['a.internal', 'a.internal:443', 'a.internal:80'] } },
        'node',
      ),
    ).toEqual([]);
  });

  it('refuses a trailing-dot allowlist entry', () => {
    expect(
      validateRegistryConfig({ outbound: { allowPrivateHosts: ['a.internal.'] } }, 'node'),
    ).toHaveLength(1);
  });

  it.each([
    ['127.0.0.1:3000', 'http://localhost:3000'],
    ['localhost:3000', 'http://127.0.0.1:3000'],
    ['[::1]:3000', 'http://localhost:3000'],
    ['127.0.0.2', 'http://[::1]:3000'],
  ])('refuses loopback alias %s against extra self origin %s', (entry, origin) => {
    expect(() =>
      resolveRegistryConfig(
        { outbound: { allowPrivateHosts: [entry], extraSelfOrigins: [origin] } },
        'node',
        PUBLIC_URL,
      ),
    ).toThrow(RegistryConfigError);
  });

  it('reports an over-long or invalid PB_PUBLIC_URL with its own message', () => {
    const long = `https://broker.example.com/${'a'.repeat(2048)}`;
    expect(() => resolveRegistryConfig(undefined, 'node', long)).toThrow(
      /PB_PUBLIC_URL: must be at most 2048/,
    );
    expect(() => resolveRegistryConfig(undefined, 'node', 'nope')).toThrow(
      /PB_PUBLIC_URL: must be an absolute/,
    );
    expect(() =>
      resolveRegistryConfig(undefined, 'node', `https://broker.example.com/${'a'.repeat(2000)}`),
    ).not.toThrow();
  });

  it('refuses an access key id embedded in a user agent', () => {
    expect(
      validateRegistryConfig({ userAgent: { default: 'x AKIAABCDEFGHIJKLMNOP y' } }, 'node'),
    ).toHaveLength(1);
  });

  it.each([
    ['registry.internal', 'http://registry.internal/', true],
    ['registry.internal:8080', 'http://registry.internal:8080/x', true],
    ['registry.internal:8080', 'http://registry.internal:9090/x', false],
    ['10.0.0.5:8080', 'http://10.0.0.5:8080/', true],
    ['[::1]:3000', 'http://[::1]:3000/', true],
    ['localhost', 'http://localhost/', true],
  ])('round-trips allowlist entry %s through the outbound policy for %s', (entry, url, ok) => {
    const resolved = resolveRegistryConfig(
      { outbound: { allowPrivateHosts: [entry] } },
      'node',
      PUBLIC_URL,
    );
    const policy = createOutboundPolicy({
      allowPrivateHosts: resolved.outbound.allowPrivateHosts,
      runtime: 'node',
      selfOrigins: resolved.outbound.selfOrigins,
    });
    expect(classifyUrl(url, policy).ok).toBe(ok);
  });

  it('merges partial sections over the defaults and normalizes hosts', () => {
    const resolved = resolveRegistryConfig(
      {
        outbound: { allowPrivateHosts: ['Registry.Internal:8080'] },
        timers: { waitBudgetMs: 2000 },
        upstreamContact: 'mailto:ops@example.com',
      },
      'node',
      PUBLIC_URL,
    );
    expect(resolved.outbound.allowPrivateHosts).toEqual(['registry.internal:8080']);
    expect(resolved.timers).toEqual({
      metadataTtlSeconds: 300,
      negativeTtlSeconds: 30,
      waitBudgetMs: 2000,
    });
    expect(resolved.upstreamContact).toBe('mailto:ops@example.com');
    expect(resolved.userAgent).toEqual({
      default: 'PackageBroker/2',
      composerStyle: 'Composer/2.8.0',
    });
  });

  it('derives the self origin from the public URL and refuses an allowlisted self host', () => {
    expect(
      resolveRegistryConfig(undefined, 'node', 'https://Broker.Example.com:443/base?x=1').outbound
        .selfOrigins,
    ).toEqual(['https://broker.example.com']);
    expect(() =>
      resolveRegistryConfig(
        { outbound: { allowPrivateHosts: ['broker.example.com'] } },
        'node',
        PUBLIC_URL,
      ),
    ).toThrow(RegistryConfigError);
  });

  it('refuses a missing or invalid public URL', () => {
    expect(() => resolveRegistryConfig(undefined, 'node', 'not a url')).toThrow(
      RegistryConfigError,
    );
    expect(() => resolveRegistryConfig(undefined, 'node', 'ftp://x.example.com')).toThrow(
      RegistryConfigError,
    );
  });

  it('throws a RegistryConfigError listing the problems', () => {
    try {
      resolveRegistryConfig(
        { outbound: { allowPrivateHosts: ['a.internal'] } },
        'cloudflare',
        PUBLIC_URL,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryConfigError);
      expect((error as RegistryConfigError).problems).toEqual([
        'registry.outbound.allowPrivateHosts: not available on cloudflare',
      ]);
    }
  });

  it('does not share default objects between results', () => {
    const a = resolveRegistryConfig(undefined, 'node', PUBLIC_URL);
    (a.outbound.allowPrivateHosts as string[]).push('x');
    expect(resolveRegistryConfig(undefined, 'node', PUBLIC_URL).outbound.allowPrivateHosts).toEqual(
      [],
    );
  });
});

describe('hardening', () => {
  it('ignores inherited values and refuses non-plain sections', () => {
    const inheritedCaps = Object.create({ archiveBytes: 1 }) as object;
    expect(() =>
      resolveRegistryConfig({ caps: inheritedCaps } as never, 'node', PUBLIC_URL),
    ).toThrow(RegistryConfigError);
    const inheritedSection = Object.create({ caps: { archiveBytes: 1 } }) as object;
    expect(() => resolveRegistryConfig(inheritedSection as never, 'node', PUBLIC_URL)).toThrow(
      RegistryConfigError,
    );
    const nullProto = Object.assign(Object.create(null) as object, {
      timers: { waitBudgetMs: 1000 },
    });
    expect(resolveRegistryConfig(nullProto as never, 'node', PUBLIC_URL).timers.waitBudgetMs).toBe(
      1000,
    );
  });

  it('ignores values inherited from a polluted Object.prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.caps = { archiveBytes: 1 };
    proto.upstreamContact = 'https://evil.example.com';
    try {
      const resolved = resolveRegistryConfig({}, 'node', PUBLIC_URL);
      expect(resolved.caps.archiveBytes).toBe(67108864);
      expect(resolved.upstreamContact).toBe('https://github.com/package-broker/broker');
    } finally {
      delete proto.caps;
      delete proto.upstreamContact;
    }
  });

  it.each(['0123456789ABCDEF', 'ABCDEFGHIJKLMNO2'])(
    'redacts the credential-looking key and user agent %s',
    (value) => {
      const problems = validateRegistryConfig(
        { [value]: 1, userAgent: { default: `Tool/1 ${value}` } },
        'node',
      );
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).not.toContain(value);
      expect(problems).toContain('registry.<redacted>: unknown key');
    },
  );

  it('still accepts an ordinary composer-style user agent', () => {
    expect(
      validateRegistryConfig(
        { userAgent: { default: 'Composer/2.8.0 (Linux; PackageBroker)' } },
        'node',
      ),
    ).toEqual([]);
  });

  it.each(['https://a..b', 'https://-a.example.com', 'https://a-.example.com'])(
    'refuses the public URL %s and extra origin with bad labels',
    (url) => {
      expect(() => resolveRegistryConfig(undefined, 'node', url)).toThrow(RegistryConfigError);
      expect(() =>
        resolveRegistryConfig({ outbound: { extraSelfOrigins: [url] } }, 'node', PUBLIC_URL),
      ).toThrow(RegistryConfigError);
    },
  );

  it('produces self origins that createOutboundPolicy accepts', () => {
    const resolved = resolveRegistryConfig(
      {
        outbound: {
          extraSelfOrigins: [
            'http://127.0.0.1:8787',
            'http://[::1]:8787',
            'https://Broker.Internal.:8443/x',
          ],
        },
      },
      'node',
      'https://Broker.Example.com.:8443/base',
    );
    expect(() =>
      createOutboundPolicy({
        allowPrivateHosts: [],
        runtime: 'node',
        selfOrigins: resolved.outbound.selfOrigins,
      }),
    ).not.toThrow();
  });
});

describe('BrokerConfig.registry', () => {
  it('is carried by defineConfig', () => {
    const config = defineConfig({
      platform: 'node',
      plugins: [],
      registry: { timers: { waitBudgetMs: 1000 } },
    });
    expect(config.registry?.timers?.waitBudgetMs).toBe(1000);
  });
});
