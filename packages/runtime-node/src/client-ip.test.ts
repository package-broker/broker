import { describe, expect, it } from 'vitest';
import { nodeClientIp } from './client-ip.js';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://broker.test', { headers });

describe('Node client IP trust boundary', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('defaults to socket address %s', (peer) => {
    expect(
      nodeClientIp(
        request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
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
    '',
    'unknown',
    '999.1.1.1',
    '1.2.3',
    ':::',
    'a:b',
    'fe80::1%eth0',
    '[::1]',
    '192.0.2.1:80',
  ])('refuses invalid header %j without falling back', (value) => {
    expect(
      nodeClientIp(
        request({ 'cf-connecting-ip': value, 'x-forwarded-for': '198.51.100.1' }),
        '127.0.0.1',
        true,
      ),
    ).toBeNull();
    expect(
      nodeClientIp(request({ 'x-forwarded-for': `${value}, 192.0.2.1` }), '::1', true),
    ).toBeNull();
  });
});
