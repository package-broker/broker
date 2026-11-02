import { describe, expect, it } from 'vitest';
import { auditEvent, validateAuditEvent, type AuditEventInput } from './actions.js';

const ID = '01J0P000000000000000000000';
const RULE = '01J0P0000000000000000000RR';

function build(
  action: AuditEventInput['action'],
  changes?: AuditEventInput['changes'],
): ReturnType<typeof auditEvent> {
  return auditEvent({
    id: ID,
    now: '2026-11-01T00:00:00.000Z',
    action,
    actor: { type: 'user', id: 'user' },
    context: { opId: ID, requestId: ID, sourceIp: null, tokenSelector: null },
    target: { type: 'registry_policy', id: RULE },
    projectId: 'project',
    ...(changes === undefined ? {} : { changes }),
  });
}

const created = {
  kind: { new: 'block' },
  ecosystem: { new: 'npm' },
  package_key: { new: '@scope/pkg' },
  project_id: { new: 'project' },
  min_age_seconds: { new: null },
  client_family: { new: null },
  client_min_version: { new: null },
  deny_unknown: { new: false },
  reason_code: { new: 'security_review' },
  incident_id: { new: null },
  expires_at: { new: '2026-12-01T00:00:00.000Z' },
  revision: { new: 1 },
  member_count: { new: 3 },
};

describe('registry policy mutation audit events', () => {
  it('accepts a complete rule creation and round-trips it through validation', () => {
    const result = build('registry_policy.create', created);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateAuditEvent(result.event)).toEqual(result.event);
  });

  it('accepts an override with old and new revision, changed field names and a reason', () => {
    const result = build('registry_policy.update', {
      revision: { old: 3, new: 4 },
      min_age_seconds: { old: 604800, new: 86400 },
      changed_fields: { new: ['min_age_seconds'] },
      override_reason: { new: 'emergency_compatibility' },
    });
    expect(result.ok).toBe(true);
    expect(
      build('registry_policy.disable', {
        revision: { old: 1, new: 2 },
        changed_fields: { new: ['disabled'] },
        override_reason: { new: 'false_positive' },
      }).ok,
    ).toBe(true);
    expect(
      build('registry_policy.release', {
        kind: { new: 'quarantine' },
        revision: { old: 1, new: 2 },
        override_reason: { new: 'superseded' },
      }).ok,
    ).toBe(true);
    expect(
      build('registry_policy.expire', {
        kind: { new: 'allowlist' },
        expires_at: { new: '2026-12-01T00:00:00.000Z' },
        revision: { new: 2 },
      }).ok,
    ).toBe(true);
  });

  it('requires a fixed override reason on disable, release and block member removal', () => {
    for (const action of ['registry_policy.disable', 'registry_policy.release'] as const) {
      expect(build(action)).toEqual({ ok: false, reason: 'bad_value' });
      expect(build(action, { revision: { old: 1, new: 2 } })).toEqual({
        ok: false,
        reason: 'bad_value',
      });
    }
    for (const kind of ['block', 'quarantine']) {
      expect(
        build('registry_policy.members_replace', {
          kind: { new: kind },
          revision: { old: 1, new: 2 },
          member_count: { old: 2, new: 1 },
          members_added: { new: 0 },
          members_removed: { new: 1 },
        }),
      ).toEqual({ ok: false, reason: 'bad_value' });
    }
    expect(
      build('registry_policy.members_replace', {
        kind: { new: 'block' },
        revision: { old: 1, new: 2 },
        member_count: { old: 2, new: 1 },
        members_added: { new: 0 },
        members_removed: { new: 1 },
        override_reason: { new: 'other' },
      }).ok,
    ).toBe(true);
    expect(
      build('registry_policy.members_replace', {
        kind: { new: 'block' },
        revision: { old: 1, new: 2 },
        member_count: { old: 2, new: 0 },
        members_added: { new: 0 },
        members_removed: { new: 2 },
      }).ok,
    ).toBe(true);
    expect(
      build('registry_policy.members_replace', {
        kind: { new: 'allowlist' },
        revision: { old: 1, new: 2 },
        members_removed: { new: 1 },
      }).ok,
    ).toBe(true);
  });

  it('requires an override reason when an empty block gains its first member', () => {
    const first = {
      kind: { new: 'block' },
      revision: { old: 1, new: 2 },
      member_count: { old: 0, new: 1 },
      members_added: { new: 1 },
      members_removed: { new: 0 },
    };
    expect(build('registry_policy.members_replace', first)).toEqual({
      ok: false,
      reason: 'bad_value',
    });
    expect(
      build('registry_policy.members_replace', {
        ...first,
        override_reason: { new: 'false_positive' },
      }).ok,
    ).toBe(true);
    expect(
      build('registry_policy.members_replace', {
        ...first,
        member_count: { old: 1, new: 2 },
      }).ok,
    ).toBe(true);
  });

  it('refuses a member replacement that does not name the rule kind', () => {
    expect(
      build('registry_policy.members_replace', {
        revision: { old: 1, new: 2 },
        member_count: { old: 2, new: 1 },
        members_added: { new: 0 },
        members_removed: { new: 1 },
      }),
    ).toEqual({ ok: false, reason: 'bad_value' });
    expect(build('registry_policy.members_replace')).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each<[string, AuditEventInput['changes']]>([
    ['a free-text reason code', { reason_code: { new: 'looked suspicious' } }],
    ['a free-text override reason', { override_reason: { new: 'customer asked' } }],
    ['an unknown kind', { kind: { new: 'exception' } }],
    ['a range as client floor', { client_min_version: { new: '>=9.0.0' } }],
    ['a non-canonical package key', { package_key: { new: 'Left-Pad' } }],
    ['an incident URL', { incident_id: { new: 'https://tracker.example/1' } }],
    ['a negative age', { min_age_seconds: { new: -1 } }],
    ['an age above the cap', { min_age_seconds: { new: 315360001 } }],
    ['a fractional revision', { revision: { new: 1.5 } }],
    ['an oversized member count', { member_count: { new: 1001 } }],
    ['an unknown changed field', { changed_fields: { new: ['note'] } }],
    ['a non-boolean deny_unknown', { deny_unknown: { new: 'false' } }],
    ['a malformed expiry', { expires_at: { new: 'tomorrow' } }],
    ['a project id with spaces', { project_id: { new: 'project one' } }],
  ])('refuses %s', (_label, changes) => {
    expect(build('registry_policy.update', changes)).toEqual({ ok: false, reason: 'bad_value' });
  });

  it.each([
    ['note', 'free text'],
    ['email', 'admin@example.test'],
    ['token', 'pb_pat_0123456789abcdefghijklmnop'],
    ['members', '1.0.0'],
  ])('refuses the unregistered field %s', (field, value) => {
    expect(build('registry_policy.create', { [field]: { new: value } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('refuses a secret-shaped identifier and an oversized payload', () => {
    const secret = build('registry_policy.update', {
      project_id: { new: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' },
    });
    expect(secret.ok).toBe(false);
    const fields = Array.from({ length: 8 }, () => 'members');
    expect(build('registry_policy.update', { changed_fields: { new: fields } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });
});
