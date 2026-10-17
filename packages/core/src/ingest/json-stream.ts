import { JsonStreamError, JsonTokenizer, type JsonToken } from './json-tokenizer.js';

const DEFAULT_MAX_MEMBER_BYTES = 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MEMBERS_PER_LEVEL = 400_000;
const KEY_LIMIT_BYTES = 64 * 1024;
const INITIAL_CAPTURE_BYTES = 1024;
const EMPTY_SLOT = -1;
const INITIAL_SLOTS = 8;
const NO_BYTES = new Uint8Array(0);

/** Final selector segment that selects each element of the array at the preceding path. */
export const ARRAY_ELEMENTS = '[]';

export type JsonExtractErrorCode =
  | 'member_too_large'
  | 'document_too_large'
  | 'too_many_members'
  | 'duplicate_key'
  | 'not_object'
  | 'not_array'
  | 'invalid_member';

export class JsonExtractError extends Error {
  readonly code: JsonExtractErrorCode;
  readonly offset: number;
  /** Set for `not_array`: the path of the offending value. Never part of the message. */
  readonly path: readonly string[] | undefined;

  constructor(code: JsonExtractErrorCode, offset: number, path?: readonly string[]) {
    super(`Invalid JSON member extraction (${code}) at byte ${offset}`);
    this.name = 'JsonExtractError';
    this.code = code;
    this.offset = offset;
    this.path = path;
  }
}

/**
 * Object key names from the document root; '*' matches any key but never an array element.
 * `ARRAY_ELEMENTS` as the last segment, and only there, selects each element of the array at
 * the preceding path; an object key spelled `[]` is matched only by '*'. No other arrays are
 * entered.
 */
export type MemberSelector = readonly string[];

export interface ExtractLimits {
  /** Largest raw size of one extracted member. Default 1 MiB. */
  readonly maxMemberBytes?: number;
  /** Largest size of the whole document. Default 32 MiB. */
  readonly maxDocumentBytes?: number;
  /**
   * Most distinct keys tracked for duplicate detection in one object, and most elements in one
   * array selected with `ARRAY_ELEMENTS`. Default 400000.
   */
  readonly maxMembersPerLevel?: number;
}

export interface ExtractOptions extends ExtractLimits {
  /**
   * What a value that is not an array does at a path selected with `ARRAY_ELEMENTS`: 'throw'
   * (default) throws `not_array`; 'report' yields a `notArray` record decided by the value's
   * first token and skips the value without retaining it.
   */
  readonly nonArray?: 'throw' | 'report';
}

interface ResolvedLimits {
  readonly maxMember: number;
  readonly maxDocument: number;
  readonly maxMembers: number;
}

/**
 * A selected object member (`path`, `raw`), an array element (`index` set, `path` ends with the
 * decimal index), after the last element of an element-selected array its end record
 * (`end: true`, `raw` is '[]', `path` is the array path, `count` its number of elements) or, with
 * `nonArray: 'report'`, a non-array at an element-selected path (`notArray: true`, `raw` is '').
 */
export type ExtractedMember =
  | {
      readonly path: readonly string[];
      readonly raw: string;
      readonly index?: undefined;
      readonly end?: undefined;
      readonly count?: undefined;
      readonly notArray?: undefined;
    }
  | {
      readonly path: readonly string[];
      readonly raw: string;
      readonly index: number;
      readonly end?: undefined;
      readonly count?: undefined;
      readonly notArray?: undefined;
    }
  | {
      readonly path: readonly string[];
      readonly raw: '[]';
      readonly index?: undefined;
      readonly end: true;
      readonly count: number;
      readonly notArray?: undefined;
    }
  | {
      readonly path: readonly string[];
      readonly raw: '';
      readonly index?: undefined;
      readonly end?: undefined;
      readonly count?: undefined;
      readonly notArray: true;
    };

interface Elements {
  readonly path: readonly string[];
  count: number;
}

interface Capture {
  readonly path: readonly string[];
  readonly index?: number;
  lead?: boolean;
  buffer: Uint8Array;
  length: number;
  from: number;
  depth: number;
  origin: number;
  scopes: (KeyTable | null | undefined)[];
}

class KeyTable {
  #slots = new Float64Array(INITIAL_SLOTS).fill(EMPTY_SLOT);
  #size = 0;

  get size(): number {
    return this.#size;
  }

  has(hash: number): boolean {
    const slots = this.#slots;
    let index = hash % slots.length;
    while (slots[index] !== EMPTY_SLOT) {
      if (slots[index] === hash) {
        return true;
      }
      index = (index + 1) % slots.length;
    }
    return false;
  }

  /** The hash must not be present. */
  add(hash: number): void {
    if ((this.#size + 1) * 2 > this.#slots.length) {
      this.#grow();
    }
    const slots = this.#slots;
    let index = hash % slots.length;
    while (slots[index] !== EMPTY_SLOT) {
      index = (index + 1) % slots.length;
    }
    slots[index] = hash;
    this.#size += 1;
  }

  #grow(): void {
    const old = this.#slots;
    const slots = new Float64Array(old.length * 2).fill(EMPTY_SLOT);
    for (const hash of old) {
      if (hash !== EMPTY_SLOT) {
        let index = hash % slots.length;
        while (slots[index] !== EMPTY_SLOT) {
          index = (index + 1) % slots.length;
        }
        slots[index] = hash;
      }
    }
    this.#slots = slots;
  }
}

function selects(selector: MemberSelector, path: readonly string[], whole: boolean): boolean {
  if (whole ? selector.length !== path.length : selector.length <= path.length) {
    return false;
  }
  return path.every((name, index) => selector[index] === '*' || selector[index] === name);
}

function overlaps(left: MemberSelector, right: MemberSelector): boolean {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a !== b && a !== '*' && b !== '*' && a !== ARRAY_ELEMENTS && b !== ARRAY_ELEMENTS) {
      return false;
    }
  }
  return true;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function isNoise(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x3a ||
    byte === 0x2c
  );
}

function hashKey(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

async function* chunksOf(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!('getReader' in source)) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Yields the members of a JSON object document that match `selectors`, in document order,
 * without holding the document. Only the bytes of the member being captured are retained.
 *
 * Members are yielded as soon as they complete, before the rest of the document has been
 * validated. A consumer that writes anything must stage its writes and commit them only after
 * the generator has completed without throwing.
 *
 * Duplicate keys throw at every selected or prefix level and inside captured members; a hash
 * collision between two distinct keys is also reported as a duplicate.
 */
export function extractMembers(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  selectors: readonly MemberSelector[],
  limits: ExtractOptions = {},
): AsyncGenerator<ExtractedMember> {
  const maxMember = positive('maxMemberBytes', limits.maxMemberBytes ?? DEFAULT_MAX_MEMBER_BYTES);
  const maxDocument = positive(
    'maxDocumentBytes',
    limits.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
  );
  const maxMembers = positive(
    'maxMembersPerLevel',
    limits.maxMembersPerLevel ?? DEFAULT_MAX_MEMBERS_PER_LEVEL,
  );
  if (selectors.length === 0 || selectors.some((selector) => selector.length === 0)) {
    throw new TypeError('Selectors must be non-empty');
  }
  for (const selector of selectors) {
    const at = selector.indexOf(ARRAY_ELEMENTS);
    if (at === 0 || (at !== -1 && at !== selector.length - 1)) {
      throw new TypeError('ARRAY_ELEMENTS must be the single last segment after an object key');
    }
  }
  for (let left = 0; left < selectors.length; left += 1) {
    for (let right = left + 1; right < selectors.length; right += 1) {
      if (overlaps(selectors[left] as MemberSelector, selectors[right] as MemberSelector)) {
        throw new TypeError('Selectors must not overlap');
      }
    }
  }

  const nonArray = limits.nonArray ?? 'throw';
  if (nonArray !== 'throw' && nonArray !== 'report') {
    throw new TypeError('nonArray must be throw or report');
  }
  return extract(source, selectors, { maxMember, maxDocument, maxMembers }, nonArray);
}

async function* extract(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  selectors: readonly MemberSelector[],
  { maxMember, maxDocument, maxMembers }: ResolvedLimits,
  nonArray: 'throw' | 'report',
): AsyncGenerator<ExtractedMember> {
  const tokenizer = new JsonTokenizer({ maxStringBytes: KEY_LIMIT_BYTES });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const plain = selectors.filter((selector) => selector.at(-1) !== ARRAY_ELEMENTS);
  const arrays = selectors
    .filter((selector) => selector.at(-1) === ARRAY_ELEMENTS)
    .map((selector) => selector.slice(0, -1));
  const ready: ExtractedMember[] = [];
  const levels: KeyTable[] = [];
  const names: string[] = [];
  let pending: string | null = null;
  let ignoring = 0;
  let capture: Capture | null = null;
  let awaiting: readonly string[] | null = null;
  let elements: Elements | null = null;
  let chunk: Uint8Array = NO_BYTES;
  let chunkBase = 0;

  const take = (active: Capture, to: number): void => {
    let start = Math.max(active.from, chunkBase) - chunkBase;
    const end = to - chunkBase;
    if (active.lead === true) {
      while (start < end && isNoise(chunk[start] as number)) {
        start += 1;
      }
      if (start >= end) {
        active.from = Math.max(active.from, to);
        return;
      }
      active.lead = false;
      active.origin = chunkBase + start;
    }
    if (end <= start) {
      return;
    }
    const need = active.length + (end - start);
    if (need > maxMember) {
      throw new JsonExtractError('member_too_large', to);
    }
    if (need > active.buffer.length) {
      const grown = new Uint8Array(
        Math.min(maxMember, Math.max(need, active.buffer.length * 2, INITIAL_CAPTURE_BYTES)),
      );
      grown.set(active.buffer.subarray(0, active.length));
      active.buffer = grown;
    }
    active.buffer.set(chunk.subarray(start, end), active.length);
    active.length = need;
    active.from = to;
  };

  const finish = (active: Capture, end: number): void => {
    take(active, end);
    let first = 0;
    while (first < active.length && isNoise(active.buffer[first] as number)) {
      first += 1;
    }
    const raw = decoder.decode(active.buffer.subarray(first, active.length));
    active.buffer = NO_BYTES;
    capture = null;
    try {
      JSON.parse(raw);
    } catch {
      throw new JsonExtractError('invalid_member', end);
    }
    ready.push(
      active.index === undefined
        ? { path: active.path, raw }
        : { path: active.path, raw, index: active.index },
    );
  };

  const nextElement = (array: Elements, from: number): void => {
    capture = {
      path: [...array.path, String(array.count)],
      index: array.count,
      lead: true,
      buffer: NO_BYTES,
      length: 0,
      from,
      origin: from,
      depth: 0,
      scopes: [],
    };
  };

  const track = (seen: KeyTable, name: string, at: number): void => {
    const hash = hashKey(name);
    if (seen.has(hash)) {
      throw new JsonExtractError('duplicate_key', at);
    }
    if (seen.size >= maxMembers) {
      throw new JsonExtractError('too_many_members', at);
    }
    seen.add(hash);
  };

  const onKey = (name: string, end: number, at: number): void => {
    const path = [...names, name];
    const whole = plain.some((selector) => selects(selector, path, true));
    const array = !whole && arrays.some((selector) => selects(selector, path, true));
    if (
      !whole &&
      !array &&
      !plain.some((selector) => selects(selector, path, false)) &&
      !arrays.some((selector) => selects(selector, path, false))
    ) {
      pending = null;
      tokenizer.skipNext();
      return;
    }
    track(levels[levels.length - 1] as KeyTable, name, at);
    tokenizer.structureOnlyNext();
    if (whole) {
      pending = null;
      capture = { path, buffer: NO_BYTES, length: 0, from: end, origin: end, depth: 0, scopes: [] };
    } else if (array) {
      pending = null;
      awaiting = path;
    } else {
      pending = name;
    }
  };

  const onCaptured = (active: Capture, token: JsonToken): void => {
    if (active.index !== undefined && active.depth === 0 && elements !== null) {
      if (token.type === 'endArray') {
        capture = null;
        ready.push({ path: elements.path, raw: '[]', end: true, count: elements.count });
        elements = null;
        return;
      }
      if (elements.count >= maxMembers) {
        throw new JsonExtractError('too_many_members', token.start);
      }
    }
    if (token.type === 'key') {
      const top = active.scopes.length - 1;
      const seen = active.scopes[top] ?? new KeyTable();
      active.scopes[top] = seen;
      track(seen, token.value, token.start);
      return;
    }
    if (token.type === 'beginObject' || token.type === 'beginArray') {
      active.depth += 1;
      active.scopes.push(token.type === 'beginObject' ? undefined : null);
    } else if (token.type === 'endObject' || token.type === 'endArray') {
      active.depth -= 1;
      active.scopes.pop();
    }
    if (active.depth === 0) {
      finish(active, token.end);
      if (active.index !== undefined && elements !== null) {
        elements.count += 1;
        nextElement(elements, token.end);
      }
    }
  };

  const sink = (token: JsonToken): void => {
    if (capture !== null) {
      onCaptured(capture, token);
      return;
    }
    if (ignoring > 0) {
      if (token.type === 'beginObject' || token.type === 'beginArray') {
        ignoring += 1;
      } else if (token.type === 'endObject' || token.type === 'endArray') {
        ignoring -= 1;
      }
      return;
    }
    if (awaiting !== null) {
      if (token.type !== 'beginArray') {
        if (nonArray === 'throw') {
          throw new JsonExtractError('not_array', token.start, awaiting);
        }
        ready.push({ path: awaiting, raw: '', notArray: true });
        awaiting = null;
        if (token.type === 'beginObject') {
          ignoring = 1;
        }
        return;
      }
      elements = { path: awaiting, count: 0 };
      awaiting = null;
      nextElement(elements, token.end);
      return;
    }
    if (levels.length === 0) {
      if (token.type !== 'beginObject') {
        throw new JsonExtractError('not_object', token.start);
      }
      levels.push(new KeyTable());
      return;
    }
    if (token.type === 'key') {
      onKey(token.value, token.end, token.start);
    } else if (token.type === 'endObject') {
      levels.pop();
      names.pop();
    } else if (token.type === 'beginObject') {
      levels.push(new KeyTable());
      names.push(pending as string);
    } else if (token.type === 'beginArray') {
      ignoring = 1;
    }
  };

  const byteAt = (active: Capture, offset: number): number | undefined =>
    offset >= chunkBase ? chunk[offset - chunkBase] : active.buffer[offset - active.origin];

  let seenBytes = 0;
  for await (const next of chunksOf(source)) {
    if (seenBytes + next.length > maxDocument) {
      throw new JsonExtractError('document_too_large', maxDocument);
    }
    chunk = next;
    chunkBase = seenBytes;
    try {
      tokenizer.write(next, sink);
    } catch (error) {
      if (
        capture !== null &&
        error instanceof JsonStreamError &&
        error.code === 'token_too_large' &&
        byteAt(capture, error.offset) === 0x22
      ) {
        throw new JsonExtractError('member_too_large', error.offset);
      }
      throw error;
    }
    seenBytes += next.length;
    if (capture !== null) {
      take(capture, seenBytes);
    }
    yield* ready.splice(0);
  }
  chunk = NO_BYTES;
  tokenizer.end(sink);
  yield* ready.splice(0);
}
