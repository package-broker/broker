import { describe, expect, it } from 'vitest';
import { NPM_AUDIT_ADVISORY_FIELDS, sanitizeNpmAuditResponse } from './audit-response.js';

// Fields @npmcli/metavuln-calculator lib/advisory.js (9.0.3, bundled with npm 11.17.0) reads from
// a bulk advisory: id, title, url, severity, cwe, cvss, vulnerable_versions. It also reads `name`,
// which the sanitizer drops on purpose: an advisory without `name` is attributed to its key.
const NPM_CLI_ADVISORY_FIELDS = [
  'id',
  'title',
  'url',
  'severity',
  'cwe',
  'cvss',
  'vulnerable_versions',
] as const;

const ADVISORY = {
  id: 1_106_913,
  url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
  title: 'Command Injection in lodash',
  severity: 'high',
  vulnerable_versions: '<4.17.21',
  cwe: ['CWE-77', 'CWE-94'],
  cvss: { score: 7.2, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' },
};

const SENTINEL = 'zz-never-sent-sentinel-7f3a';
const sent = new Set(['lodash', '@scope/pkg']);
const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const sanitize = (value: unknown) => sanitizeNpmAuditResponse(bytes(value), sent);

describe('npm audit response fixture', () => {
  it.each(NPM_CLI_ADVISORY_FIELDS)(
    'pins %s, read by the npm CLI, in fixture and allowlist',
    (field) => {
      expect(ADVISORY).toHaveProperty(field);
      expect(NPM_AUDIT_ADVISORY_FIELDS).toContain(field);
      expect(sanitize({ lodash: [ADVISORY] })?.body.lodash?.[0]).toHaveProperty(field);
    },
  );

  it('round-trips a valid response with only allowlisted fields', () => {
    const result = sanitize({
      lodash: [ADVISORY, { ...ADVISORY, id: 'GHSA-x', cvss: { score: 0, vectorString: null } }],
      '@scope/pkg': [],
    });
    expect(result).toEqual({
      body: {
        lodash: [ADVISORY, { ...ADVISORY, id: 'GHSA-x', cvss: { score: 0 } }],
        '@scope/pkg': [],
      },
      unexpectedKeys: 0,
      droppedAdvisories: 0,
    });
    for (const advisory of result!.body.lodash!) {
      expect(
        Object.keys(advisory).every((key) => NPM_AUDIT_ADVISORY_FIELDS.includes(key as never)),
      ).toBe(true);
    }
  });

  it('keeps an advisory with only an id', () => {
    expect(sanitize({ lodash: [{ id: 1 }] })).toEqual({
      body: { lodash: [{ id: 1 }] },
      unexpectedKeys: 0,
      droppedAdvisories: 0,
    });
  });

  it('accepts exactly the advisory cap', () => {
    const advisories = Array.from({ length: 200 }, (_, id) => ({ id }));
    expect(sanitize({ lodash: advisories })?.body.lodash).toHaveLength(200);
  });
});

describe('npm audit response key allowlist', () => {
  it('drops keys that were never sent, including a sentinel name, and counts them', () => {
    const result = sanitize({
      lodash: [ADVISORY],
      [SENTINEL]: [ADVISORY],
      other: [{ id: 'x', url: 'javascript:alert(1)' }],
    });
    expect(result).toEqual({
      body: { lodash: [ADVISORY] },
      unexpectedKeys: 2,
      droppedAdvisories: 0,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('reads a sent name that upstream omitted as absent, even an Object.prototype name', () => {
    const names = new Set(['constructor', 'toString', 'lodash']);
    const result = sanitizeNpmAuditResponse(bytes({ lodash: [] }), names);
    expect(result?.body.constructor).toBeUndefined();
    expect(result?.body.toString).toBeUndefined();
    expect(Object.getPrototypeOf(result!.body)).toBeNull();
  });

  it('keeps a sent Object.prototype name that upstream returned', () => {
    const names = new Set(['constructor']);
    const result = sanitizeNpmAuditResponse(bytes({ constructor: [{ id: 1 }] }), names);
    expect(result?.body.constructor).toEqual([{ id: 1 }]);
  });

  it('does not let __proto__ through when it was not sent', () => {
    const result = sanitize('{"__proto__":[{"id":1}],"lodash":[]}');
    expect(result).toEqual({ body: { lodash: [] }, unexpectedKeys: 1, droppedAdvisories: 0 });
    expect(Object.hasOwn(result!.body, '__proto__')).toBe(false);
  });
});

describe('npm audit response advisory allowlist', () => {
  it('drops unknown advisory and cvss fields', () => {
    const result = sanitize({
      lodash: [
        {
          ...ADVISORY,
          name: 'other-package',
          overview: '<script>x</script>',
          recommendation: 'x',
          cvss: { ...ADVISORY.cvss, extra: true },
        },
      ],
    });
    expect(result).toEqual({
      body: { lodash: [ADVISORY] },
      unexpectedKeys: 0,
      droppedAdvisories: 0,
    });
  });
});

describe('npm audit response null tolerance', () => {
  it.each([
    ['null url', { url: null }, {}],
    ['null title', { title: null }, {}],
    ['null severity', { severity: null }, {}],
    ['null vulnerable_versions', { vulnerable_versions: null }, {}],
    ['null cwe', { cwe: null }, {}],
    ['null cvss', { cvss: null }, {}],
    ['null cvss.score', { cvss: { score: null, vectorString: 'CVSS:3.1/x' } }, {}],
    ['empty severity', { severity: '' }, {}],
    ['null cvss.vectorString', { cvss: { score: 5, vectorString: null } }, { cvss: { score: 5 } }],
    ['missing cvss.vectorString', { cvss: { score: 5 } }, { cvss: { score: 5 } }],
  ])('omits %s and keeps the advisory', (_, field, expected) => {
    expect(sanitize({ lodash: [{ id: 1, ...field }] })).toEqual({
      body: { lodash: [{ id: 1, ...expected }] },
      unexpectedKeys: 0,
      droppedAdvisories: 0,
    });
  });

  it('keeps every other field when one optional field is null', () => {
    const rest: Partial<typeof ADVISORY> = { ...ADVISORY };
    delete rest.cwe;
    expect(sanitize({ lodash: [{ ...ADVISORY, cwe: null }] })?.body.lodash).toEqual([rest]);
  });
});

describe('npm audit response control characters', () => {
  const ESC = '\u001b';
  const OSC = `${ESC}]8;;https://evil.test${ESC}\\link${ESC}]8;;${ESC}\\`;
  const C1 = '\u009b31m';

  it('strips C0 and C1 control characters from text fields and string ids', () => {
    const result = sanitize({
      lodash: [
        {
          id: `GHSA-${ESC}[2Jx\u0000`,
          title: `${ESC}[31mRed${ESC}[0m ${OSC}\u0007${C1}`,
          vulnerable_versions: `<1.0.0\r\n${ESC}[1A`,
          cwe: [`CWE-${ESC}[0m79`, '\u007fCWE-1\u0085'],
          cvss: { score: 1, vectorString: `CVSS:3.1${ESC}[K` },
        },
      ],
    });
    expect(result?.body.lodash).toEqual([
      {
        id: 'GHSA-[2Jx',
        title: '[31mRed[0m ]8;;https://evil.test\\link]8;;\\31m',
        vulnerable_versions: '<1.0.0[1A',
        cwe: ['CWE-[0m79', 'CWE-1'],
        cvss: { score: 1, vectorString: 'CVSS:3.1[K' },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/\\u00(1b|9b|07|00|7f|85)/i);
  });

  it.each(['', ESC])('refuses a string id that is empty after stripping (%j)', (id) => {
    expect(sanitize({ lodash: [{ id, title: 'x' }] })).toBeNull();
  });

  it('measures the cap after stripping control characters', () => {
    const title = `${'a'.repeat(1024)}${ESC.repeat(10)}`;
    expect(sanitize({ lodash: [{ id: 1, title }] })?.body.lodash).toEqual([
      { id: 1, title: 'a'.repeat(1024) },
    ]);
  });
});

describe('npm audit response severity', () => {
  it.each(['info', 'low', 'moderate', 'high', 'critical'])('keeps severity %s', (severity) => {
    expect(sanitize({ lodash: [{ ...ADVISORY, severity }] })?.body.lodash).toEqual([
      { ...ADVISORY, severity },
    ]);
  });

  it.each(['unknown', 'High', 'High!', 'severe', '\u001bhigh'])(
    'drops and counts an advisory with severity %j, keeping the rest',
    (severity) => {
      const result = sanitize({
        lodash: [ADVISORY, { ...ADVISORY, id: 2, severity }, { ...ADVISORY, id: 3 }],
        '@scope/pkg': [{ ...ADVISORY, id: 4, severity }],
      });
      expect(result).toEqual({
        body: { lodash: [ADVISORY, { ...ADVISORY, id: 3 }], '@scope/pkg': [] },
        unexpectedKeys: 0,
        droppedAdvisories: 2,
      });
      expect(JSON.stringify(result)).not.toContain(`"${severity}"`);
    },
  );
});

describe('npm audit response all-or-nothing', () => {
  const malformed: [string, unknown][] = [
    ['non-https url', { ...ADVISORY, url: 'http://github.com/advisories/x' }],
    ['javascript url', { ...ADVISORY, url: 'javascript:alert(1)' }],
    ['relative url', { ...ADVISORY, url: '/advisories/x' }],
    ['credential url', { ...ADVISORY, url: 'https://user:pass@github.com/x' }],
    ['oversize url', { ...ADVISORY, url: `https://github.com/${'a'.repeat(2048)}` }],
    ['oversize title', { ...ADVISORY, title: 'a'.repeat(1025) }],
    ['oversize multibyte title', { ...ADVISORY, title: 'ż'.repeat(513) }],
    ['oversize severity', { ...ADVISORY, severity: 'a'.repeat(33) }],
    ['numeric severity', { ...ADVISORY, severity: 3 }],
    ['missing id', { url: ADVISORY.url }],
    ['float id', { ...ADVISORY, id: 1.5 }],
    ['unsafe id', { ...ADVISORY, id: 2 ** 53 }],
    ['oversize id', { ...ADVISORY, id: 'a'.repeat(201) }],
    ['object id', { ...ADVISORY, id: {} }],
    ['null id', { ...ADVISORY, id: null }],
    ['boolean title', { ...ADVISORY, title: true }],
    ['array severity', { ...ADVISORY, severity: ['high'] }],
    ['oversize range', { ...ADVISORY, vulnerable_versions: '<'.repeat(1025) }],
    ['range array', { ...ADVISORY, vulnerable_versions: ['<1'] }],
    ['cwe string', { ...ADVISORY, cwe: 'CWE-77' }],
    ['cwe number', { ...ADVISORY, cwe: [77] }],
    ['too many cwe', { ...ADVISORY, cwe: Array.from({ length: 21 }, () => 'CWE-1') }],
    ['oversize cwe', { ...ADVISORY, cwe: ['C'.repeat(33)] }],
    ['cvss score above 10', { ...ADVISORY, cvss: { score: 10.1, vectorString: null } }],
    ['cvss score negative', { ...ADVISORY, cvss: { score: -1, vectorString: null } }],
    ['cvss score string', { ...ADVISORY, cvss: { score: '7', vectorString: null } }],
    ['cvss vector number', { ...ADVISORY, cvss: { score: 1, vectorString: 1 } }],
    ['cvss vector number with null score', { ...ADVISORY, cvss: { score: null, vectorString: 1 } }],
    ['unknown severity with javascript url', { ...ADVISORY, severity: 'zzz', url: 'javascript:x' }],
    ['unknown severity with object title', { ...ADVISORY, severity: 'zzz', title: {} }],
    ['unknown severity with float id', { ...ADVISORY, severity: 'zzz', id: 1.5 }],
    ['unknown severity with bad cvss', { ...ADVISORY, severity: 'zzz', cvss: { score: 11 } }],
    ['cvss string', { ...ADVISORY, cvss: '7.2' }],
    ['cvss vector oversize', { ...ADVISORY, cvss: { score: 1, vectorString: 'a'.repeat(257) } }],
    ['cvss array', { ...ADVISORY, cvss: [] }],
    ['advisory string', 'GHSA-x'],
    ['advisory null', null],
    ['advisory array', [ADVISORY]],
  ];

  it.each(malformed)('fails the whole response on %s', (_, bad) => {
    expect(sanitize({ lodash: [ADVISORY, bad], '@scope/pkg': [ADVISORY] })).toBeNull();
  });

  it('fails on 201 advisories for one name', () => {
    const advisories = Array.from({ length: 201 }, (_, id) => ({ id }));
    expect(sanitize({ lodash: advisories })).toBeNull();
  });

  it.each([
    ['object', { id: 1 }],
    ['null', null],
    ['string', 'x'],
  ])('fails when a sent name maps to a non-array %s', (_, value) => {
    expect(sanitize({ lodash: value })).toBeNull();
  });

  it.each([
    ['invalid JSON', '{"lodash":['],
    ['HTML', '<html><body>error</body></html>'],
    ['empty body', ''],
    ['array body', '[]'],
    ['null body', 'null'],
    ['string body', '"x"'],
    ['number body', '1'],
  ])('fails on %s', (_, body) => {
    expect(sanitize(body)).toBeNull();
  });

  it('fails on invalid UTF-8', () => {
    expect(sanitizeNpmAuditResponse(new Uint8Array([0x7b, 0xff, 0x7d]), sent)).toBeNull();
  });
});
