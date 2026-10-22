import { apiError } from '../api/response.js';
import { envelopeResponse } from '../kernel/errors.js';
import type { Kernel } from '../kernel/kernel.js';
import type { RequestContext } from '../plugin.js';
import { mcpCallContextOf } from './transport.js';

const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 50;
const encoder = new TextEncoder();

export interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: true;
}

export function toolResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true as const } : {}) };
}

interface DispatchOptions {
  readonly kernel: Pick<Kernel, 'fetch'>;
  readonly origin: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly paginated: boolean;
  readonly validationError?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function dispatchTool(
  options: DispatchOptions,
  ctx: RequestContext,
): Promise<ToolResult> {
  const call = mcpCallContextOf(ctx);
  const fits = (result: ToolResult) =>
    encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: call?.id ?? null, result })).byteLength <=
    MAX_BYTES;
  const failure = async (
    code: 'bad_gateway' | 'payload_too_large' | 'unavailable',
  ): Promise<ToolResult> => toolResult(await apiError(code, ctx.requestId).text(), true);
  const path = options.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) =>
    encodeURIComponent(options.params[key] ?? ''),
  );
  const url = new URL(options.origin);
  url.pathname = path;
  if (url.origin !== options.origin || url.pathname !== path)
    return toolResult(
      await envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId).text(),
      true,
    );
  for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
  let limit = Math.min(Number(options.query['limit'] ?? MAX_ITEMS), MAX_ITEMS);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.any([
    controller.signal,
    ctx.request.signal,
    ...(call === undefined ? [] : [call.signal]),
  ]);
  let rejectAborted: (() => void) | undefined;
  try {
    if (call === undefined) timer = setTimeout(() => controller.abort(), 10000);
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(signal.reason);
        signal.addEventListener('abort', rejectAborted, { once: true });
        if (signal.aborted) rejectAborted();
      }),
      (async () => {
        for (;;) {
          signal.throwIfAborted();
          if (options.paginated && options.validationError === undefined)
            url.searchParams.set('limit', String(limit));
          const headers = new Headers({ accept: 'application/json' });
          const authorization = ctx.request.headers.get('authorization');
          if (authorization !== null) headers.set('authorization', authorization);
          const response = await options.kernel.fetch(
            new Request(url, {
              method: 'GET',
              headers,
              redirect: 'manual',
              signal,
            }),
          );
          signal.throwIfAborted();
          if (response.status >= 300 && response.status < 400) return failure('bad_gateway');
          if (options.validationError !== undefined && ![401, 403, 404].includes(response.status)) {
            void response.body?.cancel().catch(() => undefined);
            return toolResult(options.validationError, true);
          }
          const raw = await response.text();
          signal.throwIfAborted();
          if (!response.ok) {
            const result = toolResult(raw, true);
            return fits(result) ? result : failure('payload_too_large');
          }
          const body: unknown = JSON.parse(raw);
          const page = record(body) && Array.isArray(body['items']) ? body : null;
          const items = page?.['items'] as unknown[] | undefined;
          const result = toolResult(
            page === null ? raw : JSON.stringify({ ...page, cursor: page['next'] ?? null }),
          );
          if ((items?.length ?? 0) <= MAX_ITEMS && fits(result)) return result;
          if (!options.paginated || limit <= 1 || (items !== undefined && items.length <= 1))
            return failure('payload_too_large');
          // Refetch a smaller REST page so its next cursor includes no omitted items.
          limit = Math.max(1, Math.floor(limit / 2));
        }
      })(),
    ]);
  } catch (error) {
    if (call?.signal.aborted) throw error;
    return failure(signal.aborted ? 'unavailable' : 'bad_gateway');
  } finally {
    clearTimeout(timer);
    if (rejectAborted !== undefined) signal.removeEventListener('abort', rejectAborted);
    controller.abort();
  }
}
