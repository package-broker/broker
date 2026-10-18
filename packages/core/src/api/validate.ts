import { safeParse, type $ZodIssue, type $ZodType, type output } from 'zod/v4/core';

export const MAX_BODY_BYTES = 65536;
export const MAX_BODY_DEPTH = 16;
const MAX_DETAILS = 20;

export interface BodyLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 415; readonly code: 'unsupported_media_type' }
  | { readonly ok: false; readonly status: 413; readonly code: 'payload_too_large' }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly code: 'invalid_request';
      readonly detail: BadDetail;
    };

const BODY_VALIDATION_CODES = ['invalid_encoding', 'too_deep', 'invalid_json'] as const;

type BadDetail = (typeof BODY_VALIDATION_CODES)[number] | 'invalid_request';

const unsupported = (): BodyResult => ({ ok: false, status: 415, code: 'unsupported_media_type' });
const tooLarge = (): BodyResult => ({ ok: false, status: 413, code: 'payload_too_large' });

function bad(detail: BadDetail): BodyResult {
  return { ok: false, status: 400, code: 'invalid_request', detail };
}

function isJsonMediaType(header: string | null): boolean {
  if (header === null) return false;
  const [type, ...params] = header.split(';');
  if (type?.trim().toLowerCase() !== 'application/json') return false;
  return params.every((param) => /^\s*(?:charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(param));
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | 'unreadable' | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
    try {
      chunk = await reader.read();
    } catch {
      return 'unreadable';
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exceedsDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '[' || char === '{') {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (char === ']' || char === '}') depth -= 1;
  }
  return false;
}

function wellFormed(text: string): boolean {
  return (text as string & { isWellFormed(): boolean }).isWellFormed();
}

function isWellFormedTree(root: unknown, maxNodes: number): boolean {
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > maxNodes) return false;
    const node = stack.pop();
    if (typeof node === 'string') {
      if (!wellFormed(node)) return false;
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === 'object' && node !== null) {
      for (const key of Object.keys(node)) {
        if (!wellFormed(key)) return false;
        stack.push((node as Record<string, unknown>)[key]);
      }
    }
  }
  return true;
}

function dropProto(key: string, value: unknown): unknown {
  return key === '__proto__' ? undefined : value;
}

export async function readJsonBody(request: Request, limits: BodyLimits = {}): Promise<BodyResult> {
  const maxBytes = limits.maxBytes ?? MAX_BODY_BYTES;
  const maxDepth = limits.maxDepth ?? MAX_BODY_DEPTH;

  if (!isJsonMediaType(request.headers.get('content-type'))) return unsupported();

  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    return tooLarge();
  }

  if (request.body === null) return bad('invalid_json');
  const bytes = await readCapped(request.body, maxBytes);
  if (bytes === null) return tooLarge();
  if (bytes === 'unreadable') return bad('invalid_request');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bad('invalid_encoding');
  }

  if (exceedsDepth(text, maxDepth)) return bad('too_deep');

  let value: unknown;
  try {
    value = JSON.parse(text, dropProto) as unknown;
  } catch {
    return bad('invalid_json');
  }
  if (!isWellFormedTree(value, maxBytes + 1)) return bad('invalid_encoding');
  return { ok: true, value };
}

const SCHEMA_VALIDATION_CODES = [
  'invalid_type',
  'too_small',
  'too_big',
  'invalid_format',
  'invalid_value',
  'unrecognized_keys',
  'invalid_union',
  'invalid',
] as const;

export const VALIDATION_DETAIL_CODES = [
  ...SCHEMA_VALIDATION_CODES,
  ...BODY_VALIDATION_CODES,
] as const;

export const VALIDATION_CODES: ReadonlySet<string> = new Set(VALIDATION_DETAIL_CODES);

export type ValidationCode = (typeof VALIDATION_DETAIL_CODES)[number];

export interface ValidationDetail {
  readonly path: string;
  readonly code: ValidationCode;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly details: readonly ValidationDetail[] };

interface SchemaDef {
  readonly type?: string;
  readonly shape?: Readonly<Record<string, $ZodType>>;
  readonly element?: $ZodType;
  readonly items?: readonly $ZodType[];
  readonly rest?: $ZodType | null;
  readonly innerType?: $ZodType;
  readonly in?: $ZodType;
  readonly left?: $ZodType;
  readonly right?: $ZodType;
  readonly getter?: () => $ZodType;
  readonly discriminator?: string;
  readonly options?: readonly $ZodType[];
}

const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

function defOf(schema: $ZodType): SchemaDef {
  return schema._zod.def as unknown as SchemaDef;
}

type Candidates = readonly $ZodType[];

function unwrap(schema: $ZodType, input: unknown): Candidates {
  let current = schema;
  for (let guard = 0; guard < 32; guard += 1) {
    const def = defOf(current);
    const type = def.type ?? '';
    if (WRAPPERS.has(type) && def.innerType) current = def.innerType;
    else if (type === 'pipe' && def.in) current = def.in;
    else if (type === 'lazy' && def.getter) current = def.getter();
    else break;
  }
  const def = defOf(current);
  if (def.type === 'intersection') {
    return [def.left, def.right].flatMap((branch) => (branch ? unwrap(branch, input) : []));
  }
  if (def.type === 'union' && def.discriminator !== undefined && def.options) {
    const wanted = isRecord(input) ? input[def.discriminator] : undefined;
    const match = def.options.find((option) =>
      option._zod.propValues?.[def.discriminator as string]?.has(wanted as never),
    );
    return match ? unwrap(match, input) : [];
  }
  return [current];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function descend(schema: $ZodType, segment: string | number, input: unknown): Candidates {
  return unwrap(schema, input).flatMap((candidate): Candidates => {
    const def = defOf(candidate);
    switch (def.type) {
      case 'object': {
        if (typeof segment !== 'string' || !def.shape || !Object.hasOwn(def.shape, segment)) {
          return [];
        }
        const child = def.shape[segment];
        return child ? [child] : [];
      }
      case 'array':
        return typeof segment === 'number' && def.element ? [def.element] : [];
      case 'tuple': {
        if (typeof segment !== 'number') return [];
        const child = def.items?.[segment] ?? def.rest;
        return child ? [child] : [];
      }
      default:
        return [];
    }
  });
}

function pointerOf(schema: $ZodType, path: readonly PropertyKey[], input: unknown): string {
  let current: Candidates = [schema];
  let node = input;
  let pointer = '';
  for (const segment of path) {
    if (typeof segment === 'symbol') break;
    const next = current.flatMap((candidate) => descend(candidate, segment, node));
    if (next.length === 0) break;
    pointer += `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
    current = next;
    node = isRecord(node) ? node[segment] : undefined;
  }
  return pointer;
}

function codeOf(issue: $ZodIssue): ValidationCode {
  return VALIDATION_CODES.has(issue.code) ? (issue.code as ValidationCode) : 'invalid';
}

const thrown = (): ValidationResult<never> => ({
  ok: false,
  details: [{ path: '', code: 'invalid' }],
});

export function validateInput<S extends $ZodType>(
  schema: S,
  value: unknown,
): ValidationResult<output<S>> {
  try {
    const result = safeParse(schema, value, { reportInput: false, error: () => 'invalid' });
    if (result.success) return { ok: true, data: result.data };
    const details = result.error.issues.slice(0, MAX_DETAILS).map((issue) => ({
      path: pointerOf(schema, issue.path, value),
      code: codeOf(issue),
    }));
    return { ok: false, details };
  } catch {
    return thrown();
  }
}
