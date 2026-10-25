import { isIpLiteral } from '@package-broker/core/audit/actions';
import { sessionMetaOf } from '@package-broker/core/auth/session';
import { describe, expect, it } from 'vitest';
import { clientIpOf } from './client-ip.js';

function requestWith(cookie: string | null, headers: Record<string, string> = {}): Request {
  const all: Record<string, string> = { ...headers };
  if (cookie !== null) {
    all.cookie = cookie;
  }
  return new Request('https://broker.example.test/_pb/auth/me', { headers: all });
}

describe('sessionMetaOf with clientIpOf', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
      'test-request-id',
      clientIpOf,
    );
    expect(meta.ip).toBe('203.0.113.7');
  });

  it('takes the first x-forwarded-for entry', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'x-forwarded-for': ' 198.51.100.1 , 192.0.2.9, 192.0.2.10' }),
      'test-request-id',
      clientIpOf,
    );
    expect(meta.ip).toBe('198.51.100.1');
  });

  it('returns null ip when no header gives an address', async () => {
    expect((await sessionMetaOf(requestWith(null), 'test-request-id', clientIpOf)).ip).toBeNull();
    expect(
      (
        await sessionMetaOf(
          requestWith(null, { 'x-forwarded-for': ' , 192.0.2.9' }),
          'test-request-id',
          clientIpOf,
        )
      ).ip,
    ).toBeNull();
    expect(
      (
        await sessionMetaOf(
          requestWith(null, { 'cf-connecting-ip': '  ' }),
          'test-request-id',
          clientIpOf,
        )
      ).ip,
    ).toBeNull();
  });

  it('keeps only IP literals', async () => {
    const accepted = ['203.0.113.7', '2001:db8::1', '::ffff:192.0.2.1'];
    for (const ip of accepted) {
      expect(
        (
          await sessionMetaOf(
            requestWith(null, { 'cf-connecting-ip': ip }),
            'test-request-id',
            clientIpOf,
          )
        ).ip,
      ).toBe(ip);
    }
    const rejected = [
      'a'.repeat(64),
      'a'.repeat(65),
      'unknown',
      '1.2.3.4<script>',
      '203.0.113.7:80x',
      '1.2.3.4 5',
    ];
    for (const ip of rejected) {
      expect(
        (
          await sessionMetaOf(
            requestWith(null, { 'cf-connecting-ip': ip }),
            'test-request-id',
            clientIpOf,
          )
        ).ip,
      ).toBeNull();
      expect(
        (
          await sessionMetaOf(
            requestWith(null, { 'x-forwarded-for': ip }),
            'test-request-id',
            clientIpOf,
          )
        ).ip,
      ).toBeNull();
    }
  });

  it('does not fall back to x-forwarded-for when cf-connecting-ip is present but invalid', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'cf-connecting-ip': 'unknown', 'x-forwarded-for': '198.51.100.1' }),
      'test-request-id',
      clientIpOf,
    );
    expect(meta.ip).toBeNull();
  });
});

describe('clientIpOf', () => {
  const cases = [
    ['1.2', null],
    ['abc', null],
    ['::::', null],
    ['999.1.1.1', null],
    ['a'.repeat(8192), null],
    ['', null],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['2001:0DB8:0:0::1', '2001:0DB8:0:0::1'],
    ['::ffff:192.0.2.7', '::ffff:192.0.2.7'],
    ['fe80::1%eth0', null],
    ['[::1]', null],
    ['192.0.2.1:80', null],
    ['01.2.3.4', null],
  ] as const;

  it.each(cases)('returns only audit-compatible literals for case %#', (value, expected) => {
    for (const header of ['cf-connecting-ip', 'x-forwarded-for']) {
      const result = clientIpOf(requestWith(null, { [header]: value }));
      expect(result).toBe(expected);
      if (result !== null) expect(isIpLiteral(result)).toBe(true);
    }
  });

  it.each([
    [{ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }, '203.0.113.7'],
    [{ 'x-forwarded-for': ' 198.51.100.1 , 192.0.2.9' }, '198.51.100.1'],
    [{ 'cf-connecting-ip': 'unknown', 'x-forwarded-for': '198.51.100.1' }, null],
    [{ 'x-forwarded-for': 'unknown' }, null],
    [{}, null],
  ])('resolves client address from %j', (headers, expected) => {
    expect(clientIpOf(requestWith(null, headers))).toBe(expected);
  });
});
