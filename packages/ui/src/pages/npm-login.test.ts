import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { NpmLoginPage } from './npm-login.js';
import { ServicesContext, safePageHash, type ShellServices } from '../auth.js';
import { parseHash, resolveRoute } from '../app.js';
const hash = '#/npm-login/' + 'a'.repeat(43);
afterEach(() => vi.unstubAllGlobals());
it('keeps the opaque browser selector through sign-in and reauthentication', () => {
  expect(parseHash(hash).route).toBe('npm-login');
  expect(resolveRoute(hash, false).route).toBe('login');
  expect(resolveRoute(hash, true).route).toBe('npm-login');
  expect(safePageHash(hash)).toBe(hash);
  for (const bad of [hash + '?extra=1', hash + '/', hash + 'a'])
    expect(safePageHash(bad)).toBe('#/projects');
});
it('shows the phishing warning before any approval control and issues no request during rendering', () => {
  vi.stubGlobal('window', { location: { hash } });
  const request = vi.fn();
  const services = { client: { request }, requireReauth: vi.fn() } as unknown as ShellServices;
  const html = renderToString(
    createElement(ServicesContext.Provider, { value: services }, createElement(NpmLoginPage)),
  );
  expect(html).toContain('Only continue if you ran npm login yourself a moment ago.');
  expect(html).toContain('Someone else may have sent you this link');
  expect(html).toContain('Loading login request');
  expect(html).not.toContain('Approve login');
  expect(request).not.toHaveBeenCalled();
});
