export type AppJwtErrorCode = 'invalid_key' | 'invalid_app_id' | 'invalid_now';

const MESSAGES: Record<AppJwtErrorCode, string> = {
  invalid_key: 'GitHub App private key is not a usable RSA key',
  invalid_app_id: 'GitHub App id must be a string of digits',
  invalid_now: 'Clock value must be a positive integer number of seconds',
};

export class AppJwtError extends Error {
  readonly code: AppJwtErrorCode;

  constructor(code: AppJwtErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AppJwtError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const RSA_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const PKCS8_RSA_PREFIX = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, body: readonly number[] | Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(body.length), ...body]);
}

const MAX_PEM_LENGTH = 16384;
const MIN_MODULUS_BITS = 2048;
const MAX_NOW_SECONDS = 1e11;

function decodePem(pem: string): { pkcs8: Uint8Array; raw: Uint8Array } {
  if (pem.length > MAX_PEM_LENGTH) throw new AppJwtError('invalid_key');
  const match =
    /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----$/.exec(
      pem.trim(),
    );
  if (!match) throw new AppJwtError('invalid_key');
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(match[2]!.replace(/\s+/g, '')), (char) => char.charCodeAt(0));
  } catch {
    throw new AppJwtError('invalid_key');
  }
  if (match[1] === 'PRIVATE KEY') return { pkcs8: raw, raw };
  return { pkcs8: der(0x30, [...PKCS8_RSA_PREFIX, ...der(0x04, raw)]), raw };
}

async function importAppKey(pem: string) {
  const { pkcs8, raw } = decodePem(pem);
  try {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_ALGORITHM, false, ['sign']);
    const bits = (key.algorithm as { modulusLength?: number }).modulusLength;
    if (typeof bits !== 'number' || bits < MIN_MODULUS_BITS) throw new AppJwtError('invalid_key');
    return key;
  } catch {
    throw new AppJwtError('invalid_key');
  } finally {
    pkcs8.fill(0);
    raw.fill(0);
  }
}

export async function createAppJwt(key: string, appId: string, now: number): Promise<string> {
  if (!/^[1-9][0-9]{0,19}$/.test(appId)) throw new AppJwtError('invalid_app_id');
  if (!Number.isSafeInteger(now) || now <= 0 || now >= MAX_NOW_SECONDS)
    throw new AppJwtError('invalid_now');
  const cryptoKey = await importAppKey(key);
  const signingInput = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(RSA_ALGORITHM.name, cryptoKey, encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64Url(signature)}`;
}
