import type { AuditContext } from '../audit/actions.js';
import { isCredentialValue } from '../audit/redact.js';
import { errorEnvelope } from '../envelope.js';
import type { Principal } from '../plugin.js';
import { API_ERROR_CODES, jsonResponse } from './response.js';

export const IDEMPOTENCY_TTL_SECONDS = 86400;
const MAX_RESPONSE_BYTES = 8192;

export interface IdempotencyRecord {
  principalKey: string;
  key: string;
  route: string;
  requestHash: string;
  status: number;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiCall {
  audit: AuditContext;
  idempotency?: IdempotencyRecord;
}

export function parseIdempotencyKey(
  header: string | null,
): { ok: true; key: string | null } | { ok: false } {
  if (header === null) return { ok: true, key: null };
  return header.length >= 1 && header.length <= 128 && !/[^A-Za-z0-9_-]/.test(header)
    ? { ok: true, key: header }
    : { ok: false };
}

export function principalKey(principal: Principal): string {
  const key = `${principal.kind}:${principal.id}`;
  if (key.length > 80) throw new TypeError('Principal key is too long');
  return key;
}

function sortJson(value: unknown, checkCredentials: boolean): string {
  if (typeof value === 'string' && checkCredentials && isCredentialValue(value)) {
    throw new TypeError('Response contains a credential value');
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => sortJson(item, checkCredentials)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortJson(object[key], checkCredentials)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedJson(value: unknown, checkCredentials = false): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError('Value cannot be serialized as JSON');
  }
  if (json === undefined) throw new TypeError('Value cannot be serialized as JSON');
  return sortJson(JSON.parse(json) as unknown, checkCredentials);
}

export async function requestHash(input: {
  method: string;
  route: string;
  params: Readonly<Record<string, string>>;
  body: unknown;
}): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sortedJson(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildIdempotencyRecord(input: {
  principal: Principal;
  key: string;
  route: string;
  hash: string;
  status: number;
  response: unknown;
  now: Date;
}): IdempotencyRecord {
  const responseJson = sortedJson(input.response, true);
  if (new TextEncoder().encode(responseJson).byteLength > MAX_RESPONSE_BYTES) {
    throw new TypeError('Response is too large');
  }
  return {
    principalKey: principalKey(input.principal),
    key: input.key,
    route: input.route,
    requestHash: input.hash,
    status: input.status,
    responseJson,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000).toISOString(),
  };
}

export function decideReplay(
  existing: IdempotencyRecord | null,
  hash: string,
  now: Date,
): 'proceed' | 'replay' | 'mismatch' {
  if (existing === null || new Date(existing.expiresAt).getTime() <= now.getTime()) {
    return 'proceed';
  }
  return existing.requestHash === hash ? 'replay' : 'mismatch';
}

export function replayResponse(record: IdempotencyRecord, requestId: string): Response {
  const body = JSON.parse(record.responseJson) as unknown;
  let response: Response;
  if (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    body.code === 'already_issued'
  ) {
    response = jsonResponse(409, {
      ...errorEnvelope('already_issued', API_ERROR_CODES.already_issued.message, requestId),
      id: 'id' in body ? body.id : undefined,
    });
  } else {
    response = jsonResponse(record.status, body);
  }
  response.headers.set('Idempotent-Replayed', 'true');
  return response;
}

type Settlement<T> =
  | { kind: 'result'; result: T }
  | { kind: 'replay'; record: IdempotencyRecord }
  | { kind: 'mismatch' };

export async function settleIdempotent<T>(input: {
  record: IdempotencyRecord | undefined;
  hash: string;
  now: Date;
  find: () => Promise<IdempotencyRecord | null>;
  run: () => Promise<T>;
  failed: (result: T) => boolean;
}): Promise<Settlement<T>> {
  if (input.record === undefined) return { kind: 'result', result: await input.run() };
  const findWinner = async (): Promise<Exclude<Settlement<T>, { kind: 'result' }> | null> => {
    const record = await input.find();
    const decision = decideReplay(record, input.hash, input.now);
    if (decision === 'replay' && record !== null) return { kind: 'replay', record };
    return decision === 'mismatch' ? { kind: 'mismatch' } : null;
  };
  let result: T;
  try {
    result = await input.run();
  } catch (error) {
    const winner = await findWinner();
    if (winner !== null) return winner;
    throw error;
  }
  if (input.failed(result)) {
    const winner = await findWinner();
    if (winner !== null) return winner;
  }
  return { kind: 'result', result };
}
