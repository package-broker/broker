import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, QR_MAX_VERSION, encodeQr, qrCapacityBytes } from './qr.js';

interface Vector {
  readonly name: string;
  readonly text: string;
  readonly version: number;
  readonly mask: number;
  readonly size: number;
  readonly hex: string;
  readonly forced?: boolean;
}

const fixture = JSON.parse(
  readFileSync(new URL('./test-fixtures/qr-vectors.json', import.meta.url), 'utf8'),
) as { capacities: number[]; vectors: Vector[] };

function packed(modules: readonly (readonly boolean[])[]): string {
  const bits = modules.flatMap((row) => row.map((dark) => (dark ? 1 : 0)));
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!).toString(
      16,
    );
  }
  return hex;
}

describe('qr encoder against an independently generated corpus', () => {
  it('has the byte capacities of the standard for level M', () => {
    expect(fixture.capacities).toHaveLength(QR_MAX_VERSION);
    fixture.capacities.forEach((capacity, index) => {
      expect(qrCapacityBytes(index + 1)).toBe(capacity);
    });
    expect(QR_MAX_BYTES).toBe(fixture.capacities[QR_MAX_VERSION - 1]);
  });

  it.each(fixture.vectors.map((vector) => [vector.name, vector] as const))(
    'matches the reference matrix for %s',
    (_, vector) => {
      const matrix = encodeQr(vector.text, { mask: vector.mask });
      expect(matrix.version).toBe(vector.version);
      expect(matrix.size).toBe(vector.size);
      expect(matrix.mask).toBe(vector.mask);
      expect(packed(matrix.modules)).toBe(vector.hex);
    },
  );

  it('selects a mask on its own and the result is the same symbol as forcing that mask', () => {
    for (const vector of fixture.vectors.filter((entry) => !entry.forced)) {
      const automatic = encodeQr(vector.text);
      expect(automatic.mask).toBeGreaterThanOrEqual(0);
      expect(automatic.mask).toBeLessThan(8);
      expect(packed(automatic.modules)).toBe(
        packed(encodeQr(vector.text, { mask: automatic.mask }).modules),
      );
    }
  });

  it('keeps the three finder patterns, the timing lines and the dark module', () => {
    const { modules, size } = encodeQr('https://example.test/');
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(modules[y]![x]).toBe(true);
      expect(modules[y + 3]![x + 3]).toBe(true);
      expect(modules[y + 1]![x + 1]).toBe(false);
    }
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });
});

describe('qr input bounds', () => {
  it('rejects empty input and inputs longer than the largest supported symbol', () => {
    expect(() => encodeQr('')).toThrow(TypeError);
    expect(() => encodeQr('a'.repeat(QR_MAX_BYTES + 1))).toThrow(RangeError);
    expect(encodeQr('a'.repeat(QR_MAX_BYTES)).version).toBe(QR_MAX_VERSION);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(() => encodeQr('é'.repeat(Math.floor(QR_MAX_BYTES / 2) + 1))).toThrow(RangeError);
    expect(encodeQr('é'.repeat(Math.floor(QR_MAX_BYTES / 2))).version).toBe(QR_MAX_VERSION);
  });

  it('rejects an unsupported mask or version', () => {
    expect(() => encodeQr('abc', { mask: 8 })).toThrow(RangeError);
    expect(() => encodeQr('abc', { mask: 1.5 })).toThrow(RangeError);
    expect(() => qrCapacityBytes(0)).toThrow(RangeError);
    expect(() => qrCapacityBytes(QR_MAX_VERSION + 1)).toThrow(RangeError);
  });
});
