export const QR_MAX_VERSION = 14;

const EC_CODEWORDS_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24] as const;
const EC_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9] as const;
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
];
const PAD_BYTES = [0xec, 0x11] as const;
const FORMAT_MASK = 0x5412;
const FORMAT_GENERATOR = 0x537;
const VERSION_GENERATOR = 0x1f25;
const MASK_COUNT = 8;

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  const index = version - 1;
  return Math.floor(rawModules(version) / 8) - EC_CODEWORDS_PER_BLOCK[index]! * EC_BLOCKS[index]!;
}

function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

export function qrCapacityBytes(version: number): number {
  if (!Number.isInteger(version) || version < 1 || version > QR_MAX_VERSION) {
    throw new RangeError('unsupported QR version');
  }
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

export const QR_MAX_BYTES = qrCapacityBytes(QR_MAX_VERSION);

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function gfMultiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

function reedSolomon(data: readonly number[], degree: number): number[] {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j += 1) {
      next[j] = next[j]! ^ gfMultiply(generator[j]!, 1);
      next[j + 1] = next[j + 1]! ^ gfMultiply(generator[j]!, EXP[i]!);
    }
    generator = next;
  }
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = remainder[i]! ^ gfMultiply(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

function codewordsFor(version: number, bytes: Uint8Array): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  for (let pad = 0; data.length < dataCodewords(version); pad += 1) {
    data.push(PAD_BYTES[pad % 2]!);
  }

  const index = version - 1;
  const blocks = EC_BLOCKS[index]!;
  const ecLength = EC_CODEWORDS_PER_BLOCK[index]!;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks) - ecLength;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let block = 0; block < blocks; block += 1) {
    const length = shortLength + (block < shortBlocks ? 0 : 1);
    const slice = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(slice);
    ecBlocks.push(reedSolomon(slice, ecLength));
  }
  const result: number[] = [];
  for (let i = 0; i < shortLength + 1; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

function bchRemainder(value: number, generator: number, degree: number): number {
  let remainder = value;
  for (let i = 0; i < degree; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> (degree - 1)) * generator);
  }
  return remainder;
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function runPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) {
      run += 1;
      continue;
    }
    if (run >= 5) penalty += 3 + (run - 5);
    run = 1;
  }
  const padded = `0000${line.map((dark) => (dark ? '1' : '0')).join('')}0000`;
  for (let i = 0; i + 11 <= padded.length; i += 1) {
    const window = padded.slice(i, i + 11);
    if (window === '10111010000' || window === '00001011101') penalty += 40;
  }
  return penalty;
}

function penaltyOf(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    const row = modules[y]!;
    penalty += runPenalty(row);
    penalty += runPenalty(modules.map((line) => line[y]!));
    for (let x = 0; x < size; x += 1) {
      if (row[x]) dark += 1;
      if (
        x + 1 < size &&
        y + 1 < size &&
        row[x] === row[x + 1] &&
        row[x] === modules[y + 1]![x] &&
        row[x] === modules[y + 1]![x + 1]
      ) {
        penalty += 3;
      }
    }
  }
  const total = size * size;
  penalty += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return penalty;
}

function buildMatrix(version: number, codewords: readonly number[], forcedMask?: number) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = ALIGNMENT_POSITIONS[version - 1]!;
  const last = positions.length - 1;
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  const drawFormat = (mask: number): void => {
    const data = mask;
    const bits = ((data << 10) | bchRemainder(data, FORMAT_GENERATOR, 10)) ^ FORMAT_MASK;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  if (version >= 7) {
    const bits = (version << 12) | bchRemainder(version, VERSION_GENERATOR, 12);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!reserved[y]![x] && index < codewords.length * 8) {
          modules[y]![x] = ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0;
          index += 1;
        }
      }
    }
  }

  const masked = (mask: number): boolean[][] =>
    modules.map((row, y) =>
      row.map((dark, x) => (!reserved[y]![x] && maskApplies(mask, x, y) ? !dark : dark)),
    );
  let chosen = forcedMask ?? 0;
  if (forcedMask === undefined) {
    let best = Infinity;
    for (let mask = 0; mask < MASK_COUNT; mask += 1) {
      drawFormat(mask);
      const penalty = penaltyOf(masked(mask));
      if (penalty < best) {
        best = penalty;
        chosen = mask;
      }
    }
  }
  drawFormat(chosen);
  return { version, size, mask: chosen, modules: masked(chosen) } satisfies QrMatrix;
}

/** Byte mode, error correction level M, UTF-8. Throws RangeError when the text exceeds QR_MAX_BYTES. */
export function encodeQr(text: string, options: { readonly mask?: number } = {}): QrMatrix {
  const { mask } = options;
  if (mask !== undefined && (!Number.isInteger(mask) || mask < 0 || mask >= MASK_COUNT)) {
    throw new RangeError('unsupported QR mask');
  }
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('QR text is empty');
  if (text.length > QR_MAX_BYTES) throw new RangeError('QR text is too long');
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > QR_MAX_BYTES) throw new RangeError('QR text is too long');
  let version = 1;
  while (qrCapacityBytes(version) < bytes.length) version += 1;
  return buildMatrix(version, codewordsFor(version, bytes), mask);
}
