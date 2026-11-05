import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ShellServices } from '../auth.js';
import type { Endpoint } from './notification-actions.js';
import { createNotificationsController } from './notifications-controller.js';
import { NotificationsView } from './notifications.js';

const endpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: '01JB0000000000000000000001',
  name: 'Release hook',
  method: 'POST',
  events: ['npm.package.published', 'npm.package.released'],
  packagePattern: '@acme/*',
  state: 'disabled',
  disabledReason: 'failures',
  failureStreak: 10,
  revision: 4,
  destinationConfigured: true,
  signingConfigured: true,
  headersConfigured: true,
  templateConfigured: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const delivery = {
  id: '0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b',
  eventId: '01JC0000000000000000000001',
  eventType: 'npm.package.released',
  state: 'failed',
  attempts: 8,
  nextAttemptAt: null,
  lastStatus: 503,
  outcomeCode: 'attempt_limit',
  createdAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-02T00:00:00.000Z',
};

function fixture() {
  const request = vi.fn();
  const services = { client: { request }, requireReauth: vi.fn() } as unknown as ShellServices;
  const controller = createNotificationsController(services);
  const render = (project: string | null = 'demo') =>
    renderToString(
      createElement(NotificationsView, { services, controller, project, projectName: 'Demo' }),
    );
  return { request, services, controller, render };
}

describe('notifications list', () => {
  it('asks for a project in organization scope and loads nothing', async () => {
    const f = fixture();
    await f.controller.load(null);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render(null)).toContain('Choose a project to manage its notifications.');
  });

  it.each([
    [403, 'You cannot manage notifications in this project.'],
    [404, 'Notifications are not available.'],
    [500, 'Notification endpoints could not be loaded. Try again.'],
  ])('explains a %i list answer', async (status, copy) => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ ok: false, status, code: 'x' });
    await f.controller.load('demo');
    const html = f.render();
    expect(html).toContain(copy);
    expect(html).not.toContain('No notification endpoints yet');
  });

  it('renders the first-use state with one create action', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ ok: true, status: 200, data: { items: [], next: null } });
    await f.controller.load('demo');
    const html = f.render();
    expect(html).toContain('No notification endpoints yet.');
    expect(html).toContain('Add endpoint');
    expect(html).toContain('Project Demo');
  });

  it('renders names, event labels, the disabled reason and configured flags without IDs', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { items: [endpoint()], next: null },
    });
    await f.controller.load('demo');
    const html = f.render();
    expect(html).toContain('Release hook');
    expect(html).toContain('Version published, Held version released');
    expect(html).toContain('Disabled after 10 deliveries in a row failed.');
    expect(html).toContain('custom headers');
    expect(html).not.toContain('01JB0000000000000000000001');
    expect(html).not.toContain('npm.package.published');
    expect(html).not.toContain('failures');
  });

  it('reads only list and history routes, and pages with the server cursor', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { items: [endpoint()], next: '01JB0000000000000000000002' },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { items: [], next: null } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { items: [endpoint()], next: '01JB0000000000000000000002' },
      });
    await f.controller.load('demo');
    await f.controller.nextPage();
    expect(f.request).toHaveBeenLastCalledWith('get', '/_pb/projects/{project}/notifications', {
      params: { project: 'demo' },
      query: { cursor: '01JB0000000000000000000002' },
    });
    expect(f.controller.snapshot().hasPrevious).toBe(true);
    await f.controller.previousPage();
    expect(f.request).toHaveBeenLastCalledWith('get', '/_pb/projects/{project}/notifications', {
      params: { project: 'demo' },
      query: {},
    });
  });
});

describe('delivery history', () => {
  it('filters, pages and opens attempts of the selected endpoint', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { items: [endpoint()], next: null },
    });
    await f.controller.load('demo');
    f.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        items: [delivery],
        next: '2026-11-01T00:00:00.000Z~0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b',
      },
    });
    await f.controller.select('01JB0000000000000000000001');
    const html = f.render();
    expect(html).toContain('Delivery history: Release hook');
    expect(html).toContain('Stopped after 8 attempts (HTTP 503)');
    expect(html).toContain('8 of 8');
    f.request.mockResolvedValueOnce({ ok: true, status: 200, data: { items: [], next: null } });
    await f.controller.nextHistory();
    expect(f.request).toHaveBeenLastCalledWith(
      'get',
      '/_pb/projects/{project}/notifications/{id}/deliveries',
      {
        params: { project: 'demo', id: '01JB0000000000000000000001' },
        query: { cursor: '2026-11-01T00:00:00.000Z~0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b' },
      },
    );
    f.request.mockResolvedValueOnce({ ok: true, status: 200, data: { items: [], next: null } });
    await f.controller.filterHistory('failed');
    expect(f.request).toHaveBeenLastCalledWith(
      'get',
      '/_pb/projects/{project}/notifications/{id}/deliveries',
      { params: { project: 'demo', id: '01JB0000000000000000000001' }, query: { state: 'failed' } },
    );
    expect(f.render()).toContain('No deliveries match this filter on this page.');
    f.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        ...delivery,
        history: [
          {
            attempt: 1,
            outcome: 'retry',
            outcomeCode: 'http_retry',
            status: 503,
            durationMs: 40,
            startedAt: '2026-11-01T00:00:00.000Z',
            finishedAt: '2026-11-01T00:00:00.040Z',
          },
        ],
      },
    });
    await f.controller.openDelivery(delivery.id);
    expect(f.render()).toContain('Receiver asked to retry (HTTP 503), 40 ms');
  });

  it('shows a retryable error when history cannot be loaded', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { items: [endpoint()], next: null },
    });
    await f.controller.load('demo');
    f.request.mockResolvedValueOnce({ ok: false, status: 500, code: 'unavailable' });
    await f.controller.select('01JB0000000000000000000001');
    expect(f.render()).toContain('Deliveries could not be loaded. Try again.');
  });

  it('drops the selection and history when the scope changes', async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [endpoint()], next: null },
    });
    await f.controller.load('demo');
    await f.controller.select('01JB0000000000000000000001');
    await f.controller.load('other');
    expect(f.controller.snapshot().selected).toBeNull();
    expect(f.controller.snapshot().deliveries).toEqual([]);
  });
});
