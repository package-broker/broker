import { isIpLiteral } from '@package-broker/core/audit/actions';
import { describe, expect, it } from 'vitest';
import { nodeClientIp } from './client-ip.js';

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
