import { describe, expect, it, vi } from 'vitest';
import { npmVcsDescription, parseNpmVcsManifest } from './npm-adapter.js';
import { snapshotRef } from '../../sources/provider.js';
const sha = 'a'.repeat(40);
const snapshot = snapshotRef('sha256:' + 'a'.repeat(64));
const file = (value: unknown) => ({
  ref: 'refs/tags/v1.0.0',
  commit: sha,
  text: JSON.stringify(value),
});
describe('npm VCS adapter', () => {
  it('rejects oversized manifest text before allocating its UTF-8 copy', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(() => parseNpmVcsManifest('{"x":"' + 'a'.repeat(262144) + '"}')).toThrow(
        'invalid_manifest',
      );
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it.each(['files', 'bytes'])('caps aggregate adapter %s', async (budget) => {
    function* files() {
      const count = budget === 'files' ? 50001 : 129;
      for (let i = 0; i < count; i++)
        yield {
          ref: 'unselected',
          commit: sha,
          text: budget === 'bytes' ? 'a'.repeat(262144) : null,
        };
    }
    await expect(npmVcsDescription('fixture', undefined, [], files(), snapshot)).rejects.toThrow(
      'too_large',
    );
  });
  it.each([null, '{', '{}'])(
    'skips an invalid old tag and keeps newer versions complete',
    async (text) => {
      const description = await npmVcsDescription(
        'fixture',
        undefined,
        ['v1.0.0', 'v2.0.0', 'v3.0.0'],
        [
          { ref: 'refs/tags/v1.0.0', commit: sha, text },
          ...['2.0.0', '3.0.0'].map((version) => ({
            ref: `refs/tags/v${version}`,
            commit: sha,
            text: JSON.stringify({ name: 'fixture', version }),
          })),
        ],
        snapshot,
      );
      expect((await collect(description.members)).map((v) => v.version)).toEqual([
        '3.0.0',
        '2.0.0',
      ]);
      expect(description.skippedMembers).toEqual([
        { version: '1.0.0', reason: 'invalid_manifest' },
      ]);
      expect(description.distTags).toEqual({ latest: '3.0.0' });
      expect(description.upstreamComplete).toBe(true);
    },
  );
  it('emits an npm-vcs candidate without upstream dist and chooses latest', async () => {
    const description = await npmVcsDescription(
      '@scope/a',
      undefined,
      ['v1.0.0'],
      [file({ name: '@scope/a', version: '1.0.0', dist: { tarball: 'untrusted' } })],
      snapshot,
    );
    const members = [];
    for await (const item of description.members) members.push(item);
    expect(members).toEqual([
      {
        ordinal: 0,
        version: '1.0.0',
        form: 'npm-vcs',
        raw: JSON.stringify({ name: '@scope/a', version: '1.0.0', gitHead: sha }),
      },
    ]);
    expect(description.distTags).toEqual({ latest: '1.0.0' });
  });
  it.each([
    ['@scope/b', '1.0.0', 'name_mismatch'],
    ['@scope/a', '2.0.0', 'version_mismatch'],
  ])('skips %s at %s as %s', async (name, version, reason) => {
    const description = await npmVcsDescription(
      '@scope/a',
      '@scope/a',
      ['v1.0.0'],
      [file({ name, version })],
      snapshot,
    );
    expect(await collect(description.members)).toEqual([]);
    expect(description.skippedMembers).toEqual([{ version: '1.0.0', reason }]);
    expect(description.distTags).toEqual({});
  });
  it.each([
    '[]',
    '{"name":"a","name":"b"}',
    '{"__proto__":{}}',
    '{"x":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}',
    '{"x":"' + 'a'.repeat(262144) + '"}',
    '{"x":[' + '0,'.repeat(10000) + '0]}',
  ])('refuses bounded or malformed manifests', (text) => {
    expect(() => parseNpmVcsManifest(text)).toThrow('invalid_manifest');
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}
