const MODIFIER = '[._-]?(?:(stable|beta|b|RC|alpha|a|patch|pl|p)((?:[.-]?\\d)*)?)?([.-]?dev)?';
const NUMERIC = new RegExp(`^v?(\\d{1,5})(\\.\\d+)?(\\.\\d+)?(\\.\\d+)?${MODIFIER}$`, 'i');
const DATE = new RegExp(`^v?(\\d{4}(?:[.:-]?\\d{2}){1,6}(?:[.:-]?\\d{1,3}){0,2})${MODIFIER}$`, 'i');
const ALIAS = /^([^,\s]+) +as +([^,\s]+)$/;
const STABILITY_FLAG = /@(?:stable|RC|beta|alpha|dev)$/i;
const BUILD = /^([^,\s+]+)\+\S+$/;
const DEV_SUFFIX = /^(.*?)[.-]?dev$/i;
const BRANCH_NUMERIC = /^v?(\d+)(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?$/i;
const PHP_WHITESPACE = new Set([32, 9, 10, 13, 0, 11]);

export type InvalidVersionCode = 'invalid' | 'too_long';

const MAX_LENGTH = 255;
const MESSAGE_INPUT_LIMIT = 128;

export class InvalidVersionError extends Error {
  readonly code: InvalidVersionCode;
  readonly input: string;

  constructor(input: string, code: InvalidVersionCode = 'invalid') {
    const shown = JSON.stringify(phpTrim(input).slice(0, MESSAGE_INPUT_LIMIT));
    super(`Invalid version string ${shown}`);
    this.name = 'InvalidVersionError';
    this.code = code;
    this.input = input;
  }
}

function expandStability(stability: string): string {
  switch (stability.toLowerCase()) {
    case 'a':
      return 'alpha';
    case 'b':
      return 'beta';
    case 'p':
    case 'pl':
      return 'patch';
    case 'rc':
      return 'RC';
    default:
      return stability.toLowerCase();
  }
}

function phpTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PHP_WHITESPACE.has(value.charCodeAt(start))) start += 1;
  while (end > start && PHP_WHITESPACE.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

export function normalizeBranch(name: string): string {
  const trimmed = phpTrim(name);
  const matches = BRANCH_NUMERIC.exec(trimmed);
  if (matches === null) {
    return `dev-${trimmed}`;
  }
  let version = '';
  for (let index = 1; index < 5; index += 1) {
    version += (matches[index] ?? '.x').replace(/[*X]/g, 'x');
  }
  return `${version.replace(/x/g, '9999999')}-dev`;
}

function applyModifier(
  base: string,
  stability: string | undefined,
  number: string | undefined,
  dev: string | undefined,
): string {
  let version = base;
  if (stability) {
    if (stability === 'stable') {
      return version;
    }
    version += `-${expandStability(stability)}${number ? number.replace(/^[.-]+/, '') : ''}`;
  }
  if (dev) {
    version += '-dev';
  }
  return version;
}

export function normalizeVersion(pretty: string): string {
  const input = phpTrim(pretty);
  if (input.length > MAX_LENGTH) {
    throw new InvalidVersionError(pretty, 'too_long');
  }
  let version = ALIAS.exec(input)?.[1] ?? input;
  const flag = STABILITY_FLAG.exec(version);
  if (flag !== null) {
    version = version.slice(0, flag.index);
  }
  if (version === 'master' || version === 'trunk' || version === 'default') {
    version = `dev-${version}`;
  }
  if (version.slice(0, 4).toLowerCase() === 'dev-') {
    return `dev-${version.slice(4)}`;
  }
  version = BUILD.exec(version)?.[1] ?? version;

  const numeric = NUMERIC.exec(version);
  if (numeric !== null) {
    const base = `${numeric[1]}${numeric[2] ?? '.0'}${numeric[3] ?? '.0'}${numeric[4] ?? '.0'}`;
    return applyModifier(base, numeric[5], numeric[6], numeric[7]);
  }
  const date = DATE.exec(version);
  if (date !== null) {
    return applyModifier(date[1]!.replace(/\D/g, '.'), date[2], date[3], date[4]);
  }
  const branch = DEV_SUFFIX.exec(version);
  if (branch !== null) {
    const normalized = normalizeBranch(branch[1]!);
    if (!normalized.includes('dev-')) {
      return normalized;
    }
  }
  throw new InvalidVersionError(pretty);
}
