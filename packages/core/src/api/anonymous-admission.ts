import { isIpLiteral } from '../audit/actions.js';

export type AnonymousEndpoint = 'login-start' | 'login-poll' | 'oidc-exchange';
const IPV6_48_BUDGET_MULTIPLIER = 16;
const BUDGETS: Readonly<Record<AnonymousEndpoint, number>> = {
  'login-start': 10,
  'login-poll': 60,
  'oidc-exchange': 10,
};
const UNKNOWN_BUDGETS: Readonly<Record<AnonymousEndpoint, number>> = {
  'login-start': 2,
  'login-poll': 60,
  'oidc-exchange': 2,
};

function addressKeys(ip: string | null): readonly string[] {
  if (ip === null || !isIpLiteral(ip)) return ['unknown'];
  if (!ip.includes(':')) return [ip];
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left = '', right = ''] = canonical.split('::');
  const prefix = left === '' ? [] : left.split(':');
  const suffix = right === '' ? [] : right.split(':');
  const parts = canonical.includes('::')
    ? [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix]
    : prefix;
  // IPv4-mapped sockets must share the budget of the corresponding IPv4 address.
  if (parts.slice(0, 5).every((part) => part === '0') && parts[5] === 'ffff') {
    return [
      parts
        .slice(6)
        .flatMap((part) => {
          const word = parseInt(part, 16);
          return [word >> 8, word & 255];
        })
        .join('.'),
    ];
  }
  return [`${parts.slice(0, 3).join(':')}::/48`, `${parts.slice(0, 4).join(':')}::/64`];
}

interface Bucket {
  readonly until: number;
  used: number;
}

/** Fixed windows; expiry and LRU indexes keep eviction O(1) amortised. */
export function createAnonymousAdmission(now: () => number, capacity = 65_536) {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new RangeError('Invalid admission capacity');
  // Insertion order follows window deadlines; touches only reorder the LRU index.
  const buckets = new Map<string, Bucket>();
  const lru = new Map<string, Bucket>();
  let lastTime = -Infinity;
  const remove = (key: string): void => {
    buckets.delete(key);
    lru.delete(key);
  };
  return (orgId: string, endpoint: AnonymousEndpoint, ip: string | null): number => {
    const time = Math.max(lastTime, now());
    lastTime = time;
    const addresses = addressKeys(ip);
    const charged: Bucket[] = [];
    for (const address of addresses) {
      const key = JSON.stringify([orgId, endpoint, address]);
      let bucket = buckets.get(key);
      if (bucket !== undefined && bucket.until <= time) {
        remove(key);
        bucket = undefined;
      }
      if (bucket === undefined) {
        if (buckets.size >= capacity) {
          const oldest = buckets.keys().next().value!;
          if (buckets.get(oldest)!.until <= time) remove(oldest);
          else {
            const victim = lru.keys().next().value;
            // Unknown buckets and this request's /48 budget cannot be evicted.
            if (victim === undefined || charged.includes(lru.get(victim)!)) return 60;
            remove(victim);
          }
        }
        bucket = { until: time + 60_000, used: 0 };
        buckets.set(key, bucket);
      }
      if (address !== 'unknown') {
        lru.delete(key);
        lru.set(key, bucket);
      }
      const budget =
        (address === 'unknown' ? UNKNOWN_BUDGETS : BUDGETS)[endpoint] *
        (address.endsWith('::/48') ? IPV6_48_BUDGET_MULTIPLIER : 1);
      if (bucket.used >= budget) return Math.max(1, Math.ceil((bucket.until - time) / 1000));
      charged.push(bucket);
    }
    for (const bucket of charged) bucket.used++;
    return 0;
  };
}
