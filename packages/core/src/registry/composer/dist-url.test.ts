import { describe, expect, it } from 'vitest';
import { composerDistPath, parseComposerDistPath } from './dist-url.js';

const ID = '01HZX3K9M2ABCDEFGHJKMNPQRS';
const MAX_REVISION = 2 ** 31 - 1;

function build(name: string, revision = 1, type: 'zip' | 'tar' = 'zip'): string {
  return composerDistPath({ project: 'acme', key: name, versionId: ID, revision, type });
}

describe('composerDistPath', () => {
  it('builds the permanent path', () => {
    expect(build('monolog/monolog', 7, 'tar')).toBe(`/acme/dist/monolog/monolog/${ID}.7.tar`);
  });

  it.each(['vendor/pkg.name', 'vendor/pkg-name', 'my.vendor/my-pkg_x', 'a-b/c--d.e'])(
    'round trips %s across the revision range',
    (name) => {
      for (const revision of [1, 2, 10, 999, MAX_REVISION]) {
        for (const type of ['zip', 'tar'] as const) {
          const [vendor, pkg] = name.split('/');
          expect(parseComposerDistPath(build(name, revision, type))).toEqual({
            project: 'acme',
            vendor,
            package: pkg,
            key: name,
            versionId: ID,
            revision,
            type,
          });
        }
      }
    },
  );

  it.each([0, -1, 1.5, 2 ** 31, Number.NaN, Number.MAX_SAFE_INTEGER])(
    'refuses revision %s',
    (revision) => {
      expect(() => build('a/b', revision)).toThrow(TypeError);
    },
  );

  it('reverses parse exactly', () => {
    for (const p of [`/acme/dist/a/b/${ID}.1.zip`, `/x-1/dist/my.v/p--q.r/${ID}.2147483647.tar`]) {
      const ref = parseComposerDistPath(p);
      expect(ref).not.toBeNull();
      if (ref !== null) {
        expect(composerDistPath({ ...ref })).toBe(p);
      }
    }
  });

  it('refuses a bad id, name, project or type', () => {
    expect(() =>
      composerDistPath({
        project: 'acme',
        key: 'a/b',
        versionId: ID.slice(1),
        revision: 1,
        type: 'zip',
      }),
    ).toThrow(TypeError);
    expect(() => build('a/../b')).toThrow(TypeError);
    expect(() => build('ab')).toThrow(TypeError);
    expect(() =>
      composerDistPath({ project: '../x', key: 'a/b', versionId: ID, revision: 1, type: 'zip' }),
    ).toThrow(TypeError);
    expect(() =>
      composerDistPath({
        project: 'acme',
        key: 'a/b',
        versionId: ID,
        revision: 1,
        type: 'rar' as 'zip',
      }),
    ).toThrow(TypeError);
  });
});

describe('parseComposerDistPath refusals', () => {
  const ok = `/acme/dist/a/b/${ID}.1.zip`;

  it('accepts the baseline', () => {
    expect(parseComposerDistPath(ok)).not.toBeNull();
  });

  it.each([
    ['double encoded slash', `/acme/dist/a%252fb/b/${ID}.1.zip`],
    ['encoded slash', `/acme/dist/a%2fb/b/${ID}.1.zip`],
    ['encoded dot', `/acme/dist/%2e%2e/b/${ID}.1.zip`],
    ['dot segment vendor', `/acme/dist/../b/${ID}.1.zip`],
    ['dot segment name', `/acme/dist/a/./${ID}.1.zip`],
    ['dot segment project', `/../dist/a/b/${ID}.1.zip`],
    ['backslash', `/acme/dist/a\\b/b/${ID}.1.zip`],
    ['25-character id', `/acme/dist/a/b/${ID.slice(1)}.1.zip`],
    ['27-character id', `/acme/dist/a/b/0${ID}.1.zip`],
    ['lowercase id', `/acme/dist/a/b/${ID.toLowerCase()}.1.zip`],
    ['id with I', `/acme/dist/a/b/I${ID.slice(1)}.1.zip`],
    ['revision 0', `/acme/dist/a/b/${ID}.0.zip`],
    ['leading zero revision', `/acme/dist/a/b/${ID}.01.zip`],
    ['revision 2^31', `/acme/dist/a/b/${ID}.${2 ** 31}.zip`],
    ['huge revision', `/acme/dist/a/b/${ID}.99999999999999999999.zip`],
    ['signed revision', `/acme/dist/a/b/${ID}.+1.zip`],
    ['unknown extension', `/acme/dist/a/b/${ID}.1.rar`],
    ['upper-case extension', `/acme/dist/a/b/${ID}.1.ZIP`],
    ['tar.gz', `/acme/dist/a/b/${ID}.1.tar.gz`],
    ['no extension', `/acme/dist/a/b/${ID}.1`],
    ['no revision', `/acme/dist/a/b/${ID}.zip`],
    ['extra segment', `/acme/dist/a/b/c/${ID}.1.zip`],
    ['missing segment', `/acme/dist/a/${ID}.1.zip`],
    ['trailing slash', `${ok}/`],
    ['query', `${ok}?x=1`],
    ['fragment', `${ok}#x`],
    ['wrong literal', `/acme/p2/a/b/${ID}.1.zip`],
    ['no leading slash', `acme/dist/a/b/${ID}.1.zip`],
    ['double slash', `/acme//dist/a/b/${ID}.1.zip`],
    ['credential url', `https://u:p@host/acme/dist/a/b/${ID}.1.zip`],
    ['invalid vendor', `/acme/dist/-a/b/${ID}.1.zip`],
    ['uppercase vendor', `/acme/dist/A/b/${ID}.1.zip`],
    ['invalid project', `/Acme_/dist/a/b/${ID}.1.zip`],
    ['empty', ''],
    ['fullwidth letters', `/acme/dist/\uff41/b/${ID}.1.zip`],
    ['fullwidth digit revision', `/acme/dist/a/b/${ID}.\uff11.zip`],
    ['unicode name', `/acme/dist/\u00e9/b/${ID}.1.zip`],
    ['overlong vendor', `/acme/dist/${'a'.repeat(430)}/b/${ID}.1.zip`],
    ['overlong name', `/acme/dist/a/${'b'.repeat(430)}/${ID}.1.zip`],
    ['overlong project', `/${'p'.repeat(65)}/dist/a/b/${ID}.1.zip`],
    ['trailing space', `${ok} `],
    ['trailing newline', `${ok}\n`],
    ['trailing CRLF', `${ok}\r\n`],
    ['leading space', ` ${ok}`],
    ['ULID first char 8', `/acme/dist/a/b/8${ID.slice(1)}.1.zip`],
    ['ULID first char Z', `/acme/dist/a/b/Z${ID.slice(1)}.1.zip`],
    ['exponent revision', `/acme/dist/a/b/${ID}.1e3.zip`],
    ['hex revision', `/acme/dist/a/b/${ID}.0x1.zip`],
    ['decimal revision', `/acme/dist/a/b/${ID}.1.5.zip`],
    ['nul byte', `/acme/dist/a/b/${ID}.1.zip\0`],
  ])('refuses %s', (_label, path) => {
    expect(parseComposerDistPath(path)).toBeNull();
  });
});
