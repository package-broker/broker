import { describe, expect, it } from 'vitest';
import { finaliseSecurityHeaders } from './security-headers.js';

describe('finaliseSecurityHeaders', () => {
  it('handles immutable redirect headers without changing the source response', () => {
    const original = Response.redirect('https://public.test/target');
    const response = finaliseSecurityHeaders(original, true, false);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://public.test/target');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(original.headers.has('x-content-type-options')).toBe(false);
  });

  it('preserves a streaming body and response status', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    const response = finaliseSecurityHeaders(new Response(body, { status: 201 }), true, false);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('streamed');
  });
});
