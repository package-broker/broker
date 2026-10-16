const MAX_PACKET = 65520;
const MAX_PAYLOAD = MAX_PACKET - 4;
const MAX_EMPTY_CHUNKS = 1000;
const HEADER = /^[0-9a-fA-F]{4}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH: Uint8Array = encoder.encode('0000');
export const DELIM: Uint8Array = encoder.encode('0001');
export const RESPONSE_END: Uint8Array = encoder.encode('0002');

export type PktLineErrorCode =
  | 'bad_length'
  | 'oversized_line'
  | 'truncated'
  | 'total_cap'
  | 'bad_band'
  | 'unsupported_packet'
  | 'trailing_data'
  | 'stalled'
  | 'busy'
  | 'source_error';

export class PktLineError extends Error {
  readonly code: PktLineErrorCode;

  constructor(code: PktLineErrorCode) {
    super(code);
    this.name = 'PktLineError';
    this.code = code;
  }
}

export type GitRemoteErrorCode = 'remote_error' | 'remote_band3';

export class GitRemoteError extends Error {
  readonly code: GitRemoteErrorCode;

  constructor(code: GitRemoteErrorCode) {
    super(code);
    this.name = 'GitRemoteError';
    this.code = code;
  }
}

export type Packet =
  { kind: 'data'; data: Uint8Array } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export type SidebandPacket = { band: 1; data: Uint8Array } | { band: 2; length: number };

export type PktLineReaderOptions = { maxTotalBytes: number; protocol?: 1 | 2 };

export function encodePkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
  if (body.length === 0) throw new PktLineError('bad_length');
  if (body.length > MAX_PAYLOAD) throw new PktLineError('oversized_line');
  const out = new Uint8Array(body.length + 4);
  out.set(encoder.encode((body.length + 4).toString(16).padStart(4, '0')));
  out.set(body, 4);
  return out;
}

export function decodeSideband(data: Uint8Array): SidebandPacket {
  const band = data[0];
  if (band === 3) throw new GitRemoteError('remote_band3');
  if (band === 1) return { band, data: data.subarray(1) };
  if (band === 2) return { band, length: data.length - 1 };
  throw new PktLineError('bad_band');
}

export class PktLineReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly maxTotalBytes: number;
  private readonly protocol: 1 | 2;
  private chunks: Uint8Array[] = [];
  private head = 0;
  private buffered = 0;
  private received = 0;
  private emptyChunks = 0;
  private consumed = 0;
  private ended = false;
  private exhausted = false;
  private failure: Error | null = null;
  private reading = false;

  constructor(source: AsyncIterable<Uint8Array>, options: PktLineReaderOptions) {
    if (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes <= 0) {
      throw new RangeError('maxTotalBytes must be a positive safe integer');
    }
    this.iterator = source[Symbol.asyncIterator]();
    this.maxTotalBytes = options.maxTotalBytes;
    const protocol = options.protocol === undefined ? 2 : options.protocol;
    if (protocol !== 1 && protocol !== 2) throw new RangeError('protocol must be 1 or 2');
    this.protocol = protocol;
  }

  get consumedBytes(): number {
    return this.consumed;
  }

  async next(): Promise<Packet | null> {
    return this.guard(() => this.read());
  }

  async nextSideband(): Promise<Packet | null> {
    return this.guard(async () => {
      for (;;) {
        const packet = await this.read();
        if (packet === null || packet.kind !== 'data') return packet;
        const decoded = decodeSideband(packet.data);
        if (decoded.band === 1) return { kind: 'data', data: decoded.data };
      }
    });
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.reading) throw new PktLineError('busy');
    this.reading = true;
    try {
      return await run();
    } catch (error) {
      this.failure = error instanceof Error ? error : new PktLineError('source_error');
      this.chunks = [];
      this.head = 0;
      this.buffered = 0;
      this.close();
      throw this.failure;
    } finally {
      this.reading = false;
    }
  }

  private close(): void {
    void Promise.resolve()
      .then(() => this.iterator.return?.())
      .catch(() => undefined);
  }

  private async read(): Promise<Packet | null> {
    if (this.ended) {
      if ((await this.take(1, true)) !== null) throw new PktLineError('trailing_data');
      return null;
    }
    const header = await this.take(4, true);
    if (header === null) return null;
    const text = decoder.decode(header);
    if (!HEADER.test(text)) throw new PktLineError('bad_length');
    const length = Number.parseInt(text, 16);
    if (length > MAX_PACKET) throw new PktLineError('oversized_line');
    if (length === 3) throw new PktLineError('bad_length');
    if (length === 1 || length === 2) {
      if (this.protocol === 1) throw new PktLineError('unsupported_packet');
    }
    const size = Math.max(length, 4);
    if (this.consumed + size > this.maxTotalBytes) throw new PktLineError('total_cap');
    this.consumed += size;
    if (length === 0) return { kind: 'flush' };
    if (length === 1) return { kind: 'delim' };
    if (length === 2) {
      this.ended = true;
      return { kind: 'end' };
    }
    const data = (await this.take(length - 4, false)) as Uint8Array;
    if (data[0] === 0x45 && data[1] === 0x52 && data[2] === 0x52 && data[3] === 0x20) {
      throw new GitRemoteError('remote_error');
    }
    return { kind: 'data', data };
  }

  private async take(size: number, allowCleanEnd: boolean): Promise<Uint8Array | null> {
    while (this.buffered < size) {
      const next = this.exhausted
        ? { done: true as const, value: undefined }
        : await this.iterator.next();
      if (next.done) {
        this.exhausted = true;
        if (allowCleanEnd && this.buffered === 0) return null;
        throw new PktLineError('truncated');
      }
      const chunk = next.value;
      if (chunk.length > 0) this.emptyChunks = 0;
      else {
        this.emptyChunks += 1;
        if (this.emptyChunks > MAX_EMPTY_CHUNKS) throw new PktLineError('stalled');
        continue;
      }
      if (this.received + chunk.length > this.maxTotalBytes) throw new PktLineError('total_cap');
      this.received += chunk.length;
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const chunk = this.chunks[this.head] as Uint8Array;
      const used = Math.min(chunk.length, size - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.length) {
        this.head += 1;
        if (this.head > 64 && this.head * 2 > this.chunks.length) {
          this.chunks = this.chunks.slice(this.head);
          this.head = 0;
        }
      } else {
        this.chunks[this.head] = chunk.subarray(used);
      }
    }
    this.buffered -= size;
    return out;
  }
}
