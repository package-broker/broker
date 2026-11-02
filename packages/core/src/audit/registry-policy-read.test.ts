import { describe, expect, it } from 'vitest';
import { auditEvent, type AuditEventInput } from './actions.js';

const ID = '01J0P000000000000000000000';
const RULE = '01J0P0000000000000000000RR';

function build(
  action: AuditEventInput['action'],
  changes: NonNullable<AuditEventInput['changes']>,
): ReturnType<typeof auditEvent> {
  return auditEvent({
    id: ID,
    now: '2026-11-01T00:00:00.000Z',
    action,
    actor: { type: 'user', id: 'user' },
    context: { opId: ID, requestId: ID, sourceIp: null, tokenSelector: null },
    target: { type: 'version', id: 'version-1' },
    projectId: 'project',
    changes,
  });
}

const denied = (reasons: string[]) => ({
  read_kind: { new: 'dist' },
  ecosystem: { new: 'npm' },
  package_key: { new: 'left-pad' },
  version_id: { new: 'version-1' },
  version_revision: { new: 2 },
  reasons: { new: reasons },
});

describe('policy read denial audit events', () => {
  it('accepts rule and plugin denials with fixed reasons', () => {
    expect(
      build(
        'policy.read_denied',
        denied([`rule:${RULE}:3:blocked`, 'plugin:acme-policy:restricted']),
      ).ok,
    ).toBe(true);
    for (const kind of ['version', 'tag', 'dist']) {
      expect(
        build('policy.read_denied', {
          ...denied([`rule:${RULE}:1:min_age`]),
          read_kind: { new: kind },
        }).ok,
      ).toBe(true);
    }
  });

  it('bounds a chunk at 32 reasons', () => {
    const reasons = Array.from(
      { length: 33 },
      (_, index) => `rule:01J0P00000000000000000RR${String(index).padStart(2, '0')}:1:blocked`,
    );
    expect(build('policy.read_denied', denied(reasons.slice(0, 32))).ok).toBe(true);
    expect(build('policy.read_denied', denied(reasons))).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it.each([
    ['an unknown rule reason', `rule:${RULE}:1:looked_bad`],
    ['a free-text plugin reason', 'plugin:acme:not on my watch'],
    ['a raw user agent', 'npm/10.2.0 node/v20.0.0 darwin arm64'],
    ['a header value', 'authorization: Bearer abc'],
    ['a rule without revision', `rule:${RULE}:blocked`],
    ['a malformed rule id', 'rule:rule-1:1:blocked'],
  ])('refuses %s', (_label, reason) => {
    expect(build('policy.read_denied', denied([reason]))).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('refuses duplicate or empty reasons and client or header fields', () => {
    expect(build('policy.read_denied', denied([]))).toEqual({ ok: false, reason: 'bad_value' });
    expect(
      build('policy.read_denied', denied([`rule:${RULE}:1:blocked`, `rule:${RULE}:1:blocked`])),
    ).toEqual({
      ok: false,
      reason: 'bad_value',
    });
    for (const field of ['user_agent', 'client', 'headers', 'query']) {
      expect(build('policy.read_denied', { [field]: { new: 'npm/10' } })).toEqual({
        ok: false,
        reason: 'unknown_field',
      });
    }
    expect(build('policy.read_denied', { read_kind: { new: 'search' } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('accepts a bounded management inspection event', () => {
    expect(
      build('policy.inspect', {
        scope: { new: 'project' },
        ecosystem: { new: 'composer' },
        package_key: { new: 'vendor/package' },
        result_count: { new: 12 },
      }).ok,
    ).toBe(true);
    expect(build('policy.inspect', { result_count: { new: 10_001 } })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
    expect(build('policy.inspect', { manifest: { new: '{}' } })).toEqual({
      ok: false,
      reason: 'unknown_field',
    });
  });
});
