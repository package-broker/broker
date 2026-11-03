import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  NotificationConfigError,
  validateNotificationDestination,
  validateNotificationHeaders,
  validateNotificationMethod,
  validateSigningKey,
} from './config.js';

const SELF = {
  selfOrigins: [
    'https://Broker.Example.org',
    'https://packages.example.net:8443',
    'https://default.example.net:443/',
  ],
};

function refusal(run: () => unknown): NotificationConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationConfigError);
    return error as NotificationConfigError;
  }
  throw new Error('expected a refusal');
}

function expectFixedRefusal(run: () => unknown, ...sentinels: string[]): void {
  const error = refusal(run);
  expect(error.name).toBe('NotificationConfigError');
  expect(error.code).toBe('invalid_configuration');
  expect(error.message).toBe('Invalid notification configuration');
  const shown = `${inspect(error, { depth: 5, showHidden: true })} ${JSON.stringify(error)} ${String(error)}`;
  for (const sentinel of sentinels) expect(shown).not.toContain(sentinel);
}

describe('notification destination', () => {
  it('returns the canonical URL of a public HTTPS destination', () => {
    expect(validateNotificationDestination('https://hooks.example.com/path?token=x', SELF)).toBe(
      'https://hooks.example.com/path?token=x',
    );
    expect(validateNotificationDestination('HTTPS://Hooks.Example.COM:443/a/../b', SELF)).toBe(
      'https://hooks.example.com/b',
    );
    expect(validateNotificationDestination('https://hooks.example.com', SELF)).toBe(
      'https://hooks.example.com/',
    );
  });

  it.each([
    ['userinfo', 'https://user:SENTINEL@hooks.example.com/'],
    ['bare userinfo', 'https://SENTINEL@hooks.example.com/'],
    ['empty userinfo', 'https://@hooks.example.com/'],
    ['fragment', 'https://hooks.example.com/SENTINEL#frag'],
    ['empty fragment', 'https://hooks.example.com/SENTINEL#'],
    ['http', 'http://hooks.example.com/SENTINEL'],
    ['other scheme', 'wss://hooks.example.com/SENTINEL'],
    ['port 8443', 'https://hooks.example.com:8443/SENTINEL'],
    ['port 80', 'https://hooks.example.com:80/SENTINEL'],
    ['single label', 'https://hooks/SENTINEL'],
    ['trailing-dot single label', 'https://hooks./SENTINEL'],
    ['trailing dot', 'https://hooks.example.com./SENTINEL'],
    ['localhost', 'https://localhost/SENTINEL'],
    ['localhost suffix', 'https://api.localhost/SENTINEL'],
    ['local', 'https://printer.local/SENTINEL'],
    ['internal', 'https://metadata.google.internal/SENTINEL'],
    ['home.arpa', 'https://nas.home.arpa/SENTINEL'],
    ['lan', 'https://router.lan/SENTINEL'],
    ['corp', 'https://wiki.corp/SENTINEL'],
    ['test', 'https://hooks.example.test/SENTINEL'],
    ['example', 'https://hooks.example/SENTINEL'],
    ['invalid', 'https://hooks.invalid/SENTINEL'],
    ['onion', 'https://abcdefghijklmnop.onion/SENTINEL'],
    ['upper-case special-use suffix', 'https://Router.LAN/SENTINEL'],
    ['loopback v4', 'https://127.0.0.1/SENTINEL'],
    ['private v4', 'https://10.1.2.3/SENTINEL'],
    ['public v4 literal', 'https://8.8.8.8/SENTINEL'],
    ['hex v4', 'https://0x7f000001/SENTINEL'],
    ['decimal v4', 'https://2130706433/SENTINEL'],
    ['octal v4', 'https://0177.0.0.1/SENTINEL'],
    ['short v4', 'https://127.1/SENTINEL'],
    ['loopback v6', 'https://[::1]/SENTINEL'],
    ['zone id', 'https://[fe80::1%25eth0]/SENTINEL'],
    ['mapped v4', 'https://[::ffff:127.0.0.1]/SENTINEL'],
    ['nat64', 'https://[64:ff9b::a00:1]/SENTINEL'],
    ['6to4', 'https://[2002:a00:1::]/SENTINEL'],
    ['public v6 literal', 'https://[2606:4700::1111]/SENTINEL'],
    ['self origin', 'https://broker.example.org/SENTINEL'],
    ['self origin other case', 'https://BROKER.example.ORG/SENTINEL'],
    ['self origin with an explicit default port', 'https://default.example.net/SENTINEL'],
    ['CRLF', 'https://hooks.example.com/SENTINEL\r\nX: y'],
    ['tab', 'https://hooks.example.com/SEN\tTINEL'],
    ['NUL', 'https://hooks.example.com/SENTINEL\u0000'],
    ['DEL', 'https://hooks.example.com/SENTINEL\u007f'],
    ['leading space', ' https://hooks.example.com/SENTINEL'],
    ['no-break space', 'https://hooks.example.com/SENTINEL '],
    ['backslash', 'https://hooks.example.com\\SENTINEL'],
    ['relative', '/SENTINEL'],
    ['scheme without slashes', 'https:hooks.example.com/SENTINEL'],
    ['too long', `https://hooks.example.com/SENTINEL${'a'.repeat(2048)}`],
  ])('refuses %s', (_label, url) => {
    expectFixedRefusal(() => validateNotificationDestination(url, SELF), 'SENTINEL', url);
  });

  it('accepts a destination at the length limit and refuses one byte over it', () => {
    const base = 'https://hooks.example.com/';
    const atLimit = base + 'a'.repeat(2048 - base.length);
    expect(validateNotificationDestination(atLimit, SELF)).toBe(atLimit);
    expectFixedRefusal(() => validateNotificationDestination(`${atLimit}a`, SELF));
  });

  it('measures the limit on both the raw and the canonical URL', () => {
    const expanding = `https://hooks.example.com/${'\u00e9'.repeat(1000)}`;
    expect(expanding.length).toBeLessThan(2048);
    expectFixedRefusal(() => validateNotificationDestination(expanding, SELF));
    const shrinking = `https://hooks.example.com/${'a/../'.repeat(500)}x`;
    expect(new URL(shrinking).href.length).toBeLessThan(2048);
    expectFixedRefusal(() => validateNotificationDestination(shrinking, SELF));
  });

  it('matches a bare-host self origin case-insensitively', () => {
    expectFixedRefusal(() =>
      validateNotificationDestination('https://bare.example.com/x', {
        selfOrigins: ['BARE.example.com'],
      }),
    );
  });

  it('refuses a non-string destination', () => {
    expectFixedRefusal(() => validateNotificationDestination(42 as unknown as string, SELF));
  });

  it('compares a configured full self origin by scheme, host and port', () => {
    expect(validateNotificationDestination('https://packages.example.net/x', SELF)).toBe(
      'https://packages.example.net/x',
    );
    expect(
      validateNotificationDestination('https://plain.example.net/x', {
        selfOrigins: ['http://plain.example.net'],
      }),
    ).toBe('https://plain.example.net/x');
  });

  it('accepts a host that only contains a special-use label', () => {
    expect(validateNotificationDestination('https://test.example.com/x', SELF)).toBe(
      'https://test.example.com/x',
    );
    expect(validateNotificationDestination('https://hooks.lan.example.com/x', SELF)).toBe(
      'https://hooks.lan.example.com/x',
    );
  });

  it('does not treat a host sharing a suffix with a self origin as self', () => {
    expect(validateNotificationDestination('https://notbroker.example.org/x', SELF)).toBe(
      'https://notbroker.example.org/x',
    );
  });
});

describe('notification method', () => {
  it.each(['POST', 'PUT'])('accepts %s', (method) => {
    expect(validateNotificationMethod(method)).toBe(method);
  });

  it.each(['post', 'GET', 'PATCH', 'DELETE', '', null, 1])('refuses %s', (method) => {
    expectFixedRefusal(() => validateNotificationMethod(method));
  });
});

describe('notification headers', () => {
  it('accepts Authorization and X-* headers from pairs or a plain object', () => {
    expect(
      validateNotificationHeaders([
        ['Authorization', 'Bearer abc'],
        ['X-Team', 'core'],
      ]),
    ).toEqual([
      ['Authorization', 'Bearer abc'],
      ['X-Team', 'core'],
    ]);
    expect(validateNotificationHeaders({ authorization: 'Bearer abc', 'x-a': '' })).toEqual([
      ['authorization', 'Bearer abc'],
      ['x-a', ''],
    ]);
    expect(validateNotificationHeaders(Object.assign(Object.create(null), { 'X-B': 'b' }))).toEqual(
      [['X-B', 'b']],
    );
    expect(validateNotificationHeaders([])).toEqual([]);
  });

  it.each([
    'Host',
    'Cookie',
    'Proxy-Authorization',
    'Forwarded',
    'X-Forwarded-For',
    'x-forwarded-host',
    'X-Real-IP',
    'X-Client-IP',
    'X-Cluster-Client-IP',
    'Connection',
    'Keep-Alive',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'Proxy-Connection',
    'Content-Length',
    'Content-Type',
    'Content-Encoding',
    'traceparent',
    'tracestate',
    'X-B3-TraceId',
    'x-b3-sampled',
    'X-Request-Id',
    'X-Amzn-Trace-Id',
    'X-Cloud-Trace-Context',
    'Sentry-Trace',
    'Baggage',
    'Idempotency-Key',
    'X-Package-Broker-Signature',
    'x-package-broker-anything',
    'User-Agent',
    'Accept',
  ])('refuses the %s header', (name) => {
    expectFixedRefusal(() => validateNotificationHeaders([[name, 'SENTINEL']]), 'SENTINEL');
  });

  it.each([
    ['CRLF', 'a\r\nX-Injected: 1'],
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['tab', 'a\tb'],
    ['DEL', 'a\u007fb'],
    ['non-ASCII', 'caf\u00e9'],
    ['leading space', ' a', true],
    ['trailing space', 'a ', false],
  ])('refuses a value with %s', (_label, value, prefix = false) => {
    const header = prefix ? `${value}SENTINEL` : `SENTINEL${value}`;
    expectFixedRefusal(() => validateNotificationHeaders([['X-Token', header]]), 'SENTINEL');
  });

  it.each(['X Token', 'X-Token:', 'X-(a)', '', 'X-Tök', 'X-a\r\n'])(
    'refuses the name %j',
    (name) => {
      expectFixedRefusal(() => validateNotificationHeaders([[name, 'SENTINEL']]), 'SENTINEL');
    },
  );

  it('accepts every RFC 7230 tchar in a name', () => {
    const name = "X-!#$%&'*+.^_`|~09azAZ";
    expect(validateNotificationHeaders([[name, 'v']])).toEqual([[name, 'v']]);
  });

  it('refuses names duplicated in a different case', () => {
    expectFixedRefusal(
      () =>
        validateNotificationHeaders([
          ['X-Token', 'SENTINEL1'],
          ['x-TOKEN', 'SENTINEL2'],
        ]),
      'SENTINEL',
    );
  });

  it('accepts sixteen headers and refuses seventeen', () => {
    const pairs = Array.from({ length: 16 }, (_, index) => [`X-H${index}`, 'v'] as const);
    expect(validateNotificationHeaders(pairs)).toHaveLength(16);
    expectFixedRefusal(
      () => validateNotificationHeaders([...pairs, ['X-H16', 'SENTINEL']]),
      'SENTINEL',
    );
  });

  it('accepts 8 KiB of combined values and refuses one byte more', () => {
    const half = 'a'.repeat(4096);
    expect(
      validateNotificationHeaders([
        ['X-A', half],
        ['X-B', half],
      ]),
    ).toHaveLength(2);
    expectFixedRefusal(
      () =>
        validateNotificationHeaders([
          ['X-A', half],
          ['X-B', `${half}S`],
        ]),
      half,
    );
  });

  it.each([
    ['null', null],
    ['string', 'X-A: b'],
    ['pair of wrong length', [['X-A', 'b', 'c']]],
    ['non-string value', [['X-A', 1]]],
    ['non-string name', [[1, 'b']]],
    ['non-array pair', ['X-A']],
    ['class instance', new Map([['X-A', 'b']])],
    ['object with non-string value', { 'X-A': 1 }],
  ])('refuses %s input', (_label, input) => {
    expectFixedRefusal(() => validateNotificationHeaders(input));
  });

  it('refuses objects with a foreign prototype, accessors or symbol keys', () => {
    const inherited = Object.create({ 'X-Inherited': 'SENTINEL' }) as Record<string, string>;
    expectFixedRefusal(() => validateNotificationHeaders(inherited), 'SENTINEL');
    const accessor = {};
    Object.defineProperty(accessor, 'X-A', { get: () => 'SENTINEL', enumerable: true });
    expectFixedRefusal(() => validateNotificationHeaders(accessor), 'SENTINEL');
    expectFixedRefusal(
      () => validateNotificationHeaders({ [Symbol('x')]: 'SENTINEL' }),
      'SENTINEL',
    );
  });

  it('ignores non-enumerable own properties of a plain object', () => {
    const value = { 'X-A': 'a' };
    Object.defineProperty(value, 'X-Hidden', { value: 'h', enumerable: false });
    expect(validateNotificationHeaders(value)).toEqual([['X-A', 'a']]);
  });
});

describe('signing key', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
  const encoded = Buffer.from(bytes).toString('base64url');

  it('decodes a 32-byte unpadded base64url key', () => {
    expect(validateSigningKey(encoded)).toEqual(bytes);
    const highBits = Buffer.from(new Uint8Array(32).fill(0xfb)).toString('base64url');
    expect(highBits).toMatch(/[-_]/);
    expect(validateSigningKey(highBits)).toEqual(new Uint8Array(32).fill(0xfb));
  });

  it.each([
    ['padded', `${encoded}=`],
    ['standard alphabet', Buffer.from(new Uint8Array(32).fill(0xfb)).toString('base64')],
    ['31 bytes', Buffer.from(bytes.slice(1)).toString('base64url')],
    ['33 bytes', Buffer.from([...bytes, 1]).toString('base64url')],
    ['non-canonical trailing bits', `${encoded.slice(0, -1)}${encoded.endsWith('B') ? 'C' : 'B'}`],
    ['whitespace', ` ${encoded}`],
    ['empty', ''],
    ['non-string', 7],
  ])('refuses a %s key', (_label, key) => {
    expectFixedRefusal(() => validateSigningKey(key), encoded);
  });
});
