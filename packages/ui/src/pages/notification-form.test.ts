import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Endpoint } from './notification-actions.js';
import { NotificationForm, exampleEnvelope, previewBody } from './notification-form.js';

const endpoint: Endpoint = {
  id: '01JB0000000000000000000001',
  name: 'Release hook',
  method: 'PUT',
  events: ['npm.package.released'],
  packagePattern: '@acme/*',
  state: 'enabled',
  disabledReason: null,
  failureStreak: 0,
  revision: 2,
  destinationConfigured: true,
  signingConfigured: true,
  headersConfigured: true,
  templateConfigured: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const render = (value: Endpoint | null) =>
  renderToString(
    createElement(NotificationForm, {
      projectName: 'Demo',
      endpoint: value,
      disabled: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    }),
  );

describe('notification form', () => {
  it('asks for every delivery setting when adding, with empty secret fields', () => {
    const html = render(null);
    expect(html).toContain('New notification endpoint');
    expect(html).toMatch(/<input[^>]*type="url"[^>]*value=""/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*required=""[^>]*value=""/);
    expect(html).toContain('The endpoint is added disabled.');
    expect(html).toContain('Project Demo');
  });

  it('shows configured flags and keeps replacement fields closed when editing', () => {
    const html = render(endpoint);
    expect(html).toContain('destination configured');
    expect(html).toContain('body template configured');
    expect(html).toContain('Replace delivery settings');
    expect(html).not.toContain('type="url"');
    expect(html).not.toMatch(/value="[•*]+"/);
    expect(html).toContain('including a rename');
  });

  it('explains legacy capital encoding in the package filter help', () => {
    expect(render(null)).toContain('!my!package for MyPackage');
  });
});

describe('local preview', () => {
  it('shows the standard envelope for made-up data', () => {
    expect(JSON.parse(previewBody('npm.package.unpublished', ''))).toEqual(
      exampleEnvelope('npm.package.unpublished'),
    );
  });

  it('substitutes whole-string paths and keeps literals', () => {
    const body = JSON.parse(
      previewBody(
        'npm.package.dist_tag_changed',
        '{"text":"{{package.name}}","tag":"{{data.tag}}","n":1}',
      ),
    );
    expect(body).toEqual({ text: '@example/library', tag: 'latest', n: 1 });
  });

  it('reports a path the event lacks and invalid JSON instead of guessing', () => {
    expect(previewBody('npm.package.published', '{"x":"{{data.tag}}"}')).toBe(
      'The template names a value this event does not have.',
    );
    expect(previewBody('npm.package.published', '{')).toBe('The template is not valid JSON.');
  });
});
