export type NotificationMethod = 'POST' | 'PUT';

export interface NotificationSignatureInput {
  readonly key: Uint8Array;
  /** Integer Unix seconds of this attempt. */
  readonly timestamp: number;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly method: NotificationMethod;
  readonly body: Uint8Array;
}

export interface NotificationVerificationInput extends NotificationSignatureInput {
  readonly signature: string;
  /** Receiver clock in integer Unix seconds. */
  readonly now: number;
}

export class NotificationSignatureError extends Error {
  constructor() {
    super('Invalid notification signature input');
    this.name = 'NotificationSignatureError';
  }
}

const KEY_BYTES = 32;
const MAX_ID_LENGTH = 256;
const MAX_SKEW_SECONDS = 300;
const PRINTABLE_ID = /^[\x21-\x7e]+$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const encoder = new TextEncoder();

function validId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && PRINTABLE_ID.test(value);
}

function signedBytes(input: NotificationSignatureInput): Uint8Array<ArrayBuffer> {
  if (
    !(input.key instanceof Uint8Array) ||
    input.key.length !== KEY_BYTES ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp <= 0 ||
    !validId(input.deliveryId) ||
    !validId(input.eventId) ||
    (input.method !== 'POST' && input.method !== 'PUT') ||
    !(input.body instanceof Uint8Array)
  ) {
    throw new NotificationSignatureError();
  }
  const prefix = encoder.encode(
    `v1\n${input.timestamp}\n${input.deliveryId}\n${input.eventId}\n${input.method}\n`,
  );
  const data = new Uint8Array(prefix.length + input.body.length);
  data.set(prefix);
  data.set(input.body, prefix.length);
  return data;
}

function hmacKey(key: Uint8Array, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', key.slice(), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);
}

export async function signNotification(input: NotificationSignatureInput): Promise<string> {
  const data = signedBytes(input);
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(input.key, 'sign'), data),
  );
  return `v1=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function notificationHeaders(
  input: NotificationSignatureInput,
): Promise<readonly (readonly [name: string, value: string])[]> {
  const signature = await signNotification(input);
  return [
    ['Content-Type', 'application/json'],
    ['X-Package-Broker-Timestamp', String(input.timestamp)],
    ['X-Package-Broker-Signature', signature],
    ['X-Package-Broker-Delivery', input.deliveryId],
    ['Idempotency-Key', input.deliveryId],
    ['X-Package-Broker-Event', input.eventId],
  ];
}

/** Receiver-side check: constant-time HMAC comparison and a ±300 s timestamp window. */
export async function verifyNotificationSignature(
  input: NotificationVerificationInput,
): Promise<boolean> {
  const hex = SIGNATURE.exec(input.signature)?.[1];
  if (hex === undefined || !Number.isSafeInteger(input.now)) return false;
  if (Math.abs(input.now - input.timestamp) > MAX_SKEW_SECONDS) return false;
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = signedBytes(input);
  } catch {
    return false;
  }
  const mac = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(input.key, 'verify'), mac, data);
}
