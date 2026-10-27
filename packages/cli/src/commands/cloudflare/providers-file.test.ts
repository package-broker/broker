import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareError } from './api.js';
import { readProvidersOption } from './providers-file.js';

const provider = {
  id: 'corp',
  kind: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'broker',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
};
const compact = JSON.stringify([provider]);
const read = (raw: string | Uint8Array) =>
  vi.fn(async () => (typeof raw === 'string' ? Buffer.from(raw) : raw));
async function refused(raw: string, problem: string) {
  const promise = readProvidersOption('private-path.json', read(raw));
  await expect(promise).rejects.toBeInstanceOf(CloudflareError);
  await expect(promise).rejects.toMatchObject({
    code: 'invalid_input',
    exitCode: 2,
    message: expect.stringContaining(problem),
  });
  await expect(promise).rejects.not.toHaveProperty(
    'message',
    expect.stringContaining('private-path'),
  );
}

describe('readProvidersOption', () => {
  it('distinguishes absent and remove without reading', async () => {
    const file = read('');
    expect(await readProvidersOption(undefined, file)).toEqual({ kind: 'absent' });
    expect(await readProvidersOption('none', file)).toEqual({ kind: 'remove' });
    expect(file).not.toHaveBeenCalled();
  });

  it('reads UTF-8 and returns the compact document and ids', async () => {
    const file = read(JSON.stringify([provider], null, 2));
    expect(await readProvidersOption('x.json', file)).toEqual({
      kind: 'set',
      value: compact,
      ids: ['corp'],
    });
    expect(file).toHaveBeenCalledWith('x.json', 'deploy');
  });

  it('accepts raw whitespace above the runtime bound after compaction', async () => {
    const raw = JSON.stringify([provider], null, ' '.repeat(10)) + ' '.repeat(5120);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(5120);
    expect(await readProvidersOption('x.json', read(raw))).toMatchObject({ value: compact });
  });

  it('enforces the compact UTF-8 byte bound, not character count', async () => {
    const raw = JSON.stringify([{ ...provider, clientId: 'é'.repeat(2600) }]);
    expect(raw.length).toBeLessThan(5120);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(5120);
    await refused(raw, 'too_large');
  });

  it('refuses files above 64 KiB before attempting syntax or member parsing', async () => {
    await refused('[' + ' '.repeat(64 * 1024), 'file_too_large');
    await refused('é'.repeat(32769), 'file_too_large');
  });

  it.each([
    '{"a":1,"a":2}',
    '[{"id":"corp","id":"other"}]',
    '[{"policy":{"autoJoin":true,"autoJoin":false}}]',
    '{"a":1,"\\u0061":2}',
    '[{"a\\"b":1,"a\\u0022b":2}]',
  ])('rejects repeated members at any depth: %s', async (raw) => {
    await refused(raw, 'duplicate_member');
  });

  it('allows the same keys in sibling objects and ignores punctuation inside strings', async () => {
    const entries = [
      { ...provider, clientId: 'a\\"{}[]:,' },
      { ...provider, id: 'second', issuer: 'https://second.example.com' },
    ];
    expect(await readProvidersOption('x.json', read(JSON.stringify(entries)))).toMatchObject({
      kind: 'set',
      ids: ['corp', 'second'],
    });
  });

  it.each(['{', '[{"a":"\\q"}]', '[true,]'])('refuses syntax errors: %s', async (raw) => {
    await refused(raw, 'syntax');
  });

  it.each(['{}', 'null', '"text"', '1'])('refuses non-arrays: %s', async (raw) => {
    await refused(raw, 'not_array');
  });

  it('lists all rejected indexes, validated ids and codes without source values', async () => {
    const raw = JSON.stringify([
      { ...provider, issuer: 'ISSUER_SENTINEL', policy: { verifiedDomains: ['DOMAIN_SENTINEL'] } },
      { ...provider, id: 'UNSAFE_ID_SENTINEL', issuer: 'SECOND_ISSUER_SENTINEL' },
    ]);
    const promise = readProvidersOption('x.json', read(raw));
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('"index":0,"id":"corp","codes":'),
    });
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('"index":1,"codes":'),
    });
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('kind_rules'),
    });
    await expect(promise).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('SENTINEL'),
    );
  });

  it('refuses over-cap documents and duplicate provider identities', async () => {
    await refused(JSON.stringify(Array(65).fill(null)), 'over_cap');
    await refused(JSON.stringify([provider, provider]), 'duplicate_id');
  });

  it('refuses unreadable files without echoing the filesystem error', async () => {
    const file = vi.fn(async () => {
      throw new Error('SECRET_FILESYSTEM_SENTINEL');
    });
    await expect(readProvidersOption('x.json', file)).rejects.toMatchObject({
      code: 'invalid_input',
      exitCode: 2,
      message: 'Invalid providers: unreadable',
    });
  });
});

it('reports syntax before duplicate members in malformed input', async () => {
  await refused('{"a":1,"a":2,}', 'syntax');
  await refused('["' + '\\"'.repeat(32766), 'syntax');
});

it('rejects invalid UTF-8 with its own safe problem class', async () => {
  await expect(
    readProvidersOption('x.json', read(Uint8Array.of(0x5b, 0xff, 0x5d)), 'setup'),
  ).rejects.toMatchObject({ message: 'Invalid providers: encoding', stage: 'setup' });
});

it('strips exactly one leading UTF-8 BOM', async () => {
  expect(await readProvidersOption('x.json', read('\ufeff[]'))).toMatchObject({ value: '[]' });
  await refused('\ufeff\ufeff[]', 'syntax');
});

it('keeps filesystem exceptions, including TypeError, in the unreadable class', async () => {
  await expect(
    readProvidersOption('x.json', async () => {
      throw new TypeError('SENTINEL');
    }),
  ).rejects.toMatchObject({ message: 'Invalid providers: unreadable', stage: 'deploy' });
});

it('handles real files at the raw size boundary and rejects sparse oversized files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-providers-bound-'));
  const path = join(dir, 'providers.json');
  try {
    await writeFile(path, '[]' + ' '.repeat(65534));
    expect(await readProvidersOption(path)).toEqual({ kind: 'set', value: '[]', ids: [] });
    await truncate(path, 2 ** 30);
    await expect(readProvidersOption(path)).rejects.toMatchObject({
      message: 'Invalid providers: file_too_large',
    });
    await expect(readProvidersOption(dir)).rejects.toMatchObject({
      message: 'Invalid providers: unreadable',
    });
    await expect(readProvidersOption(join(dir, 'missing'))).rejects.toMatchObject({
      message: 'Invalid providers: unreadable',
    });
    await writeFile(path, Uint8Array.of(0xff));
    await expect(readProvidersOption(path)).rejects.toMatchObject({
      message: 'Invalid providers: encoding',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')(
  'refuses devices and FIFOs without reading them',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-providers-fifo-'));
    try {
      const path = join(dir, 'pipe');
      execFileSync('mkfifo', [path]);
      for (const file of [path, '/dev/zero']) {
        await expect(readProvidersOption(file)).rejects.toMatchObject({
          message: 'Invalid providers: unreadable',
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
