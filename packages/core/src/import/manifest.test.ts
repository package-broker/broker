import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPermission } from '../authz/permissions.js';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
  type ParsedManifest,
} from './manifest.js';

const SENTINEL = 'S3CR3T-SENTINEL';

type Json = Record<string, unknown>;
type Doc = { items: Json[]; widening: Json[] } & Json;

function base(): Doc {
  return {
    version: 1,
    source_system: 'synthetic-registry',
    items: [
      { type: 'project', external_ref: 'p1', slug: 'acme', name: 'Acme' },
      {
        type: 'role',
        external_ref: 'r1',
        key: 'release_manager',
        name: 'Release manager',
        scope: 'project',
        permissions: ['project:read', 'project:packages:write', 'project:service-principals:write'],
      },
      {
        type: 'grant',
        external_ref: 'g1',
        scope: 'project',
        project: { ref: 'p1' },
        role: { ref: 'r1' },
        subject: { type: 'email', value: 'dev@example.test' },
      },
      {
        type: 'grant',
        external_ref: 'g2',
        scope: 'organization',
        project: null,
        role: { existing: 'organization_auditor' },
        subject: { type: 'group', provider: 'okta', value: 'Engineers' },
      },
      {
        type: 'source',
        external_ref: 's1',
        name: 'acme-vcs',
        ecosystem: 'composer',
        source_type: 'vcs',
        project: { ref: 'p1' },
        url: null,
        credential_ref: 'op://Vault/Item/field',
        config: null,
      },
      {
        type: 'source',
        external_ref: 's2',
        name: 'npm-main',
        ecosystem: 'npm',
        source_type: 'npm_registry',
        project: null,
        url: 'https://npm.example.test/',
        credential_ref: null,
        config: null,
      },
      {
        type: 'source',
        external_ref: 's3',
        name: 'packagist',
        ecosystem: 'composer',
        source_type: 'packagist_proxy',
        project: null,
        url: 'https://repo.packagist.org',
        credential_ref: null,
        config: null,
      },
      {
        type: 'name',
        external_ref: 'n1',
        source: { ref: 's1' },
        ecosystem: 'composer',
        pattern: 'acme/*',
      },
      {
        type: 'name',
        external_ref: 'n2',
        source: { ref: 's2' },
        ecosystem: 'npm',
        pattern: '@acme/widget',
      },
      {
        type: 'attachment',
        external_ref: 'a1',
        project: { ref: 'p1' },
        source: { ref: 's2' },
        precedence: 10,
      },
      {
        type: 'version_override',
        external_ref: 'v1',
        source: { ref: 's1' },
        package: 'acme/widget',
        version: '1.0.0+build.5',
        published_at: '2024-01-02T03:04:05.000Z',
        basis: 'source_release',
      },
    ],
    widening: [{ type: 'grant', external_ref: 'g1' }],
  };
}

function item(doc: Doc, externalRef: string): Json {
  const found = doc.items.find((entry) => entry.external_ref === externalRef);
  if (!found) throw new Error(`no fixture item ${externalRef}`);
  return found;
}

function mutated(change: (doc: Doc) => void): Doc {
  const doc = structuredClone(base());
  change(doc);
  return doc;
}

function parsed(input: unknown): ParsedManifest {
  const result = parseManifest(input);
  if (!result.ok) throw new Error('expected a valid manifest');
  return result.data;
}

function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed).reverse();
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reversed(v)]),
    );
  }
  return value;
}

function expectRefused(input: unknown): void {
  expect(parseManifest(input).ok).toBe(false);
}

describe('brand', () => {
  it('accepts only a parsed manifest', async () => {
    const plain = base();
    // @ts-expect-error a plain object is not a ParsedManifest
    canonicalManifest(plain);
    // @ts-expect-error a plain object is not a ParsedManifest
    await planHash(plain).catch(() => undefined);
    expect(parseManifest(base()).ok).toBe(true);
  });
});

describe('canonical form and hash', () => {
  it('gives one hash for keys, items, permissions and widening in another order', async () => {
    const doc = mutated((d) => {
      d.items.push({
        type: 'grant',
        external_ref: 'g3',
        scope: 'organization',
        project: null,
        role: { existing: 'organization_admin' },
        subject: { type: 'email', value: 'ops@example.test' },
      });
      d.widening.push({ type: 'grant', external_ref: 'g3' });
    });
    const shuffled = parsed(reversed(doc));
    const original = parsed(doc);
    expect(canonicalManifest(shuffled)).toBe(canonicalManifest(original));
    expect(await planHash(shuffled)).toBe(await planHash(original));
  });

  it('sorts role permissions and widening in the canonical string', () => {
    const doc = mutated((d) => {
      item(d, 'r1').permissions = ['project:read', 'project:packages:write'];
    });
    const text = canonicalManifest(parsed(doc));
    expect(text).toContain('"permissions":["project:packages:write","project:read"]');
  });

  it('matches a fixed vector', async () => {
    const minimal = parsed({
      version: 1,
      source_system: 'satis',
      items: [
        { type: 'project', external_ref: 'p2', slug: 'beta', name: 'Beta' },
        { type: 'project', external_ref: 'p1', slug: 'alpha', name: 'Alpha' },
      ],
      widening: [],
    });
    expect(canonicalManifest(minimal)).toBe(
      '{"items":[{"external_ref":"p1","name":"Alpha","slug":"alpha","type":"project"},{"external_ref":"p2","name":"Beta","slug":"beta","type":"project"}],"source_system":"satis","version":1,"widening":[]}',
    );
    expect(await planHash(minimal)).toBe(
      '80d4b686b29caa84756e1bd8bc19b9e421062007f36e5fd1c2e0416211462d7d',
    );
  });

  it('returns lower-case 64 character hex', async () => {
    expect(await planHash(parsed(base()))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when one character of an external_ref changes', async () => {
    const other = parsed(renamedProject());
    expect(await planHash(other)).not.toBe(await planHash(parsed(base())));
  });

  it('changes when one published_at changes', async () => {
    const other = parsed(
      mutated((d) => void (item(d, 'v1').published_at = '2024-01-02T03:04:05.001Z')),
    );
    expect(await planHash(other)).not.toBe(await planHash(parsed(base())));
  });

  it('changes when a widening entry changes', async () => {
    const other = parsed(
      mutated((d) => void (d.widening = [{ type: 'grant', external_ref: 'g2' }])),
    );
    expect(await planHash(other)).not.toBe(await planHash(parsed(base())));
  });

  it('changes when source_system changes', async () => {
    const other = parsed(mutated((d) => void (d.source_system = 'satis')));
    expect(await planHash(other)).not.toBe(await planHash(parsed(base())));
  });
});

function renamedProject(): Doc {
  return mutated((d) => {
    item(d, 'p1').external_ref = 'p9';
    for (const entry of d.items) {
      for (const key of ['project', 'source'] as const) {
        const value = entry[key] as { ref?: string } | null | undefined;
        if (value && value.ref === 'p1') value.ref = 'p9';
      }
    }
  });
}

describe('schema', () => {
  it('accepts the base manifest', () => {
    expect(parseManifest(base()).ok).toBe(true);
  });

  const unknownKeys: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['top level', (d) => void (d.extra = 1)],
    ['project item', (d) => void (item(d, 'p1').extra = 1)],
    ['widening entry', (d) => void (d.widening[0]!.extra = 1)],
    ['subject', (d) => void ((item(d, 'g1').subject as Json).extra = 1)],
    ['reference', (d) => void ((item(d, 'g1').project as Json).extra = 1)],
    ['credential field', (d) => void (item(d, 's1').password = SENTINEL)],
  ];
  for (const [label, change] of unknownKeys) {
    it(`refuses an unknown key at ${label}`, () => expectRefused(mutated(change)));
  }

  const missing: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['source_system', (d) => void delete d.source_system],
    ['source url', (d) => void delete item(d, 's1').url],
    ['source credential_ref', (d) => void delete item(d, 's1').credential_ref],
    ['source config', (d) => void delete item(d, 's1').config],
    ['grant project', (d) => void delete item(d, 'g2').project],
  ];
  for (const [label, change] of missing) {
    it(`refuses a missing ${label}`, () => expectRefused(mutated(change)));
  }

  const invalid: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    [
      'a duplicate external_ref within a type',
      (d) => void d.items.push({ ...item(d, 'p1'), slug: 'other' }),
    ],
    [
      'a duplicate project slug',
      (d) => void d.items.push({ ...item(d, 'p1'), external_ref: 'p2' }),
    ],
    ['an external_ref with a space', (d) => void (item(d, 'p1').external_ref = 'a b')],
    [
      'an external_ref of 201 characters',
      (d) => void (item(d, 'p1').external_ref = 'a'.repeat(201)),
    ],
    ['an empty external_ref', (d) => void (item(d, 'p1').external_ref = '')],
    ['a source_system with capitals', (d) => void (d.source_system = 'Satis')],
    ['version 2', (d) => void (d.version = 2)],
    ['an unknown basis', (d) => void (item(d, 'v1').basis = 'guess')],
    ['a precedence of -1', (d) => void (item(d, 'a1').precedence = -1)],
    ['a fractional precedence', (d) => void (item(d, 'a1').precedence = 1.5)],
    ['a precedence above the maximum', (d) => void (item(d, 'a1').precedence = 100001)],
    ['a negative zero precedence', (d) => void (item(d, 'a1').precedence = -0)],
    ['a project slug with capitals', (d) => void (item(d, 'p1').slug = 'Acme')],
    ['a project name that is not NFC', (d) => void (item(d, 'p1').name = 'Café')],
    ['a project name with a control character', (d) => void (item(d, 'p1').name = 'A\u0007b')],
    ['a project name with a format character', (d) => void (item(d, 'p1').name = 'A​b')],
    ['a project name with surrounding spaces', (d) => void (item(d, 'p1').name = ' Acme')],
    ['an empty project name', (d) => void (item(d, 'p1').name = '')],
    ['a project name of 101 characters', (d) => void (item(d, 'p1').name = 'a'.repeat(101))],
    ['a lone surrogate in a name', (d) => void (item(d, 'p1').name = 'a\uD800')],
  ];
  for (const [label, change] of invalid) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts the same external_ref in different types', () => {
    const doc = mutated((d) => {
      item(d, 'p1').external_ref = 'shared';
      item(d, 'r1').external_ref = 'shared';
      for (const entry of d.items) {
        const reference = entry.project as { ref?: string } | null | undefined;
        if (reference?.ref === 'p1') reference.ref = 'shared';
      }
      (item(d, 'g1').role as { ref: string }).ref = 'shared';
    });
    expect(parseManifest(doc).ok).toBe(true);
  });
});

describe('published_at', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['no fraction', '2024-01-02T03:04:05Z'],
    ['one fraction digit', '2024-01-02T03:04:05.1Z'],
    ['an offset', '2024-01-02T03:04:05.000+02:00'],
    ['an impossible date', '2024-02-31T03:04:05.000Z'],
    ['a year before 1970', '1969-12-31T23:59:59.000Z'],
    ['a lower-case t', '2024-01-02t03:04:05.000Z'],
  ];
  for (const [label, value] of bad) {
    it(`refuses ${label}`, () =>
      expectRefused(mutated((d) => void (item(d, 'v1').published_at = value))));
  }

  it('accepts the three-digit form', () => {
    expect(
      parseManifest(mutated((d) => void (item(d, 'v1').published_at = '2024-01-02T03:04:05.000Z')))
        .ok,
    ).toBe(true);
  });
});

describe('role permissions', () => {
  const bad: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['an unknown permission', (d) => void (item(d, 'r1').permissions = ['project:nope'])],
    [
      'a duplicate permission',
      (d) => void (item(d, 'r1').permissions = ['project:read', 'project:read']),
    ],
    ['an empty permission set', (d) => void (item(d, 'r1').permissions = [])],
    [
      'an organization permission in a project role',
      (d) => void (item(d, 'r1').permissions = ['org:read']),
    ],
    ['a default role key', (d) => void (item(d, 'r1').key = 'project_owner')],
    ['a scope other than organization or project', (d) => void (item(d, 'r1').scope = 'global')],
  ];
  for (const [label, change] of bad) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts hyphenated catalogue names', () => {
    const name = 'project:service-principals:write';
    expect(isPermission(name)).toBe(true);
    expect(parseManifest(base()).ok).toBe(true);
    expect(canonicalManifest(parsed(base()))).toContain(name);
  });

  it('accepts an organization role with organization permissions', () => {
    const doc = mutated((d) => {
      Object.assign(item(d, 'r1'), {
        scope: 'organization',
        permissions: ['org:read', 'project:read'],
      });
      Object.assign(item(d, 'g1'), { scope: 'organization', project: null });
    });
    expect(parseManifest(doc).ok).toBe(true);
  });
});

describe('references', () => {
  const bad: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['a ref naming no item', (d) => void (item(d, 'g1').project = { ref: 'missing' })],
    ['a ref naming an item of another type', (d) => void (item(d, 'g1').project = { ref: 'r1' })],
    [
      'a reference with both ref and existing',
      (d) => void (item(d, 'g1').project = { ref: 'p1', existing: 'acme' }),
    ],
    [
      'an existing project equal to an in-manifest slug',
      (d) => void (item(d, 'g1').project = { existing: 'acme' }),
    ],
    [
      'an existing role equal to an in-manifest role key',
      (d) => void (item(d, 'g1').role = { existing: 'release_manager' }),
    ],
    [
      'an existing source equal to an in-manifest source',
      (d) => void (item(d, 'n1').source = { existing: { project: 'acme', name: 'acme-vcs' } }),
    ],
    ['a project grant with a null project', (d) => void (item(d, 'g1').project = null)],
    ['an organization grant with a project', (d) => void (item(d, 'g2').project = { ref: 'p1' })],
    ['a grant whose role scope differs', (d) => void (item(d, 'g2').role = { ref: 'r1' })],
    [
      'a duplicate grant natural key',
      (d) => void d.items.push({ ...item(d, 'g1'), external_ref: 'g9' }),
    ],
    [
      'a name whose ecosystem differs from its source',
      (d) => void (item(d, 'n1').ecosystem = 'npm'),
    ],
    [
      'a duplicate source natural key',
      (d) => void d.items.push({ ...item(d, 's1'), external_ref: 's9' }),
    ],
    [
      'a duplicate name natural key',
      (d) => void d.items.push({ ...item(d, 'n1'), external_ref: 'n9' }),
    ],
    [
      'a duplicate attachment natural key',
      (d) => void d.items.push({ ...item(d, 'a1'), external_ref: 'a9' }),
    ],
    [
      'an attachment of a project source to another project',
      (d) => {
        d.items.push({ type: 'project', external_ref: 'p2', slug: 'beta', name: 'Beta' });
        Object.assign(item(d, 'a1'), { project: { ref: 'p2' }, source: { ref: 's1' } });
      },
    ],
    [
      'a duplicate version_override natural key',
      (d) => void d.items.push({ ...item(d, 'v1'), external_ref: 'v9' }),
    ],
    ['a version_override naming a project', (d) => void (item(d, 'v1').source = { ref: 'p1' })],
  ];
  for (const [label, change] of bad) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts an existing project, role and source', () => {
    const doc = mutated((d) => {
      Object.assign(item(d, 'g1'), {
        project: { existing: 'other' },
        role: { existing: 'project_developer' },
      });
      item(d, 'n1').source = { existing: { project: null, name: 'legacy' } };
    });
    expect(parseManifest(doc).ok).toBe(true);
  });
});

describe('subjects', () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an upper-case e-mail', { type: 'email', value: `Dev-${SENTINEL}@Example.test` }],
    ['an e-mail with spaces', { type: 'email', value: ` dev-${SENTINEL}@example.test` }],
    ['an invalid e-mail', { type: 'email', value: `not-an-email-${SENTINEL}` }],
    ['a group without a provider', { type: 'group', value: `Group ${SENTINEL}` }],
    [
      'a group with a bad provider',
      { type: 'group', provider: 'Okta!', value: `Group ${SENTINEL}` },
    ],
    [
      'a group value with a control character',
      { type: 'group', provider: 'okta', value: `G\u0007${SENTINEL}` },
    ],
    ['an e-mail with a provider', { type: 'email', provider: 'okta', value: 'dev@example.test' }],
  ];
  for (const [label, value] of bad) {
    it(`refuses ${label} and does not echo it`, () => {
      const result = parseManifest(mutated((d) => void (item(d, 'g1').subject = value)));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    });
  }
});

describe('source', () => {
  const bad: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['a hosted type', (d) => void (item(d, 's1').source_type = 'hosted')],
    ['an ecosystem that does not match the type', (d) => void (item(d, 's1').ecosystem = 'npm')],
    ['a vcs source with a url', (d) => void (item(d, 's1').url = 'https://git.example.test/')],
    ['a registry source without a url', (d) => void (item(d, 's2').url = null)],
    [
      'a proxy with a different url',
      (d) => void (item(d, 's3').url = 'https://proxy.example.test/'),
    ],
    ['a proxy without a url', (d) => void (item(d, 's3').url = null)],
    ['a non-null config', (d) => void (item(d, 's1').config = {})],
    ['an uppercase source name', (d) => void (item(d, 's1').name = 'Acme')],
  ];
  for (const [label, change] of bad) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts the npmjs proxy at its default url', () => {
    const doc = mutated((d) =>
      Object.assign(item(d, 's2'), {
        source_type: 'npmjs_proxy',
        url: 'https://registry.npmjs.org',
        name: 'npmjs',
      }),
    );
    expect(parseManifest(doc).ok).toBe(true);
  });
});

describe('credential_ref', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['a pasted token', `ghp_${SENTINEL}`],
    ['an https URL', `https://example.test/${SENTINEL}`],
    ['an empty string', ''],
    ['an op reference with a query', `op://Vault/${SENTINEL}?attribute=otp`],
  ];
  for (const [label, value] of bad) {
    it(`refuses ${label} and does not echo it`, () => {
      const result = parseManifest(mutated((d) => void (item(d, 's1').credential_ref = value)));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    });
  }

  it('refuses an op reference of 201 characters after the scheme', () => {
    expectRefused(mutated((d) => void (item(d, 's1').credential_ref = `op://${'a'.repeat(201)}`)));
  });

  it('accepts an op reference with spaces', () => {
    expect(
      parseManifest(
        mutated((d) => void (item(d, 's1').credential_ref = 'op://My Vault/My Item/token')),
      ).ok,
    ).toBe(true);
  });

  it('accepts null', () => {
    expect(parseManifest(mutated((d) => void (item(d, 's1').credential_ref = null))).ok).toBe(true);
  });
});

describe('url', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['userinfo', 'https://user:pw@npm.example.test/'],
    ['a username only', 'https://user@npm.example.test/'],
    ['a query string', 'https://npm.example.test/p?x=1'],
    ['an empty query string', 'https://npm.example.test/p?'],
    ['a fragment', 'https://npm.example.test/p#f'],
    ['another scheme', 'ftp://npm.example.test/'],
    ['a non-URL', 'not a url'],
    ['a bare origin', 'https://npm.example.test'],
    ['an upper-case host', 'https://NPM.example.test/'],
    ['a default port', 'https://npm.example.test:443/'],
    ['a trailing-dot host', 'https://npm.example.test./'],
    ['a lower-case percent escape', 'https://npm.example.test/a%2fb'],
    ['an encoded unreserved character', 'https://npm.example.test/%41'],
    ['an encoded tilde', 'https://npm.example.test/%7E'],
    ['a url over 2048 characters', `https://npm.example.test/${'a'.repeat(2048)}`],
  ];
  for (const [label, value] of bad) {
    it(`refuses a source url with ${label}`, () =>
      expectRefused(mutated((d) => void (item(d, 's2').url = value))));
  }

  const good: ReadonlyArray<readonly [string, string]> = [
    ['an http url', 'http://npm.example.test/p'],
    ['a trailing slash', 'https://npm.example.test/p/'],
    ['an upper-case reserved escape', 'https://npm.example.test/a%2Fb'],
    ['an IP literal', 'https://192.0.2.10/'],
    ['a non-default port', 'https://npm.example.test:8443/'],
  ];
  for (const [label, value] of good) {
    it(`accepts ${label}`, () =>
      expect(parseManifest(mutated((d) => void (item(d, 's2').url = value))).ok).toBe(true));
  }
});

describe('name', () => {
  const bad: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['an uppercase composer name', (d) => void (item(d, 'n1').pattern = 'Acme/widget')],
    ['an uppercase npm name', (d) => void (item(d, 'n2').pattern = '@Acme/widget')],
    ['more than four wildcards', (d) => void (item(d, 'n1').pattern = 'a*b*c*d*e*f')],
    ['an empty pattern', (d) => void (item(d, 'n1').pattern = '')],
    ['a composer name without a vendor', (d) => void (item(d, 'n1').pattern = 'widget')],
  ];
  for (const [label, change] of bad) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts a scoped npm name', () => {
    expect(parseManifest(base()).ok).toBe(true);
    expect(canonicalManifest(parsed(base()))).toContain('"pattern":"@acme/widget"');
  });

  it('accepts an npm scope wildcard', () => {
    expect(parseManifest(mutated((d) => void (item(d, 'n2').pattern = '@acme/*'))).ok).toBe(true);
  });
});

describe('version_override', () => {
  const bad: ReadonlyArray<readonly [string, (d: Doc) => void]> = [
    ['a package that is not in key form', (d) => void (item(d, 'v1').package = 'Acme/Widget')],
    ['a version with a space', (d) => void (item(d, 'v1').version = '1.0 0')],
    ['an empty version', (d) => void (item(d, 'v1').version = '')],
  ];
  for (const [label, change] of bad) {
    it(`refuses ${label}`, () => expectRefused(mutated(change)));
  }

  it('accepts a version with a build suffix', () => {
    expect(parseManifest(base()).ok).toBe(true);
  });
});

describe('attachment', () => {
  it('accepts an organization source attached to a project', () => {
    expect(parseManifest(base()).ok).toBe(true);
  });
});

describe('widening', () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an entry that names no item', [{ type: 'grant', external_ref: 'missing' }]],
    ['an entry that names an item of another type', [{ type: 'grant', external_ref: 'p1' }]],
    ['a type other than grant', [{ type: 'role', external_ref: 'r1' }]],
    [
      'a duplicate entry',
      [
        { type: 'grant', external_ref: 'g1' },
        { type: 'grant', external_ref: 'g1' },
      ],
    ],
  ];
  for (const [label, widening] of bad) {
    it(`refuses ${label}`, () => expectRefused({ ...base(), widening }));
  }

  it('accepts a grant listed in widening', () => {
    expect(parseManifest(base()).ok).toBe(true);
  });
});

describe('limits', () => {
  const projects = (count: number): unknown => ({
    version: 1,
    source_system: 'satis',
    items: Array.from({ length: count }, (_, i) => ({
      type: 'project',
      external_ref: `p${i}`,
      slug: `s${i}`,
      name: `Project ${i}`,
    })),
    widening: [],
  });

  it('exports the limits', () => {
    expect(MAX_MANIFEST_ITEMS).toBe(10000);
    expect(MAX_MANIFEST_BYTES).toBe(1048576);
  });

  it('accepts 10000 items', () => {
    expect(parseManifest(projects(10000)).ok).toBe(true);
  });

  it('refuses 10001 items', () => {
    expectRefused(projects(10001));
  });
});

describe('package exports', () => {
  it('exposes ./import/*', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { types: string; default: string }> };
    expect(pkg.exports['./import/*']).toEqual({
      types: './dist/import/*.d.ts',
      default: './dist/import/*.js',
    });
  });
});
