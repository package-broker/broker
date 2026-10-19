import { describe, expect, it } from 'vitest';
import { parsePublicOrigin, PublicOriginError } from './public-origin.js';

describe('parsePublicOrigin', () => {
  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['broker', 'absolute-url'],
    ['http://broker.test', 'scheme'],
    ['ftp://broker.test', 'scheme'],
    ['https://broker.test/path', 'origin'],
    ['https://broker.test/?q=1', 'origin'],
    ['https://broker.test/#fragment', 'origin'],
    ['https://user@broker.test', 'origin'],
    ['https://:password@broker.test', 'origin'],
    ['https://broker.test/?', 'origin'],
    ['https://broker.test/#', 'origin'],
  ])('rejects %j with a safe %s error', (raw, problem) => {
    try {
      parsePublicOrigin(raw);
      expect.unreachable('accepted invalid origin');
    } catch (error) {
      expect(error).toBeInstanceOf(PublicOriginError);
      expect(error).toMatchObject({ name: 'PublicOriginError', problem });
      expect((error as Error).message).toBe('Invalid public origin');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    ['https://Broker.Test/', 'https://broker.test'],
    ['https://broker.test:443', 'https://broker.test'],
    ['https://broker.test:8443', 'https://broker.test:8443'],
  ])('canonicalizes %s', (raw, origin) => {
    expect(parsePublicOrigin(raw)).toBe(origin);
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('requires explicit loopback HTTP for %s', (host) => {
    const raw = `http://${host}:8080/`;
    expect(() => parsePublicOrigin(raw)).toThrow(PublicOriginError);
    expect(parsePublicOrigin(raw, { http: 'loopback' })).toBe(`http://${host}:8080`);
  });

  it.each(['broker.test', 'localhost.evil.test', '127.0.0.2', '[::2]'])(
    'denies HTTP on %s',
    (host) => {
      expect(() => parsePublicOrigin(`http://${host}`, { http: 'loopback' })).toThrow(
        PublicOriginError,
      );
    },
  );

  it('preserves the kernel explicit HTTP policy without allowing other schemes', () => {
    expect(parsePublicOrigin('http://public.test/', { http: 'allow' })).toBe('http://public.test');
    expect(() => parsePublicOrigin('ftp://public.test', { http: 'allow' })).toThrow(
      PublicOriginError,
    );
  });
});
