export const MASTER_KEY_PATTERN: RegExp = /^pbmk_v([1-9][0-9]{0,5})_([A-Za-z0-9_-]{43})$/;

export interface MasterKey {
  readonly version: number;
  readonly bytes: Uint8Array;
}

export type SecretsConfigProblem = 'missing' | 'malformed' | 'weak' | 'version_order' | 'too_many';

export type MasterKeyVariable =
  | 'PB_MASTER_KEY'
  | 'PB_MASTER_KEY_PREVIOUS'
  | 'PB_MASTER_KEY_FILE'
  | 'PB_MASTER_KEY_PREVIOUS_FILE'
  | 'PASSWORD_ITERATIONS';

export class SecretsConfigError extends Error {
  readonly problem: SecretsConfigProblem;
  readonly variable: MasterKeyVariable;

  constructor(problem: SecretsConfigProblem, variable: MasterKeyVariable) {
    super(`${variable} is ${problem}`);
    this.name = 'SecretsConfigError';
    this.problem = problem;
    this.variable = variable;
  }
}

const CURRENT_VARIABLE = 'PB_MASTER_KEY';
const PREVIOUS_VARIABLE = 'PB_MASTER_KEY_PREVIOUS';
const PARSE_PATTERN = new RegExp(MASTER_KEY_PATTERN.source);
const KEY_BYTES = 32;
const MAX_VERSION = 999_999;
const MAX_PREVIOUS = 3;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET.charAt((buffer >> bits) & 63);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (6 - bits)) & 63);
  return out;
}

function decodeBase64Url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

function validVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= MAX_VERSION;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function parseMasterKey(text: string, variable: MasterKeyVariable): MasterKey {
  const match = PARSE_PATTERN.exec(text);
  const versionText = match?.[1];
  const body = match?.[2];
  if (versionText === undefined || body === undefined) {
    throw new SecretsConfigError('malformed', variable);
  }
  const bytes = decodeBase64Url(body);
  if (bytes.length !== KEY_BYTES || encodeBase64Url(bytes) !== body) {
    throw new SecretsConfigError('malformed', variable);
  }
  const first = bytes[0];
  if (bytes.every((byte) => byte === first)) {
    throw new SecretsConfigError('weak', variable);
  }
  return { version: Number(versionText), bytes };
}

export function readMasterKeys(input: {
  readonly current: string | undefined;
  readonly previous?: string | undefined;
}): readonly MasterKey[] {
  if (input.current === undefined || input.current === '') {
    throw new SecretsConfigError('missing', CURRENT_VARIABLE);
  }
  const current = parseMasterKey(input.current, CURRENT_VARIABLE);
  const keys: MasterKey[] = [current];
  if (input.previous === undefined || input.previous === '') return keys;

  const entries = input.previous.split(',');
  if (entries.length > MAX_PREVIOUS) {
    throw new SecretsConfigError('too_many', PREVIOUS_VARIABLE);
  }
  for (const entry of entries) {
    const key = parseMasterKey(entry, PREVIOUS_VARIABLE);
    const last = keys[keys.length - 1] as MasterKey;
    if (key.version >= last.version || keys.some((other) => sameBytes(other.bytes, key.bytes))) {
      throw new SecretsConfigError('version_order', PREVIOUS_VARIABLE);
    }
    keys.push(key);
  }
  return keys;
}

export function generateMasterKey(version: number): MasterKey {
  if (!validVersion(version)) throw new RangeError('Master key version is out of range');
  return { version, bytes: crypto.getRandomValues(new Uint8Array(KEY_BYTES)) };
}

export function formatMasterKey(key: MasterKey): string {
  if (!validVersion(key.version)) throw new RangeError('Master key version is out of range');
  if (key.bytes.length !== KEY_BYTES) throw new RangeError('Master key must be 32 bytes');
  return `pbmk_v${key.version}_${encodeBase64Url(key.bytes)}`;
}
