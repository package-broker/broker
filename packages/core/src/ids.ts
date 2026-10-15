const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const TIME_LIMIT = 2 ** 48;
const RANDOM_LIMIT = 1n << 80n;

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encode(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    out = ENCODING.charAt(Number(rest & 31n)) + out;
    rest >>= 5n;
  }
  return out;
}

let lastTime = -1;
let lastRandom = 0n;

function randomPart(): bigint {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function ulid(now?: number): string {
  const time = now ?? Date.now();
  if (!Number.isInteger(time) || time < 0 || time >= TIME_LIMIT) {
    throw new RangeError(`ulid time must be an integer in [0, 2**48): ${String(time)}`);
  }
  let random: bigint;
  if (time > lastTime) {
    lastTime = time;
    random = randomPart();
  } else if (lastRandom >= RANDOM_LIMIT - 1n) {
    throw new Error('ulid overflow');
  } else {
    random = lastRandom + 1n;
  }
  lastRandom = random;
  return encode(BigInt(lastTime), TIME_LENGTH) + encode(random, RANDOM_LENGTH);
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export function ulidTime(id: string): number {
  if (!isUlid(id)) {
    throw new TypeError(`invalid ULID: ${id}`);
  }
  let time = 0;
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    time = time * 32 + ENCODING.indexOf(id.charAt(index));
  }
  return time;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: () => new Date(instant.getTime()) };
}

export function isoTimestamp(date: Date): string {
  return date.toISOString();
}
