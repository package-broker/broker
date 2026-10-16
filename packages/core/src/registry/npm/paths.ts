import { packageKey } from '../../catalogue/names.js';
import { validateVersion } from '../../catalogue/versions.js';

export type NpmPath =
  | { kind: 'not_found' }
  | { kind: 'packument'; key: string }
  | { kind: 'version'; key: string; selector: string }
  | { kind: 'tarball'; key: string; version: string; file: string }
  | { kind: 'dist_tags'; key: string }
  | { kind: 'whoami' }
  | { kind: 'ping' }
  | { kind: 'search' }
  | { kind: 'audit' };

const NOT_FOUND: NpmPath = { kind: 'not_found' };
const MAX_SEGMENTS = 6;
const MAX_RAW_SEGMENT = 700;
const MAX_SELECTOR = 256;
const SELECTOR = /^[A-Za-z0-9._~+-]+$/;
const SAFE_DECODED = /^[\x21-\x7e]+$/;
const DOUBLE_ENCODED = /%25/i;

function decodeSegments(raw: readonly string[]): string[] | undefined {
  if (raw.length === 0 || raw.length > MAX_SEGMENTS) {
    return undefined;
  }
  const decoded: string[] = [];
  for (const segment of raw) {
    if (segment.length === 0 || segment.length > MAX_RAW_SEGMENT || DOUBLE_ENCODED.test(segment)) {
      return undefined;
    }
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!SAFE_DECODED.test(value) || value.includes('\\') || value === '.' || value === '..') {
      return undefined;
    }
    decoded.push(value);
  }
  return decoded;
}

function resolveKey(name: string): string | undefined {
  const parts = name.split('/');
  if (name === '-' || parts.some((part) => part.startsWith('.'))) {
    return undefined;
  }
  if (name.startsWith('@') && /[A-Z]/.test(parts[0] ?? '')) {
    return undefined;
  }
  try {
    return packageKey(name, { ecosystem: 'npm', legacyCase: true });
  } catch {
    return undefined;
  }
}

function takeName(
  segments: readonly string[],
  at: number,
): { name: string; next: number } | undefined {
  const first = segments[at];
  if (first === undefined) {
    return undefined;
  }
  if (!first.startsWith('@')) {
    return first.includes('/') ? undefined : { name: first, next: at + 1 };
  }
  if (first.includes('/')) {
    return { name: first, next: at + 1 };
  }
  const second = segments[at + 1];
  if (second === undefined || second.includes('/')) {
    return undefined;
  }
  return { name: `${first}/${second}`, next: at + 2 };
}

function parseTarball(name: string, key: string, file: string): NpmPath {
  const unscoped = name.slice(name.lastIndexOf('/') + 1);
  const prefix = `${unscoped}-`;
  if (!file.startsWith(prefix) || !file.endsWith('.tgz')) {
    return NOT_FOUND;
  }
  const version = file.slice(prefix.length, -'.tgz'.length);
  try {
    validateVersion({ ecosystem: 'npm', version, versionNormalized: version });
  } catch {
    return NOT_FOUND;
  }
  return { kind: 'tarball', key, version, file };
}

function parseSpecial(segments: readonly string[]): NpmPath {
  const [, a, b, c, d, e] = segments;
  if (segments.length === 2 && a === 'whoami') {
    return { kind: 'whoami' };
  }
  if (segments.length === 2 && a === 'ping') {
    return { kind: 'ping' };
  }
  if (segments.length === 3 && a === 'v1' && b === 'search') {
    return { kind: 'search' };
  }
  if (
    segments.length === 6 &&
    a === 'npm' &&
    b === 'v1' &&
    c === 'security' &&
    d === 'advisories' &&
    e === 'bulk'
  ) {
    return { kind: 'audit' };
  }
  if (a === 'package') {
    const taken = takeName(segments, 2);
    const key = taken && resolveKey(taken.name);
    if (
      taken &&
      key &&
      segments.length === taken.next + 1 &&
      segments[taken.next] === 'dist-tags'
    ) {
      return { kind: 'dist_tags', key };
    }
  }
  return NOT_FOUND;
}

export function parseNpmPath(rawSegments: readonly string[]): NpmPath {
  const segments = decodeSegments(rawSegments);
  if (!segments) {
    return NOT_FOUND;
  }
  if (rawSegments[0] === '-') {
    return parseSpecial(segments);
  }
  const taken = takeName(segments, 0);
  const key = taken && resolveKey(taken.name);
  if (!taken || !key) {
    return NOT_FOUND;
  }
  const rest = segments.slice(taken.next);
  if (rest.length === 0) {
    return { kind: 'packument', key };
  }
  const [head, file] = rest;
  if (rest.length === 1 && head !== undefined) {
    return head !== '-' && head.length <= MAX_SELECTOR && SELECTOR.test(head)
      ? { kind: 'version', key, selector: head }
      : NOT_FOUND;
  }
  if (
    rest.length === 2 &&
    head === '-' &&
    rawSegments[taken.next] === '-' &&
    file !== undefined &&
    !file.includes('/')
  ) {
    return parseTarball(taken.name, key, file);
  }
  return NOT_FOUND;
}
