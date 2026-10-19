import type { ApiRequestDescription } from './api.js';

const STORAGE_KEY = 'pb.pending-action';
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const STORED_KEYS = new Set(['method', 'path', 'idempotencyKey', 'body', 'savedAt']);

export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type RequestFields = Pick<ApiRequestDescription, 'method' | 'path' | 'idempotencyKey' | 'body'>;

export type PendingInput = RequestFields & {
  credential: boolean;
  secretFields: readonly string[];
};

export type PendingAction = RequestFields & { savedAt: number };

type SaveResult = { ok: true } | { ok: false };
type LoadResult = { ok: true; action: PendingAction | null } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/_pb/') &&
    !path.includes('//') &&
    !/[\\:?#{}\s]/.test(path) &&
    !path.split('/').some((part) => {
      const decoded = part.replace(/%2e/gi, '.');
      return decoded === '.' || decoded === '..';
    })
  );
}

function validRequest(value: Record<string, unknown>): boolean {
  return (
    typeof value.method === 'string' &&
    /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(value.method) &&
    validPath(value.path) &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string')
  );
}

function validStored(value: unknown): value is PendingAction {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => STORED_KEYS.has(key)) &&
    validRequest(value) &&
    typeof value.savedAt === 'number' &&
    Number.isFinite(value.savedAt)
  );
}

function redact(body: unknown, fields: readonly string[]): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(body));
  for (const field of fields) {
    const parts = field.split('.');
    let parent: unknown = copy;
    for (const part of parts.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) {
        parent = undefined;
        break;
      }
      parent = (parent as Record<string, unknown>)[part];
    }
    const last = parts[parts.length - 1]!;
    if (parent !== null && typeof parent === 'object' && Object.hasOwn(parent, last)) {
      delete (parent as Record<string, unknown>)[last];
    }
  }
  return copy;
}

export function savePending(storage: PendingStorage, action: PendingInput): SaveResult {
  try {
    if (
      !validRequest(action) ||
      typeof action.credential !== 'boolean' ||
      !Array.isArray(action.secretFields) ||
      !action.secretFields.every((field) => typeof field === 'string')
    ) {
      return { ok: false };
    }
    const pending: PendingAction = {
      method: action.method,
      path: action.path,
      ...(action.idempotencyKey === undefined ? {} : { idempotencyKey: action.idempotencyKey }),
      ...(!action.credential && action.body !== undefined
        ? { body: redact(action.body, action.secretFields) }
        : {}),
      savedAt: Date.now(),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(pending));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function loadPending(storage: PendingStorage, now: number): LoadResult {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
    if (raw === null) return { ok: true, action: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: true, action: null };
    }
    if (
      !validStored(parsed) ||
      !Number.isFinite(now) ||
      now < parsed.savedAt ||
      now - parsed.savedAt > REAUTH_WINDOW_MS
    ) {
      return { ok: true, action: null };
    }
    return { ok: true, action: parsed };
  } catch {
    return { ok: false };
  }
}
