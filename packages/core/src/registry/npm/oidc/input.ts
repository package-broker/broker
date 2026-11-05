export class OidcError extends Error {
  constructor(
    readonly code:
      | 'invalid_oidc_config'
      | 'invalid_oidc_token'
      | 'jwks_unavailable'
      | 'no_trusted_publisher'
      | 'ambiguous_trusted_publisher',
  ) {
    super(code);
    this.name = 'OidcError';
  }
}

export function invalid(): never {
  throw new OidcError('invalid_oidc_token');
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function base64url(value: string, maxBytes: number): Uint8Array {
  if (
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  )
    invalid();
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  if (btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') !== value)
    invalid();
  return bytes;
}

/** Bounded JSON grammar with duplicate decoded member names refused before materialization. */
export function parseJson(text: string): unknown {
  if (text.length > 65536) invalid();
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++]!;
      if (ch === '"') {
        const result: unknown = JSON.parse(text.slice(start, at));
        if (
          typeof result !== 'string' ||
          result.length > 8192 ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)
        )
          invalid();
        return result;
      }
      if (ch === '\\') at++;
      if (at - start > 16384) invalid();
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > 4 || ++nodes > 512) invalid();
    whitespace();
    const ch = text[at];
    if (ch === '"') return string();
    if (ch === '{' || ch === '[') {
      const array = ch === '[';
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const list: unknown[] = [];
      const end = array ? ']' : '}';
      at++;
      whitespace();
      if (text[at] === end) {
        at++;
        return array ? list : result;
      }
      for (let count = 0; count < 128; count++) {
        whitespace();
        if (array) list.push(value(depth + 1));
        else {
          if (text[at] !== '"') invalid();
          const key = string();
          whitespace();
          if (Object.hasOwn(result, key) || text[at++] !== ':') invalid();
          result[key] = value(depth + 1);
        }
        whitespace();
        if (text[at] === end) {
          at++;
          return array ? list : result;
        }
        if (text[at++] !== ',') invalid();
      }
      return invalid();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(at),
    );
    if (!match) invalid();
    at += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) invalid();
    return result;
  }
  try {
    const parsed = value(0);
    whitespace();
    if (at !== text.length) invalid();
    return parsed;
  } catch {
    return invalid();
  }
}

export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid();
  }
}
