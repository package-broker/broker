import { parseToken } from '../secrets/token-format.js';

export type RedactResult =
  { ok: true; value: string } | { ok: false; reason: 'bad_value' | 'credential_value' };

type FieldKind = 'text' | 'url' | 'version' | 'hash' | 'id';

interface ScanOptions {
  readonly commitHex: boolean;
}

const TEXT_SCAN: ScanOptions = { commitHex: false };
const VERSION_SCAN: ScanOptions = { commitHex: true };

const MAX_CHECKED_LENGTH = 4096;
const HASH_FIELDS: ReadonlySet<string> = new Set(['sha256_old', 'sha256_new', 'plan_hash']);
const ID_FIELDS: ReadonlySet<string> = new Set(['id', 'project_id', 'role_id', 'source_id']);
const HASH_64 = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;
const ULID = /^[0-9A-Z]{26}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const URL_LIKE_START = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]{2}/;
const SCRIPT_SCHEME = /^(?:javascript|data|mailto|vbscript):/i;
const SCP_ADDRESS = /^(?:[^\s@:/\\]+@)?([A-Za-z0-9.-]+):(?![/\\])(\S*)$/;
const COMMIT_PATH =
  /(\/(?:archive|zipball|tarball|commits?)\/)(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[./]|$)/gi;
const SCHEME_USERINFO = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:[/\\]*[^\s/\\?#@]*@/;
const URL_QUERY_OR_FRAGMENT = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:[/\\]+[^\s?#]*[?#]/;
const SECRET_KEY_WORDS = '(?:token|key|secret|signature|credential|auth|password)';
const SECRET_KEY_ASSIGNMENT = new RegExp(`${SECRET_KEY_WORDS}\\s*=\\s*[^\\s&#;]`, 'i');
const SECRET_KEY_LABEL = new RegExp(`${SECRET_KEY_WORDS}:\\s+(\\S+)`, 'gi');
const LABEL_VALUE_FLOOR = 8;

const BROKER_TOKEN = /pb_(?:pat|svc|cst)_[a-z2-7]{12}_[A-Za-z0-9_-]{43}/;
const FIXED_PROVIDER_TOKENS: readonly RegExp[] = [
  /A[KS]IA[A-Z0-9]{16}/,
  /(?<![A-Za-z0-9])(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9]{16}/i,
  /xox[abeprs]-\d+-/i,
  /shp(?:at|ss|ca|pa)_[0-9a-f]{32}/i,
];
const GITLAB_TOKEN = /(?:glpat|gldt|glptt|gloas)-([A-Za-z0-9_-]{16,})/gi;
const RANDOM_BODY_PROVIDER_TOKENS: ReadonlyArray<{ pattern: RegExp; length: number | null }> = [
  { pattern: /(?:gh[pousr]|github_pat|npm)_([A-Za-z0-9]+)/gi, length: 36 },
  { pattern: /hf_([A-Za-z0-9]+)/gi, length: 34 },
  { pattern: /dckr_pat_([A-Za-z0-9_-]+)/gi, length: 27 },
  { pattern: /[prs]k_(?:live|test)_([A-Za-z0-9]+)/gi, length: null },
  { pattern: /AIza([A-Za-z0-9_-]+)/g, length: 35 },
];
const MIN_PROVIDER_BODY = 16;
const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/;
const PEM = /-{3,}\s*begin\b/i;
const AUTH_HEADER = /(?<![A-Za-z0-9])(?:bearer|basic)[:= ]\s*[A-Za-z0-9._~+/=-]{16,}/i;
const TOKEN_SCHEME = /(?<![A-Za-z0-9])token[:= ]\s*([A-Za-z0-9._~+/=-]{16,})/gi;

const RUN = /[A-Za-z0-9+_/-]+/g;
const PIECE_SEPARATOR = /[-_]/;
const RUN_PIECE_SEPARATOR = /[-_/]/;
const SHORT_PIECE = 4;
const MAX_NUMBER_PIECE = 16;
const SEGMENT_FLOOR = 32;
const RANDOM_CHAR_FLOOR = 20;
const ALNUM_PIECE_FLOOR = 24;
const LONG_RUN_FLOOR = 40;
const RANDOM_SHARE_FLOOR = 0.75;
const WORD_PIECE = /^([A-Za-z]+)(\d*)$/;
const CAMEL_WORDS = /^[a-z]*(?:[A-Z][a-z]{2,})+$/;
const CONSONANT_CLUSTER = /[b-df-hj-np-tv-xz]{5}/i;
const VOWEL = /[aeiouy]/i;
const SHORT_WORD = 3;

const LOCAL_PART_STOP = /[\s/@<>(),;:"'[\]]/;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const TLD = /^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu;
const SEMVER_DOMAIN = /^\d+\.\d+\.\d+/;
const IPV4_DOMAIN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SERVICE_MAILBOXES: ReadonlySet<string> = new Set(['git']);

function fieldKind(field: string): FieldKind {
  if (field === 'url') return 'url';
  if (field === 'version') return 'version';
  if (HASH_FIELDS.has(field)) return 'hash';
  if (ID_FIELDS.has(field)) return 'id';
  return 'text';
}

function pathWithoutParams(pathname: string): string {
  return pathname.replace(/;[^/]*/g, '');
}

export function redactUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!URL_LIKE_START.test(trimmed)) return value;
  try {
    const url = new URL(trimmed);
    if (url.host === '') return null;
    return `${url.protocol}//${url.host}${pathWithoutParams(url.pathname)}`;
  } catch {
    return null;
  }
}

function isMixedCase(text: string): boolean {
  return /[A-Z]/.test(text) && /[a-z]/.test(text);
}

function isMixedCaseWithDigit(text: string): boolean {
  return /[A-Z]/.test(text) && /[a-z]/.test(text) && /\d/.test(text);
}

function isDictionaryLike(letters: string): boolean {
  if (CONSONANT_CLUSTER.test(letters)) return false;
  return letters.length <= SHORT_WORD || VOWEL.test(letters);
}

function isWordPiece(piece: string, options: ScanOptions): boolean {
  if (piece.length <= SHORT_PIECE) return true;
  if (/^\d+$/.test(piece)) return piece.length <= MAX_NUMBER_PIECE;
  if (ULID.test(piece)) return true;
  if (options.commitHex && COMMIT_HEX.test(piece)) return true;
  const word = WORD_PIECE.exec(piece);
  if (word === null) return false;
  const letters = word[1] ?? '';
  const hasDigits = (word[2] ?? '') !== '';
  if (hasDigits && !isDictionaryLike(letters)) return false;
  return (
    letters === letters.toLowerCase() ||
    letters === letters.toUpperCase() ||
    CAMEL_WORDS.test(letters)
  );
}

function looksRandom(text: string): boolean {
  return text.split(/[^A-Za-z0-9+]+/).some((piece) => !isWordPiece(piece, TEXT_SCAN));
}

function isSecretSegment(segment: string, options: ScanOptions): boolean {
  let randomChars = 0;
  for (const piece of segment.split(PIECE_SEPARATOR)) {
    if (isWordPiece(piece, options)) continue;
    randomChars += piece.length;
    if (piece.length >= ALNUM_PIECE_FLOOR && /[a-z]/.test(piece) && /\d/.test(piece)) return true;
  }
  return segment.length >= SEGMENT_FLOOR && randomChars >= RANDOM_CHAR_FLOOR;
}

function isNeutralPiece(piece: string): boolean {
  return piece.length <= SHORT_PIECE || ULID.test(piece);
}

function isSecretLongRun(run: string, options: ScanOptions): boolean {
  if (run.length < LONG_RUN_FLOOR) return false;
  const pieces = run.split(RUN_PIECE_SEPARATOR).filter((piece) => piece !== '');
  let counted = 0;
  let random = 0;
  for (const piece of pieces) {
    if (isNeutralPiece(piece)) continue;
    counted += piece.length;
    if (!isWordPiece(piece, options)) random += piece.length;
  }
  if (counted > 0) return random >= counted * RANDOM_SHARE_FLOOR;
  const mixesLettersAndDigits = /[A-Za-z]/.test(run) && /\d/.test(run);
  const hasWord = pieces.some((piece) => /^[A-Za-z]{2,}$/.test(piece) && isDictionaryLike(piece));
  return mixesLettersAndDigits && !hasWord;
}

function hasRandomRun(value: string, options: ScanOptions): boolean {
  for (const [run] of value.matchAll(RUN)) {
    if (isSecretLongRun(run, options)) return true;
    for (const segment of run.split('/')) {
      if (isSecretSegment(segment, options)) return true;
    }
  }
  return false;
}

function hasProviderToken(value: string): boolean {
  if (FIXED_PROVIDER_TOKENS.some((pattern) => pattern.test(value))) return true;
  for (const match of value.matchAll(GITLAB_TOKEN)) {
    const body = match[1] ?? '';
    if (/^[A-Za-z0-9]{16}/.test(body) || isMixedCase(body) || looksRandom(body)) return true;
  }
  for (const { pattern, length } of RANDOM_BODY_PROVIDER_TOKENS) {
    for (const match of value.matchAll(pattern)) {
      const body = match[1] ?? '';
      if (body.length < MIN_PROVIDER_BODY) continue;
      if (isMixedCaseWithDigit(body)) return true;
      if (body.length === length && looksRandom(body)) return true;
    }
  }
  return false;
}

function hasAuthValue(value: string): boolean {
  if (AUTH_HEADER.test(value)) return true;
  for (const match of value.matchAll(TOKEN_SCHEME)) {
    if (looksRandom(match[1] ?? '')) return true;
  }
  return false;
}

function hasSecretKey(value: string): boolean {
  if (SECRET_KEY_ASSIGNMENT.test(value)) return true;
  for (const match of value.matchAll(SECRET_KEY_LABEL)) {
    const label = match[1] ?? '';
    if (label.length >= LABEL_VALUE_FLOOR || looksRandom(label)) return true;
  }
  return false;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function emailDomainAt(value: string, at: number): string {
  let end = at + 1;
  while (end < value.length && DOMAIN_CHAR.test(value.charAt(end))) end += 1;
  return value.slice(at + 1, end).replace(/[.-]+$/, '');
}

function isEmailAt(value: string, at: number): boolean {
  let start = at;
  while (start > 0 && !LOCAL_PART_STOP.test(value.charAt(start - 1))) start -= 1;
  const local = value.slice(start, at);
  if (local === '' || SERVICE_MAILBOXES.has(local)) return false;
  if (value.charAt(at + 1) === '[') return true;
  const domain = emailDomainAt(value, at);
  if (domain === '') return false;
  if (domain.toLowerCase() === 'localhost' || IPV4_DOMAIN.test(domain)) return true;
  const labels = domain.split('.');
  if (labels.length >= 2) {
    return TLD.test(labels[labels.length - 1] ?? '') && !SEMVER_DOMAIN.test(domain);
  }
  const inPackagePath = start > 0 && value.charAt(start - 1) === '/';
  return !inPackagePath && /\p{L}/u.test(domain);
}

function hasEmail(text: string): boolean {
  const value = text.normalize('NFKC');
  let at = value.indexOf('@');
  while (at !== -1) {
    if (isEmailAt(value, at)) return true;
    at = value.indexOf('@', at + 1);
  }
  return false;
}

function hasCredential(value: string, options: ScanOptions): boolean {
  if (value.length > MAX_CHECKED_LENGTH) return true;
  if (parseToken(value).ok || BROKER_TOKEN.test(value)) return true;
  if (hasProviderToken(value)) return true;
  if (JWT.test(value) || PEM.test(value) || hasAuthValue(value)) return true;
  if (SCHEME_USERINFO.test(value) || URL_QUERY_OR_FRAGMENT.test(value)) return true;
  if (hasSecretKey(value)) return true;
  if (UUID_ANYWHERE.test(value)) return true;
  if (hasEmail(value) || hasEmail(safeDecode(value))) return true;
  return hasRandomRun(value, options);
}

export function isCredentialValue(value: string): boolean {
  return hasCredential(value, TEXT_SCAN);
}

function urlFieldForm(trimmed: string): RedactResult {
  if (SCRIPT_SCHEME.test(trimmed)) return { ok: false, reason: 'bad_value' };
  if (URL_START.test(trimmed)) {
    const redacted = redactUrl(trimmed);
    return redacted === null ? { ok: false, reason: 'bad_value' } : { ok: true, value: redacted };
  }
  const scp = SCP_ADDRESS.exec(trimmed);
  if (scp === null) return { ok: false, reason: 'bad_value' };
  const host = scp[1] ?? '';
  const path = scp[2] ?? '';
  if (!host.includes('.') && host.toLowerCase() !== 'localhost') {
    return { ok: false, reason: 'bad_value' };
  }
  if (/[?#]/.test(path)) return { ok: false, reason: 'credential_value' };
  return { ok: true, value: `${host}:${path}` };
}

function storedForm(value: string, kind: FieldKind): RedactResult {
  const trimmed = value.trim();
  if (kind === 'url') return urlFieldForm(trimmed);
  if (!URL_START.test(trimmed)) return { ok: true, value };
  const redacted = redactUrl(trimmed);
  return redacted === null ? { ok: false, reason: 'bad_value' } : { ok: true, value: redacted };
}

export function redactValue(value: string, limit: number, field: string): RedactResult {
  if (value.length > limit) return { ok: false, reason: 'bad_value' };
  const kind = fieldKind(field);
  const stored = storedForm(value, kind);
  if (!stored.ok) return stored;
  const text = stored.value;
  if (kind === 'hash' && HASH_64.test(text)) return stored;
  if (kind === 'id' && UUID.test(text)) return stored;
  const scanned = kind === 'url' ? text.replace(COMMIT_PATH, '$1commit') : text;
  const options = kind === 'version' ? VERSION_SCAN : TEXT_SCAN;
  return hasCredential(scanned, options) ? { ok: false, reason: 'credential_value' } : stored;
}
