import { packageKey } from '../../catalogue/names.js';
import { validateVersion } from '../../catalogue/versions.js';
import { CATALOGUE_WINNER_KEYS_MAX, type CatalogueReader } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import type { SourceRepository } from '../../db/source.js';
import type {
  AuthorizedNpmAudit,
  NpmAuditAuthorizer,
  NpmAuditRef,
} from '../../db/vulnerability.js';
import type { Observability } from '../../platform/observability.js';
import { UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import { sanitizeNpmAuditResponse, type NpmAuditAdvisory } from './audit-response.js';

const RESPONSE_MAX = 4 * 1024 * 1024;
const ORIGIN = 'https://registry.npmjs.org';
const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
};

export type NpmAuditEntries = readonly (readonly [string, readonly string[]])[];

export interface NpmAuditDependencies extends NpmAuditAuthorizer {
  readonly classifyWinners: CatalogueReader['classifyWinners'];
  readonly hasAttachedProxy: SourceRepository['hasAttachedProxy'];
  /** Bound to registry.userAgent.default, without credentials or request tracing headers. */
  readonly policyFetch: PolicyFetch;
  readonly observability: Pick<Observability, 'log'>;
}

export function serializeNpmAudit(grant: AuthorizedNpmAudit): string {
  const names = new Map<string, Set<string>>();
  for (const { name, version } of grant.tuples) {
    const versions = names.get(name) ?? new Set<string>();
    versions.add(version);
    names.set(name, versions);
  }
  return JSON.stringify(
    Object.fromEntries(
      [...names]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, versions]) => [name, [...versions].sort()]),
    ),
  );
}

async function boundedBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX) throw new RangeError('Body exceeds limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Reason =
  | 'ok'
  | 'empty'
  | 'unsupported'
  | 'verify_overflow'
  | 'verify_failed'
  | 'upstream_unavailable'
  | 'upstream_rate_limited'
  | 'upstream_status'
  | 'upstream_protocol'
  | 'aborted';

export async function forwardNpmAudit(
  entries: NpmAuditEntries,
  request: Request,
  ctx: OrgContext,
  projectId: string,
  requestId: string,
  dependencies: NpmAuditDependencies,
): Promise<Response> {
  let reason: Reason = 'verify_failed';
  let forwardedNames = 0;
  let advisories = 0;
  let unexpectedKeys = 0;
  let droppedAdvisories = 0;
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS });
  const fail = () =>
    json(502, { error: 'Upstream request failed', code: 'upstream_error', requestId });
  function checkAbort() {
    if (request.signal.aborted) {
      reason = 'aborted';
      throw new DOMException('Audit request aborted', 'AbortError');
    }
  }
  try {
    checkAbort();
    const normalized = new Map<string, { spellings: Set<string>; versions: Set<string> }>();
    for (const [name, versions] of entries) {
      const key = packageKey(name, { ecosystem: 'npm', legacyCase: true });
      const value = normalized.get(key) ?? {
        spellings: new Set<string>(),
        versions: new Set<string>(),
      };
      value.spellings.add(name);
      for (const version of versions) {
        if (new TextEncoder().encode(version).byteLength > 200) continue;
        try {
          validateVersion({ ecosystem: 'npm', version, versionNormalized: version });
          value.versions.add(version);
        } catch {
          // Invalid versions are ineligible pairs, not malformed bulk requests.
        }
      }
      normalized.set(key, value);
    }

    let grant: AuthorizedNpmAudit;
    try {
      if (!(await dependencies.hasAttachedProxy(ctx, projectId, 'npm'))) {
        reason = 'unsupported';
        checkAbort();
        return json(501, {
          error: 'npm audit requires an npmjs.org proxy source in this project',
          code: 'unsupported',
          requestId,
        });
      }
      checkAbort();
      const keys = [...normalized.keys()];
      const refs: NpmAuditRef[] = [];
      for (let offset = 0; offset < keys.length; offset += CATALOGUE_WINNER_KEYS_MAX) {
        const winners = await dependencies.classifyWinners(ctx, {
          projectId,
          ecosystem: 'npm',
          keys: keys.slice(offset, offset + CATALOGUE_WINNER_KEYS_MAX),
        });
        checkAbort();
        for (const { key, winner } of winners) {
          if (winner?.sourceType !== 'npmjs_proxy') continue;
          for (const version of normalized.get(key)?.versions ?? []) {
            refs.push({ sourceId: winner.sourceId, key, version });
          }
        }
      }
      grant = await dependencies.authorizeNpmAudit(ctx, refs);
    } catch (error) {
      checkAbort();
      reason =
        error instanceof Error &&
        (error.message === 'vulnerability evidence unavailable' ||
          error.message === 'vulnerability snapshot malformed')
          ? 'verify_overflow'
          : 'verify_failed';
      return fail();
    }
    checkAbort();
    if (grant.orgId !== ctx.orgId) {
      reason = 'verify_failed';
      return fail();
    }
    const sentNames = new Set(grant.tuples.map(({ name }) => name));
    forwardedNames = sentNames.size;
    if (grant.tuples.length === 0) {
      reason = 'empty';
      return json(200, {});
    }
    reason = 'upstream_unavailable';
    try {
      const upstream = await dependencies.policyFetch({
        url: `${ORIGIN}/-/npm/v1/security/advisories/bulk`,
        method: 'POST',
        purpose: 'api',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(serializeNpmAudit(grant)),
        destinations: [ORIGIN],
        redirects: 'error',
        maxBytes: RESPONSE_MAX,
        timeoutMs: 30_000,
        signal: request.signal,
      });
      checkAbort();
      if (upstream.status < 200 || upstream.status >= 300 || upstream.redirected) {
        reason =
          upstream.status === 429
            ? 'upstream_rate_limited'
            : upstream.status >= 500 || upstream.redirected
              ? 'upstream_unavailable'
              : 'upstream_status';
        await upstream.body?.cancel().catch(() => undefined);
        checkAbort();
        return fail();
      }
      reason = 'upstream_protocol';
      const clean = sanitizeNpmAuditResponse(await boundedBody(upstream.body), sentNames);
      checkAbort();
      if (clean === null) return fail();
      const body: Record<string, NpmAuditAdvisory[]> = Object.create(null);
      for (const [name, list] of Object.entries(clean.body)) {
        advisories += list.length;
        const key = packageKey(name, { ecosystem: 'npm', legacyCase: true });
        for (const spelling of normalized.get(key)?.spellings ?? []) body[spelling] = list;
      }
      unexpectedKeys = clean.unexpectedKeys;
      droppedAdvisories = clean.droppedAdvisories;
      reason = 'ok';
      return json(200, body);
    } catch (error) {
      checkAbort();
      if (error instanceof UpstreamError) {
        reason = error.code === 'too_large' ? 'upstream_protocol' : 'upstream_unavailable';
      }
      return fail();
    }
  } finally {
    dependencies.observability.log({
      level: 'info',
      event: 'registry.npm_audit',
      outcome: request.signal.aborted
        ? 'aborted'
        : reason === 'ok' || reason === 'empty'
          ? 'success'
          : 'error',
      reason_code: reason,
      requested_names: new Set(entries.map(([name]) => name)).size,
      forwarded_names: forwardedNames,
      advisories,
      unexpected_keys: unexpectedKeys,
      dropped_advisories: droppedAdvisories,
    });
  }
}
