import { packageKey } from '../../catalogue/names.js';
import { CATALOGUE_WINNER_KEYS_MAX, type CatalogueReader } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import type { SourceRepository } from '../../db/source.js';
import { errorEnvelope } from '../../envelope.js';
import { CodecLimitError, type Codecs } from '../../platform/codec.js';
import type { PolicyFetch } from '../../sources/policy-fetch.js';

const REQUEST_MAX = 1024 * 1024;
const RESPONSE_MAX = 4 * REQUEST_MAX;
const ORIGIN = 'https://registry.npmjs.org';

export interface NpmAuditDependencies {
  readonly catalogue: Pick<CatalogueReader, 'classifyWinners'>;
  readonly sources: Pick<SourceRepository, 'hasAttachedProxy'>;
  readonly codecs: Pick<Codecs, 'gunzip'>;
  readonly policyFetch: PolicyFetch;
}

async function boundedBody(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new RangeError('Body exceeds limit');
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

export async function forwardNpmAudit(
  request: Request,
  ctx: OrgContext,
  projectId: string,
  requestId: string,
  dependencies: NpmAuditDependencies,
): Promise<Response> {
  const fail = (status: number, code: string, message: string) =>
    Response.json(errorEnvelope(code, message, requestId), { status });
  if (!(await dependencies.sources.hasAttachedProxy(ctx, projectId, 'npm'))) {
    return fail(404, 'not_found', 'Not found');
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity' && encoding !== 'gzip') {
    return fail(415, 'unsupported_encoding', 'Unsupported content encoding');
  }
  let entries: [string, string[]][];
  let keys: string[];
  try {
    const stream =
      encoding === 'gzip' && request.body !== null
        ? request.body.pipeThrough(dependencies.codecs.gunzip(REQUEST_MAX))
        : request.body;
    const bytes = await boundedBody(stream, REQUEST_MAX);
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return fail(400, 'invalid_request', 'Invalid audit request');
    }
    const values = Object.entries(input);
    if (values.length > CATALOGUE_WINNER_KEYS_MAX) {
      return fail(413, 'too_large', 'Audit request exceeds limit');
    }
    if (
      !values.every(
        ([, versions]) =>
          Array.isArray(versions) && versions.every((v: unknown) => typeof v === 'string'),
      )
    ) {
      return fail(400, 'invalid_request', 'Invalid audit request');
    }
    entries = values as [string, string[]][];
    keys = entries.map(([name]) => packageKey(name, { ecosystem: 'npm', legacyCase: true }));
  } catch (error) {
    return error instanceof RangeError || error instanceof CodecLimitError
      ? fail(413, 'too_large', 'Audit request exceeds limit')
      : fail(400, 'invalid_request', 'Invalid audit request');
  }
  const winners = await dependencies.catalogue.classifyWinners(ctx, {
    projectId,
    ecosystem: 'npm',
    keys,
  });
  const publicKeys = new Set(
    winners.filter(({ winner }) => winner?.sourceType === 'npmjs_proxy').map(({ key }) => key),
  );
  const body = JSON.stringify(
    Object.fromEntries(entries.filter((_, index) => publicKeys.has(keys[index]!))),
  );
  try {
    const upstream = await dependencies.policyFetch({
      url: `${ORIGIN}/-/npm/v1/security/advisories/bulk`,
      method: 'POST',
      purpose: 'api',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(body),
      destinations: [ORIGIN],
      redirects: 'error',
      maxBytes: RESPONSE_MAX,
      timeoutMs: 30_000,
      signal: request.signal,
    });
    if (upstream.status < 200 || upstream.status >= 300) {
      await upstream.body?.cancel().catch(() => undefined);
      return fail(502, 'upstream_error', 'Upstream request failed');
    }
    const bytes = await boundedBody(upstream.body, RESPONSE_MAX);
    const bodyless =
      request.method === 'HEAD' ||
      upstream.status === 204 ||
      upstream.status === 205 ||
      upstream.status === 304;
    return new Response(bodyless ? null : bytes, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return fail(502, 'upstream_error', 'Upstream request failed');
  }
}
