import type { OrgContext } from '../db/port.js';
import type { RegisteredNameRepository, SourceRepository } from '../db/source.js';
import type { ClaimProbeTarget, SourcePackageProbe } from '../ingest/source-package.js';

const MAX_ENUMERATED_SOURCES = 1000;
const MAX_ENUMERATED_CLAIMS = 1000;
const MAX_CONFLICTING_CLAIMS = 100;

export const MAX_VERIFIED_CLAIMS_BYTES = 48 * 1024;

export interface ProxyClaimDeps {
  readonly sources: Pick<SourceRepository, 'list'>;
  readonly registeredNames: Pick<RegisteredNameRepository, 'list'>;
  readonly claimProbe?: SourcePackageProbe;
}

export async function checkProxyClaims(
  deps: ProxyClaimDeps,
  ctx: OrgContext,
  proxy: ClaimProbeTarget,
  verified?: string[],
): Promise<string[] | null> {
  const deadline = new AbortController();
  const expired = Symbol('claim preflight deadline');
  let expire: (reason: symbol) => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  void timeout.catch(() => {});
  const timer = setTimeout(() => {
    deadline.abort();
    expire(expired);
  }, 15_000);
  const patterns: string[] = [];
  let proofBytes = 2;
  let sourceCount = 0;
  let claimCount = 0;
  const candidates: number[] = [];
  const encoder = new TextEncoder();
  try {
    let after: string | null = null;
    for (;;) {
      const rows: Awaited<ReturnType<ProxyClaimDeps['sources']['list']>> = await Promise.race([
        deps.sources.list(ctx, { projectId: null, ownership: 'all', after, limit: 100 }),
        timeout,
      ]);
      const page = rows.slice(0, 100);
      for (const source of page) {
        if (++sourceCount > MAX_ENUMERATED_SOURCES) return null;
        if (source.ecosystem !== 'npm') continue;
        let next: string | undefined;
        do {
          const names = await Promise.race([
            deps.registeredNames.list(ctx, {
              sourceId: source.id,
              ...(next === undefined ? {} : { after: next }),
              limit: 100,
            }),
            timeout,
          ]);
          for (const { pattern } of names.items) {
            if (++claimCount > MAX_ENUMERATED_CLAIMS) return null;
            if (pattern.includes('*')) continue;
            patterns.push(pattern);
            const bytes =
              encoder.encode(JSON.stringify(pattern)).length + (candidates.length ? 1 : 0);
            if (proofBytes + bytes <= MAX_VERIFIED_CLAIMS_BYTES) {
              candidates.push(patterns.length - 1);
              proofBytes += bytes;
            }
          }
          next = names.next ?? undefined;
        } while (next !== undefined);
      }
      if (rows.length <= 100) break;
      after = page[page.length - 1]!.id;
    }
    const answers = new Set<number>();
    let index = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (index < candidates.length && !deadline.signal.aborted) {
          const position = candidates[index++]!;
          const pattern = patterns[position]!;
          const attempt = new AbortController();
          const attemptTimer = setTimeout(() => attempt.abort(), 5000);
          const signal = AbortSignal.any([deadline.signal, attempt.signal]);
          let onAbort: () => void = () => {};
          try {
            const aborted = new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(new Error('Claim probe deadline'));
              deadline.signal.addEventListener('abort', onAbort, { once: true });
            });
            const answer = await Promise.race([
              deps.claimProbe?.(ctx, proxy, pattern, signal, 'claim'),
              aborted,
            ]);
            if (answer === 'not_found' && !signal.aborted) answers.add(position);
          } catch {
            // Unverified names remain conflicts, including probes that ignore cancellation.
          } finally {
            clearTimeout(attemptTimer);
            deadline.signal.removeEventListener('abort', onAbort);
          }
        }
      }),
    );
    const accepted = candidates
      .filter((position) => answers.has(position))
      .map((position) => patterns[position]!);
    verified?.push(...accepted);
    return patterns
      .filter((_pattern, position) => !answers.has(position))
      .slice(0, MAX_CONFLICTING_CLAIMS);
  } catch (error) {
    if (error === expired) return null;
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
