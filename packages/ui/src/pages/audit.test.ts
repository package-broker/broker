import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { AuditView, auditHash, readAuditHash, loadAudit, type AuditFilters } from './audit.js';

const filters: AuditFilters = {
  actor: 'user-1',
  action: 'source.update',
  project: 'web',
  limit: '25',
  after: 'cursor+/',
};
const head = { seq: 42, hash: 'abc', pendingCount: 3, lastVerifiedAt: null };
const item = {
  id: 'event',
  seq: 42,
  action: '<img src=x onerror=alert(1)>',
  actor: { type: 'user', id: 'user-1' },
  createdAt: '2026-10-22T10:00:00Z',
  targetType: 'source',
  targetId: 'source-1',
  projectId: 'web',
  payload: {},
  source_ip: 'private-source-ip',
};
function markup(overrides: Partial<Parameters<typeof AuditView>[0]> = {}) {
  return renderToString(
    createElement(AuditView, {
      filters,
      scope: null,
      data: { items: [item], next: 'next' },
      head,
      error: null,
      loading: false,
      onNavigate: () => undefined,
      ...overrides,
    }),
  );
}

describe('audit', () => {
  it('shows the chain head and positive pending count', () => {
    expect(markup()).toContain('Head 42');
    expect(markup()).toContain('3 pending');
  });
  it('omits pending text at zero', () => {
    expect(markup({ head: { ...head, pendingCount: 0 } })).not.toContain('pending');
  });
  it('never invents a verification time for null', () => {
    const html = markup();
    expect(html).toContain('never verified');
    expect(html).not.toContain('Last verified');
  });
  it('shows the supplied verification time', () => {
    expect(markup({ head: { ...head, lastVerifiedAt: '2026-10-21T12:34:00Z' } })).toContain(
      '2026-10-21T12:34:00Z',
    );
  });
  it('round-trips organization filters and cursor in the hash', () => {
    expect(readAuditHash(auditHash(filters, null))).toEqual({ filters, scope: null });
  });
  it('round-trips project scope separately from the organization project filter', () => {
    expect(readAuditHash(auditHash({ ...filters, project: '' }, 'web'))).toEqual({
      filters: { ...filters, project: '' },
      scope: 'web',
    });
  });
  it('escapes hostile actions in rows and filter inputs', () => {
    const html = markup({ filters: { ...filters, action: item.action } });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
  it('does not render source_ip or payload from a hostile response', () => {
    const html = markup();
    expect(html).toContain('source-1');
    expect(html).not.toContain('source_ip');
    expect(html).not.toContain('private-source-ip');
  });
  it('renders events alongside both withheld reasons without inventing event fields', () => {
    const html = markup({
      data: {
        items: [
          item,
          { kind: 'withheld', id: 'withheld-content', seq: 43, reason: 'content' },
          { kind: 'withheld', id: 'withheld-unreadable', seq: 44, reason: 'unreadable' },
        ],
        next: null,
      },
    });
    const rows = html.match(/<tbody[^>]*>(.*?)<\/tbody>/s)![1]!.match(/<tr\b.*?<\/tr>/gs)!;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rows[0]).toContain('2026-10-22T10:00:00Z');
    expect(rows[0]).toContain('user-1');
    expect(rows[0]).toContain('source-1');
    for (const [index, seq, reason] of [
      [1, 43, 'Content withheld: the stored record differs from its safe form'],
      [2, 44, 'Record unreadable'],
    ] as const) {
      const cells = rows[index]!.match(/<td\b.*?<\/td>/gs)!;
      expect(cells).toHaveLength(7);
      expect(cells[0]).toContain(`${seq}<span class="block">${reason}</span>`);
      for (const cell of cells.slice(1)) {
        expect(cell).toMatch(/<div class="cell-value"><\/div><\/td>$/);
      }
      expect(rows[index]).not.toContain('withheld-');
    }
  });
  it('uses the organization list filters and chain-head client routes', async () => {
    const fetch = vi.fn<(_: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ items: [], next: null }),
    );
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    await loadAudit(client, filters, null);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/_pb/audit?actor=user-1&action=source.update&project=web&limit=25&after=cursor%2B%2F',
      '/_pb/audit/head',
    ]);
  });
  it('uses the project route without an organization project filter', async () => {
    const fetch = vi.fn<(_: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ items: [], next: null }),
    );
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    await loadAudit(client, filters, 'web');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
    );
  });
  it('does not invent a head when access is denied', () => {
    const html = markup({ head: null, error: 'Unable to load the chain head.' });
    expect(html).toContain('Unable to load the chain head.');
    expect(html).not.toContain('Head 0');
    expect(html).not.toContain('never verified');
  });
});
