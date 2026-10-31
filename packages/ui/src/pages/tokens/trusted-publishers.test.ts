import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ShellServices } from '../../auth.js';
import { createTrustedPublishersController } from './trusted-publishers-controller.js';
import { TrustedPublishers } from './trusted-publishers.js';
function fixture() {
  const request = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { items: [] } });
  const services = { client: { request }, requireReauth: vi.fn() } as unknown as ShellServices;
  return { request, services, c: createTrustedPublishersController(services) };
}
const draft = {
  packageName: 'widget',
  repository: 'owner/repo',
  workflow: 'publish.yml',
  environment: '',
  refPattern: '',
};
it('retains a failed draft and clears it only on confirmed success', async () => {
  const { c, request } = fixture();
  c.draft(draft);
  request.mockResolvedValueOnce({ ok: false, status: 409, code: 'github_credentials_required' });
  await c.save();
  expect(c.snapshot().draft).toEqual(draft);
  expect(c.snapshot().notice).toContain('GitHub');
  request.mockResolvedValueOnce({ ok: true, status: 201, data: {} });
  await c.save();
  expect(c.snapshot().draft.packageName).toBe('');
});
it('keeps edits and blocks retry on revision conflict until explicit reload', async () => {
  const { c, request } = fixture();
  c.edit({ ...draft, id: 'publisher', revision: 3, refPattern: null });
  request.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict' });
  await c.save();
  expect(request).toHaveBeenCalledWith(
    'put',
    '/_pb/trusted-publishers/{id}',
    expect.objectContaining({ headers: { 'If-Match': '"r3"' } }),
  );
  expect(c.snapshot().stale).toBe(true);
  const calls = request.mock.calls.length;
  await c.save();
  expect(request).toHaveBeenCalledTimes(calls);
});
it('prevents duplicate writes and only disables with the selected revision', async () => {
  const { c, request } = fixture();
  let resolve!: (value: unknown) => void;
  request.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = c.disable({ id: 'publisher', revision: 2 });
  await c.disable({ id: 'publisher', revision: 2 });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('delete', '/_pb/trusted-publishers/{id}', {
    params: { id: 'publisher' },
    headers: { 'If-Match': '"r2"' },
  });
  resolve({ ok: true, status: 204 });
  await pending;
});

it.each([
  { items: [] },
  { items: [{ ...draft, id: 'publisher', revision: 4, disabledAt: '2026-10-31' }] },
])(
  'keeps the edit target and blocks saving when a reload finds it disabled or missing: %j',
  async ({ items }) => {
    const { c, request } = fixture();
    c.edit({ ...draft, id: 'publisher', revision: 3, refPattern: null });
    request.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict' });
    await c.save();
    request.mockResolvedValueOnce({ ok: true, status: 200, data: { items } });
    await c.load();
    expect(c.snapshot().editing?.id).toBe('publisher');
    expect(c.snapshot().draft).toEqual(draft);
    expect(c.snapshot().notice).toContain('disabled');
    const calls = request.mock.calls.length;
    await c.save();
    expect(request).toHaveBeenCalledTimes(calls);
    c.cancel();
    expect(c.snapshot().editing).toBeNull();
  },
);

const publisherPermissions = ['org:service-principals:write', 'org:packages:publish'];
it('starts with a collapsed publisher disclosure and an explicit create action', () => {
  const { c } = fixture();
  const html = renderToString(
    createElement(TrustedPublishers, { controller: c, permissions: publisherPermissions }),
  );
  expect(html).toMatch(/<details[^>]*id="trusted-publishers"/);
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).toContain('>Trusted publishers</summary>');
  expect(html).toContain('Add trusted publisher');
  expect(html).not.toContain('<form');
});
it('opens the disclosure and form for an existing publisher edit', () => {
  const { c } = fixture();
  c.edit({ ...draft, id: 'publisher', revision: 3, refPattern: null });
  const html = renderToString(
    createElement(TrustedPublishers, { controller: c, permissions: publisherPermissions }),
  );
  expect(html).toMatch(/<details[^>]*open/);
  expect(html).toContain('aria-label="Edit trusted publisher"');
});
