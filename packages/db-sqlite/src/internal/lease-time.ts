import { sql } from 'kysely';

export const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
export const NOW = sql.raw(`strftime('${FORMAT}','now')`);
export const MAX_LEASE_SECONDS = 3600;

export function seconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LEASE_SECONDS
  ) {
    throw new RangeError(`leaseSeconds must be an integer from 1 to ${String(MAX_LEASE_SECONDS)}`);
  }
  return value;
}

export function until(leaseSeconds: number) {
  return sql<string>`strftime('${sql.raw(FORMAT)}','now', ${`+${String(leaseSeconds)} seconds`})`;
}
