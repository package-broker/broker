const MAX_DEPTH = 64;
const DEFAULT_MAX_STRING_BYTES = 1024 * 1024;
const DECODE_CHUNK_UNITS = 8192;
const DEFAULT_MAX_SCALAR_BYTES = 1024;
const MAX_LITERAL_BYTES = 5;

export type JsonStreamErrorCode =
  | 'invalid_utf8'
  | 'invalid_syntax'
  | 'unterminated'
  | 'trailing_garbage'
  | 'depth_exceeded'
  | 'token_too_large'
  | 'closed';

export class JsonStreamError extends Error {
  readonly code: JsonStreamErrorCode;
  readonly offset: number;

  constructor(code: JsonStreamErrorCode, offset: number) {
    super(`Invalid JSON stream (${code}) at byte ${offset}`);
    this.name = 'JsonStreamError';
    this.code = code;
    this.offset = offset;
  }
}

export type JsonToken =
  | {
      readonly type:
        'beginObject' | 'endObject' | 'beginArray' | 'endArray' | 'true' | 'false' | 'null';
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: 'key' | 'string';
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly type: 'number'; readonly raw: string; readonly start: number; readonly end: number };

export type JsonTokenSink = (token: JsonToken) => void;

export interface JsonTokenizerOptions {
  /** Largest decoded size in bytes of one string or key. */
  readonly maxStringBytes?: number;
  /** Largest size in bytes of one number lexeme. */
  readonly maxScalarBytes?: number;
}

type Expect = 'value' | 'valueOrEnd' | 'keyOrEnd' | 'key' | 'colon' | 'commaOrEnd' | 'done';
type Mode = 'none' | 'string' | 'number' | 'literal';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_PREFIX_PATTERN = /^-$|^-?(?:0|[1-9]\d*)(?:\.|(?:\.\d+)?(?:[eE][+-]?\d*)?)$/;
const LITERALS = ['true', 'false', 'null'];
const SIMPLE_ESCAPES = new Map<number, number>([
  [0x22, 0x22],
  [0x5c, 0x5c],
  [0x2f, 0x2f],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
]);

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isNumberByte = (byte: number): boolean =>
  isDigit(byte) ||
  byte === 0x2b ||
  byte === 0x2d ||
  byte === 0x2e ||
  byte === 0x65 ||
  byte === 0x45;
const isLetter = (byte: number): boolean => byte >= 0x61 && byte <= 0x7a;
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

function hexValue(byte: number): number {
  if (isDigit(byte)) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

export class JsonTokenizer {
  readonly #maxStringBytes: number;
  readonly #maxScalarBytes: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  readonly #stack: boolean[] = [];
  #offset = 0;
  #expect: Expect = 'value';
  #mode: Mode = 'none';
  #buffer = new Uint8Array(256);
  #length = 0;
  #lexemeStart = 0;
  #isKey = false;
  #escape: 0 | 1 | 2 = 0;
  #hexLeft = 0;
  #hexValue = 0;
  #pendingHigh = -1;
  #loneAt = new Uint32Array(16);
  #loneUnit = new Uint16Array(16);
  #loneCount = 0;
  #skipPending = false;
  #muted = false;
  #muteDepth = 0;
  #bareNext = false;
  #bare = false;
  #bareDepth = 0;
  #closed = false;
  #failure: { readonly error: unknown } | null = null;

  constructor(options: JsonTokenizerOptions = {}) {
    this.#maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
    this.#maxScalarBytes = options.maxScalarBytes ?? DEFAULT_MAX_SCALAR_BYTES;
  }

  /** Discards the next value (scalar or whole container) without emitting or buffering it. */
  skipNext(): void {
    if (!this.#muted) {
      this.#skipPending = true;
    }
  }

  /**
   * Structure-only mode for the next value (scalar or whole container): tokens are emitted and
   * everything is validated, but string values are not decoded or buffered and arrive as ''.
   * Keys are still decoded.
   */
  structureOnlyNext(): void {
    if (!this.#muted) {
      this.#bareNext = true;
    }
  }

  write(chunk: Uint8Array, sink: JsonTokenSink): void {
    this.#guard();
    try {
      const base = this.#offset;
      const size = chunk.length;
      let index = 0;
      while (index < size) {
        if (this.#mode === 'string') {
          index = this.#scanString(chunk, index, base, sink);
          continue;
        }
        this.#byte(chunk[index] as number, base + index, sink);
        index += 1;
      }
      this.#offset = base + size;
    } catch (error) {
      this.#failure = { error };
      throw error;
    }
  }

  end(sink: JsonTokenSink): void {
    this.#guard();
    try {
      if (this.#mode === 'string') {
        throw new JsonStreamError('unterminated', this.#offset);
      }
      if (this.#mode !== 'none') {
        this.#finishScalar(this.#offset, sink, true);
      }
      if (this.#expect !== 'done') {
        throw new JsonStreamError('unterminated', this.#offset);
      }
      this.#closed = true;
    } catch (error) {
      this.#failure = { error };
      throw error;
    }
  }

  #lean(): boolean {
    return this.#muted || (this.#bare && !this.#isKey);
  }

  #guard(): void {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
    if (this.#closed) {
      throw new JsonStreamError('closed', this.#offset);
    }
  }

  #emit(sink: JsonTokenSink, token: JsonToken): void {
    if (!this.#muted) {
      sink(token);
    }
  }

  #byte(byte: number, at: number, sink: JsonTokenSink): void {
    if (this.#mode === 'number' || this.#mode === 'literal') {
      if (this.#mode === 'number' ? isNumberByte(byte) : isLetter(byte)) {
        this.#pushScalarByte(byte);
        return;
      }
      this.#finishScalar(at, sink, false);
    }
    this.#structuralByte(byte, at, sink);
  }

  #pushScalarByte(byte: number): void {
    if (
      this.#mode === 'literal'
        ? this.#length >= MAX_LITERAL_BYTES
        : this.#length >= this.#maxScalarBytes
    ) {
      throw new JsonStreamError(
        this.#mode === 'literal' ? 'invalid_syntax' : 'token_too_large',
        this.#lexemeStart,
      );
    }
    this.#reserve(1);
    this.#buffer[this.#length] = byte;
    this.#length += 1;
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(needed, this.#buffer.length * 2));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
  }

  #scanString(chunk: Uint8Array, from: number, base: number, sink: JsonTokenSink): number {
    const size = chunk.length;
    let index = from;
    if (
      this.#length === 0 &&
      this.#escape === 0 &&
      this.#pendingHigh < 0 &&
      this.#loneCount === 0 &&
      !this.#lean()
    ) {
      let end = index;
      while (end < size) {
        const byte = chunk[end] as number;
        if (byte === QUOTE) {
          if (end - index > this.#maxStringBytes) {
            throw new JsonStreamError('token_too_large', this.#lexemeStart);
          }
          this.#emitString(this.#asciiText(chunk, index, end), base + end, sink);
          return end + 1;
        }
        if (byte === BACKSLASH || byte < 0x20 || byte >= 0x80) {
          break;
        }
        end += 1;
      }
    }
    while (index < size) {
      if (this.#escape !== 0) {
        this.#escapeByte(chunk[index] as number, base + index);
        index += 1;
        continue;
      }
      let end = index;
      while (end < size) {
        const byte = chunk[end] as number;
        if (byte === QUOTE || byte === BACKSLASH || byte < 0x20) {
          break;
        }
        end += 1;
      }
      if (end > index) {
        this.#appendSpan(chunk.subarray(index, end), base + index);
        index = end;
        if (index >= size) {
          break;
        }
      }
      const byte = chunk[index] as number;
      if (byte === QUOTE) {
        this.#finishString(base + index, sink);
        return index + 1;
      }
      if (byte !== BACKSLASH) {
        throw new JsonStreamError('invalid_syntax', base + index);
      }
      if (this.#lean()) {
        this.#flushDecoder(base + index);
      }
      this.#escape = 1;
      index += 1;
    }
    return index;
  }

  #appendSpan(span: Uint8Array, at: number): void {
    if (this.#lean()) {
      try {
        this.#decoder.decode(span, { stream: true });
      } catch {
        throw new JsonStreamError('invalid_utf8', at);
      }
      return;
    }
    this.#flushHigh();
    this.#checkRoom(span.length);
    this.#reserve(span.length);
    this.#buffer.set(span, this.#length);
    this.#length += span.length;
  }

  #checkRoom(extra: number): void {
    if (this.#length + extra > this.#maxStringBytes) {
      throw new JsonStreamError('token_too_large', this.#lexemeStart);
    }
  }

  #flushHigh(): void {
    if (this.#pendingHigh >= 0) {
      this.#pushLone(this.#pendingHigh);
      this.#pendingHigh = -1;
    }
  }

  #pushLone(unit: number): void {
    this.#checkRoom(3);
    this.#reserve(3);
    if (this.#loneCount === this.#loneAt.length) {
      const at = new Uint32Array(this.#loneCount * 2);
      at.set(this.#loneAt);
      this.#loneAt = at;
      const units = new Uint16Array(this.#loneCount * 2);
      units.set(this.#loneUnit);
      this.#loneUnit = units;
    }
    this.#loneAt[this.#loneCount] = this.#length;
    this.#loneUnit[this.#loneCount] = unit;
    this.#loneCount += 1;
    this.#length += 3;
  }

  #escapeByte(byte: number, at: number): void {
    if (this.#escape === 1) {
      if (byte === 0x75) {
        this.#escape = 2;
        this.#hexLeft = 4;
        this.#hexValue = 0;
        return;
      }
      const code = SIMPLE_ESCAPES.get(byte);
      if (code === undefined) {
        throw new JsonStreamError('invalid_syntax', at);
      }
      this.#escape = 0;
      this.#codePoint(code);
      return;
    }
    const digit = hexValue(byte);
    if (digit < 0) {
      throw new JsonStreamError('invalid_syntax', at);
    }
    this.#hexValue = this.#hexValue * 16 + digit;
    this.#hexLeft -= 1;
    if (this.#hexLeft === 0) {
      this.#escape = 0;
      this.#codeUnit(this.#hexValue);
    }
  }

  #codeUnit(unit: number): void {
    if (this.#lean()) {
      return;
    }
    if (this.#pendingHigh >= 0 && isLowSurrogate(unit)) {
      const point = 0x10000 + ((this.#pendingHigh - 0xd800) << 10) + (unit - 0xdc00);
      this.#pendingHigh = -1;
      this.#writePoint(point);
      return;
    }
    this.#flushHigh();
    if (isHighSurrogate(unit)) {
      this.#pendingHigh = unit;
    } else if (isLowSurrogate(unit)) {
      this.#pushLone(unit);
    } else {
      this.#writePoint(unit);
    }
  }

  #codePoint(point: number): void {
    if (this.#lean()) {
      return;
    }
    this.#flushHigh();
    this.#writePoint(point);
  }

  #writePoint(point: number): void {
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    this.#checkRoom(size);
    this.#reserve(size);
    const buffer = this.#buffer;
    const at = this.#length;
    if (size === 1) {
      buffer[at] = point;
    } else if (size === 2) {
      buffer[at] = 0xc0 | (point >> 6);
      buffer[at + 1] = 0x80 | (point & 0x3f);
    } else if (size === 3) {
      buffer[at] = 0xe0 | (point >> 12);
      buffer[at + 1] = 0x80 | ((point >> 6) & 0x3f);
      buffer[at + 2] = 0x80 | (point & 0x3f);
    } else {
      buffer[at] = 0xf0 | (point >> 18);
      buffer[at + 1] = 0x80 | ((point >> 12) & 0x3f);
      buffer[at + 2] = 0x80 | ((point >> 6) & 0x3f);
      buffer[at + 3] = 0x80 | (point & 0x3f);
    }
    this.#length += size;
  }

  #decode(): string {
    try {
      if (this.#loneCount === 0) {
        return this.#decoder.decode(this.#buffer.subarray(0, this.#length));
      }
      return this.#decodeLoneChunks().join('');
    } catch {
      throw new JsonStreamError('invalid_utf8', this.#lexemeStart);
    }
  }

  #decodeLoneChunks(): string[] {
    const units = new Uint16Array(this.#length - 2 * this.#loneCount);
    let size = 0;
    let from = 0;
    const copy = (to: number): void => {
      if (to > from) {
        const segment = this.#decoder.decode(this.#buffer.subarray(from, to));
        for (let offset = 0; offset < segment.length; offset += 1) {
          units[size + offset] = segment.charCodeAt(offset);
        }
        size += segment.length;
      }
    };
    for (let index = 0; index < this.#loneCount; index += 1) {
      const at = this.#loneAt[index] as number;
      copy(at);
      units[size] = this.#loneUnit[index] as number;
      size += 1;
      from = at + 3;
    }
    copy(this.#length);
    const chunks: string[] = [];
    for (let start = 0; start < size; start += DECODE_CHUNK_UNITS) {
      chunks.push(
        String.fromCharCode.apply(
          null,
          units.subarray(start, Math.min(start + DECODE_CHUNK_UNITS, size)) as unknown as number[],
        ),
      );
    }
    return chunks;
  }

  #flushDecoder(at: number): void {
    try {
      this.#decoder.decode();
    } catch {
      throw new JsonStreamError('invalid_utf8', at);
    }
  }

  #asciiText(chunk: Uint8Array, from: number, to: number): string {
    const span = chunk.subarray(from, to);
    return to - from <= 128
      ? String.fromCharCode.apply(null, span as unknown as number[])
      : this.#decoder.decode(span);
  }

  #finishString(at: number, sink: JsonTokenSink): void {
    this.#flushHigh();
    if (this.#muted) {
      this.#flushDecoder(at);
      this.#emitString(null, at, sink);
    } else if (this.#lean()) {
      this.#flushDecoder(at);
      this.#emitString('', at, sink);
    } else {
      this.#emitString(this.#decode(), at, sink);
    }
  }

  #emitString(value: string | null, at: number, sink: JsonTokenSink): void {
    this.#mode = 'none';
    if (value !== null) {
      sink({ type: this.#isKey ? 'key' : 'string', value, start: this.#lexemeStart, end: at + 1 });
    }
    this.#length = 0;
    this.#loneCount = 0;
    if (this.#isKey) {
      this.#expect = 'colon';
    } else {
      this.#valueDone();
    }
  }

  #finishScalar(at: number, sink: JsonTokenSink, atEnd: boolean): void {
    const text = String.fromCharCode.apply(
      null,
      this.#buffer.subarray(0, this.#length) as unknown as number[],
    );
    const start = this.#lexemeStart;
    if (this.#mode === 'number') {
      if (!NUMBER_PATTERN.test(text)) {
        throw new JsonStreamError(
          atEnd && NUMBER_PREFIX_PATTERN.test(text) ? 'unterminated' : 'invalid_syntax',
          atEnd ? at : start,
        );
      }
      this.#emit(sink, { type: 'number', raw: text, start, end: at });
    } else {
      if (text !== 'true' && text !== 'false' && text !== 'null') {
        const prefix = atEnd && LITERALS.some((literal) => literal.startsWith(text));
        throw new JsonStreamError(prefix ? 'unterminated' : 'invalid_syntax', prefix ? at : start);
      }
      this.#emit(sink, { type: text, start, end: at });
    }
    this.#length = 0;
    this.#mode = 'none';
    this.#valueDone();
  }

  #valueDone(): void {
    if (this.#muted && this.#stack.length === this.#muteDepth) {
      this.#muted = false;
    }
    if (this.#bare && this.#stack.length === this.#bareDepth) {
      this.#bare = false;
    }
    this.#expect = this.#stack.length === 0 ? 'done' : 'commaOrEnd';
  }

  #expectValue(at: number): void {
    if (this.#expect !== 'value' && this.#expect !== 'valueOrEnd') {
      throw new JsonStreamError('invalid_syntax', at);
    }
    if (this.#skipPending) {
      this.#skipPending = false;
      this.#muted = true;
      this.#muteDepth = this.#stack.length;
    } else if (this.#bareNext) {
      this.#bareNext = false;
      this.#bare = true;
      this.#bareDepth = this.#stack.length;
    }
  }

  #open(
    isObject: boolean,
    type: 'beginObject' | 'beginArray',
    at: number,
    sink: JsonTokenSink,
  ): void {
    this.#expectValue(at);
    if (this.#stack.length >= MAX_DEPTH) {
      throw new JsonStreamError('depth_exceeded', at);
    }
    this.#stack.push(isObject);
    this.#emit(sink, { type, start: at, end: at + 1 });
    this.#expect = isObject ? 'keyOrEnd' : 'valueOrEnd';
  }

  #close(isObject: boolean, type: 'endObject' | 'endArray', at: number, sink: JsonTokenSink): void {
    const empty = isObject ? 'keyOrEnd' : 'valueOrEnd';
    if (
      (this.#expect !== empty && this.#expect !== 'commaOrEnd') ||
      this.#stack[this.#stack.length - 1] !== isObject
    ) {
      throw new JsonStreamError('invalid_syntax', at);
    }
    this.#stack.pop();
    this.#skipPending = false;
    this.#bareNext = false;
    this.#emit(sink, { type, start: at, end: at + 1 });
    this.#valueDone();
  }

  #structuralByte(byte: number, at: number, sink: JsonTokenSink): void {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      return;
    }
    if (byte >= 0x80) {
      throw new JsonStreamError(byte < 0xc2 || byte > 0xf4 ? 'invalid_utf8' : 'invalid_syntax', at);
    }
    if (this.#expect === 'done') {
      throw new JsonStreamError('trailing_garbage', at);
    }
    switch (byte) {
      case 0x7b:
        this.#open(true, 'beginObject', at, sink);
        return;
      case 0x5b:
        this.#open(false, 'beginArray', at, sink);
        return;
      case 0x7d:
        this.#close(true, 'endObject', at, sink);
        return;
      case 0x5d:
        this.#close(false, 'endArray', at, sink);
        return;
      case 0x2c:
        if (this.#expect !== 'commaOrEnd') {
          throw new JsonStreamError('invalid_syntax', at);
        }
        this.#expect = this.#stack[this.#stack.length - 1] === true ? 'key' : 'value';
        return;
      case 0x3a:
        if (this.#expect !== 'colon') {
          throw new JsonStreamError('invalid_syntax', at);
        }
        this.#expect = 'value';
        return;
      case QUOTE:
        this.#isKey = this.#expect === 'key' || this.#expect === 'keyOrEnd';
        if (!this.#isKey) {
          this.#expectValue(at);
        }
        this.#startLexeme('string', byte, at);
        return;
      default:
        if (byte === 0x2d || isDigit(byte)) {
          this.#expectValue(at);
          this.#startLexeme('number', byte, at);
        } else if (isLetter(byte)) {
          this.#expectValue(at);
          this.#startLexeme('literal', byte, at);
        } else {
          throw new JsonStreamError('invalid_syntax', at);
        }
    }
  }

  #startLexeme(mode: Mode, byte: number, at: number): void {
    this.#mode = mode;
    this.#lexemeStart = at;
    this.#length = 0;
    this.#escape = 0;
    this.#loneCount = 0;
    this.#pendingHigh = -1;
    if (mode !== 'string') {
      this.#pushScalarByte(byte);
    }
  }
}
