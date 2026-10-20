import type { WebhookVerifier } from '@package-broker/core/sources/provider';

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export const githubWebhookVerifier: WebhookVerifier = {
  async verify(secret, headers, rawBody) {
    try {
      const match = SIGNATURE.exec(headers.get('x-hub-signature-256') ?? '');
      const token: unknown = secret.token;
      if (match === null || typeof token !== 'string' || token === '') return false;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(token),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify('HMAC', key, fromHex(match[1]!), rawBody);
    } catch {
      return false;
    }
  },
};
