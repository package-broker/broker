import type { OrgContext } from '@package-broker/core/db/port';
import type { BoundCacheKey, Cache, CacheEnvelope } from '@package-broker/core/platform/cache';

export interface LruCacheOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;

interface Slot {
  readonly envelope: CacheEnvelope;
  readonly bytes: number;
}

function resolveLimit(name: string, value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`${name} must be an integer greater than or equal to 1`);
  }
  return limit;
}

function sizeOf(storageKey: string, envelope: CacheEnvelope): number {
  return (
    storageKey.length +
    envelope.value.byteLength +
    envelope.freshUntil.length +
    (envelope.staleUntil?.length ?? 0) +
    envelope.insertedAt.length
  );
}

function isStorable(envelope: CacheEnvelope): boolean {
  return (
    envelope.value instanceof Uint8Array &&
    typeof envelope.freshUntil === 'string' &&
    typeof envelope.insertedAt === 'string' &&
    (envelope.staleUntil === null || typeof envelope.staleUntil === 'string') &&
    typeof envelope.negative === 'boolean'
  );
}

export function createLruCache(options: LruCacheOptions = {}): Cache {
  const maxBytes = resolveLimit('maxBytes', options.maxBytes, DEFAULT_MAX_BYTES);
  const maxEntries = resolveLimit('maxEntries', options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxEntryBytes = resolveLimit(
    'maxEntryBytes',
    options.maxEntryBytes,
    DEFAULT_MAX_ENTRY_BYTES,
  );

  // A Map iterates in insertion order, so the first key is always the least recently used.
  const slots = new Map<string, Slot>();
  let totalBytes = 0;

  function storageKey(ctx: OrgContext, key: BoundCacheKey): string {
    return `${ctx.orgId}\u0000${key.digest}`;
  }

  function remove(id: string): void {
    const slot = slots.get(id);
    if (slot === undefined) return;
    slots.delete(id);
    totalBytes -= slot.bytes;
  }

  return {
    get(ctx, key) {
      try {
        const id = storageKey(ctx, key);
        const slot = slots.get(id);
        if (slot === undefined) return Promise.resolve(null);
        const { envelope } = slot;
        const now = Date.now();
        const freshUntil = Date.parse(envelope.freshUntil);
        const expiry = Math.max(
          freshUntil,
          envelope.staleUntil === null ? freshUntil : Date.parse(envelope.staleUntil),
        );
        if (!(expiry > now)) {
          remove(id);
          return Promise.resolve(null);
        }
        const state = freshUntil > now ? 'fresh' : 'stale';
        slots.delete(id);
        slots.set(id, slot);
        return Promise.resolve({
          entry: { ...envelope, value: envelope.value.slice() },
          state,
        });
      } catch {
        return Promise.resolve(null);
      }
    },

    set(ctx, key, entry) {
      try {
        const id = storageKey(ctx, key);
        remove(id);
        if (!isStorable(entry)) return Promise.resolve();
        const bytes = sizeOf(id, entry);
        if (entry.value.byteLength > maxEntryBytes || bytes > maxBytes) return Promise.resolve();
        slots.set(id, { envelope: { ...entry, value: entry.value.slice() }, bytes });
        totalBytes += bytes;
        while (slots.size > maxEntries || totalBytes > maxBytes) {
          const oldest = slots.keys().next();
          if (oldest.done === true) break;
          remove(oldest.value);
        }
      } catch {
        return Promise.resolve();
      }
      return Promise.resolve();
    },

    delete(ctx, key) {
      try {
        remove(storageKey(ctx, key));
      } catch {
        return Promise.resolve();
      }
      return Promise.resolve();
    },
  };
}
