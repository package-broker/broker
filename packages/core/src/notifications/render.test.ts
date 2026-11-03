import { describe, expect, it } from 'vitest';
import type { NotificationEvent } from './events.js';
import { NotificationRenderError, renderNotificationBody } from './render.js';
import { parseNotificationTemplate } from './template-schema.js';

const event = (
  type: NotificationEvent['type'],
  version: string | null,
  data: Record<string, unknown>,
  name = '@example/Library',
) =>
  ({
    schemaVersion: 1,
    id: '01J0EVENT00000000000000EV1',
    type,
    occurredAt: '2026-11-01T12:00:00.000Z',
    operationId: '01J0P0000000000000000000P1',
    organizationId: '01J00000000000000000000A0A',
    projectId: '01J0PR0JECT00000000000000P',
    package: { ecosystem: 'npm', name, version },
    data,
  }) as NotificationEvent;

const released = event('npm.package.released', '1.2.3', { releaseCause: 'scan' });
const removed = event('npm.package.unpublished', null, {
  removalScope: 'package',
  removalKind: 'tombstone',
});
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('notification body rendering', () => {
  it('renders the canonical envelope without a template', () => {
    expect(decode(renderNotificationBody(null, released))).toBe(
      '{"schemaVersion":1,"id":"01J0EVENT00000000000000EV1","type":"npm.package.released","occurredAt":"2026-11-01T12:00:00.000Z","operationId":"01J0P0000000000000000000P1","organizationId":"01J00000000000000000000A0A","projectId":"01J0PR0JECT00000000000000P","package":{"ecosystem":"npm","name":"@example/Library","version":"1.2.3"},"data":{"releaseCause":"scan"}}',
    );
  });

  it('preserves exact bytes for escaped literals and substituted values', () => {
    const template = parseNotificationTemplate(
      '{"text":"quote \\" back \\\\ nul \\u0000 sep \\u2028 é","name":"{{package.name}}","n":[1.5,-0,1e3,true,null],"cause":"{{data.releaseCause}}"}',
      ['npm.package.released'],
    );
    const bytes = renderNotificationBody(template, released);
    expect(decode(bytes)).toBe(
      '{"text":"quote \\" back \\\\ nul \\u0000 sep   é","name":"@example/Library","n":[1.5,0,1000,true,null],"cause":"scan"}',
    );
    expect(Array.from(bytes.slice(-7))).toEqual([...new TextEncoder().encode('"scan"}')]);
  });

  it('is deterministic across renders', () => {
    const template = parseNotificationTemplate('{"b":"{{id}}","a":"{{type}}"}', [
      'npm.package.released',
    ]);
    expect(decode(renderNotificationBody(template, released))).toBe(
      '{"b":"01J0EVENT00000000000000EV1","a":"npm.package.released"}',
    );
    expect(renderNotificationBody(template, released)).toEqual(
      renderNotificationBody(template, released),
    );
  });

  it('renders a permitted null as JSON null', () => {
    const template = parseNotificationTemplate('{"version":"{{package.version}}"}', [
      'npm.package.unpublished',
    ]);
    expect(decode(renderNotificationBody(template, removed))).toBe('{"version":null}');
  });

  it('refuses an event type the template was not validated for', () => {
    const template = parseNotificationTemplate('{"tag":"{{data.tag}}"}', [
      'npm.package.dist_tag_changed',
    ]);
    expect(() => renderNotificationBody(template, released)).toThrow(NotificationRenderError);
    const envelopeOnly = parseNotificationTemplate('{"id":"{{id}}"}', [
      'npm.package.dist_tag_changed',
    ]);
    expect(() => renderNotificationBody(envelopeOnly, released)).toThrow(NotificationRenderError);
  });

  it('refuses a null where the template expects a value', () => {
    const template = parseNotificationTemplate('{"version":"{{package.version}}"}', [
      'npm.package.published',
    ]);
    const forged = {
      ...template,
      events: [...template.events, 'npm.package.unpublished' as const],
    };
    expect(() => renderNotificationBody(forged, removed)).toThrow(NotificationRenderError);
  });

  it('refuses a missing field', () => {
    const template = parseNotificationTemplate('{"cause":"{{data.releaseCause}}"}', [
      'npm.package.released',
    ]);
    const forged = {
      ...template,
      events: [...template.events, 'npm.package.unpublished' as const],
    };
    expect(() => renderNotificationBody(forged, removed)).toThrow(NotificationRenderError);
  });

  it('refuses an invalid event', () => {
    expect(() =>
      renderNotificationBody(null, { ...released, actor: 'x' } as unknown as NotificationEvent),
    ).toThrow(NotificationRenderError);
  });

  it('refuses a render over 16 KiB', () => {
    const long = event('npm.package.released', '1.2.3', { releaseCause: 'scan' }, 'a'.repeat(214));
    const fits = parseNotificationTemplate(JSON.stringify(Array(70).fill('{{package.name}}')), [
      'npm.package.released',
    ]);
    expect(renderNotificationBody(fits, long).byteLength).toBeLessThanOrEqual(16_384);
    const over = parseNotificationTemplate(JSON.stringify(Array(100).fill('{{package.name}}')), [
      'npm.package.released',
    ]);
    expect(() => renderNotificationBody(over, long)).toThrow(NotificationRenderError);
  });
});
