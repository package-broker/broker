import { describe, expect, it } from 'vitest';
import { MAX_NPM_NAME_LENGTH } from '../catalogue/names.js';
import { formatToken } from '../secrets/token-format.js';
import { redactValue } from './redact.js';
import { FAKE, githubWithSentinel } from '../test-support/credential-fixtures.js';
import {
  AUDIT_ACTIONS,
  AUDIT_FIELDS,
  type AuditAction,
  type AuditContext,
  auditEvent,
  validateAuditEvent,
  withPackageAuditName,
} from './actions.js';

const ACTION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const SENTINEL = 'SENTINEL-d41d8cd98f00b204e9800998ecf8427e';

const context: AuditContext = {
  opId: '01J0QPAD000000000000000000',
  requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  sourceIp: '203.0.113.7',
  tokenSelector: 'abcdefghijkl',
};

function build(
  action: string,
  changes?: Record<string, { old?: unknown; new?: unknown }>,
  overrides: Record<string, unknown> = {},
) {
  return auditEvent({
    id: '01J0AUDIT000000000000000A',
    now: '2026-10-17T09:00:00.000Z',
    action: action as AuditAction,
    actor: { type: 'user', id: '01J0USER000000000000000000' },
    context,
    target: { type: 'role', id: '01J0ROLE000000000000000000' },
    ...(changes === undefined ? {} : { changes: changes as never }),
    ...overrides,
  });
}

function payloadOf(result: ReturnType<typeof build>): string {
  if (!result.ok) throw new Error('expected ok');
  return result.event.payloadJson;
}

describe('AUDIT_ACTIONS', () => {
  it('has 74 unique actions', () => {
    expect(AUDIT_ACTIONS.length).toBe(74);
    expect(new Set(AUDIT_ACTIONS).size).toBe(74);
  });

  it.each([...AUDIT_ACTIONS])('%s matches the naming pattern', (action) => {
    expect(action).toMatch(ACTION_PATTERN);
  });

  it('has a field table entry for every action and none extra', () => {
    expect(Object.keys(AUDIT_FIELDS).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('allows the specified fields for role.create', () => {
    expect([...AUDIT_FIELDS['role.create']]).toEqual(['key', 'name', 'scope', 'permissions']);
  });

  it('allows no change fields for session.login', () => {
    expect(AUDIT_FIELDS['session.login']).toEqual([]);
  });
});

describe('token rotation audit registration', () => {
  it('registers token.rotate with exactly its three allowed fields', () => {
    expect(AUDIT_ACTIONS).toContain('token.rotate');
    expect(AUDIT_FIELDS['token.rotate' as AuditAction]).toEqual([
      'replacement_id',
      'overlap_days',
      'expires_at',
    ]);
    const changes = {
      replacement_id: { new: '01J0TOKEN000000000000000001' },
      overlap_days: { new: 7 },
      expires_at: { new: '2026-10-24T09:00:00.000Z' },
    };
    const result = build('token.rotate', changes);
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result)).changes).toEqual(changes);
  });

  it('rejects a field outside the token.rotate allowlist', () => {
    expect(build('token.rotate', { cause: { new: 'suspended' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it.each(['suspended', 'membership_removed', 'erased'])(
    'preserves the token.revoke cause %s',
    (cause) => {
      const result = build('token.revoke', { cause: { new: cause } });
      expect(result.ok).toBe(true);
      expect(JSON.parse(payloadOf(result)).changes).toEqual({ cause: { new: cause } });
    },
  );

  it('keeps a manual token.revoke free of a cause', () => {
    const result = build('token.revoke');
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result))).not.toHaveProperty('changes');
  });
});

describe('identity audit fields', () => {
  const IDENTITY_ACTIONS = ['identity.unlink', 'identity.block', 'identity.unblock'] as const;
  const userTarget = { target: { type: 'user', id: '01J0USER000000000000000009' } };

  it.each(IDENTITY_ACTIONS)('%s allows only the provider field', (action) => {
    expect(AUDIT_FIELDS[action]).toEqual(['provider']);
  });

  it.each(IDENTITY_ACTIONS)('%s records the provider id', (action) => {
    const result = build(action, { provider: { new: 'oidc' } }, userTarget);
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result)).changes).toEqual({ provider: { new: 'oidc' } });
  });

  it('records identity.unblock with the production identity_block target and no broker id', () => {
    const target = { type: 'identity_block', id: null };
    const result = build('identity.unblock', { provider: { new: 'oidc' } }, { target });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.event.target).toEqual(target);
    expect(JSON.parse(result.event.payloadJson).changes).toEqual({ provider: { new: 'oidc' } });
  });

  it.each(
    IDENTITY_ACTIONS.flatMap((action) =>
      ['issuer', 'subject', 'email', 'display_name'].map((field) => [action, field] as const),
    ),
  )('%s refuses an extra %s field', (action, field) => {
    const result = build(
      action,
      { provider: { new: 'oidc' }, [field]: { new: SENTINEL } },
      userTarget,
    );
    expect(result).toEqual({ ok: false, reason: 'unknown_field' });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  const RANDOM_PROVIDERS = ['k8s3jd9fh2kd8sj3hd8sk2jd9fk3ls8d', '01j0user000000000000000009'];

  it.each(
    IDENTITY_ACTIONS.flatMap((action) => RANDOM_PROVIDERS.map((id) => [action, id] as const)),
  )('%s records the random-looking provider id %s', (action, provider) => {
    const result = build(action, { provider: { new: provider } }, userTarget);
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result)).changes).toEqual({ provider: { new: provider } });
  });

  it.each(
    IDENTITY_ACTIONS.flatMap((action) =>
      ['glpat-abcdefghijklmnop1234', 'xoxb-1234-abcdefgh'].map((id) => [action, id] as const),
    ),
  )('%s records the token-prefix-shaped provider id %s', (action, provider) => {
    const result = build(action, { provider: { new: provider } }, userTarget);
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result)).changes).toEqual({ provider: { new: provider } });
  });

  it.each(
    IDENTITY_ACTIONS.flatMap((action) =>
      [
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'Okta',
        '-oidc',
        'oidc-',
        'a'.repeat(65),
        'user@example.test',
        'https://idp.example.test',
        '',
      ].map((id) => [action, id] as const),
    ),
  )('%s refuses the provider %j outside the provider-id grammar', (action, provider) => {
    expect(build(action, { provider: { new: provider } }, userTarget)).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('keeps the credential heuristic for the same value under another field', () => {
    expect(build('role.rename', { name: { new: RANDOM_PROVIDERS[0] } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('keeps the credential heuristic for a provider field outside the identity actions', () => {
    expect(redactValue(RANDOM_PROVIDERS[0]!, 200, 'provider')).toEqual({
      ok: false,
      reason: 'credential_value',
    });
    expect(redactValue('glpat-abcdefghijklmnop1234', 200, 'provider')).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('refuses a provider field on an action outside the identity actions', () => {
    expect(build('user.suspend', { provider: { new: 'oidc' } }, userTarget)).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });
});

describe('auditEvent action and fields', () => {
  it('builds version.published_at_set with its four fields', () => {
    const changes = {
      package_name: { new: 'acme/widgets' },
      version: { new: '1.0.0' },
      published_at: { new: '2026-10-19T09:00:00.000Z' },
      published_at_basis: { new: 'source_release' },
    };
    const result = build('version.published_at_set', changes);
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result)).changes).toEqual(changes);
  });

  it('refuses an extra version.published_at_set field', () => {
    expect(build('version.published_at_set', { extra: { new: 'value' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('refuses an action outside the list', () => {
    expect(build('role.explode')).toEqual({ ok: false, reason: 'unknown_action' });
  });

  it('refuses an inherited property name as action', () => {
    expect(build('constructor')).toEqual({ ok: false, reason: 'unknown_action' });
  });

  it('refuses a field not allowed for the action', () => {
    expect(build('role.rename', { key: { new: 'x' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('accepts the same field under an action that allows it', () => {
    expect(build('role.create', { key: { new: 'x' } }).ok).toBe(true);
  });

  it('refuses a changes field for an action that allows only op_id and request_id', () => {
    expect(build('session.login', { name: { new: 'x' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('refuses an inherited property name as field', () => {
    expect(build('role.create', { toString: { new: 'x' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('does not echo a refused field name', () => {
    const result = build('role.rename', { [SENTINEL]: { new: 'x' } });
    expect(result).toEqual({ ok: false, reason: 'unknown_field' });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('import credential external references', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const target = { type: 'import_run', id: '01J0IMPORT0000000000000000' };

  it.each([
    ['UUID', uuid],
    ['environment credential reference', 'env:REGISTRY_TOKEN'],
    ['UUID file credential reference', `file:./${uuid}/${uuid}/token`],
    ['UUID at start of file path', `file:${uuid}/token`],
    ['UUID as entire file path', `file:${uuid}`],
    ['UUID Windows relative file path', `file:${uuid}\\token`],
    ['UUID Windows absolute file path', `file:C:\\${uuid}\\${uuid}\\token`],
    ['UUID Windows UNC file path', `file:\\\\server\\${uuid}\\token`],
    ['file credential reference', 'file:./My Vault/My Item/token'],
  ])('preserves a %s', (_name, externalRef) => {
    const result = build(
      'import_run.credential_set',
      { external_ref: { new: externalRef } },
      { target },
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(payloadOf(result))).toEqual({
      op_id: context.opId,
      request_id: context.requestId,
      changes: { external_ref: { new: externalRef } },
    });
  });

  it.each([
    ['broker token', formatToken('pat', 'abcdefghijkl', 'A'.repeat(43))],
    ['provider token', FAKE.GITHUB_CLASSIC_A20],
    ['random material', FAKE.RUN_1],
    ['JWT', FAKE.JWT_1],
    ['private key', FAKE.PEM_1],
    ['credential URL', 'https://deploy:password@example.test/repo'],
    ['credential query', 'file:./vault/item/token?secret=private'],
    ['embedded provider token', `file:./vault/${FAKE.GITHUB_CLASSIC_A20}/token`],
    ['embedded random material', `file:./vault/${FAKE.RUN_1}/token`],
    ['UUID with credential material', `file:./${uuid}/${FAKE.GITHUB_CLASSIC_A20}/token`],
    ['initial UUID with credential material', `file:${uuid}/${FAKE.GITHUB_CLASSIC_A20}/token`],
    ['Windows UUID with credential material', `file:C:\\${uuid}\\${FAKE.GITHUB_CLASSIC_A20}`],
    ['UUID embedded in Windows path', `file:C:\\prefix-${uuid}\\token`],
    ['UUID embedded in text', `prefix-${uuid}`],
    ['UUID in a URL', `https://example.test/${uuid}`],
  ])('refuses %s without echoing it', (_name, value) => {
    for (const key of ['old', 'new']) {
      const result = build(
        'import_run.credential_set',
        { external_ref: { [key]: value } },
        { target },
      );
      expect(result).toEqual({ ok: false, reason: 'credential_value' });
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it('keeps UUID credential references refused in ordinary text fields', () => {
    expect(build('role.rename', { name: { new: `file:./${uuid}/token` } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });
});

describe('auditEvent event shape', () => {
  it('builds the event and payload', () => {
    const result = build('role.rename', { name: { old: 'A', new: 'B' } }, { projectId: 'p1' });
    expect(result).toEqual({
      ok: true,
      event: {
        id: '01J0AUDIT000000000000000A',
        occurredAt: '2026-10-17T09:00:00.000Z',
        action: 'role.rename',
        actor: { type: 'user', id: '01J0USER000000000000000000' },
        tokenSelector: 'abcdefghijkl',
        sourceIp: '203.0.113.7',
        target: { type: 'role', id: '01J0ROLE000000000000000000' },
        projectId: 'p1',
        payloadJson:
          '{"changes":{"name":{"new":"B","old":"A"}},"op_id":"01J0QPAD000000000000000000","request_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}',
      },
    });
  });

  it('defaults projectId to null and omits changes when absent', () => {
    const result = build('session.login');
    expect(result.ok && result.event.projectId).toBeNull();
    expect(payloadOf(result)).toBe(
      '{"op_id":"01J0QPAD000000000000000000","request_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}',
    );
  });

  it('omits undefined old and new', () => {
    expect(payloadOf(build('role.rename', { name: { new: 'B' } }))).toContain('"name":{"new":"B"}');
  });

  it('serializes the same bytes for different key order', () => {
    const a = build('role.create', { key: { new: 'k', old: 'j' }, name: { new: 'n' } });
    const b = build('role.create', { name: { new: 'n' }, key: { old: 'j', new: 'k' } });
    expect(payloadOf(a)).toBe(payloadOf(b));
  });

  it('sorts keys at every level', () => {
    const payload = payloadOf(
      build('role.create', { scope: { new: 's' }, key: { new: 'k' }, name: { new: 'n' } }),
    );
    expect(payload.indexOf('"key"')).toBeLessThan(payload.indexOf('"name"'));
    expect(payload.indexOf('"name"')).toBeLessThan(payload.indexOf('"scope"'));
    expect(payload.indexOf('"changes"')).toBeLessThan(payload.indexOf('"op_id"'));
    expect(payload.indexOf('"op_id"')).toBeLessThan(payload.indexOf('"request_id"'));
  });
});

describe('auditEvent value validation', () => {
  const badValues: Array<[string, unknown]> = [
    ['undefined-like object', {}],
    ['nested object', { a: 1 }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 1n],
    ['201-character string', 'a b '.repeat(50) + 'x'],
    ['array of 51 strings', Array.from({ length: 51 }, () => 'a')],
    ['array with a 101-character string', ['a b '.repeat(25) + 'x']],
    ['array with a number', [1]],
  ];
  it.each(badValues)('refuses %s as bad_value', (_name, value) => {
    expect(build('role.create', { name: { new: value } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses a non-object change entry', () => {
    expect(build('role.create', { name: 'x' as never })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses an unknown key inside a change entry', () => {
    expect(build('role.create', { name: { newer: 'x' } as never })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('accepts string, number, boolean, null and array values', () => {
    const result = build('role.create', {
      key: { new: 'k' },
      name: { new: 3.5 },
      scope: { new: true, old: null },
      permissions: { new: ['a', 'b'] },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a 200-character string and a 50-element array', () => {
    expect(build('role.create', { name: { new: 'a b '.repeat(50) } }).ok).toBe(true);
    expect(
      build('role.create', { permissions: { new: Array.from({ length: 50 }, () => 'a') } }).ok,
    ).toBe(true);
  });

  it('refuses a bad op_id as bad_value', () => {
    expect(build('session.login', undefined, { context: { ...context, opId: 7 } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses a credential in the request id without echoing it', () => {
    const token = formatToken('pat', 'abcdefghijkl', 'A'.repeat(43));
    const result = build('session.login', undefined, {
      context: { ...context, requestId: token },
    });
    expect(result).toEqual({ ok: false, reason: 'credential_value' });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe('auditEvent URL redaction', () => {
  it('stores a URL without userinfo, query and fragment', () => {
    const payload = payloadOf(
      build('source.create', { url: { new: 'https://user:pw@git.example.test/a/b?token=x#f' } }),
    );
    expect(payload).toContain('"url":{"new":"https://git.example.test/a/b"}');
    expect(payload).not.toContain('pw@');
    expect(payload).not.toContain('token=x');
  });

  it('strips git@ from an ssh URL', () => {
    const payload = payloadOf(
      build('source.create', { url: { new: 'ssh://git@host.example.test/a.git' } }),
    );
    expect(payload).toContain('ssh://host.example.test/a.git');
    expect(payload).not.toContain('git@');
  });

  it('refuses a URL that does not parse', () => {
    expect(build('source.create', { url: { new: 'https://' } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses an e-mail address that only survives in the URL path', () => {
    const result = build('source.create', {
      url: { new: 'https://h.example.test/someone@example.test' },
    });
    expect(result).toEqual({ ok: false, reason: 'credential_value' });
  });

  it('redacts URLs inside array values', () => {
    const payload = payloadOf(
      build('role.create', { permissions: { new: ['https://u:p@h.example.test/x?k=v'] } }),
    );
    expect(payload).toContain('https://h.example.test/x');
    expect(payload).not.toContain('k=v');
  });
});

describe('auditEvent credential refusal', () => {
  const rows: Array<[string, string]> = [
    ['broker token', formatToken('pat', 'abcdefghijkl', 'A'.repeat(43))],
    ['AWS key', FAKE.AWS_ACCESS_1],
    ['GitHub token', FAKE.GITHUB_CLASSIC_A20],
    ['GitLab token', FAKE.GITLAB_B20],
    ['JWT', FAKE.JWT_1],
    ['PEM header', FAKE.PEM_3],
    ['Bearer value', `Bearer ${'c'.repeat(20)}`],
    ['44-character base64', FAKE.RUN_1],
    ['e-mail address', 'someone@example.test'],
  ];

  it.each(rows)('refuses %s in new and does not echo it', (_name, value) => {
    const result = build('role.create', { name: { new: value } });
    expect(result).toEqual({ ok: false, reason: 'credential_value' });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each(rows)('refuses %s in old', (_name, value) => {
    expect(build('role.create', { name: { old: value } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it.each(rows)('refuses %s inside an array', (_name, value) => {
    expect(build('role.create', { permissions: { new: ['ok', value] } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('refuses a credential reached through a URL path', () => {
    const value = `https://h.example.test/${'Zm9vYmFy'.repeat(6)}`;
    const result = build('source.create', { url: { new: value } });
    expect(result).toEqual({ ok: false, reason: 'credential_value' });
    expect(JSON.stringify(result)).not.toContain('Zm9vYmFy');
  });

  it('refuses sentinel-bearing credentials with no sentinel in the reason', () => {
    const value = githubWithSentinel(SENTINEL);
    const result = build('role.create', { name: { new: value } });
    expect(result).toEqual({ ok: false, reason: 'credential_value' });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('never lets a credential reach any successful payload', () => {
    for (const [, value] of rows) {
      const result = build('role.create', { name: { new: value } });
      expect(result.ok).toBe(false);
    }
  });
});

describe('auditEvent false-positive guard', () => {
  it('accepts a ULID', () => {
    expect(build('role.create', { key: { new: '01J0ROLE000000000000000000' } }).ok).toBe(true);
  });

  it('accepts a long package name', () => {
    expect(
      build('version.state_change', {
        package_name: { new: 'vendor/a-very-long-package-name-with-many-words' },
      }).ok,
    ).toBe(true);
  });

  it('accepts a 64-hex value in sha256_new', () => {
    expect(build('version.rebuilt', { sha256_new: { new: '0123456789abcdef'.repeat(4) } }).ok).toBe(
      true,
    );
  });

  it('accepts a 64-hex plan_hash', () => {
    expect(build('import_run.apply', { plan_hash: { new: 'ab12cd34'.repeat(8) } }).ok).toBe(true);
  });

  it('refuses a 64-hex value in a non-hash field', () => {
    expect(build('role.create', { name: { new: '0123456789abcdef'.repeat(4) } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('accepts a 100-character display name with spaces', () => {
    const name = 'word '.repeat(20);
    expect(name.length).toBe(100);
    expect(build('role.create', { name: { new: name } }).ok).toBe(true);
  });
});

describe('auditEvent size limit', () => {
  function sized(target: number) {
    const base = build('role.create', { permissions: { new: [] } });
    const baseLength = new TextEncoder().encode(payloadOf(base)).length;
    let remaining = target - baseLength;
    const items: string[] = [];
    while (remaining > 0) {
      const room = remaining - (items.length === 0 ? 0 : 1) - 2;
      const length = Math.min(100, room);
      items.push('ab '.repeat(40).slice(0, length));
      remaining -= length + 2 + (items.length === 1 ? 0 : 1);
    }
    return build('role.create', { permissions: { new: items } });
  }

  it('accepts a payload of exactly 4096 bytes', () => {
    const result = sized(4096);
    expect(result.ok).toBe(true);
    expect(new TextEncoder().encode(payloadOf(result)).length).toBe(4096);
  });

  it('refuses a payload of 4097 bytes', () => {
    expect(sized(4097)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('counts UTF-8 bytes rather than characters', () => {
    const wide = 'ł'.repeat(100);
    const result = build('role.create', {
      permissions: { new: Array.from({ length: 30 }, () => wide) },
    });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('auditEvent envelope', () => {
  const secret = FAKE.GITHUB_CLASSIC_MIXED20;

  it.each([
    ['actor.id', { actor: { type: 'user', id: secret } }],
    ['target.type', { target: { type: secret, id: null } }],
    ['target.id', { target: { type: 'role', id: secret } }],
    ['projectId', { projectId: secret }],
    ['id', { id: secret }],
    ['now', { now: secret }],
    ['sourceIp', { context: { ...context, sourceIp: 'jan@example.test' } }],
  ])('refuses a credential in %s without echoing it', (_name, override) => {
    const result = build('role.delete', undefined, override);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Ab1Cd2Ef3Gh4Ij5Kl6Mn');
    expect(JSON.stringify(result)).not.toContain('jan@');
  });

  it('refuses an actor type outside the union', () => {
    expect(build('role.delete', undefined, { actor: { type: 'admin', id: null } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses a token selector of the wrong shape', () => {
    expect(
      build('role.delete', undefined, { context: { ...context, tokenSelector: secret } }),
    ).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each(['203.0.113.7', '2001:db8::1', '::1'])('accepts source IP %s', (sourceIp) => {
    expect(build('role.delete', undefined, { context: { ...context, sourceIp } }).ok).toBe(true);
  });

  it.each(['999.1.1.1', 'not-an-ip', '1.2.3', ':::'])('refuses source IP %s', (sourceIp) => {
    expect(build('role.delete', undefined, { context: { ...context, sourceIp } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses an envelope string that a URL redaction would alter', () => {
    expect(
      build('role.delete', undefined, { target: { type: 'https://u:p@h.test/?q=1', id: null } }),
    ).toEqual({ ok: false, reason: 'bad_value' });
  });

  it('refuses a change with neither old nor new', () => {
    expect(build('role.rename', { name: {} })).toEqual({ ok: false, reason: 'bad_value' });
  });

  it('refuses the 60-character lowercase dashed secret in a name field', () => {
    const value = FAKE.RUN_3;
    expect(build('role.rename', { name: { new: value } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('refuses a hash-shaped value in the plan_hash field when it is not 64 hex', () => {
    expect(build('import_run.create', { plan_hash: { new: 'a3f9'.repeat(10) } }).ok).toBe(false);
  });

  it('stores an scp-style URL without its user', () => {
    expect(
      payloadOf(build('source.update', { url: { new: 'git@github.com:vendor/repo.git' } })),
    ).toContain('github.com:vendor/repo.git');
  });

  it('stores a prerelease package spec', () => {
    expect(build('role.rename', { name: { new: '@scope/pkg@1.0.0-alpha.beta' } }).ok).toBe(true);
  });
});

describe('auditEvent false-positive corpus', () => {
  const ids = {
    id: '01HZXY8J9K2M3N4P5Q6R7S8T9V',
    actor: { type: 'user', id: '01HZXY8J9K2M3N4P5Q6R7S8T9W' },
    target: { type: 'package', id: '01HZXY8J9K2M3N4P5Q6R7S8T9X' },
    projectId: '01HZXY8J9K2M3N4P5Q6R7S8T9Y',
    context: {
      opId: '01HZXY8J9K2M3N4P5Q6R7S8T9V',
      requestId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      sourceIp: '203.0.113.7',
      tokenSelector: 'abcdefghijkl',
    },
  };
  const packages = [
    'vendor/kaizen-toolkit',
    '@types/node',
    'symfony/http-foundation',
    'laravel/framework',
    'monolog/monolog',
    'guzzlehttp/guzzle',
    'phpunit/phpunit',
    'doctrine/orm',
    'magento/module-catalog',
    'magento/product-community-edition',
    'magento/module-inventory-sales-admin-ui',
    'magento/module-sales-rule-graph-ql',
    'magento/module-customer-import-export',
    'magento/module-configurable-product-graph-ql',
    'magento/magento-composer-installer',
    'phpstan/phpstan',
    'friendsofphp/php-cs-fixer',
    'symfony/polyfill-intl-normalizer',
    'symfony/polyfill-intl-grapheme',
    'symfony/polyfill-php80',
    'symfony/deprecation-contracts',
    'psr/http-message',
    'ramsey/uuid',
    'league/flysystem-aws-s3-v3',
    'aws/aws-sdk-php',
    'google/apiclient-services',
    'google/cloud-storage',
    'huggingface/transformers',
    '@huggingface/inference',
    FAKE.HUGGINGFACE_3,
    '@aws-sdk/client-s3',
    '@aws-sdk/credential-provider-node',
    '@babel/plugin-transform-modules-commonjs',
    '@babel/plugin-proposal-class-properties',
    '@typescript-eslint/eslint-plugin',
    'eslint-plugin-react-hooks',
    '@nestjs/platform-express',
    '@angular-devkit/build-angular',
    '@vue/compiler-sfc',
    'react-dom',
    'lodash.debounce',
    '@fortawesome/free-solid-svg-icons',
    '@storybook/addon-essentials',
    'webpack-dev-server',
    '@cloudflare/workers-types',
    '@octokit/plugin-paginate-rest',
    'core-js',
    'is-number',
    'left-pad',
    '@sk-live/foo',
    FAKE.STRIPE_2,
    ['acme/ask', '_live_events'].join(''),
    ['acme/disk', '_live_monitor'].join(''),
    ['acme/risk', '_live_scoring'].join(''),
    ['vendor/task', '_live_reload'].join(''),
    ['acme/desk', '_live_chat'].join(''),
    'vendor/maiza-theme',
    'vendor/kaiza-lib',
    'acme/paizaapi',
    'vendor/thaizapp',
    'acme/brazil-aiza-payments',
    ['acme/shf', '_utils'].join(''),
    ['acme/chf', '_converter'].join(''),
    'acme/pdf_tools',
    ['acme/gh', 'p_utils'].join(''),
    ['acme/np', 'm_helpers'].join(''),
    ['acme/np', 'm_registry_mirror_utils'].join(''),
    ['acme/xo', 'xa-tools'].join(''),
    'acme/akia',
    'vendor/asiapacific-shipping-integration',
    'vendor/malaysia-asia-pacific-regionaldata',
    'vendor/asiaasiaasiaasiaasiaasia',
    ['acme/gl', 'pat-scanner'].join(''),
    ['acme/gl', 'oas-helper'].join(''),
    ['acme/sh', 'pat_client'].join(''),
    ['acme/dc', 'kr_pat_helper'].join(''),
    ['acme/gi', 'thub_pat_rotator'].join(''),
    ['@acme/np', 'm_publish-action-helper'].join(''),
    'acme/token-auth',
    'acme/bearer-token-middleware',
    'vendor/basic-auth-bundle',
    'acme/my.email@helpers',
    'acme/eyJ-decoder',
    'acme/a1b2c3d4e5f6a7b8',
    'acme/module-abcdef1234567890',
    'vendor/package-v2-2024-10-17',
    'vendor/l10n-i18n-g11n-a11y-k8s-utils',
    '@ckeditor/ckeditor5-build-classic',
    '@ckeditor/ckeditor5-engine',
    '@angular/platform-browser-dynamic',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@aws-sdk/client-secrets-manager',
    '@google-cloud/secret-manager',
    'vendor/package_with_underscores_and_numbers_123',
    'acme/sha256-hasher',
    'vendor/base64url',
    'vendor/uuid-v4',
    'acme/12345',
    'acme/2fa',
    'acme/oauth2-client',
    'league/oauth2-server',
    'web-token/jwt-framework',
    'firebase/php-jwt',
    'lcobucci/jwt',
    'spatie/laravel-permission',
    'spatie/laravel-medialibrary',
    'barryvdh/laravel-debugbar',
    'nesbot/carbon',
    'vlucas/phpdotenv',
    'sebastian/comparator',
    'webmozart/assert',
    'composer/semver',
    'composer/ca-bundle',
    'paragonie/sodium_compat',
    'paragonie/random_compat',
    'ezyang/htmlpurifier',
    'tecnickcom/tcpdf',
    'dompdf/dompdf',
    'mpdf/mpdf',
    'phpoffice/phpspreadsheet',
    'hyva-themes/magento2-default-theme',
    'hyva-themes/magento2-theme-module',
    'yireo/magento2-webp2',
    'mageplaza/module-smtp',
    'amasty/module-gdpr-cookie-compliance',
    'smile/elasticsuite',
    'klarna/module-kp-graph-ql',
    'paypal/module-braintree-graph-ql',
    'adobe-commerce/os-extensions-metapackage',
    'magento/module-adobe-stock-image-admin-ui',
    'magento/module-inventory-in-store-pickup-sales-admin-ui',
    'magento/module-login-as-customer-admin-ui',
    'magento/module-two-factor-auth',
    'magento/module-page-builder-admin-analytics',
  ];
  const patterns = packages.concat(packages.map((name) => `${name.split('/')[0]}/*`));
  const slugs = [
    'acme-web',
    'kaizen',
    'team-a',
    'production-eu-west-1',
    'shop2',
    'client-xyz-2026',
    'b2b-portal',
    'my_project',
    'hf-staging',
    FAKE.GOOGLE_2,
    'sk-live-store',
    'risk-live',
    'desk-live-2',
  ];
  const roles = [
    'admin',
    'owner',
    'viewer',
    'project_admin',
    'package_publisher',
    'billing.read',
    'sources:write',
    'token-issuer',
    FAKE.STRIPE_3,
  ];
  const versions = [
    '1.0.0',
    '1.0.0-beta.1+build.5',
    'v2.3.4',
    '2.4.7-p3',
    'dev-main',
    'dev-feature/ABC-123-new-checkout',
    '1.0.0-rc.1',
    '0.0.0-20241017123045-a1b2c3d4e5f6',
    '1.2.3+sha.5114f85',
    '9999999-dev',
    '2.x-dev',
    '1.0.0-alpha.0.1.2.3.4.5.6.7.8.9',
    'v1.2.3-0.20241017120000-abcdef123456',
    'dev-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    '1.0.0-SNAPSHOT',
    '4.0.0-next.12',
    '1.0.0-beta.1+exp.sha.5114f85',
    '2024.10.17',
    'main',
    'refs/heads/main',
    'refs/tags/v1.2.3',
    'feature/ABC-123',
    'release/2.4.7',
    'a1b2c3d',
    '5114f85',
    'refs/pull/123/merge',
    ['origin/dependabot/np', 'm_and_yarn/eslint-plugin-react-hooks-5.0.0'].join(''),
    'dependabot/composer/symfony/http-foundation-6.4.14',
    'renovate/major-aws-sdk-javascript-monorepo',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  ];
  const timestamps = [
    '2026-10-17T10:00:00Z',
    '2026-10-17T10:00:00.123456Z',
    '2026-10-17T10:00:00+02:00',
    '2026-10-17',
  ];
  const uuids = [
    '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    '01HZXY8J9K2M3N4P5Q6R7S8T9V',
    '550e8400-e29b-41d4-a716-446655440000',
  ];
  const digests = [
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
  ];
  const urls = [
    'https://repo.packagist.org/',
    'ssh://git@github.com/acme/w.git',
    'https://github.com/acme/widget.git',
    'git@github.com:acme/widget.git',
    'https://registry.npmjs.org/',
    'https://repo.magento.com/',
    'https://gitlab.com/acme-group/sub-group/widget.git',
    'https://bitbucket.org/acme/widget.git',
    'https://packages.example.com/composer/',
    'https://npm.pkg.github.com/acme',
    'https://acme.jfrog.io/artifactory/api/npm/npm-remote/',
    'https://europe-west1-npm.pkg.dev/my-project-123456/my-repo/',
    'https://123456789012.dkr.ecr.eu-west-1.amazonaws.com/',
    'https://my-domain-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/my-repo/',
    'https://pkgs.dev.azure.com/acme/_packaging/feed/npm/registry/',
    'https://hf.co/acme',
    'https://huggingface.co/datasets/acme/x',
    'https://github.com/acme/widget/archive/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0.zip',
    'https://api.github.com/repos/acme/widget/zipball/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    'https://codeload.github.com/acme/widget/legacy.zip/refs/tags/v1.2.3',
    'https://gitlab.com/api/v4/projects/12345678/packages/composer/packages.json',
    ['https://github.com/hf', '_org/repo.git'].join(''),
    ['https://github.com/acme/sk', '_live_dashboard.git'].join(''),
    'https://maiza.example.com/repo',
    'git+ssh://git@bitbucket.org/acme/w.git',
    'https://storage.googleapis.com/acme-artifacts-bucket-2026/packages/',
    'https://acme.blob.core.windows.net/packages/',
    'https://s3.eu-west-1.amazonaws.com/acme-composer-mirror/',
  ];
  const displayNames = [
    'Kaizen Toolkit',
    'Production mirror',
    'Łukasz Bajsarowicz',
    'Main source (Packagist)',
    'ACME Corp — EU',
    'Release token 2026-10',
    'CI token for acme/widget',
    'GitHub Actions deploy',
    'HF staging',
    ['AI', 'za integration notes'].join(''),
    'Stripe sk_live rotation',
    'Deploy key for git@github.com',
  ];

  function corpus(action: string, field: string, values: readonly unknown[]) {
    return values.map((value): [string, string, unknown] => [action, field, value]);
  }

  const rows = [
    ...corpus('version.rebuilt', 'package_name', packages),
    ...corpus('registered_name.add', 'pattern', patterns),
    ...corpus('source.update', 'name', packages),
    ...corpus('project.create', 'slug', slugs),
    ...corpus('role.create', 'key', roles),
    ...corpus('role.permissions_set', 'permissions', [roles]),
    ...corpus('version.rebuilt', 'version', versions),
    ...corpus('token.issue', 'expires_at', timestamps),
    ...corpus('source.attach', 'project_id', uuids),
    ...corpus('grant.create', 'role_id', uuids),
    ...corpus('sync_session.finalize', 'source_id', uuids),
    ...corpus('version.rebuilt', 'sha256_new', digests),
    ...corpus('import_run.create', 'plan_hash', digests),
    ...corpus('source.update', 'url', urls),
    ...corpus('project.update', 'name', displayNames),
  ];

  it.each(rows)('%s accepts %s %j', (action, field, value) => {
    expect(build(action, { [field]: { new: value } }, ids).ok).toBe(true);
  });

  it.each(uuids)('accepts %s in every envelope id', (id) => {
    const result = build('role.delete', undefined, {
      ...ids,
      target: { type: 'role', id },
      projectId: id,
      actor: { type: 'user', id },
    });
    expect(result.ok).toBe(true);
  });

  it.each(['package_version', 'service_principal', 'import_run', 'registered_name'])(
    'accepts target type %s',
    (type) => {
      expect(build('role.delete', undefined, { ...ids, target: { type, id: 'x' } }).ok).toBe(true);
    },
  );
});

describe('auditEvent leak corpus', () => {
  const hex = (length: number) => 'a3f9'.repeat(20).slice(0, length);
  const refused: Array<[string, string, unknown]> = [
    ['32 hex', 'role.rename|name', hex(32)],
    ['39 hex', 'role.rename|name', hex(39)],
    ['40 hex', 'role.rename|name', hex(40)],
    ['36-character base64', 'role.rename|name', FAKE.RUN_2],
    ['Shopify token', 'role.rename|name', `${['sh', 'pat_'].join('')}${hex(32)}`],
    ['Docker token', 'role.rename|name', FAKE.DOCKER_1],
    ['GitLab deploy token', 'role.rename|name', FAKE.GITLAB_DEPLOY_1],
    ['Google key', 'role.rename|name', FAKE.GOOGLE_1],
    ['lower-cased Google key', 'role.rename|name', FAKE.GOOGLE_3],
    ['Hugging Face token', 'role.rename|name', FAKE.HUGGINGFACE_1],
    ['prefixed Hugging Face token', 'role.rename|name', FAKE.HUGGINGFACE_4],
    ['UUID in a name', 'role.rename|name', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'],
    ['60-character dashed run', 'role.rename|name', FAKE.RUN_3],
    ['60-character dashed run in package_name', 'version.rebuilt|package_name', FAKE.RUN_3],
    ['31-character lower-case run', 'role.rename|name', FAKE.RUN_5],
    ['32-character lower-case run', 'role.rename|name', FAKE.RUN_15],
    ['39-character lower-case run', 'role.rename|name', FAKE.RUN_16],
    ['GitHub token', 'role.rename|name', FAKE.GITHUB_PAT_CLASSIC_4],
    ['Slack token', 'role.rename|name', FAKE.SLACK_2],
    ['Stripe test key', 'role.rename|name', FAKE.STRIPE_4],
    ['Stripe restricted key', 'role.rename|name', FAKE.STRIPE_RESTRICTED_1],
    ['Stripe publishable key', 'role.rename|name', FAKE.STRIPE_PUBLISHABLE_1],
    ['provider token mid-word', 'role.rename|name', FAKE.GITHUB_PAT_CLASSIC_1],
    ['upper-case provider token', 'role.rename|name', FAKE.GITHUB_UPPER_1],
    ['JWT not at start', 'role.rename|name', FAKE.JWT_EMBEDDED_1],
    ['JWT after underscore', 'role.rename|name', FAKE.JWT_2],
    ['embedded Bearer', 'role.rename|name', FAKE.BEARER_EMBEDDED_1],
    ['Bearer with an equals sign', 'role.rename|name', FAKE.BEARER_EQUALS_1],
    ['token scheme', 'role.rename|name', FAKE.TOKEN_HEADER_1],
    ['lower-case PEM', 'role.rename|name', FAKE.RUN_4],
    ['PEM with four dashes', 'role.rename|name', FAKE.PEM_2],
    ['OpenSSH key body', 'role.rename|name', FAKE.RUN_17],
    [
      'URL query in free text',
      'source.update|url',
      'mirror https://git.example.test/r?access_token=s3cr3tvalue12',
    ],
    [
      'private_token in free text',
      'source.update|url',
      'mirror https://git.example.test/r?private_token=s3cr3tvalue12',
    ],
    [
      'apikey in free text',
      'source.update|url',
      'mirror https://git.example.test/r?apikey=s3cr3tvalue12',
    ],
    [
      'signed URL in free text',
      'source.update|url',
      [
        'mirror https://git.example.test/r?X-Amz-Credential=AK',
        'IAx&X-Amz-Signature=s3cr3tvalue12',
      ].join(''),
    ],
    [
      'URL fragment in free text',
      'source.update|url',
      'mirror https://git.example.test/r#token=s3cr3tvalue12',
    ],
    ['backslash URL userinfo', 'source.update|url', 'https:\\\\deploy:hunter2pw@10.0.0.5/r'],
    ['single-slash URL userinfo', 'source.update|url', 'https:/deploy:hunter2pw@10.0.0.5/r'],
    ['no-slash URL userinfo', 'source.update|url', 'https:deploy:hunter2pw@10.0.0.5/r'],
    [
      'scp address with a password',
      'source.update|url',
      'deploy:hunter2pw@github.com:vendor/repo.git',
    ],
    ['plus-address e-mail', 'role.rename|name', 'jan+tag@example.test'],
    ['upper-case e-mail', 'role.rename|name', 'JAN@EXAMPLE.TEST'],
    ['IDN e-mail', 'role.rename|name', 'jan@bücher.de'],
    ['Cyrillic e-mail', 'role.rename|name', 'jan@пример.рф'],
    ['localhost e-mail', 'role.rename|name', 'jan@localhost'],
    ['IP literal e-mail', 'role.rename|name', 'jan@[10.0.0.1]'],
    ['bare IP e-mail', 'role.rename|name', 'jan@10.0.0.1'],
    ['single-label e-mail', 'role.rename|name', 'jan@intranet'],
    ['punycode TLD e-mail', 'role.rename|name', 'jan@example.xn--p1ai'],
    ['full-width at e-mail', 'role.rename|name', 'jan＠example.test'],
    ['small at e-mail', 'role.rename|name', 'jan﹫example.test'],
    ['percent-encoded e-mail', 'source.update|url', 'https://h.example.test/u/jan%40example.test'],
    ['e-mail in a URL path', 'source.update|url', 'https://h.example.test/u/jan@example.test'],
    ['e-mail after a slash', 'role.rename|name', 'x/jan@example.test'],
    ['zero-width space e-mail', 'role.rename|name', 'jan​@example.test'],
    ['full-width dot e-mail', 'role.rename|name', 'jan@example．test'],
    ['base64 in sha256_new', 'version.rebuilt|sha256_new', FAKE.RUN_1],
    ['two digests in sha256_new', 'version.rebuilt|sha256_new', `${hex(64)} ${hex(64)}`],
    ['24-character base64 part', 'role.rename|name', FAKE.BASE64_24],
    [
      'base64 chunks in an array',
      'role.permissions_set|permissions',
      [FAKE.BASE64_CHUNK_1, FAKE.BASE64_CHUNK_2],
    ],
    [
      'provider token in an array',
      'role.permissions_set|permissions',
      ['ok', FAKE.GITHUB_PAT_CLASSIC_5],
    ],
    ['31-character mixed run', 'role.rename|name', FAKE.RUN_18],
    ['32-character mixed run', 'role.rename|name', FAKE.RUN_19],
    ['32-character upper-case run', 'role.rename|name', FAKE.RUN_6],
    ['39-character upper-case run', 'role.rename|name', FAKE.RUN_20],
    ['embedded broker token', 'role.rename|name', FAKE.BROKER_EMBEDDED_1],
  ];

  it.each(refused)('refuses %s', (_name, actionField, value) => {
    const [action, field] = actionField.split('|') as [string, string];
    const result = build(action, { [field]: { new: value } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2pw');
    expect(JSON.stringify(result)).not.toContain('Ab1Cd2');
  });

  const redacted: Array<[string, string, string]> = [
    ['URL with leading space', ' https://deploy:hunter2pw@10.0.0.5/repo', 'https://10.0.0.5/repo'],
    [
      'URL with userinfo',
      ' https://deploy:hunter2pw@git.example.test/repo',
      'https://git.example.test/repo',
    ],
    ['localhost URL', 'https://deploy:hunter2pw@localhost/r', 'https://localhost/r'],
    ['git+https URL', 'git+https://deploy:hunter2pw@10.0.0.5/r', 'git+https://10.0.0.5/r'],
    ['ftp URL', 'ftp://deploy:hunter2pw@ftp.example.test/r', 'ftp://ftp.example.test/r'],
    ['svn URL', 'svn://deploy:hunter2pw@svn.example.test/r', 'svn://svn.example.test/r'],
    ['hg URL', 'hg+https://deploy:hunter2pw@h.example.test/r', 'hg+https://h.example.test/r'],
    [
      'path parameters',
      'https://h.example.test/r;jsessionid=s3cr3tvalue12',
      'https://h.example.test/r',
    ],
    [
      'e-mail in the query',
      'https://h.example.test/u?e=jan@example.test',
      'https://h.example.test/u',
    ],
    ['scp address', 'git@github.com:vendor/repo.git', 'github.com:vendor/repo.git'],
    [
      'git+ssh URL',
      'git+ssh://git@github.com/vendor/repo.git',
      'git+ssh://github.com/vendor/repo.git',
    ],
  ];

  it.each(redacted)('stores %s without the secret', (_name, value, stored) => {
    expect(payloadOf(build('source.update', { url: { new: value } }))).toContain(
      `"url":{"new":${JSON.stringify(stored)}}`,
    );
  });

  const benign: Array<[string, string, string]> = [
    ['provider prefix with a lower-case body', 'role.rename|name', FAKE.HUGGINGFACE_5],
    ['mid-word provider prefix with a lower-case body', 'role.rename|name', FAKE.HUGGINGFACE_6],
    ['GitHub prefix with a short body', 'role.rename|name', FAKE.GITHUB_PAT_CLASSIC_3],
    ['npm prefix with a short body', 'role.rename|name', FAKE.NPM_SHORT_1],
    ['Bearer with a short value', 'role.rename|name', FAKE.BEARER_SHORT_1],
    ['prerelease package spec', 'role.rename|name', '@scope/pkg@1.0.0-alpha.beta'],
    ['64 hex in plan_hash', 'import_run.create|plan_hash', 'a3f9'.repeat(16)],
    ['64 hex in sha256_new', 'version.rebuilt|sha256_new', 'a3f9'.repeat(16)],
  ];

  it.each(benign)('accepts %s', (_name, actionField, value) => {
    const [action, field] = actionField.split('|') as [string, string];
    expect(build(action, { [field]: { new: value } }).ok).toBe(true);
  });

  for (const gap of [
    'a secret split by dots into runs under 24 characters',
    'a base64 secret split by spaces into short chunks',
    'a secret in a short URL path segment such as /token/s3cr3tvalue12/',
    'a letters-only random run such as kqjdzsxqplmx-vnbztawqerty-zxcvbnmlkjhg',
    'an obfuscated e-mail such as jan (at) example.test',
  ]) {
    it.todo(`refuses ${gap}`);
  }
});

describe('auditEvent envelope hardening', () => {
  it('refuses a null context as bad_value', () => {
    expect(build('role.delete', undefined, { context: null })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses an op id that URL redaction would alter', () => {
    expect(
      build('role.delete', undefined, {
        context: { ...context, opId: 'https://u:p@h.example.test/' },
      }),
    ).toEqual({ ok: false, reason: 'bad_value' });
  });

  it('refuses a request id that URL redaction would alter', () => {
    expect(
      build('role.delete', undefined, {
        context: { ...context, requestId: 'https://h.example.test/?q=1' },
      }),
    ).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each(['01HZXY8J9K2M3N4P5Q6R7S8T9V', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'])(
    'accepts broker id %s as op id and request id',
    (id) => {
      expect(
        build('role.delete', undefined, { context: { ...context, opId: id, requestId: id } }).ok,
      ).toBe(true);
    },
  );

  it.each([
    ['cf-ray request id', { requestId: '8c1f2a3b4d5e6f70-WAW' }],
    ['free-form request id', { requestId: 'req-1' }],
    ['free-form op id', { opId: 'op-1' }],
  ])('refuses a %s as bad_value', (_name, override) => {
    expect(build('role.delete', undefined, { context: { ...context, ...override } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses a lower-case ULID as op id', () => {
    expect(
      build('role.delete', undefined, {
        context: { ...context, opId: '01hzxy8j9k2m3n4p5q6r7s8t9v' },
      }).ok,
    ).toBe(false);
  });

  it.each([
    ['an offset timestamp', '2026-10-17T10:00:00.000+02:00'],
    ['a date only', '2026-10-17'],
    ['a URL', 'https://h.example.test/x'],
    ['an impossible date', '2026-13-45T10:00:00Z'],
  ])('refuses %s as now', (_name, now) => {
    expect(build('role.delete', undefined, { now })).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each(['2026-10-17T10:00:00Z', '2026-10-17T10:00:00.123456Z'])('accepts now %s', (now) => {
    expect(build('role.delete', undefined, { now }).ok).toBe(true);
  });

  it('refuses a UUID as target type', () => {
    expect(
      build('role.delete', undefined, {
        target: { type: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', id: 'x' },
      }),
    ).toEqual({ ok: false, reason: 'credential_value' });
  });
});

describe('manifest audit string bounds', () => {
  const packages = ['a/'.padEnd(201, 'a'), 'a/'.padEnd(428, 'a'), '@a/'.padEnd(214, 'a')];

  it.each(packages.map((value) => [value.length, value] as const))(
    'preserves the complete %i-character package name',
    (_length, value) => {
      const result = build('version.published_at_set', {
        package_name: { old: value, new: value },
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(payloadOf(result)).changes.package_name).toEqual({
        old: value,
        new: value,
      });
    },
  );

  it('preserves a maximum manifest version', () => {
    const value = 'dev-'.padEnd(256, 'a');
    expect(
      JSON.parse(payloadOf(build('version.published_at_set', { version: { new: value } }))).changes
        .version.new,
    ).toBe(value);
  });

  it.each(['project_id', 'role_id'])('preserves a maximum external ref in %s', (field) => {
    const value = 'legacy:projects/'.padEnd(200, 'a');
    const action = field === 'project_id' ? 'source.attach' : 'grant.create';
    expect(
      JSON.parse(payloadOf(build(action, { [field]: { new: value } }))).changes[field].new,
    ).toBe(value);
  });

  it.each([
    ['package_name', 'a/'.padEnd(429, 'a')],
    ['package_name', 'a '.repeat(110)],
    ['version', 'dev-'.padEnd(257, 'a')],
    ['version', 'a '.repeat(110)],
  ])('refuses an invalid extended %s', (field, value) => {
    expect(build('version.published_at_set', { [field]: { new: value } }).ok).toBe(false);
  });

  it('keeps the generic text limit', () => {
    expect(build('role.rename', { name: { new: 'a'.repeat(201) } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it.each(['package_name', 'version'])('refuses provider credentials in extended %s', (field) => {
    const value = 'a/'.padEnd(201, 'a') + FAKE.GITHUB_PAT_CLASSIC_4.toLowerCase();
    expect(build('version.published_at_set', { [field]: { new: value } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });
});

describe('import rollback audit counts', () => {
  const target = { type: 'import_run', id: '01J0IMPORT0000000000000000' };

  it('accepts restored, conflict and expired counts on import_run.rollback', () => {
    const result = build(
      'import_run.rollback',
      { restored: { new: 3 }, conflict: { new: 1 }, expired: { new: 0 } },
      { target },
    );
    expect(result.ok).toBe(true);
  });

  it.each(['restored', 'conflict', 'expired'])('refuses %s on import_run.apply', (field) => {
    expect(build('import_run.apply', { [field]: { new: 1 } }, { target })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });
});

describe('source package request audit', () => {
  it.each(['JSONStream', '@scope/' + 'A'.repeat(207)])(
    'records a validated legacy npm display name: %s',
    (name) => {
      const result = build('source.package_requested', { package_name: { new: name } });
      expect(result.ok).toBe(true);
      expect(JSON.parse(payloadOf(result)).changes).toEqual({ package_name: { new: name } });
    },
  );
});

describe('npm audit values', () => {
  it.each(['sha512', 'sha1'] as const)(
    'accepts a real %s SRI digest only for publish integrity',
    async (algorithm) => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          algorithm === 'sha512' ? 'SHA-512' : 'SHA-1',
          new TextEncoder().encode('package tarball'),
        ),
      );
      const digest = `${algorithm}-${btoa(String.fromCharCode(...bytes))}`;
      expect(build('package.publish', { integrity: { new: digest } }).ok).toBe(true);
      expect(build('publish.reject', { reason: { new: digest } }).ok).toBe(false);
      for (const invalid of [
        digest + 'x',
        digest + '\n',
        digest + '\r\n',
        'sha512-abc',
        digest.replace(/.$/, '!'),
      ])
        expect(build('package.publish', { integrity: { new: invalid } }).ok).toBe(false);
    },
  );
  it.each([
    'package.publish',
    'token.workload_issue',
    'package.access_request',
    'package.access_decide',
  ])('bounds npm package names in %s', (action) => {
    expect(build(action, { package: { new: 'a'.repeat(MAX_NPM_NAME_LENGTH) } }).ok).toBe(true);
    expect(build(action, { package: { new: 'a'.repeat(215) } }).ok).toBe(false);
    expect(build(action, { package: { new: 'a/' + 'b'.repeat(213) } }).ok).toBe(false);
  });
});

describe('workload claim audit bounds', () => {
  it.each([
    ['workflow', 255],
    ['environment', 255],
    ['ref', 1024],
  ] as const)('preserves %s at its byte limit and refuses excess bytes', (field, limit) => {
    const value = field === 'workflow' ? 'w'.repeat(limit - 4) + '.yml' : 'a'.repeat(limit);
    const result = build('token.workload_issue', { [field]: { new: value } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.event.payloadJson).changes[field].new).toBe(value);
    for (const oversized of [value + 'a', 'é'.repeat(Math.floor(limit / 2) + 1)])
      expect(build('token.workload_issue', { [field]: { new: oversized } })).toEqual({
        ok: false,
        reason: 'bad_value',
      });
  });
});

describe('verified workload claim audit values', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  it.each([
    ['workflow', `release-${uuid}.yml`],
    ['environment', `release-${uuid}`],
    ['ref', `refs/heads/release-${uuid}`],
    ['repository_id', '12345678901234567890'],
    ['repository_owner_id', '98765432109876543210'],
    ['repository_visibility', 'private'],
  ])('preserves verified %s without generic credential detection', (field, value) => {
    const result = build('token.workload_issue', { [field]: { new: value } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.event.payloadJson).changes[field].new).toBe(value);
  });
  it.each([
    ['workflow', 'invalid.txt'],
    ['workflow', 'dir/publish.yml'],
    ['workflow', 'publish@main.yml'],
    ['workflow', '\ud800.yml'],
    ['environment', 'prod\n'],
    ['ref', 'refs/heads/with space'],
    ['ref', ''],
    ['repository_id', '0123'],
    ['repository_owner_id', 'a'],
    ['repository_visibility', 'unknown'],
  ])('refuses invalid %s claim characters', (field, value) => {
    expect(build('token.workload_issue', { [field]: { new: value } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });
  it('keeps credential detection on other actions and workload fields', () => {
    expect(build('token.issue', { name: { new: `release-${uuid}` } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
    expect(build('token.workload_issue', { token_id: { new: `release-${uuid}` } })).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });
});

it('preserves complete publisher restriction snapshots including absent and long values', () => {
  const changes = {
    package: { old: 'a'.repeat(MAX_NPM_NAME_LENGTH), new: 'widget' },
    environment: { old: '', new: 'prod' },
    ref_pattern: { old: null, new: 'refs/tags/v*' },
    repository_id: { old: '123', new: '789' },
    repository_owner_id: { old: '456', new: '987' },
    repository: { old: 'owner/repo', new: 'owner/next' },
    workflow: { old: 'p'.repeat(240) + '.yml', new: 'publish.yml' },
  };
  expect(JSON.parse(payloadOf(build('trusted_publisher.update', changes))).changes).toEqual(
    changes,
  );
  expect(build('token.workload_issue', { repository_id: { new: null } })).toEqual({
    ok: false,
    reason: 'bad_value',
  });
});

describe('final audit validation', () => {
  it('validates package names after enrichment and preserves a valid event', () => {
    const result = build('package.access_request', { package: { new: 'widget' } });
    if (!result.ok) throw new Error('invalid fixture');
    expect(withPackageAuditName(result.event, '@scope/widget')).toMatchObject({
      payloadJson: expect.stringContaining('@scope/widget'),
    });
    expect(validateAuditEvent(result.event)).toEqual(result.event);
    for (const name of ['person@example.test', 'https://user:password@example.test/path'])
      expect(() => withPackageAuditName(result.event, name)).toThrow('invalid audit event');
  });
  it('enforces the final payload byte budget', () => {
    const result = build('role.rename');
    if (!result.ok) throw new Error('invalid fixture');
    const payloadJson = JSON.stringify({
      op_id: context.opId,
      request_id: context.requestId,
      changes: { name: { new: Array.from({ length: 50 }, () => 'x'.repeat(90)) } },
    });
    expect(new TextEncoder().encode(payloadJson).length).toBeGreaterThan(4096);
    expect(() => validateAuditEvent({ ...result.event, payloadJson })).toThrow(
      'invalid audit event',
    );
  });
  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ op_id: context.opId, request_id: context.requestId, extra: 'private' }),
    JSON.stringify({
      op_id: context.opId,
      request_id: context.requestId,
      changes: { unknown: { new: true } },
    }),
    JSON.stringify({
      op_id: context.opId,
      request_id: context.requestId,
      changes: { reason: { new: 'https://example.test/path?private=value' } },
    }),
    JSON.stringify({
      op_id: context.opId,
      request_id: context.requestId,
      changes: { reason: { new: 'x'.repeat(4096) } },
    }),
  ])('rejects malformed, unsafe or oversized final payloads', (payloadJson) => {
    const result = build('package.access_request');
    if (!result.ok) throw new Error('invalid fixture');
    expect(() => validateAuditEvent({ ...result.event, payloadJson })).toThrow(
      'invalid audit event',
    );
  });
});
