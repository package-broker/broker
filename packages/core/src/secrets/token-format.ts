import { base64urlDecode, base64urlEncode } from '../auth/primitives.js';

export type TokenKind = 'pat' | 'svc' | 'cst';

export type TokenRefusal = 'malformed';

export type ParsedToken =
  | {
      readonly ok: true;
      readonly kind: TokenKind;
      readonly selector: string;
      readonly secret: string;
      readonly canonical: string;
      readonly reserved: boolean;
    }
  | { readonly ok: false; readonly reason: TokenRefusal };

const KINDS: ReadonlySet<string> = new Set(['pat', 'svc', 'cst']);
const SELECTOR_LENGTH = 12;
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;
const KIND_OFFSET = 3;
const SELECTOR_OFFSET = 7;
const SECRET_OFFSET = SELECTOR_OFFSET + SELECTOR_LENGTH + 1;
const TOKEN_LENGTH = SECRET_OFFSET + SECRET_LENGTH;
const SELECTOR_PATTERN = /^[a-z2-7]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFUSED: ParsedToken = Object.freeze({ ok: false, reason: 'malformed' });

function canonicalSecret(secret: string): boolean {
  if (!SECRET_PATTERN.test(secret)) return false;
  try {
    return base64urlDecode(secret).length === SECRET_BYTES;
  } catch {
    return false;
  }
}

export function parseToken(text: unknown): ParsedToken {
  if (typeof text !== 'string' || text.length !== TOKEN_LENGTH) return REFUSED;
  const prefixOk = text.startsWith('pb_');
  const kindSeparatorOk = text.charAt(KIND_OFFSET + 3) === '_';
  const secretSeparatorOk = text.charAt(SECRET_OFFSET - 1) === '_';
  const kind = text.slice(KIND_OFFSET, KIND_OFFSET + 3);
  const selector = text.slice(SELECTOR_OFFSET, SELECTOR_OFFSET + SELECTOR_LENGTH);
  const secret = text.slice(SECRET_OFFSET);
  const kindOk = KINDS.has(kind);
  const selectorOk = SELECTOR_PATTERN.test(selector);
  const secretOk = canonicalSecret(secret);
  if (!(prefixOk && kindSeparatorOk && secretSeparatorOk && kindOk && selectorOk && secretOk)) {
    return REFUSED;
  }
  return {
    ok: true,
    kind: kind as TokenKind,
    selector,
    secret,
    canonical: text,
    reserved: kind === 'cst',
  };
}

export function formatToken(
  kind: TokenKind,
  selector: string,
  secret: string | Uint8Array,
): string {
  const secretText = typeof secret === 'string' ? secret : base64urlEncode(secret);
  const valid =
    KINDS.has(kind) &&
    typeof selector === 'string' &&
    SELECTOR_PATTERN.test(selector) &&
    canonicalSecret(secretText);
  const text = `pb_${kind}_${selector}_${secretText}`;
  const parsed = valid ? parseToken(text) : REFUSED;
  if (
    !parsed.ok ||
    parsed.kind !== kind ||
    parsed.selector !== selector ||
    parsed.secret !== secretText
  ) {
    throw new TypeError('invalid token parts');
  }
  return text;
}
