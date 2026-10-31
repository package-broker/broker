import { describe, expect, it, vi } from 'vitest';
import type { AuditJournalItemV1, AuditTrailContext } from '@package-broker/core/plugin';
import { auditRoutes } from '@package-broker/core/api/routes/audit';
import { orgContext } from '@package-broker/core/db/port';
import { auditTrail } from './index.js';

const event: AuditJournalItemV1 = {
  kind: 'event',
  chainId: 'chain',
  epoch: 1,
  id: 'event',
  orgId: 'org-a',
  seq: 7,
  prevHash: '0'.repeat(64),
  hash: 'a'.repeat(64),
  createdAt: '2026-10-31T00:00:00Z',
  actorType: 'system',
  actorId: null,
  tokenSelector: null,
  action: 'project.update',
  targetType: 'project',
  targetId: 'project-a',
  projectId: 'project-a',
  payloadJson: '{"op_id":"operation"}',
};

function fixture(active = true, items: readonly AuditJournalItemV1[] = [event]) {
  const ctx: AuditTrailContext = {
    active,
    journal: {
      list: vi.fn(async () => ({ items, next: 7 })),
      head: vi.fn(async () => ({
        chainId: 'chain',
        epoch: 1,
        headSeq: 7,
        headHash: 'a'.repeat(64),
        boundarySeq: 1,
        boundaryPrevHash: '0'.repeat(64),
        pendingCount: 2,
        verification: {
          fromSeq: 1,
          throughSeq: 7,
          bodies: 7,
          withheld: 0,
          verifiedAt: '2026-10-31T00:00:00Z',
        },
      })),
    },
    requestVerification: vi.fn(async () => undefined),
  };
  return { ctx, trail: auditTrail().auditTrail.create(ctx) };
}

describe('audit trail', () => {
  it('declares activation before the factory runs', () => {
    expect(auditTrail()).toMatchObject({
      apiVersion: 4,
      binds: ['audit-trail'],
      auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL' },
    });
  });

  it.each(['listAudit', 'listProjectAudit'] as const)(
    'maps %s to the bound journal',
    async (operation) => {
      const { ctx, trail } = fixture();
      const result = await trail.handle(operation, {
        query: { actor: 'actor', action: 'project.update', after: '3', limit: '10' },
        projectId: 'project-a',
      });
      expect(ctx.journal.list).toHaveBeenCalledWith({
        projectId: 'project-a',
        actor: 'actor',
        action: 'project.update',
        afterSeq: 3,
        limit: 10,
      });
      expect(result).toEqual({
        items: [
          {
            id: 'event',
            seq: 7,
            action: 'project.update',
            actor: { type: 'system', id: null },
            targetType: 'project',
            targetId: 'project-a',
            projectId: 'project-a',
            createdAt: event.createdAt,
            payload: { op_id: 'operation' },
          },
        ],
        next: '7',
      });
      expect(ctx.requestVerification).not.toHaveBeenCalled();
    },
  );

  it('reads the head and its actual verification timestamp', async () => {
    const { ctx, trail } = fixture();
    expect(await trail.handle('auditHead', { query: undefined, projectId: null })).toEqual({
      seq: 7,
      hash: 'a'.repeat(64),
      pendingCount: 2,
      lastVerifiedAt: '2026-10-31T00:00:00Z',
    });
    expect(ctx.journal.head).toHaveBeenCalledOnce();
    expect(ctx.requestVerification).not.toHaveBeenCalled();
  });

  it('does not report an empty verification range as verified', async () => {
    const { ctx, trail } = fixture();
    const head = await ctx.journal.head();
    vi.mocked(ctx.journal.head).mockResolvedValue({
      ...head,
      verification: {
        fromSeq: 1,
        throughSeq: 0,
        bodies: 0,
        withheld: 0,
        verifiedAt: '2026-10-31T00:00:00Z',
      },
    });
    expect(await trail.handle('auditHead', { query: undefined, projectId: null })).toMatchObject({
      lastVerifiedAt: null,
    });
    expect(ctx.requestVerification).not.toHaveBeenCalled();
  });

  it('preserves an unreadable withheld position and an exhausted cursor', async () => {
    const { ctx, trail } = fixture(true, [
      {
        kind: 'withheld',
        markerId: 'marker',
        reasonCode: 'unreadable',
        chainId: 'chain',
        epoch: 1,
        orgId: 'org-a',
        seq: 7,
        prevHash: '0'.repeat(64),
        hash: 'a'.repeat(64),
      },
    ]);
    const page = await ctx.journal.list({ projectId: null, limit: 50 });
    vi.mocked(ctx.journal.list).mockResolvedValue({ ...page, next: null });
    expect(await trail.handle('listAudit', { query: {}, projectId: null })).toEqual({
      items: [
        {
          id: 'marker',
          seq: 7,
          kind: 'withheld',
          reason: 'unreadable',
        },
      ],
      next: null,
    });
  });

  it.each(['listAudit', 'auditHead', 'listProjectAudit'] as const)(
    'refuses inactive %s without reading',
    async (operation) => {
      const { ctx, trail } = fixture(false);
      const result =
        operation === 'auditHead'
          ? await trail.handle(operation, { query: undefined, projectId: null })
          : await trail.handle(operation, { query: {}, projectId: 'project-a' });
      expect(result).toEqual({ error: 'audit_trail_unavailable' });
      expect(ctx.journal.list).not.toHaveBeenCalled();
      expect(ctx.journal.head).not.toHaveBeenCalled();
      expect(ctx.requestVerification).not.toHaveBeenCalled();
    },
  );

  it('pages past a withheld item without exposing its payload', async () => {
    const metadata = { ...event };
    expect(metadata.kind).toBe('event');
    const { trail } = fixture(true, [
      { ...metadata, kind: 'withheld', markerId: 'marker', reasonCode: 'sanitizer_mismatch' },
    ]);
    const result = await trail.handle('listAudit', { query: {}, projectId: null });
    expect(result).toMatchObject({
      items: [{ kind: 'withheld', id: 'event', seq: 7, reason: 'content' }],
      next: '7',
    });
    expect(JSON.stringify(result)).not.toContain('operation');
  });

  it.each([{ after: 'invalid' }, { after: '-1' }, { after: '9007199254740992' }])(
    'refuses invalid paging %j',
    async (query) => {
      const { ctx, trail } = fixture();
      expect(await trail.handle('listAudit', { query, projectId: null })).toEqual({
        error: 'invalid_request',
        details: [{ path: '/query/after', code: 'invalid' }],
      });
      expect(ctx.journal.list).not.toHaveBeenCalled();
    },
  );

  it('keeps a context for organization A bound while organization B is read', async () => {
    const { ctx } = fixture();
    const read = vi.fn(async (org: ReturnType<typeof orgContext>) => ({
      items: [{ ...event, orgId: org.orgId }],
      next: null,
    }));
    const services = {
      journal: {
        list: read,
        head: vi.fn(async () => ctx.journal.head()),
      },
      requestVerification: vi.fn(async () => undefined),
    };
    const routes = auditRoutes({
      trail: { definition: auditTrail().auditTrail },
      effective: async () => ({ policy: 'availability', trailActive: true }),
      services,
      log: vi.fn(),
    });
    const request = (orgId: string, projectId: string | null = null) => {
      const route = routes[projectId === null ? 0 : 2]!;
      return route.handler({
        org: orgContext(orgId),
        projectId,
        principal: null,
        ports: {
          organizations: { get: async () => null },
          clock: { now: () => new Date('2026-10-31T00:00:00Z') },
          ids: { ulid: () => 'event' },
        },
        request: new Request('https://broker.test' + route.path.replace(':project', 'demo')),
        requestId: 'request',
        params: { project: 'demo' },
      });
    };
    const responses = await Promise.all([
      request('org-a'),
      request('org-b'),
      request('org-a', 'project-a'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(read.mock.calls.map(([org]) => org)).toEqual([
      orgContext('org-a'),
      orgContext('org-b'),
      orgContext('org-a'),
    ]);
  });
});

it.each([
  'null',
  '[]',
  '42',
  '"text"',
  '{"extra":"secret"}',
  '{',
  JSON.stringify({ op_id: 'é'.repeat(4096) }),
])('guards payload %s', async (payloadJson) => {
  const { trail } = fixture(true, [{ ...event, payloadJson }]);
  expect(await trail.handle('listAudit', { query: {}, projectId: null })).toMatchObject({
    items: [{ payload: {} }],
  });
});
it.each([
  ['0', 'too_small'],
  ['201', 'too_big'],
] as const)('includes limit details for %s', async (limit, code) => {
  const { trail } = fixture();
  expect(await trail.handle('listAudit', { query: { limit }, projectId: null })).toEqual({
    error: 'invalid_request',
    details: [{ path: '/query/limit', code }],
  });
});
it('keeps content withheld in project listings', async () => {
  const { trail } = fixture(true, [
    { ...event, kind: 'withheld', markerId: 'marker', reasonCode: 'content_unavailable' },
  ]);
  expect(await trail.handle('listProjectAudit', { query: {}, projectId: 'project-a' })).toEqual({
    items: [{ kind: 'withheld', id: 'event', seq: 7, reason: 'content' }],
    next: '7',
  });
});
