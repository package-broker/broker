import { describe, expect, it } from 'vitest';
import type { NotificationEventType } from './events.js';
import {
  MAX_TEMPLATE_BYTES,
  NotificationTemplateError,
  parseNotificationTemplate,
} from './template-schema.js';

const ALL: NotificationEventType[] = [
  'npm.package.published',
  'npm.package.released',
  'npm.package.unpublished',
  'npm.package.deprecation_changed',
  'npm.package.dist_tag_changed',
];

function rejects(text: string, events: readonly NotificationEventType[] = ALL): void {
  expect(() => parseNotificationTemplate(text, events)).toThrow(NotificationTemplateError);
}

function nested(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

describe('json-v1 template grammar', () => {
  it('accepts literals and envelope substitutions for every event type', () => {
    const template = parseNotificationTemplate(
      JSON.stringify({
        text: 'published',
        name: '{{package.name}}',
        version: '{{package.version}}',
        when: '{{occurredAt}}',
        flags: [true, 1, null],
      }),
      ALL,
    );
    expect(template.format).toBe('json-v1');
    expect(template.root).toMatchObject({
      kind: 'object',
      entries: [
        ['text', { kind: 'literal', value: 'published' }],
        ['name', { kind: 'path', path: 'package.name', nullable: false }],
        ['version', { kind: 'path', path: 'package.version', nullable: true }],
        ['when', { kind: 'path', path: 'occurredAt', nullable: false }],
        ['flags', { kind: 'array' }],
      ],
    });
  });

  it('marks package.version non-null when only version-bearing events are selected', () => {
    const template = parseNotificationTemplate('["{{package.version}}"]', [
      'npm.package.published',
      'npm.package.released',
    ]);
    expect(template.root).toEqual({
      kind: 'array',
      items: [{ kind: 'path', path: 'package.version', nullable: false }],
    });
  });

  it('allows a type-specific path only when every selected type has it', () => {
    expect(() =>
      parseNotificationTemplate('{"cause":"{{data.releaseCause}}"}', ['npm.package.released']),
    ).not.toThrow();
    rejects('{"cause":"{{data.releaseCause}}"}', ['npm.package.released', 'npm.package.published']);
    rejects('{"tag":"{{data.tag}}"}', ['npm.package.dist_tag_changed', 'npm.package.unpublished']);
    expect(
      parseNotificationTemplate('{"previous":"{{data.previousVersion}}"}', [
        'npm.package.dist_tag_changed',
      ]).root,
    ).toEqual({
      kind: 'object',
      entries: [['previous', { kind: 'path', path: 'data.previousVersion', nullable: true }]],
    });
  });

  it.each([
    ['unknown path', '{"a":"{{package.tarball}}"}'],
    ['actor path', '{"a":"{{actor.email}}"}'],
    ['deep path', '{"a":"{{package.name.length}}"}'],
    ['interpolation inside a string', '{"a":"name {{package.name}}"}'],
    ['unclosed substitution', '{"a":"{{package.name"}'],
    ['stray closing braces', '{"a":"x}}"}'],
    ['dynamic property name', '{"{{package.name}}":1}'],
    ['prototype key', '{"__proto__":{"x":1}}'],
    ['constructor key', '{"constructor":1}'],
    ['nested prototype key', '{"a":{"prototype":1}}'],
    ['helper syntax', '{"a":"{{#each package}}"}'],
    ['scalar root', '"{{package.name}}"'],
    ['null root', 'null'],
    ['not json', '{a:1}'],
  ])('rejects %s', (_name, text) => rejects(text));

  it('bounds depth at eight', () => {
    expect(() => parseNotificationTemplate(nested(8), ALL)).not.toThrow();
    rejects(nested(9));
  });

  it('bounds the node count at 128', () => {
    expect(() =>
      parseNotificationTemplate(JSON.stringify(Array.from({ length: 127 }, () => 1)), ALL),
    ).not.toThrow();
    rejects(JSON.stringify(Array.from({ length: 128 }, () => 1)));
  });

  it('bounds input bytes at 8 KiB', () => {
    const fits = JSON.stringify(['x'.repeat(MAX_TEMPLATE_BYTES - 4)]);
    expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_TEMPLATE_BYTES);
    expect(() => parseNotificationTemplate(fits, ALL)).not.toThrow();
    rejects(JSON.stringify(['é'.repeat(MAX_TEMPLATE_BYTES / 2)]));
  });

  it.each([[[]], [['npm.package.published', 'npm.package.published']], [['npm.package.read']]])(
    'rejects the event selection %j',
    (events) => rejects('{}', events as NotificationEventType[]),
  );

  it('uses a fixed message without template content', () => {
    try {
      parseNotificationTemplate('{"secret-marker":"{{nope}}"}', ALL);
    } catch (error) {
      expect((error as Error).message).toBe('Invalid notification template');
    }
  });
});
