import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  classifyUrl,
  createOutboundPolicy,
  parseAllowlist,
} from './url-policy.js';

const node = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });

const refused: readonly (readonly [string, string])[] = [
  ['http://example.com/', 'scheme'],
  ['ftp://example.com/', 'scheme'],
  ['file:///etc/passwd', 'scheme'],
  ['ssh://example.com/x', 'scheme'],
  ['https://user@example.com/', 'userinfo'],
  ['https://user:pw@example.com/', 'userinfo'],
  ['https://:pw@example.com/', 'userinfo'],
  ['https://example.com:8443/', 'port'],
  ['https://example.com:80/', 'port'],
  ['https://127.0.0.1/', 'blocked_address'],
  ['https://127.1/', 'blocked_address'],
  ['https://2130706433/', 'blocked_address'],
  ['https://0x7f000001/', 'blocked_address'],
  ['https://0x7f.0.0.1/', 'blocked_address'],
  ['https://017700000001/', 'blocked_address'],
  ['https://0177.0.0.1/', 'blocked_address'],
  ['https://10.0.0.1/', 'blocked_address'],
  ['https://172.16.5.4/', 'blocked_address'],
  ['https://172.31.255.255/', 'blocked_address'],
  ['https://192.168.1.1/', 'blocked_address'],
  ['https://169.254.169.254/', 'blocked_address'],
  ['https://100.64.0.1/', 'blocked_address'],
  ['https://100.127.255.255/', 'blocked_address'],
  ['https://0.0.0.0/', 'blocked_address'],
  ['https://0/', 'blocked_address'],
  ['https://224.0.0.1/', 'blocked_address'],
  ['https://255.255.255.255/', 'blocked_address'],
  ['https://192.0.2.1/', 'blocked_address'],
  ['https://198.51.100.1/', 'blocked_address'],
  ['https://203.0.113.9/', 'blocked_address'],
  ['https://198.18.0.1/', 'blocked_address'],
  ['https://198.19.255.255/', 'blocked_address'],
  ['https://[::1]/', 'blocked_address'],
  ['https://[::]/', 'blocked_address'],
  ['https://[fc00::1]/', 'blocked_address'],
  ['https://[fd12:3456::1]/', 'blocked_address'],
  ['https://[fe80::1]/', 'blocked_address'],
  ['https://[ff02::1]/', 'blocked_address'],
  ['https://[::ffff:127.0.0.1]/', 'blocked_address'],
  ['https://[::ffff:8.8.8.8]/', 'blocked_address'],
  ['https://[::7f00:1]/', 'blocked_address'],
  ['https://[64:ff9b::7f00:1]/', 'blocked_address'],
  ['https://[64:ff9b::a00:1]/', 'blocked_address'],
  ['https://[2002:7f00:1::]/', 'blocked_address'],
  ['https://[2002:c0a8:101::1]/', 'blocked_address'],
  ['https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'blocked_address'],
  ['https://[2001:db8::1]/', 'blocked_address'],
  ['https://[fe80::1%25eth0]/', 'zone_id'],
  ['https://[fe80::1%eth0]/', 'zone_id'],
  ['https://localhost/', 'blocked_host'],
  ['https://LOCALHOST/', 'blocked_host'],
  ['https://localhost./', 'blocked_host'],
  ['https://api.localhost/', 'blocked_host'],
  ['https://printer.local/', 'blocked_host'],
  ['https://db.internal/', 'blocked_host'],
  ['https://router.home.arpa/', 'blocked_host'],
  ['https://metadata.google.internal/', 'blocked_host'],
  ['https://metadata.google.internal./', 'blocked_host'],
  ['https://localhost../', 'invalid_url'],
  ['https://127.0.0.1../', 'invalid_url'],
  ['https://intranet../', 'invalid_url'],
  ['https://metadata.google.internal../', 'invalid_url'],
  ['https://example..com/', 'invalid_url'],
  ['https://@example.com/', 'userinfo'],
  ['https://:@example.com/', 'userinfo'],
  ['  https://[fe80::1%25eth0]/', 'zone_id'],
  ['https://192.88.99.1/', 'blocked_address'],
  ['https://[fec0::1]/', 'blocked_address'],
  ['https://intranet/', 'blocked_host'],
  ['https://intranet./', 'blocked_host'],
  ['not a url', 'invalid_url'],
  ['', 'invalid_url'],
  ['https://', 'invalid_url'],
];

const accepted: readonly (readonly [string, string])[] = [
  ['https://example.com/a/b?c=1#d', 'https://example.com'],
  ['https://EXAMPLE.com/', 'https://example.com'],
  ['https://example.com./', 'https://example.com'],
  ['https://example.com:443/', 'https://example.com'],
  ['https://repo.packagist.org/p2/a/b.json', 'https://repo.packagist.org'],
  ['https://bücher.example/', 'https://xn--bcher-kva.example'],
  ['https://8.8.8.8/', 'https://8.8.8.8'],
  ['https://192.88.98.255/', 'https://192.88.98.255'],
  ['https://192.88.100.0/', 'https://192.88.100.0'],
  ['https://172.32.0.1/', 'https://172.32.0.1'],
  ['https://100.128.0.1/', 'https://100.128.0.1'],
  ['https://198.20.0.1/', 'https://198.20.0.1'],
  ['https://[2606:4700:4700::1111]/', 'https://[2606:4700:4700::1111]'],
  ['https://[64:ff9b::808:808]/', 'https://[64:ff9b::808:808]'],
  ['https://[2002:808:808::1]/', 'https://[2002:808:808::1]'],
];

describe('classifyUrl', () => {
  it.each(refused)('refuses %s as %s', (url, reason) => {
    expect(classifyUrl(url, node)).toEqual({ ok: false, reason });
  });

  it.each(accepted)('accepts %s', (url, origin) => {
    expect(classifyUrl(url, node)).toEqual({ ok: true, origin });
  });

  it('has at least 40 table rows', () => {
    expect(refused.length + accepted.length).toBeGreaterThanOrEqual(40);
  });

  it('passes an allowlisted private host on node, with http and a custom port', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: ['registry.internal:8080', 'localhost:3000', '10.0.0.5'],
      runtime: 'node',
      selfOrigins: [],
    });
    expect(classifyUrl('http://registry.internal:8080/x', policy)).toEqual({
      ok: true,
      origin: 'http://registry.internal:8080',
    });
    expect(classifyUrl('http://localhost:3000/', policy)).toEqual({
      ok: true,
      origin: 'http://localhost:3000',
    });
    expect(classifyUrl('https://10.0.0.5/', policy)).toEqual({
      ok: true,
      origin: 'https://10.0.0.5',
    });
    expect(classifyUrl('http://registry.internal:9090/x', policy)).toEqual({
      ok: false,
      reason: 'scheme',
    });
    expect(classifyUrl('https://registry.internal:9090/x', policy)).toEqual({
      ok: false,
      reason: 'blocked_host',
    });
    expect(classifyUrl('http://example.com/', policy)).toEqual({ ok: false, reason: 'scheme' });
  });

  it('allowlist entries match the effective port', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: ['plain.internal', 'p80.internal:80', 'p443.internal:443'],
      runtime: 'node',
      selfOrigins: [],
    });
    expect(classifyUrl('https://plain.internal/', policy).ok).toBe(true);
    expect(classifyUrl('http://plain.internal/', policy).ok).toBe(true);
    expect(classifyUrl('https://plain.internal:8443/', policy)).toEqual({
      ok: false,
      reason: 'blocked_host',
    });
    expect(classifyUrl('http://plain.internal:443/', policy)).toEqual({
      ok: false,
      reason: 'scheme',
    });
    expect(classifyUrl('http://p80.internal/', policy).ok).toBe(true);
    expect(classifyUrl('https://p443.internal/', policy).ok).toBe(true);
    expect(classifyUrl('http://p443.internal/', policy)).toEqual({
      ok: false,
      reason: 'scheme',
    });
  });

  it('refuses the same allowlisted host on cloudflare', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: ['registry.internal:8080', 'localhost'],
      runtime: 'cloudflare',
      selfOrigins: [],
    });
    expect(classifyUrl('http://registry.internal:8080/x', policy)).toEqual({
      ok: false,
      reason: 'scheme',
    });
    expect(classifyUrl('https://registry.internal:8080/x', policy)).toEqual({
      ok: false,
      reason: 'blocked_host',
    });
    expect(classifyUrl('https://localhost/', policy)).toEqual({
      ok: false,
      reason: 'blocked_host',
    });
  });

  it('compares self origins by host and effective port, ignoring scheme, case and trailing dot', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: [],
      runtime: 'node',
      selfOrigins: ['https://Broker.Example.com.', 'http://other.example.com:443'],
    });
    for (const url of [
      'https://broker.example.com/',
      'https://broker.example.com:443/',
      'https://BROKER.example.com./x',
      'http://broker.example.com:443/',
      'https://other.example.com/',
    ]) {
      expect(classifyUrl(url, policy)).toEqual({ ok: false, reason: 'self_origin' });
    }
    expect(classifyUrl('https://broker.example.com:8443/', policy)).toEqual({
      ok: false,
      reason: 'port',
    });
  });

  it('throws on an invalid self origin', () => {
    for (const bad of [
      'broker.example.com',
      'https://',
      'https://u@broker.example.com',
      'https://a..b',
    ]) {
      expect(() =>
        createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [bad] }),
      ).toThrow();
    }
  });

  it('returns the parsed allowlist from createOutboundPolicy', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: [' Host.Internal:80 '],
      runtime: 'node',
      selfOrigins: [],
    });
    expect(policy.allowPrivateHosts).toEqual(['host.internal:80']);
    expect(
      createOutboundPolicy({ allowPrivateHosts: ['x'], runtime: 'cloudflare', selfOrigins: [] })
        .allowPrivateHosts,
    ).toEqual([]);
  });

  it('refuses the broker own origins, even when allowlisted', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: ['broker.example.com'],
      runtime: 'node',
      selfOrigins: ['https://Broker.example.com', 'https://pkg.example.org:8443'],
    });
    expect(classifyUrl('https://broker.example.com/api', policy)).toEqual({
      ok: false,
      reason: 'self_origin',
    });
    expect(classifyUrl('https://pkg.example.org:8443/x', policy)).toEqual({
      ok: false,
      reason: 'self_origin',
    });
    expect(classifyUrl('https://other.example.com/', policy)).toEqual({
      ok: true,
      origin: 'https://other.example.com',
    });
  });
});

describe('classifyAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '2001:0:1::1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    'fe80::1%eth0',
    '64:ff9b:1::1',
    '64:ff9b:1:ffff::1',
    '3fff::1',
    '3fff:fff:ffff::1',
    'fec0::1',
    'febf::1',
    '::ffff:0:0:1',
    '2001:2::1',
    '100::1',
    '192.88.99.1',
    '192.88.99.255',
  ])('refuses %s', (ip) => {
    expect(classifyAddress(ip).ok).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '64:ff9b::808:808',
    '64:ff9b:2::1',
    '3fff:1000::1',
    '3ffe::1',
    '100:0:0:1::1',
    '2001:2:1::1',
    '2001:3::1',
    '192.88.98.255',
    '192.88.100.0',
    '2606:4700::1',
  ])('accepts %s', (ip) => {
    expect(classifyAddress(ip)).toEqual({ ok: true });
  });

  it.each([
    'example.com',
    '1.2.3.4x',
    '010.0.0.1',
    '08.8.8.8',
    '1.2.3.04',
    '::g',
    '1.2.3',
    ' 8.8.8.8\n',
    '[::1]x',
  ])('fails closed on %j', (text) => {
    expect(classifyAddress(text)).toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('keeps refusing text that is not an address', () => {
    expect(classifyAddress('example.com')).toEqual({ ok: false, reason: 'invalid_url' });
  });
});

describe('parseAllowlist', () => {
  it('lowercases and trims entries on node', () => {
    expect(parseAllowlist(['Registry.Internal:8080', ' localhost '], 'node')).toEqual([
      'registry.internal:8080',
      'localhost',
    ]);
  });

  it.each(['*', '*.internal', 'a.*.b', '**'])('refuses wildcard %s', (entry) => {
    expect(() => parseAllowlist([entry], 'node')).toThrow(/wildcard/);
  });

  it('ignores the allowlist on cloudflare', () => {
    expect(parseAllowlist(['localhost', '*'], 'cloudflare')).toEqual([]);
  });

  it('refuses entries with a scheme, path or userinfo', () => {
    for (const entry of ['http://localhost', 'localhost/x', 'u@localhost', '']) {
      expect(() => parseAllowlist([entry], 'node')).toThrow();
    }
  });
});

describe('userinfo in any spelling', () => {
  it.each([
    ['https:@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https://@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https://:@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https:\\\\@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https:/\\@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https:///@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https:/\t/@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https:\n@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['\x01https:@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['\x00https://@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['\x1fhttps:\\\\@example.com/', { username: '', password: '', hostname: 'example.com' }],
    ['https://u%40x@example.com/', { username: 'u%40x', password: '', hostname: 'example.com' }],
  ])('refuses %s as userinfo', (input, parsed) => {
    const url = new URL(input);
    expect({ username: url.username, password: url.password, hostname: url.hostname }).toEqual(
      parsed,
    );
    expect(classifyUrl(input, node)).toEqual({ ok: false, reason: 'userinfo' });
  });

  it('refuses a percent-encoded at sign in the host', () => {
    expect(() => new URL('https://user%40example.com/')).toThrow();
    expect(classifyUrl('https://user%40example.com/', node)).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });

  it.each([
    'https:@broker.example.com',
    'https:\\\\@broker.example.com',
    '\x01https:@broker.example.com',
    '\x00https://@broker.example.com',
    '\x1fhttps:\\\\@broker.example.com',
  ])('refuses %s as a self origin', (bad) => {
    expect(() =>
      createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [bad] }),
    ).toThrow('selfOrigins entries must be absolute http(s) origins');
  });
});

describe('self origins are bare origins', () => {
  it.each([
    'https://broker.example/app',
    'https://broker.example/app/',
    'https://broker.example/?x=1',
    'https://broker.example/?',
    'https://broker.example/#top',
    'https://broker.example#',
    'https://broker.example/.',
    'https://broker.example/./',
    'https://broker.example/..',
    'https://broker.example/%2e/',
    'https://broker.example//',
    'https://broker.example\\',
  ])('throws on %s', (bad) => {
    expect(() =>
      createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [bad] }),
    ).toThrow('selfOrigins entries must be absolute http(s) origins');
  });

  it('accepts an origin with or without the root slash', () => {
    const policy = createOutboundPolicy({
      allowPrivateHosts: [],
      runtime: 'node',
      selfOrigins: [
        'https://broker.example',
        'https://pkg.example:8443/',
        '\x01https://x.example\x1f',
      ],
    });
    expect(policy.selfOrigins).toEqual([
      'https://broker.example',
      'https://pkg.example:8443',
      'https://x.example',
    ]);
  });
});
