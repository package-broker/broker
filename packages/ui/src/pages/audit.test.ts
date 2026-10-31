import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import {
  AuditView,
  auditHash,
  readAuditHash,
  loadAudit,
  loadAuditNames,
  type AuditFilters,
  type AuditStatus,
} from './audit.js';

const filters: AuditFilters = {
  actor: 'user-1',
  action: 'source.update',
  project: 'web',
  limit: '25',
  after: 'cursor+/',
};
const head = { seq: 42, hash: 'abc', pendingCount: 3, lastVerifiedAt: null, verification: null };
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
  return renderToStaticMarkup(
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

const status: AuditStatus = {
  chainId: 'chain',
  epoch: 2,
  headSeq: 42,
  headHash: 'hash',
  boundarySeq: 10,
  boundaryPrevHash: 'hash',
  pendingCount: 0,
  verification: null,
  policy: 'availability',
  policySource: 'build',
  mode: 'trail',
  modeSource: 'stored',
  trailActive: true,
  capacity: { state: 'ok', journalRows: 30, journalBytes: 300, maxJournalBytes: 1000 },
  restorePending: false,
  sinks: [],
  ledger: [],
  health: { status: 'ok', codes: [] },
};
function auditClient(
  options: {
    trail?: boolean;
    organization?: boolean;
    failure?: string;
    failureStatus?: number;
    network?: boolean;
    items?: (typeof item)[];
  } = {},
) {
  const fetch = vi.fn<(_: string, init: RequestInit) => Promise<Response>>(async (url) => {
    if (options.network) throw new Error('private-network-detail');
    if (url === options.failure)
      return Response.json(
        { error: { code: 'forbidden' } },
        { status: options.failureStatus ?? 403 },
      );
    return Response.json(
      url === '/_pb/me'
        ? { features: { auditTrail: options.trail ?? true } }
        : url === '/_pb/me/permissions'
          ? { organization: options.organization === false ? [] : ['org:audit:read'] }
          : url === '/_pb/audit/status'
            ? status
            : url === '/_pb/audit/head'
              ? head
              : { items: options.items ?? [], next: null },
    );
  });
  return { fetch, client: createApiClient<paths>({ fetch, readCookie: () => undefined }) };
}

describe('audit', () => {
  it.each([
    ['none', 'Not activated because no destination is configured'],
    ['PB_AUDIT_WEBHOOK_URL', 'Activated by environment variable PB_AUDIT_WEBHOOK_URL'],
  ])('explains activation source %s', (activationSource, copy) => {
    const html = markup({
      status: {
        ...status,
        sinks: [
          {
            id: 'sink',
            state: 'inactive',
            progressSeq: 0,
            custodySeq: 0,
            durableAck: false,
            activationSource,
          },
        ],
      },
    });
    expect(html).toContain(copy);
  });
  it('explains a retained range with no checkable event bodies', () => {
    const html = markup({
      head: {
        ...head,
        verification: {
          fromSeq: 30,
          throughSeq: 40,
          bodies: 0,
          withheld: 11,
          verifiedAt: '2026-10-21T12:34:00Z',
        },
      },
    });
    expect(html).toContain(
      'Range 30–40 was checked, but every event body was withheld; no content was verified.',
    );
    expect(html).not.toContain('Verified retained range');
    expect(html).not.toContain('event bodies checked');
    expect(html).not.toContain('withheld bodies');
    expect(html).toContain(
      '<section class="space-y-2" aria-labelledby="audit-verification-heading">',
    );
    expect(html).toContain('<h2 id="audit-verification-heading"');
  });
  it('announces only the most severe status notice as an alert', () => {
    const html = markup({
      status: {
        ...status,
        capacity: { ...status.capacity, state: 'refusing' },
        restorePending: true,
        health: { status: 'degraded', codes: [] },
        ledger: [{ kind: 'gap', count: 1 }],
      },
    });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain('role="alert">Audit capacity is full.');
    expect(html).not.toContain('<span role="status"></span>');
  });
  it('uses project names already available to the shell', () => {
    const html = markup({ projects: [{ id: 'web', name: 'Storefront' }] });
    const projectCell = html.match(
      /<tbody[^>]*>.*?<tr.*?<td.*?<td.*?<td.*?<td.*?(<td.*?<\/td>)/s,
    )![1]!;
    expect(projectCell).toContain('Storefront');
    expect(projectCell).not.toContain('Name unavailable');
  });
  it('keeps one alert when a load error accompanies multiple status notices', () => {
    const html = markup({
      error: 'Audit verification could not be loaded. Try again.',
      status: {
        ...status,
        capacity: { ...status.capacity, state: 'refusing' },
        restorePending: true,
      },
    });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain('role="status">Audit capacity is full.');
    expect(html).toContain('Try again</button>');
  });
  it.each([
    ['/_pb/audit/head', 'Audit verification could not be loaded. Try again.'],
    ['/_pb/audit/status', 'Audit status could not be loaded. Try again.'],
    [
      '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
      'Audit events could not be loaded. Try again.',
    ],
  ])('offers recovery when %s fails', async (failure, copy) => {
    const { client } = auditClient({ failure, failureStatus: 500 });
    const result = await loadAudit(client, filters, 'web', { auditTrail: true }, true);
    expect(result.error).toBe(copy);
    expect(markup(result)).toContain('Try again</button>');
  });
  it('does not request /me again when using shell features', async () => {
    const { client, fetch } = auditClient();
    await loadAudit(client, filters, 'web', { auditTrail: true }, true);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/me');
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/me/permissions');
  });
  it.each([null, true])(
    'keeps failed shell capabilities recoverable with authority %s',
    async (authority) => {
      const { client } = auditClient();
      const result = await loadAudit(
        client,
        filters,
        'web',
        authority === null ? { auditTrail: true } : null,
        authority,
      );
      expect(result.error).toBe('Audit capabilities could not be loaded. Try again.');
    },
  );

  it('shows the chain head and positive pending count', () => {
    expect(markup()).toContain('Latest event 42');
    expect(markup()).toContain('3 events not yet sealed');
  });
  it('uses singular for one unsealed event', () => {
    expect(markup({ head: { ...head, pendingCount: 1 } })).toContain('1 event not yet sealed');
  });
  it('omits pending text at zero', () => {
    expect(markup({ head: { ...head, pendingCount: 0 } })).not.toContain('pending');
  });
  it('never invents a verification time for null', () => {
    const html = markup();
    expect(html).toContain('No verified retained range is available.');
    expect(html).not.toContain('Last verified');
  });
  it('shows the supplied verification time', () => {
    expect(
      markup({
        head: {
          ...head,
          lastVerifiedAt: '2026-10-21T12:34:00Z',
          verification: {
            fromSeq: 10,
            throughSeq: 40,
            bodies: 29,
            withheld: 2,
            verifiedAt: '2026-10-21T12:34:00Z',
          },
        },
      }),
    ).toContain('2026-10-21T12:34:00Z');
  });
  it('shows only the verified suffix and withheld scope', () => {
    const html = markup({
      head: {
        ...head,
        verification: {
          fromSeq: 30,
          throughSeq: 40,
          bodies: 9,
          withheld: 2,
          verifiedAt: '2026-10-21T12:34:00Z',
        },
      },
    });
    expect(html).toContain('Verified retained range: 30');
    expect(html).toContain('40');
    expect(html).toContain('9');
    expect(html).toContain('withheld bodies');
    expect(html).toContain('does not prove complete historical delivery');
  });
  it.each([
    null,
    { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0, verifiedAt: '2026-10-21T12:34:00Z' },
  ])('does not treat an empty scope as verified despite a legacy timestamp', (verification) => {
    const html = markup({
      head: { ...head, lastVerifiedAt: '2026-10-21T12:34:00Z', verification },
    });
    expect(html).toContain('No verified retained range');
    expect(html).not.toContain('Verified retained range:');
    expect(html).not.toContain('2026-10-21');
  });
  it.each([
    ['export', 'Events are sent to configured destinations.'],
    ['none', 'No durable audit history is being kept.'],
    ['trail', 'Local audit trail'],
  ] as const)('explains effective %s mode', (mode, copy) => {
    expect(markup({ status: { ...status, mode } })).toContain(copy);
  });
  it('explains pending mode, required policy, restore and delivery health', () => {
    const html = markup({
      status: {
        ...status,
        pendingMode: 'export',
        policy: 'required',
        restorePending: true,
        health: { status: 'degraded', codes: [] },
      },
    });
    for (const copy of [
      'Pending mode: Export only',
      'until the transition completes',
      'Required audit policy',
      'Restore review is pending',
      'Audit delivery needs attention',
    ])
      expect(html).toContain(copy);
  });
  it.each([
    ['warning', 'Audit capacity is under pressure'],
    ['refusing', 'Ordinary changes are refused'],
  ] as const)('explains capacity %s', (state, copy) => {
    expect(markup({ status: { ...status, capacity: { ...status.capacity, state } } })).toContain(
      copy,
    );
  });
  it('shows current-generation incident counts and loss consequences without raw enums', () => {
    const html = markup({
      status: {
        ...status,
        ledger: [
          { kind: 'gap', count: 3 },
          { kind: 'chain_reset', count: 2 },
        ],
      },
    });
    expect(html).toContain('current journal generation');
    expect(html).toContain('Missing event ranges');
    expect(html).toContain('Chain integrity recoveries');
    expect(html).toContain('including possible capacity loss');
    expect(html).not.toContain('chain_reset');
    expect(markup({ status })).toContain('No incidents or changes recorded');
  });
  it.each(['active', 'inactive', 'blocked', 'disabled', 'retired'] as const)(
    'explains %s destinations and activation source',
    (state) => {
      const html = markup({
        status: {
          ...status,
          sinks: [
            {
              id: 'hidden-sink-id',
              state,
              progressSeq: 40,
              custodySeq: 39,
              durableAck: true,
              activationSource: 'PB_AUDIT_WEBHOOK_URL',
            },
          ],
        },
      });
      expect(html).toContain('Destination 1:');
      expect(html).toContain('Activated by environment variable PB_AUDIT_WEBHOOK_URL');
      expect(html).toContain('Pruning requires a durable-storage acknowledgement');
      expect(html).not.toContain('hidden-sink-id');
    },
  );
  it('distinguishes loading, empty and filtered-empty states', () => {
    expect(markup({ data: null, loading: true })).toContain('Loading audit events');
    expect(
      markup({
        filters: { actor: '', action: '', project: '', limit: '50', after: '' },
        data: { items: [], next: null },
      }),
    ).toContain(
      'No audit events yet. Create a project or change its settings, then return to see the recorded events.',
    );
    expect(markup({ data: { items: [], next: null } })).toContain(
      'No audit events match these filters',
    );
  });
  it.each(['/_pb/audit/head', '/_pb/audit/status'])(
    'shows project events without requesting organization details when %s would deny access',
    async (failure) => {
      const { client, fetch } = auditClient({ organization: false, failure, items: [item] });
      const result = await loadAudit(client, filters, 'web', { auditTrail: true }, false);
      expect(result.explanation?.summary).toBe(
        'Reading this project’s events requires project audit access. Verification and capacity details are available to organization auditors.',
      );
      expect(result.data).toEqual({ items: [item], next: null });
      expect(result.head).toBeNull();
      expect(result.status).toBeNull();
      expect(result.error).toBeNull();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
      ]);
      const html = markup({ ...result, scope: 'web' });
      expect(html).toContain(
        'Verification and capacity details are available to organization auditors.',
      );
      expect(html).toContain('Copy ID: A user');
      expect(html).not.toContain('Latest event 42');
      expect(html).not.toContain('Organization audit status');
      expect(html).not.toContain('No verified retained range');
      expect(html).not.toContain('Try again');
      expect(html).not.toContain('Unable to load');
    },
  );
  it('asks project auditors to select a project at organization scope', async () => {
    const { client, fetch } = auditClient({ organization: false });
    const result = await loadAudit(client, filters, null, { auditTrail: true }, false);
    expect(result.explanation?.summary).toContain(
      'Organization audit access is required here. If you have project audit access, select that project.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a denied project list visible as an access error for project-only auditors', async () => {
    const { client, fetch } = auditClient({
      organization: false,
      failure:
        '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
    });
    const result = await loadAudit(client, filters, 'web', { auditTrail: true }, false);
    expect(result.data).toBeNull();
    expect(result.error).toBe(
      'Audit events are unavailable for this scope. Audit permission and an active trail are required.',
    );
    expect(result.explanation?.summary).toBe(
      'You do not have access to audit events for this scope. Ask an organization administrator for audit access.',
    );
    expect(result.explanation?.summary).not.toContain('You can read');
    expect(markup({ ...result, scope: 'web' })).toContain('Try again');
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/audit/head');
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/audit/status');
  });
  it.each([true, false])(
    'explains inactive trail for organization access %s without fetching history',
    async (organization) => {
      const { client, fetch } = auditClient({ trail: false, organization });
      const result = await loadAudit(client, filters, 'web', { auditTrail: false }, organization);
      expect(result.trailInactive).toBe(true);
      expect(result.explanation?.summary).toContain('trail is inactive');
      const html = markup({ ...result, scope: 'web' });
      if (organization) {
        expect(result.explanation?.details).toContain('You can read organization');
        expect(html).toContain('<details><summary>Audit access details</summary>');
      } else {
        expect(result.explanation?.details).toBeNull();
        expect(html).toContain('requires project audit access.');
        expect(html).not.toContain('<summary>Audit access details</summary>');
      }
      expect(result.status).toEqual(organization ? status : null);
      expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/audit/head');
    },
  );
  it.each([
    '/_pb/audit/status',
    '/_pb/audit/head',
    '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
  ])('keeps a recoverable error for denied %s', async (failure) => {
    const { client } = auditClient({ failure });
    const result = await loadAudit(client, filters, 'web', { auditTrail: true }, true);
    expect(result.error).not.toBeNull();
    expect(markup(result)).toContain('Try again');
    if (failure.includes('projects/web')) expect(result.data).toBeNull();
  });
  it('handles network failures without echoing diagnostics', async () => {
    const { client } = auditClient({ network: true });
    const result = await loadAudit(client, filters, 'web', { auditTrail: true }, true);
    expect(result.error).toBe('Audit events could not be loaded. Try again.');
    expect(markup(result)).not.toContain('private-network-detail');
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
    expect(html).toContain('Copy ID: A source');
    expect(html).not.toContain('source-1');
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
    expect(rows[0]).toContain('Copy ID: A user');
    expect(rows[0]).toContain('Copy ID: A source');
    expect(rows[0]).toContain('A user');
    expect(rows[0]).toContain('A source');
    expect(rows[0]).not.toContain('Name unavailable');
    expect(rows[0]).toContain('Person');
    expect(rows[0]).not.toContain('user-1');
    expect(rows[0]).not.toContain('source-1');
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
    const fetch = vi.fn<(_: string, init: RequestInit) => Promise<Response>>(async (url) =>
      Response.json(
        url === '/_pb/me'
          ? { features: { auditTrail: true } }
          : url === '/_pb/me/permissions'
            ? { organization: ['org:audit:read'] }
            : { items: [], next: null },
      ),
    );
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    await loadAudit(client, filters, null, { auditTrail: true }, true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/_pb/audit/status',
      '/_pb/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F&project=web',
      '/_pb/audit/head',
    ]);
  });
  it('uses the project route without an organization project filter', async () => {
    const fetch = vi.fn<(_: string, init: RequestInit) => Promise<Response>>(async (url) =>
      Response.json(
        url === '/_pb/me'
          ? { features: { auditTrail: true } }
          : url === '/_pb/me/permissions'
            ? { organization: ['org:audit:read'] }
            : { items: [], next: null },
      ),
    );
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    await loadAudit(client, filters, 'web', { auditTrail: true }, true);
    expect(fetch.mock.calls.map(([url]) => url)).toContain(
      '/_pb/projects/web/audit?actor=user-1&action=source.update&limit=25&after=cursor%2B%2F',
    );
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/audit/head');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/audit/status');
  });
  it('does not invent a head when access is denied', () => {
    const html = markup({
      head: null,
      error: 'Audit verification could not be loaded. Try again.',
    });
    expect(html).toContain('Audit verification could not be loaded. Try again.');
    expect(html).not.toContain('Head 0');
    expect(html).not.toContain('never verified');
  });
});

describe('audit names and compact controls', () => {
  it('uses allowed user, token and project names for the matching reference type', () => {
    const html = markup({
      names: { users: { 'user-1': 'Alex' }, tokens: { 'token-1': 'Laptop' } },
      projects: [{ id: 'web', name: 'Storefront' }],
      data: {
        items: [
          { ...item, targetType: 'token', targetId: 'token-1' },
          { ...item, seq: 43, targetType: 'user', targetId: 'user-1' },
          { ...item, seq: 44, targetType: 'project', targetId: 'web' },
          { ...item, seq: 45, targetType: 'token', targetId: 'missing' },
        ],
        next: null,
      },
    });
    expect(html).toContain('Alex');
    expect(html).toContain('Laptop');
    expect(html).toContain('Storefront');
    expect(html).toContain('A token');
    expect(html).not.toContain('Name unavailable');
    const button = html.match(/<button[^>]*aria-label="Copy ID: Alex"[^>]*>.*?<\/button>/s)![0];
    expect(button).toContain('data-variant="ghost"');
    expect(button).toContain('<svg');
    expect(button).toContain('h-11 min-w-11');
    expect(button).not.toContain('>Copy ID: Alex<');
  });
  it('uses a named project select, preserving an unavailable bookmarked filter without showing its ID', () => {
    const html = markup({ projects: [{ id: 'web', name: 'Storefront' }] });
    expect(html).toContain('<select');
    expect(html).toContain('name="filterProject"');
    expect(html).toContain('<option value="web" selected="">Storefront</option>');
    expect(html).not.toContain('<input id="audit-project"');
    const missing = markup({ filters: { ...filters, project: 'private-project-id' } });
    expect(missing).toContain(
      '<option value="private-project-id" selected="">Project unavailable</option>',
    );
    expect(missing).not.toContain('>private-project-id<');
    expect(markup({ scope: 'web' })).not.toContain('name="filterProject"');
  });
  it.each(['none', 'export'] as const)(
    'gives %s mode a short summary and a disclosure beneath real subheadings',
    (mode) => {
      const html = markup({
        status: { ...status, mode },
        trailInactive: true,
        data: null,
        explanation: {
          summary: 'The audit trail is inactive; local event history is unavailable.',
          details: 'Your audit access.',
        },
      });
      expect(html).toContain('<h3 class="text-base font-semibold">Delivery destinations</h3>');
      expect(html).toContain('<h3 class="text-base font-semibold">Recorded incidents');
      expect(html).toContain(
        '<details><summary>Audit access details</summary><p>Your audit access.</p></details>',
      );
      expect(html).not.toContain('name="filterProject"');
      expect(html).not.toContain('Clear filters');
      expect(html).toContain(
        mode === 'none'
          ? '<p>No durable audit history is being kept.</p><details>'
          : '<p>Events are sent to configured destinations.</p><details>',
      );
    },
  );
  it('loads paginated authorized names and keeps emails out of its result', async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url === '/_pb/me'
          ? { user: { id: 'self', displayName: null, email: 'private-self' } }
          : url === '/_pb/me/permissions'
            ? { organization: ['org:users:read', 'org:tokens:read'] }
            : url === '/_pb/users'
              ? {
                  items: [{ id: 'other', displayName: 'Sam', email: 'private-other' }],
                  next: 'next-user',
                }
              : url.includes('/_pb/users?')
                ? { items: [{ id: 'last', displayName: 'Taylor' }], next: null }
                : url === '/_pb/tokens'
                  ? { items: [{ id: 'shared', name: 'Deploy' }], next: 'next-token' }
                  : url.includes('/_pb/tokens?')
                    ? { items: [{ id: 'last-token', name: 'CI' }], next: null }
                    : { items: [{ id: 'mine', name: 'Laptop' }], next: null },
      ),
    );
    const names = await loadAuditNames(
      createApiClient<paths>({ fetch, readCookie: () => undefined }),
      null,
    );
    expect(names).toEqual({
      userId: 'self',
      users: { self: 'You', other: 'Sam', last: 'Taylor' },
      tokens: { mine: 'Laptop', shared: 'Deploy', 'last-token': 'CI' },
    });
    expect(JSON.stringify(names)).not.toContain('private-');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/users?after=next-user');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/tokens?after=next-token');
  });
  it.each([false, true])(
    'keeps self names and handles denied optional lists with project scope %s',
    async (project) => {
      const fetch = vi.fn(async (url: string) =>
        url === '/_pb/me'
          ? Response.json({ user: { id: 'self', displayName: 'Alex' } })
          : url === '/_pb/me/permissions'
            ? Response.json({ organization: [] })
            : Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
      );
      const names = await loadAuditNames(
        createApiClient<paths>({ fetch, readCookie: () => undefined }),
        project ? 'store' : null,
      );
      expect(names).toEqual({ userId: 'self', users: { self: 'Alex' }, tokens: {} });
      const urls = fetch.mock.calls.map(([url]) => url);
      expect(urls).not.toContain('/_pb/users');
      expect(urls).not.toContain('/_pb/tokens');
      expect(urls.includes('/_pb/projects/store/tokens')).toBe(project);
      expect(urls).toContain('/_pb/me/tokens');
    },
  );
  it('handles unavailable capabilities and network failures without diagnostics', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('private-diagnostic');
    });
    expect(
      await loadAuditNames(createApiClient<paths>({ fetch, readCookie: () => undefined }), null),
    ).toEqual({ userId: null, users: {}, tokens: {} });
  });
});

it('keeps unknown or inherited reference names generic and null references unrecorded', () => {
  const html = markup({
    names: { users: {}, tokens: {} },
    data: {
      items: [
        { ...item, actor: { type: 'user', id: 'toString' }, targetType: 'constructor' },
        {
          ...item,
          seq: 43,
          actor: { type: 'constructor', id: 'unknown' },
          targetType: 'token',
          targetId: 'toString',
        },
        { ...item, seq: 44, actor: { type: 'user', id: null }, targetId: null, projectId: null },
      ],
      next: null,
    },
  });
  expect(html).toContain('A user');
  expect(html).toContain('A token');
  expect(html).toContain('An item');
  expect(html).toContain('Actor type unavailable');
  expect(html).toContain('Not recorded');
  expect(html).not.toContain('[object Object]');
  expect(html).not.toContain('function Object');
});
