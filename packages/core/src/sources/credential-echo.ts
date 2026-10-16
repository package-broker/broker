import type { CredentialEchoProbe } from './credentials.js';

export type CredentialEchoResult =
  | { readonly refused: true; readonly reason: 'credential_echo' | 'malformed' }
  | { readonly refused: false; readonly object: object; readonly stripped: readonly string[] };

const MAX_DEPTH = 32;

type Segment = string | number;

const MIN_SECRET_LENGTH = 8;

class Refusal extends Error {
  constructor(readonly reason: 'credential_echo' | 'malformed') {
    super(reason);
  }
}

function isUrlField(path: readonly Segment[]): boolean {
  const [first, second, third] = path;
  if (path.length === 1) return first === 'homepage';
  if (path.length === 2) {
    if (first === 'dist') return second === 'url' || second === 'tarball';
    return (
      (first === 'source' && second === 'url') ||
      (first === 'support' && typeof second === 'string')
    );
  }
  return path.length === 3 && first === 'mirrors' && typeof second === 'number' && third === 'url';
}

function formatPath(path: readonly Segment[]): string {
  return path.reduce<string>(
    (text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`),
    '$',
  );
}

function decodeRuns(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return new TextDecoder().decode(
        Uint8Array.from(run.slice(1).split('%'), (hex) => parseInt(hex, 16)),
      );
    }
  });
}

function textVariants(text: string): string[] {
  const variants = new Set<string>();
  for (const start of [text, text.replaceAll('+', ' ')]) {
    let current = start;
    for (let pass = 0; pass <= 3; pass += 1) {
      variants.add(current.toLowerCase());
      const next = decodeRuns(current);
      if (next === current) break;
      current = next;
    }
  }
  return [...variants];
}

function isUrlText(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

function rawQuery(text: string): string | undefined {
  const queryStart = text.indexOf('?');
  if (queryStart === -1) return undefined;
  const hashStart = text.indexOf('#');
  if (hashStart !== -1 && hashStart < queryStart) return undefined;
  return text.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
}

function parsedQuery(text: string): string | undefined {
  try {
    return new URL(text).search.slice(1);
  } catch {
    return undefined;
  }
}

function carriesQueryParam(text: string, params: ReadonlySet<string>): boolean {
  if (params.size === 0) return false;
  for (const query of [rawQuery(text), parsedQuery(text)]) {
    if (query === undefined) continue;
    for (const name of new URLSearchParams(query).keys()) {
      if (params.has(name.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Known limits: only the probe's forms (including base64 cores at any byte offset),
 * percent-decoded up to 3 times and case-folded, are detected; any other transformation, or a secret split across several fields, is not. Only
 * string, number and boolean values are compared.
 */
export function stripCredentialEcho(
  object: unknown,
  probe: CredentialEchoProbe,
): CredentialEchoResult {
  const secrets = probe.secrets
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .map((v) => v.toLowerCase());
  const params: ReadonlySet<string> = new Set(probe.queryParams.map((name) => name.toLowerCase()));
  const stripped: string[] = [];
  const hasSecret = (text: string): boolean =>
    textVariants(text).some((variant) => secrets.some((value) => variant.includes(value)));

  const walk = (value: unknown, path: readonly Segment[], depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Refusal('malformed');
    if (typeof value === 'string') {
      const echoed = hasSecret(value);
      if (
        isUrlField(path) &&
        (path[0] !== 'support' || isUrlText(value)) &&
        (echoed || carriesQueryParam(value, params))
      ) {
        stripped.push(formatPath(path));
        return undefined;
      }
      if (echoed) throw new Refusal('credential_echo');
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (hasSecret(String(value))) throw new Refusal('credential_echo');
      return value;
    }
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...path, index], depth + 1));
    }
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      if (hasSecret(key)) throw new Refusal('credential_echo');
      const kept = walk(child, [...path, key], depth + 1);
      if (kept !== undefined || child === undefined) entries.push([key, kept]);
    }
    return Object.fromEntries(entries);
  };

  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    return { refused: true, reason: 'malformed' };
  }
  try {
    return { refused: false, object: walk(object, [], 0) as object, stripped };
  } catch (error) {
    if (error instanceof Refusal) return { refused: true, reason: error.reason };
    throw error;
  }
}
