import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '../../db/registry-policy.js';
import { evaluateClientFloor } from './client-floor.js';
import type { ClientHints } from './types.js';

const NOW = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-02T00:00:00.000Z';
const UNKNOWN: ClientHints = { family: 'unknown', version: null };

function floor(id: string, overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id,
    projectId: null,
    ecosystem: 'npm',
    packageKey: null,
    kind: 'client_floor',
    minAgeSeconds: null,
    clientFamily: 'npm',
    clientMinVersion: '10.0.0',
    denyUnknown: false,
    reasonCode: 'compatibility',
    incidentId: null,
    expiresAt: null,
    revision: 2,
    members: [],
    ...overrides,
  };
}

const ids = (rules: readonly PolicyRule[], client: ClientHints, now = NOW) =>
  evaluateClientFloor(rules, client, now).denials.map((d) => `${d.ruleId}:${d.reason}`);

describe('evaluateClientFloor', () => {
  it('passes every client when no floor is configured', () => {
    expect(evaluateClientFloor([], UNKNOWN, NOW)).toEqual({ denials: [], nextBoundary: null });
    expect(ids([], { family: 'npm', version: '1.0.0' })).toEqual([]);
  });

  it('passes an unknown client by default and denies it when any applicable rule sets denyUnknown', () => {
    expect(ids([floor('F1'), floor('F2', { clientFamily: 'pnpm' })], UNKNOWN)).toEqual([]);
    expect(
      ids([floor('F1'), floor('F2', { clientFamily: 'pnpm', denyUnknown: true })], UNKNOWN),
    ).toEqual(['F2:client_unsupported']);
  });

  it('treats a known family without a version as unknown', () => {
    expect(ids([floor('F1', { denyUnknown: true })], { family: 'npm', version: null })).toEqual([
      'F1:client_unsupported',
    ]);
  });

  it('passes a known family that has no floor of its own', () => {
    expect(ids([floor('F1', { denyUnknown: true })], { family: 'yarn', version: '1.0.0' })).toEqual(
      [],
    );
  });

  it('denies a known version below its floor and admits at and above it', () => {
    const rules = [floor('F1', { clientMinVersion: '10.2.0' })];
    expect(ids(rules, { family: 'npm', version: '10.1.9' })).toEqual(['F1:client_floor']);
    expect(ids(rules, { family: 'npm', version: '9.99.99' })).toEqual(['F1:client_floor']);
    expect(ids(rules, { family: 'npm', version: '10.2.0' })).toEqual([]);
    expect(ids(rules, { family: 'npm', version: '11.0.0' })).toEqual([]);
  });

  it('applies every floor of the family, organization and project alike', () => {
    const rules = [
      floor('ORG', { clientMinVersion: '9.0.0' }),
      floor('PRJ', { projectId: 'P', clientMinVersion: '10.5.0' }),
    ];
    expect(ids(rules, { family: 'npm', version: '10.0.0' })).toEqual(['PRJ:client_floor']);
    expect(ids(rules, { family: 'npm', version: '8.0.0' })).toEqual([
      'ORG:client_floor',
      'PRJ:client_floor',
    ]);
  });

  it('expired floors have no effect and an expiry bounds a denial', () => {
    const rules = [floor('F1', { expiresAt: LATER, denyUnknown: true })];
    expect(evaluateClientFloor(rules, UNKNOWN, NOW)).toEqual({
      denials: [{ ruleId: 'F1', ruleRevision: 2, reason: 'client_unsupported' }],
      nextBoundary: LATER,
    });
    expect(ids(rules, UNKNOWN, LATER)).toEqual([]);
    expect(ids(rules, { family: 'npm', version: '1.0.0' }, LATER)).toEqual([]);
  });

  it('ignores rules of other kinds', () => {
    const block = floor('B', {
      kind: 'block',
      clientFamily: null,
      clientMinVersion: null,
      denyUnknown: true,
      packageKey: 'left-pad',
    });
    expect(ids([block], UNKNOWN)).toEqual([]);
  });
});
