import { notificationHeaders } from '@package-broker/core/runtime/notification-jobs';
import { createWorkersNotificationTransport } from '../src/notifications/transport.ts';

const BODY = new TextEncoder().encode('{"schemaVersion":1,"gate":true}');

function cloudflareCode(value) {
  return /^\d{3,6}$/.test(String(value)) ? String(value) : null;
}

function errorClass(error) {
  return {
    errorClass: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name) ? error.name : 'Error',
    cloudflareCode:
      cloudflareCode(error?.code) ??
      cloudflareCode(error?.cause?.code) ??
      /error code[: ]+(\d{3,6})/i.exec(error?.message ?? '')?.[1] ??
      null,
  };
}

async function platform(gateCase) {
  try {
    const response = await fetch(gateCase.url, {
      method: gateCase.method,
      headers: { 'content-type': 'application/json' },
      body: BODY,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return {
      kind: 'response',
      status: response.status,
      errorClass: response.status >= 400 ? 'CloudflareHttpError' : null,
      cloudflareCode: cloudflareCode(response.headers.get('cf-error-code')),
    };
  } catch (error) {
    return { kind: 'error', status: null, ...errorClass(error) };
  }
}

async function broker(gateCase) {
  let error = null;
  const transport = createWorkersNotificationTransport({
    selfOrigins: [],
    fetch: async (...args) => {
      try {
        const response = await fetch(...args);
        if (response.status >= 400)
          error = {
            errorClass: 'CloudflareHttpError',
            cloudflareCode: cloudflareCode(response.headers.get('cf-error-code')),
          };
        return response;
      } catch (caught) {
        error = errorClass(caught);
        throw caught;
      }
    },
  });
  const signed = await notificationHeaders({
    key: crypto.getRandomValues(new Uint8Array(32)),
    timestamp: Math.floor(Date.now() / 1000),
    deliveryId: '01JGATE0000000000000000000',
    eventId: '01JGATEEVENT00000000000000',
    method: gateCase.method,
    body: BODY,
  });
  const result = await transport.send({
    url: gateCase.url,
    method: gateCase.method,
    headers: [],
    signed,
    body: BODY,
    signal: new AbortController().signal,
  });
  return {
    kind: result.kind,
    status: result.kind === 'response' ? result.status : null,
    ...(error ?? {
      errorClass:
        result.kind === 'refused'
          ? 'NotificationDestinationRefused'
          : result.kind === 'timeout'
            ? 'TimeoutError'
            : result.kind === 'response' && result.status >= 400
              ? 'CloudflareHttpError'
              : null,
      cloudflareCode: null,
    }),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      url.pathname === '/ready' &&
      request.headers.get('authorization') === `Bearer ${env.GATE_SECRET}`
    )
      return new Response(null, { status: 204 });
    if (
      request.method !== 'POST' ||
      url.pathname !== '/run' ||
      request.headers.get('authorization') !== `Bearer ${env.GATE_SECRET}`
    )
      return new Response(null, { status: 404 });
    const { cases } = await request.json();
    const observations = await Promise.all(
      cases.map(async (gateCase) => ({
        id: gateCase.id,
        live: true,
        ...(gateCase.mode === 'platform' ? await platform(gateCase) : await broker(gateCase)),
      })),
    );
    return Response.json(observations);
  },
};
