import { describe, expect, it } from 'vitest';
import type { FixedLengthStream, R2Bucket } from '@cloudflare/workers-types';
import type { FixedLengthStreamLike, R2BucketLike } from './r2.js';

describe('R2 shapes against the Workers binding types', () => {
  it('accepts the real R2Bucket binding', () => {
    const binding = {} as R2Bucket;
    const like: R2BucketLike = binding;
    expect(like).toBe(binding);
  });

  it('accepts the real FixedLengthStream', () => {
    const stream = {} as FixedLengthStream;
    const like: FixedLengthStreamLike = stream;
    expect(like).toBe(stream);
  });

  it('rejects a method R2 does not have', () => {
    const like = {} as R2BucketLike;
    // @ts-expect-error R2 has no truncate()
    const call = (): unknown => like.truncate();
    expect(call).toBeTypeOf('function');
  });

  it('rejects an invalid put result', () => {
    // @ts-expect-error R2 objects require a numeric size
    const put: R2BucketLike['put'] = async () => ({ size: 'invalid' });
    expect(put).toBeTypeOf('function');
  });

  it('rejects an invalid get result', () => {
    // @ts-expect-error R2 get results require an object body
    const get: R2BucketLike['get'] = async () => ({ size: 1, body: 'invalid' });
    expect(get).toBeTypeOf('function');
  });

  it('rejects a get result without a body', () => {
    // @ts-expect-error R2 get results require a body
    const get: R2BucketLike['get'] = async () => ({ size: 1 });
    expect(get).toBeTypeOf('function');
  });

  it('accepts reduced fake results', () => {
    const bucket: R2BucketLike = {
      put: async () => ({ size: 1 }),
      get: async () => null,
      head: async () => ({ size: 1 }),
      delete: async () => {},
    };
    expect(bucket).toHaveProperty('put');
  });

  it('rejects an invalid head result', () => {
    // @ts-expect-error R2 objects require a numeric size
    const head: R2BucketLike['head'] = async () => ({ size: 'invalid' });
    expect(head).toBeTypeOf('function');
  });
});
