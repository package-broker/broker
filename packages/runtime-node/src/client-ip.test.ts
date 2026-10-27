import { isIpLiteral } from '@package-broker/core/audit/actions';
import { describe, expect, it } from 'vitest';
import { nodeClientIp, parseTrustedProxy, type TrustedProxy } from './client-ip.js';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://broker.test', { headers });

describe('Node client IP trust boundary', () => {
  it.each(['203.0.113.7', '2001:db8::1', '::1', '2001:0DB8:0:0::1', '::ffff:192.0.2.7'])(
    'preserves audit-compatible literal %s across address sources',
    (value) => {
      const results = [
        nodeClientIp(request(), value),
        nodeClientIp(request(), value, true),
        nodeClientIp(request({ 'cf-connecting-ip': value }), null, true),
        nodeClientIp(request({ 'x-forwarded-for': value }), null, true),
        nodeClientIp(request({ forwarded: `for="${value}"` }), null, true),
      ];
      for (const result of results) {
        expect(result).toBe(value);
        expect(isIpLiteral(result)).toBe(true);
      }
    },
  );

  it.each(['1.2', 'abc', '::::', '999.1.1.1', 'a'.repeat(8192), ''])(
    'rejects invalid socket address for case %#',
    (value) => {
      expect(nodeClientIp(request(), value)).toBeNull();
      expect(nodeClientIp(request(), value, true)).toBeNull();
    },
  );

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('defaults to socket address %s', (peer) => {
    expect(
      nodeClientIp(
        request({
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.1',
          forwarded: 'for=192.0.2.1',
        }),
        peer,
      ),
    ).toBe(peer);
  });

  it('does not trust headers without a socket address', () => {
    expect(nodeClientIp(request({ 'cf-connecting-ip': '203.0.113.7' }), null)).toBeNull();
  });

  it('prefers cf-connecting-ip when explicitly trusted', () => {
    expect(
      nodeClientIp(
        request({ 'cf-connecting-ip': ' 203.0.113.7 ', 'x-forwarded-for': '198.51.100.1' }),
        '127.0.0.1',
        true,
      ),
    ).toBe('203.0.113.7');
  });

  it('uses only the first forwarded address, including IPv6', () => {
    expect(
      nodeClientIp(request({ 'x-forwarded-for': ' 2001:db8::1 , 192.0.2.1' }), '::1', true),
    ).toBe('2001:db8::1');
  });

  it('falls back to the socket when no forwarded headers exist', () => {
    expect(nodeClientIp(request(), '::1', true)).toBe('::1');
    expect(nodeClientIp(request(), null, true)).toBeNull();
  });

  it.each([
    ['for=203.0.113.7', '203.0.113.7'],
    ['for="203.0.113.7";proto=https', '203.0.113.7'],
    ['for="[2001:db8::1]"', '2001:db8::1'],
    ['for="[::1]"', '::1'],
    ['for="[2001:db8::1]:4711";proto=https', '2001:db8::1'],
    ['by=192.0.2.1; For="[::ffff:192.0.2.7]:443"', '::ffff:192.0.2.7'],
    ['for=203.0.113.7, for=192.0.2.1', '203.0.113.7'],
  ])('uses the first Forwarded element %j', (value, expected) => {
    expect(nodeClientIp(request({ forwarded: value }), '::1', true)).toBe(expected);
  });

  it.each([
    'by="edge;for=192.0.2.1,backup";for=203.0.113.7',
    'by="edge,backup;proxy";for="[2001:db8::1]:4711"',
    String.raw`by="edge\",;for=192.0.2.1";for=203.0.113.7`,
    String.raw`for="203.0.113.\7";by="edge,backup;proxy"`,
  ])('respects quoted Forwarded values %j', (value) => {
    const expected = value.includes('[2001:db8::1]') ? '2001:db8::1' : '203.0.113.7';
    expect(nodeClientIp(request({ forwarded: value }), '::1', true)).toBe(expected);
  });

  it.each([
    'by="edge;for=203.0.113.7',
    'for=203.0.113.7;by="edge,backup',
    String.raw`for=203.0.113.7;by="edge\"`,
    String.raw`for="203.0.113.7\"`,
  ])('falls back to the socket for unbalanced Forwarded quotes %j', (value) => {
    expect(nodeClientIp(request({ forwarded: value }), '::1', true)).toBe('::1');
    expect(nodeClientIp(request({ forwarded: value }), null, true)).toBeNull();
  });

  it('prefers X-Forwarded-For over Forwarded', () => {
    expect(
      nodeClientIp(
        request({ 'x-forwarded-for': '198.51.100.1', forwarded: 'for=192.0.2.1' }),
        '::1',
        true,
      ),
    ).toBe('198.51.100.1');
  });

  it.each([
    '',
    'proxy.example.test',
    'garbage!@#',
    'a'.repeat(8192),
    'unknown',
    '999.1.1.1',
    '1.2',
    'abc',
    '::::',
    '1.2.3',
    ':::',
    'a:b',
    'fe80::1%eth0',
    '192.0.2.1:80',
  ])('falls back to the socket for invalid header %#', (value) => {
    expect(
      nodeClientIp(
        request({ 'cf-connecting-ip': value, 'x-forwarded-for': '198.51.100.1' }),
        '127.0.0.1',
        true,
      ),
    ).toBe('127.0.0.1');
    expect(
      nodeClientIp(
        request({ 'x-forwarded-for': `${value}, 192.0.2.1`, forwarded: 'for=203.0.113.7' }),
        '::1',
        true,
      ),
    ).toBe('::1');
    expect(nodeClientIp(request({ forwarded: `for="${value}"` }), '::1', true)).toBe('::1');
    expect(nodeClientIp(request({ 'cf-connecting-ip': value }), null, true)).toBeNull();
    expect(nodeClientIp(request({ 'x-forwarded-for': value }), null, true)).toBeNull();
    expect(nodeClientIp(request({ forwarded: `for="${value}"` }), null, true)).toBeNull();
  });

  it.each(['cf-connecting-ip', 'x-forwarded-for'])(
    'rejects brackets outside Forwarded in %s',
    (header) => {
      expect(nodeClientIp(request({ [header]: '[::1]' }), '127.0.0.1', true)).toBe('127.0.0.1');
      expect(nodeClientIp(request({ [header]: '[::1]' }), null, true)).toBeNull();
    },
  );

  it.each([
    'proto=https',
    'for="[proxy.example.test]:443"',
    'for="[2001:db8::1]:garbage"',
    'for="[2001:db8::1]:443"garbage',
    'for="[192.0.2.1]:443"',
    'for="[2001:db8::1]:443',
    'for=unknown, for=203.0.113.7',
  ])('falls back to the socket for malformed Forwarded %j', (value) => {
    expect(nodeClientIp(request({ forwarded: value }), '::1', true)).toBe('::1');
  });
});

const NONE: TrustedProxy = { kind: 'none' };
const CLOUDFLARE: TrustedProxy = { kind: 'cloudflare' };
const LEGACY: TrustedProxy = { kind: 'legacy' };
const xff = (hops: number): TrustedProxy => ({ kind: 'xff', hops });

const withLines = (lines: readonly (readonly [string, string])[]) => {
  const headers = new Headers();
  for (const [name, value] of lines) headers.append(name, value);
  return new Request('http://broker.test', { headers });
};

describe('PB_TRUSTED_PROXY modes', () => {
  const SOCKET = '10.0.0.5';
  const spoofed = {
    'cf-connecting-ip': '203.0.113.66',
    'x-forwarded-for': '203.0.113.66, 198.51.100.7',
    forwarded: 'for=203.0.113.66',
  };

  it.each<{
    name: string;
    policy: TrustedProxy;
    headers: Record<string, string> | readonly (readonly [string, string])[];
    expected: string | null;
    socket?: string | null;
  }>([
    { name: 'none ignores every header', policy: NONE, headers: spoofed, expected: SOCKET },
    {
      name: 'cloudflare takes CF-Connecting-IP',
      policy: CLOUDFLARE,
      headers: spoofed,
      expected: '203.0.113.66',
    },
    {
      name: 'cloudflare ignores X-Forwarded-For and Forwarded',
      policy: CLOUDFLARE,
      headers: { 'x-forwarded-for': '198.51.100.7', forwarded: 'for=192.0.2.1' },
      expected: SOCKET,
    },
    {
      name: 'cloudflare falls back on an invalid value',
      policy: CLOUDFLARE,
      headers: { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.7' },
      expected: SOCKET,
    },
    {
      name: 'cloudflare rejects a bracketed IPv6 value',
      policy: CLOUDFLARE,
      headers: { 'cf-connecting-ip': '[2001:db8::1]' },
      expected: SOCKET,
    },
    {
      name: 'cloudflare accepts an IPv6 value',
      policy: CLOUDFLARE,
      headers: { 'cf-connecting-ip': ' 2001:db8::1 ' },
      expected: '2001:db8::1',
    },
    {
      name: 'cloudflare rejects two CF-Connecting-IP lines',
      policy: CLOUDFLARE,
      headers: [
        ['cf-connecting-ip', '203.0.113.66'],
        ['cf-connecting-ip', '198.51.100.7'],
      ],
      expected: SOCKET,
    },
    {
      name: 'xff:1 takes the entry the nearest proxy appended, not the client value',
      policy: xff(1),
      headers: spoofed,
      expected: '198.51.100.7',
    },
    {
      name: 'xff:2 takes the second entry from the right',
      policy: xff(2),
      headers: { 'x-forwarded-for': '203.0.113.66, 198.51.100.7, 192.0.2.10' },
      expected: '198.51.100.7',
    },
    {
      name: 'xff ignores a spoofed CF-Connecting-IP',
      policy: xff(1),
      headers: { 'cf-connecting-ip': '203.0.113.66', 'x-forwarded-for': '198.51.100.7' },
      expected: '198.51.100.7',
    },
    {
      name: 'xff ignores Forwarded',
      policy: xff(1),
      headers: { forwarded: 'for=203.0.113.66' },
      expected: SOCKET,
    },
    {
      name: 'xff joins multiple header lines in order',
      policy: xff(1),
      headers: [
        ['x-forwarded-for', '203.0.113.66'],
        ['x-forwarded-for', '198.51.100.7'],
      ],
      expected: '198.51.100.7',
    },
    {
      name: 'xff:2 counts across header lines',
      policy: xff(2),
      headers: [
        ['x-forwarded-for', '203.0.113.66, 192.0.2.1'],
        ['x-forwarded-for', '198.51.100.7'],
      ],
      expected: '192.0.2.1',
    },
    {
      name: 'xff falls back on a short list',
      policy: xff(3),
      headers: { 'x-forwarded-for': '203.0.113.66, 198.51.100.7' },
      expected: SOCKET,
    },
    {
      name: 'xff falls back without the header',
      policy: xff(1),
      headers: {},
      expected: SOCKET,
    },
    {
      name: 'xff falls back on a non-IP entry',
      policy: xff(1),
      headers: { 'x-forwarded-for': '198.51.100.7, unknown' },
      expected: SOCKET,
    },
    {
      name: 'xff falls back on an empty entry',
      policy: xff(1),
      headers: { 'x-forwarded-for': '198.51.100.7, ' },
      expected: SOCKET,
    },
    {
      name: 'xff falls back on an entry with a port',
      policy: xff(1),
      headers: { 'x-forwarded-for': '198.51.100.7:4711' },
      expected: SOCKET,
    },
    {
      name: 'xff falls back on a bracketed IPv6 entry',
      policy: xff(1),
      headers: { 'x-forwarded-for': '203.0.113.66, [2001:db8::1]' },
      expected: SOCKET,
    },
    {
      name: 'xff accepts an IPv6 entry',
      policy: xff(1),
      headers: { 'x-forwarded-for': '203.0.113.66, 2001:db8::1' },
      expected: '2001:db8::1',
    },
    {
      name: 'xff does not shift to a valid neighbour when the entry is invalid',
      policy: xff(2),
      headers: { 'x-forwarded-for': '203.0.113.66, garbage, 198.51.100.7' },
      expected: SOCKET,
    },
    {
      name: 'xff returns null without a valid socket address',
      policy: xff(1),
      headers: { 'x-forwarded-for': 'garbage' },
      socket: null,
      expected: null,
    },
    {
      name: 'legacy keeps the spoofable CF-Connecting-IP preference',
      policy: LEGACY,
      headers: spoofed,
      expected: '203.0.113.66',
    },
    {
      name: 'legacy keeps the leftmost X-Forwarded-For entry',
      policy: LEGACY,
      headers: { 'x-forwarded-for': '203.0.113.66, 198.51.100.7' },
      expected: '203.0.113.66',
    },
    {
      name: 'legacy keeps the Forwarded fallback',
      policy: LEGACY,
      headers: { forwarded: 'for="[2001:db8::1]:4711"' },
      expected: '2001:db8::1',
    },
  ])('$name', ({ policy, headers, expected, socket }) => {
    const incoming = Array.isArray(headers)
      ? withLines(headers)
      : request(headers as Record<string, string>);
    expect(nodeClientIp(incoming, socket === undefined ? SOCKET : socket, policy)).toBe(expected);
  });

  const longList = Array.from({ length: 12 }, (_, index) => `198.51.100.${index + 1}`).join(', ');

  it.each([0, -1, 1.5, Number.NaN, 11, 12])(
    'falls back to the socket for out-of-range xff hops %s on a long list',
    (hops) => {
      expect(nodeClientIp(request({ 'x-forwarded-for': longList }), SOCKET, xff(hops))).toBe(
        SOCKET,
      );
    },
  );

  it.each([1, 10])('accepts xff hops %s on the same long list', (hops) => {
    expect(nodeClientIp(request({ 'x-forwarded-for': longList }), SOCKET, xff(hops))).toBe(
      `198.51.100.${13 - hops}`,
    );
  });

  it('falls back to the socket for an unknown kind', () => {
    const unknown = { kind: 'forwarded' } as unknown as TrustedProxy;
    expect(nodeClientIp(request(spoofed), SOCKET, unknown)).toBe(SOCKET);
  });

  it('maps the boolean option onto none and legacy', () => {
    const incoming = request(spoofed);
    expect(nodeClientIp(incoming, SOCKET, false)).toBe(nodeClientIp(incoming, SOCKET, NONE));
    expect(nodeClientIp(incoming, SOCKET, true)).toBe(nodeClientIp(incoming, SOCKET, LEGACY));
  });
});

describe('parseTrustedProxy', () => {
  it.each<[string | undefined, TrustedProxy]>([
    [undefined, NONE],
    ['0', NONE],
    ['1', LEGACY],
    ['cloudflare', CLOUDFLARE],
    ['xff:1', xff(1)],
    ['xff:2', xff(2)],
    ['xff:9', xff(9)],
    ['xff:10', xff(10)],
  ])('accepts %j', (value, expected) => {
    expect(parseTrustedProxy(value)).toEqual(expected);
  });

  it.each([
    '',
    'true',
    'false',
    '2',
    ' 1 ',
    'Cloudflare',
    'cloudflare ',
    'xff',
    'xff:',
    'xff:0',
    'xff:01',
    'xff:11',
    'xff:99',
    'xff:-1',
    'xff:1.5',
    'xff: 1',
    'XFF:1',
    'xff:1 ',
    'xff:1,2',
  ])('rejects %j', (value) => {
    expect(parseTrustedProxy(value)).toBeNull();
  });
});
