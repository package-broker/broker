import { walkTarball } from '../registry/npm/tarball-walk';

const enc = new TextEncoder();
export function entry(path: string, body = '', type = '0', size?: number): Uint8Array {
  const bytes = enc.encode(body);
  const header = new Uint8Array(512);
  const put = (at: number, text: string) => header.set(enc.encode(text), at);
  put(0, path);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, (size ?? bytes.length).toString(8).padStart(11, '0') + '\0');
  put(136, '00000000000\0');
  put(148, '        ');
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  checksum(header);
  return join(header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
}
export function checksum(bytes: Uint8Array): void {
  bytes.fill(32, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((n, b) => n + b, 0);
  bytes.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
}
export function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
export function stream(bytes: Uint8Array, chunk = 137): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at === bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.subarray(at, (at += Math.min(chunk, bytes.length - at))));
    },
  });
}
export const manifest = JSON.stringify({ name: 'test-package', version: '1.0.0' });
export const archive = (...parts: Uint8Array[]) => join(...parts, new Uint8Array(1024));
export function pax(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let size = enc.encode(suffix).length + 1;
  while (String(size).length + enc.encode(suffix).length !== size)
    size = String(size).length + enc.encode(suffix).length;
  return `${size}${suffix}`;
}
export const walk = (bytes: Uint8Array, limits = {}) =>
  walkTarball(stream(bytes), { name: 'test-package', version: '1.0.0', ...limits });
