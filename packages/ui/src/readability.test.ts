import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Shell } from './app.js';
import { ReauthConfirmContent, safePageHash } from './auth.js';
import {
  STATUS_COLORS,
  STATUS_LABELS,
  StatusBadge,
  type Status,
} from './components/ui/status-badge.js';
import { Time } from './components/ui/time.js';
import { IdText, middleTruncate } from './components/ui/id-text.js';
import { DataTable } from './components/ui/table.js';
import { ListState } from './components/ui/list-state.js';
import { FilterToolbar } from './components/ui/toolbar.js';
import { createApiClient } from './api.js';
import type { paths } from './api-types.js';
import {
  createImportController,
  ImportView,
  importActionAllowed,
  type ImportRun,
} from './pages/import.js';
import { loadPending, savePending, type PendingStorage } from './pending.js';

const run: ImportRun = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  state: 'planned',
  planHash: '0123456789abcdef'.repeat(4),
  approvedAt: null,
  approvedByUserId: null,
  acceptedAt: null,
  beforeImageExpiresAt: null,
};
const now = Date.parse('2026-10-23T12:00:00Z');
afterEach(() => vi.unstubAllGlobals());

describe('shared readability', () => {
  it.each(Object.keys(STATUS_LABELS) as Status[])('labels and colors %s consistently', (status) => {
    const html = renderToString(createElement(StatusBadge, { status }));
    expect(html).toContain(STATUS_LABELS[status]);
    expect(html).toContain(STATUS_COLORS[status]);
  });
  it('formats time and retains the exact ISO value for inspection', () => {
    const value = '2026-10-23T12:03:00.000Z';
    const html = renderToString(createElement(Time, { value }));
    expect(html).toContain(`title="${value}"`);
    expect(html).toContain(`dateTime="${value}"`);
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain(
      new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value)),
    );
    expect(renderToString(createElement(Time, { value: 'invalid', fallback: 'Never' }))).toContain(
      'Never',
    );
    expect(renderToString(createElement(Time, { value: null }))).not.toContain('<time');
  });
  it('truncates IDs in the middle and exposes a labelled copy control', () => {
    expect(middleTruncate(run.id)).toBe('01ARZ3ND…Q69G5FAV');
    expect(middleTruncate('short')).toBe('short');
    const html = renderToString(createElement(IdText, { value: run.id, label: 'run ID' }));
    expect(html).toContain(`title="${run.id}"`);
    expect(html).toContain('aria-label="Copy run ID"');
    expect(html).toContain('font-mono');
  });
  it.each(['placeholder', 'loading', 'empty', 'filtered-empty', 'error'] as const)(
    'distinguishes %s state',
    (kind) => {
      const html = renderToString(createElement(ListState, { kind, title: kind }));
      expect(html).toContain(`data-list-state="${kind}"`);
      expect(html).toContain(kind === 'error' ? 'role="alert"' : 'role="status"');
    },
  );
  it('labels scroll regions, cells, column controls and sort scope', () => {
    const html = renderToString(
      createElement(DataTable<{ id: string }>, {
        label: 'Runs',
        items: [{ id: run.id }],
        columns: [
          { key: 'id', label: 'Run ID', value: (item) => item.id },
          { key: 'extra', label: 'Extra', value: () => 'extra', priority: 3 },
        ],
      }),
    );
    expect(html).toContain('role="region" aria-label="Runs"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-label="Run ID"');
    expect(html).toContain('priority-3');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('Sort this page');
  });
});

describe('CSP rendering', () => {
  it('renders the app and its interactive shared components without adding a style element', async () => {
    vi.stubGlobal('window', { location: { hash: '#/login' } });
    const request = vi.fn();
    const app = renderToString(createElement(App, { client: { request } as never }));
    expect(app).toContain('Sign in');
    const controller = createImportController({
      client: createApiClient<paths>({
        fetch: async () => Response.json(run),
        readCookie: () => undefined,
      }),
      requireReauth: vi.fn(),
    });
    await controller.select(run.id);
    const shell = renderToString(
      createElement(
        CSPProvider,
        { disableStyleElements: true },
        createElement(
          Shell,
          {
            route: 'import',
            project: null,
            projects: [],
            unknown: null,
            onScope: vi.fn(),
            onSignOut: vi.fn(),
          },
          createElement(
            FilterToolbar,
            {
              children: 'Filters',
              chips: [{ label: 'State', value: 'Planned', onRemove: vi.fn() }],
            },
            'Filters',
          ),
          createElement(ImportView, { controller, state: controller.snapshot() }),
        ),
      ),
    );
    expect(shell).toContain('data-panel');
    expect(shell).toContain('Copy full plan hash');
    expect(shell).toContain('Main menu');
    expect(app + shell).not.toMatch(/<style\b/i);
  });
});

describe('held action presentation', () => {
  it('shows package, version, scope and consequence with the request secondary and copyable', () => {
    const path = `/_pb/projects/storefront/packages/${run.id}/versions/${run.id}/tombstone`;
    const html = renderToString(
      createElement(ReauthConfirmContent, {
        action: {
          method: 'POST',
          path,
          body: { private: 'body-secret' },
          savedAt: 1,
          display: { packageName: '@acme/<script>', version: '3.4.1', scope: 'Storefront' },
        },
        onConfirm: vi.fn(),
        onDecline: vi.fn(),
      }),
    );
    expect(html).toContain('Tombstone version');
    expect(html).toContain('@acme/&lt;script&gt;');
    expect(html).toContain('3.4.1');
    expect(html).toContain('Storefront');
    expect(html).toContain('cannot be undone');
    expect(html).toMatch(/<details>[\s\S]*Request details[\s\S]*POST/);
    expect(html).toContain('aria-label="Copy request"');
    expect(html).not.toContain('body-secret');
    expect(html.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1]).not.toContain(path);
  });
  it('persists bounded display fields without changing replay payload or including secrets', () => {
    let raw: string | null = null;
    const storage: PendingStorage = {
      setItem: (_, value) => {
        raw = value;
      },
      getItem: () => raw,
      removeItem: () => {},
    };
    const display = { packageName: 'acme/package', version: '1.0.0', scope: 'Organization' };
    expect(
      savePending(storage, {
        method: 'POST',
        path: '/_pb/packages/id',
        credential: false,
        secretFields: ['secret'],
        body: { secret: 'private-token', safe: 'ok' },
        display,
      }),
    ).toEqual({ ok: true });
    expect(raw).not.toContain('private-token');
    expect(loadPending(storage, Date.now())).toMatchObject({
      ok: true,
      action: { display, body: { safe: 'ok' } },
    });
    expect(
      savePending(storage, {
        method: 'POST',
        path: '/_pb/packages/id',
        credential: false,
        secretFields: [],
        display: { ...display, packageName: 'x'.repeat(257) },
      }),
    ).toEqual({ ok: false });
  });
});

describe('import transition guards', () => {
  it.each([
    ['planned', false, true, false],
    ['applying', false, false, false],
    ['failed', false, false, true],
    ['applied', false, false, true],
    ['verifying', false, false, true],
    ['verified', false, false, true],
    ['rolled_back', false, false, false],
    ['cancelled', false, false, false],
  ] as const)('matches valid actions for %s', (state, apply, cancel, rollback) => {
    const item = { ...run, state };
    expect(importActionAllowed(item, 'apply', now)).toBe(apply);
    expect(importActionAllowed(item, 'cancel', now)).toBe(cancel);
    expect(importActionAllowed(item, 'rollback', now)).toBe(rollback);
  });
  it('allows apply only with valid approval and rollback only within retention', () => {
    expect(
      importActionAllowed({ ...run, approvedAt: new Date(now).toISOString() }, 'apply', now),
    ).toBe(true);
    expect(importActionAllowed({ ...run, approvedAt: 'invalid' }, 'apply', now)).toBe(false);
    expect(
      importActionAllowed(
        { ...run, approvedAt: new Date(now + 60_001).toISOString() },
        'apply',
        now,
      ),
    ).toBe(false);
    for (const expiry of [new Date(now).toISOString(), new Date(now - 1).toISOString(), 'invalid'])
      expect(
        importActionAllowed(
          { ...run, state: 'applied', beforeImageExpiresAt: expiry },
          'rollback',
          now,
        ),
      ).toBe(false);
    expect(
      importActionAllowed(
        { ...run, state: 'applied', beforeImageExpiresAt: new Date(now + 1).toISOString() },
        'rollback',
        now,
      ),
    ).toBe(true);
  });
  it('blocks invalid actions at the controller and in rendered controls', async () => {
    const fetch = vi.fn(async () => Response.json(run));
    const controller = createImportController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    await controller.select(run.id);
    await controller.action('apply');
    await controller.action('rollback');
    expect(fetch).toHaveBeenCalledTimes(1);
    const html = renderToString(
      createElement(ImportView, { state: controller.snapshot(), controller }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rollback<\/button>/);
  });
});

describe('return navigation', () => {
  it('keeps list filters and cursors with selected package and import run through reauth', () => {
    const packages = `#/packages?project=web&status=active&q=acme&after=page2&package=${run.id}&versionAfter=older`;
    expect(safePageHash(packages)).toBe(packages);
    const imports = `#/import?cursor=page2&run=${run.id}`;
    expect(safePageHash(imports)).toBe(imports);
    const audit = '#/audit?project=web&after=page2&actor=user&action=source.update&limit=25';
    expect(safePageHash(audit)).toBe(audit);
  });
});
