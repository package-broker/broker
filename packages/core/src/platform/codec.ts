export type DigestAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';

export interface DigestTap<A extends DigestAlgorithm = DigestAlgorithm> {
  readonly transform: TransformStream<Uint8Array, Uint8Array>;
  readonly digests: Promise<Record<A, Uint8Array>>;
}

export interface InflateResult {
  readonly data: Uint8Array;
  readonly consumed: number;
}

export interface Codecs {
  /**
   * Pass-through transform: every chunk is forwarded unchanged, reads are driven by the readable
   * side's pull (backpressure), and cancel and abort propagate to the source.
   * `digests` resolves only after the writable side closed, with one entry per requested
   * algorithm. It rejects when the stream errors, aborts or is cancelled; the rejection is
   * observed by the caller of `digests`, so an unobserved tap must not raise an unhandled rejection.
   */
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]): DigestTap<A>;
  /**
   * Inflates one zlib-wrapped (RFC 1950) stream at the start of `input`; raw deflate and gzip are
   * not accepted. `consumed` is the number of input bytes the stream occupied including the
   * trailer, so packfile readers can continue after it. Throws CodecTruncatedError when `input`
   * ends before the stream does (more input may help), CodecCorruptError for invalid data and
   * CodecLimitError when the output would exceed `maxOutput`.
   */
  inflateConsumed(input: Uint8Array, maxOutput: number): InflateResult;
  /**
   * Gunzips a stream of concatenated members as one output. Errors the readable side with
   * CodecLimitError past `maxOutput`, CodecTruncatedError when the input ends inside a member
   * and CodecCorruptError for a bad header, checksum or trailing bytes that are not a member.
   */
  gunzip(maxOutput: number): TransformStream<Uint8Array, Uint8Array>;
  deflateRaw(): TransformStream<Uint8Array, Uint8Array>;
}

export type CodecOperation = 'inflate' | 'gunzip';

export class CodecLimitError extends Error {
  override readonly name = 'CodecLimitError';

  readonly operation: CodecOperation;
  readonly maxOutput: number;

  constructor(operation: CodecOperation, maxOutput: number) {
    super(`${operation} output exceeds ${maxOutput} bytes`);
    this.operation = operation;
    this.maxOutput = maxOutput;
  }
}

export class CodecTruncatedError extends Error {
  override readonly name = 'CodecTruncatedError';

  readonly operation: CodecOperation;

  constructor(operation: CodecOperation) {
    super(`${operation} input ended before the stream did`);
    this.operation = operation;
  }
}

export class CodecCorruptError extends Error {
  override readonly name = 'CodecCorruptError';

  readonly operation: CodecOperation;

  constructor(operation: CodecOperation) {
    super(`${operation} input is corrupt`);
    this.operation = operation;
  }
}

export interface IntegrityHash {
  readonly alg: DigestAlgorithm;
  readonly bytes: Uint8Array;
}

export interface Integrity {
  readonly hashes: readonly IntegrityHash[];
  readonly strongestAlg: DigestAlgorithm;
  /** Every valid hash of `strongestAlg`; a caller accepts a body that matches any of them. */
  readonly strongest: readonly IntegrityHash[];
  /** Tokens naming a known algorithm with an invalid value; refuse when one outranks `strongestAlg`. */
  readonly rejectedTokens: readonly string[];
}

const DIGEST_LENGTH: Record<DigestAlgorithm, number> = {
  sha1: 20,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

const STRENGTH: readonly DigestAlgorithm[] = ['sha1', 'sha256', 'sha384', 'sha512'];

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64(value: string, expectedLength: number): Uint8Array | null {
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return null;
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return encodeBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function isAlgorithm(value: string): value is DigestAlgorithm {
  return Object.hasOwn(DIGEST_LENGTH, value);
}

/**
 * Padding is required and the value must be canonical base64 (it re-encodes to itself); algorithm
 * names are case-sensitive, as in npm's ssri. Tokens are split on ASCII whitespace.
 */
export function parseIntegrity(sri: string): Integrity | null {
  const hashes: IntegrityHash[] = [];
  const rejectedTokens: string[] = [];
  for (const token of sri.split(/[ \t\n\r\f]+/)) {
    const dash = token.indexOf('-');
    if (dash <= 0) continue;
    const alg = token.slice(0, dash);
    if (!isAlgorithm(alg)) continue;
    const encoded = token.slice(dash + 1).split('?', 1)[0] ?? '';
    const bytes = decodeBase64(encoded, DIGEST_LENGTH[alg]);
    if (bytes) hashes.push({ alg, bytes });
    else rejectedTokens.push(token);
  }
  let strongestAlg: DigestAlgorithm | undefined;
  for (const h of hashes) {
    if (!strongestAlg || STRENGTH.indexOf(h.alg) > STRENGTH.indexOf(strongestAlg)) {
      strongestAlg = h.alg;
    }
  }
  if (!strongestAlg) return null;
  return {
    hashes,
    strongestAlg,
    strongest: hashes.filter((h) => h.alg === strongestAlg),
    rejectedTokens,
  };
}

export function formatIntegrity(alg: DigestAlgorithm, bytes: Uint8Array): string {
  if (bytes.length !== DIGEST_LENGTH[alg]) {
    throw new RangeError(`${alg} digest must be ${DIGEST_LENGTH[alg]} bytes`);
  }
  return `${alg}-${encodeBase64(bytes)}`;
}
