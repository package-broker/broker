import { createDeflateRaw, gunzipSync } from 'node:zlib';
import { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { gzipFrame } from './gzip-frame.js';
import { stream } from '../../test-support/npm-publish.js';

it.each(['', '123456789', 'é'.repeat(100000)])(
  'frames raw deflate with a valid crc32 and size (%#. input)',
  async (value) => {
    const bytes = new TextEncoder().encode(value);
    const output = new Uint8Array(
      await new Response(
        gzipFrame(stream(bytes, value === '123456789' ? 1 : 4093), {
          deflateRaw: () => Duplex.toWeb(createDeflateRaw()),
        }),
      ).arrayBuffer(),
    );
    expect(gunzipSync(output)).toEqual(Buffer.from(bytes));
    expect(Array.from(output.subarray(0, 10))).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]);
    if (value === '123456789')
      expect(new DataView(output.buffer).getUint32(output.length - 8, true)).toBe(0xcbf43926);
  },
);
it('propagates source errors', async () => {
  const source = new ReadableStream<Uint8Array>({
    pull(c) {
      c.error(new Error('source_failed'));
    },
  });
  await expect(
    new Response(
      gzipFrame(source, { deflateRaw: () => Duplex.toWeb(createDeflateRaw()) }),
    ).arrayBuffer(),
  ).rejects.toThrow('source_failed');
});
