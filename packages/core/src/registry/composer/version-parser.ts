const MODIFIER = '[._-]?(?:(stable|beta|b|RC|alpha|a|patch|pl|p)((?:[.-]?\\d)*)?)?([.-]?dev)?';
const NUMERIC = new RegExp(`^v?(\\d{1,5})(\\.\\d+)?(\\.\\d+)?(\\.\\d+)?${MODIFIER}$`, 'i');
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

export function normalizeVersion(pretty: string): string {
  const input = phpTrim(pretty);
  if (input.length > MAX_LENGTH) {
    throw new InvalidVersionError(pretty, 'too_long');
  }
  const matches = NUMERIC.exec(input);
  if (matches === null) {
    throw new InvalidVersionError(pretty);
  }
  let version = `${matches[1]}${matches[2] ?? '.0'}${matches[3] ?? '.0'}${matches[4] ?? '.0'}`;
  const stability = matches[5];
  if (stability) {
    if (stability === 'stable') {
      return version;
    }
    const number = matches[6] ? matches[6].replace(/^[.-]+/, '') : '';
    version += `-${expandStability(stability)}${number}`;
  }
  if (matches[7]) {
    version += '-dev';
  }
  return version;
}
