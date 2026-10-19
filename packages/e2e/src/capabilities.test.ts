import { describe, expect, it } from 'vitest';
import { capabilities, certify, layers, requiredScenarioIds } from './capabilities.js';
import type { CertificationResult, Layer } from './capabilities.js';

function passing(layer: Layer): CertificationResult[] {
  return requiredScenarioIds(layer).map((id) => ({ id, layer, status: 'PASS' }));
}

describe('section 4 capability catalogue', () => {
  it('contains all 68 design table rows once, preserving their groups and order', () => {
    expect(capabilities).toHaveLength(68);
    expect(new Set(capabilities.map(({ id }) => id)).size).toBe(68);
    expect(
      Object.fromEntries(
        [...new Set(capabilities.map(({ group }) => group))].map((group) => [
          group,
          capabilities.filter((entry) => entry.group === group).length,
        ]),
      ),
    ).toEqual({
      Artifact: 2,
      Install: 6,
      'Mirror and proxy': 5,
      Push: 1,
      Sources: 3,
      Webhooks: 1,
      Jobs: 2,
      Auth: 3,
      SSO: 3,
      'Re-auth': 2,
      Authorisation: 5,
      Tokens: 3,
      Integrity: 3,
      Retention: 1,
      Backup: 5,
      Upgrade: 3,
      UI: 3,
      'Browser security': 3,
      'Rate limiting': 1,
      Observability: 2,
      Audit: 1,
      'D1 limits': 4,
      'Workers CPU': 1,
      Availability: 4,
      'TLS and host': 1,
    });
    for (const entry of capabilities) {
      expect(entry.scenario.trim()).not.toBe('');
      const assigned = Object.values(entry.gate).flat();
      expect(entry.layers).toEqual(assigned);
      expect(new Set(assigned).size).toBe(assigned.length);
      expect(assigned.length).toBeGreaterThan(0);
      if (entry.gate.D) {
        expect(entry.deferral?.backlogId).toMatch(/^PB-\d+$/);
        expect(entry.deferral?.reason).toBeTruthy();
      }
    }
  });

  it('maps mixed merge, release and external evidence to their original layers', () => {
    expect(capabilities.find(({ id }) => id === 'composer-normalisation')?.gate).toEqual({
      M: ['U', 'L'],
      E: ['X'],
    });
    expect(capabilities.find(({ id }) => id === 'install-composer')?.gate).toEqual({
      M: ['L'],
      R: ['C', 'H'],
    });
    expect(capabilities.find(({ id }) => id === 'restore-revocation')?.scenario).toContain(
      'invalidate every restored session and PAT',
    );
  });

  it('keeps push and rate limiting deferred with their unblocking backlog ids', () => {
    for (const [id, backlogId] of [
      ['push-publish', 'PB-40'],
      ['rate-limiting', 'PB-94'],
    ]) {
      const entry = capabilities.find((entry) => entry.id === id);
      expect(Object.keys(entry?.gate ?? {})).toEqual(['D']);
      expect(entry?.deferral).toMatchObject({ backlogId, reason: 'not-implemented' });
    }
  });

  it('records every custom-hostname decision without claiming workers.dev Cache API or Access evidence', () => {
    const hostnameDeferred = capabilities.filter(
      (entry) => entry.deferral?.reason === 'needs-custom-hostname',
    );
    expect(hostnameDeferred.map(({ id }) => id)).toEqual([
      'sso-access-edge',
      'authz-cache-revocation',
    ]);
    expect(hostnameDeferred.map(({ gate }) => gate.D)).toEqual([['B', 'C', 'X'], ['C']]);
    expect(capabilities.filter((entry) => entry.hostnameMove).map(({ id }) => id)).toEqual([
      'authz-cache-revocation',
      'tls-host',
    ]);
    expect(requiredScenarioIds('H')).toContain('tls-host');
    expect(requiredScenarioIds('C')).not.toContain('tls-host');
    expect(requiredScenarioIds('C')).not.toContain('authz-cache-revocation');
  });
});

describe('certification', () => {
  it('requires the sized restore rehearsal at cut-over while preserving per-candidate restore checks', () => {
    const candidate = passing('R');
    expect(requiredScenarioIds('R')).not.toContain('restore-rehearsal');
    expect(requiredScenarioIds('R')).toContain('restore-d1');
    expect(requiredScenarioIds('R', { beforeCutover: true })).toContain('restore-rehearsal');
    expect(certify('R', candidate).passed).toBe(true);
    expect(certify('R', candidate, { beforeCutover: true }).passed).toBe(false);
    expect(
      certify('R', [...candidate, { id: 'restore-rehearsal', layer: 'R', status: 'PASS' }], {
        beforeCutover: true,
      }).passed,
    ).toBe(true);
    expect(
      certify('R', [...candidate, { id: 'restore-rehearsal', layer: 'R', status: 'NOT RUN' }], {
        beforeCutover: true,
      }).passed,
    ).toBe(false);
  });

  it.each(layers)('certifies complete PASS evidence for layer %s', (layer) => {
    expect(requiredScenarioIds(layer).length).toBeGreaterThan(0);
    expect(certify(layer, passing(layer))).toEqual({ passed: true, issues: [] });
  });

  it.each(layers)(
    'refuses each missing, NOT RUN or failed required scenario in layer %s',
    (layer) => {
      const results = passing(layer);
      for (const id of requiredScenarioIds(layer)) {
        expect(
          certify(
            layer,
            results.filter((result) => result.id !== id),
          ).passed,
        ).toBe(false);
        for (const status of ['NOT RUN', 'FAIL'] as const) {
          expect(
            certify(
              layer,
              results.map((result) => (result.id === id ? { ...result, status } : result)),
            ).passed,
          ).toBe(false);
        }
      }
      expect(certify(layer, []).passed).toBe(false);
    },
  );

  it('never certifies deferred evidence as PASS or skipped green', () => {
    for (const entry of capabilities) {
      for (const layer of entry.gate.D ?? []) {
        expect(
          certify(layer, [...passing(layer), { id: entry.id, layer, status: 'PASS' }]).passed,
        ).toBe(false);
        expect(
          certify(layer, [...passing(layer), { id: entry.id, layer, status: 'NOT RUN' }]).passed,
        ).toBe(false);
        expect(requiredScenarioIds(layer)).not.toContain(entry.id);
      }
    }
  });

  it('refuses unknown ids, unsupported layers, duplicate evidence and malformed statuses', () => {
    for (const result of [
      { id: 'invented-capability', layer: 'L', status: 'PASS' },
      { id: 'tls-host', layer: 'C', status: 'PASS' },
      { id: 'install-composer', layer: 'L', status: 'PASS' },
      { id: 'install-composer', layer: 'L', status: 'SKIP' },
    ]) {
      expect(certify('L', [...passing('L'), result as CertificationResult]).passed).toBe(false);
    }
    expect(certify('L', passing('H')).passed).toBe(false);
  });
});
