import type { Codecs } from '../../platform/codec';

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});

export function gzipFrame(
  body: ReadableStream<Uint8Array>,
  codecs: Pick<Codecs, 'deflateRaw'>,
): ReadableStream<Uint8Array> {
  const compressor = codecs.deflateRaw();
  let crc = 0xffffffff,
    size = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
        size = (size + chunk.length) >>> 0;
        controller.enqueue(chunk);
      },
    }),
  );
  const reader = counted.pipeThrough(compressor).getReader();
  let header = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (header) {
        header = false;
        controller.enqueue(Uint8Array.of(31, 139, 8, 0, 0, 0, 0, 0, 0, 255));
        return;
      }
      try {
        const next = await reader.read();
        if (!next.done) controller.enqueue(next.value);
        else {
          const trailer = new Uint8Array(8);
          const view = new DataView(trailer.buffer);
          view.setUint32(0, (crc ^ 0xffffffff) >>> 0, true);
          view.setUint32(4, size, true);
          controller.enqueue(trailer);
          controller.close();
          reader.releaseLock();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
