import { encodeNotificationEvent, notificationEvent, type NotificationEvent } from './events.js';
import type { NotificationTemplate, TemplateNode, TemplateScalar } from './template-schema.js';

export const MAX_RENDERED_BYTES = 16_384;

export class NotificationRenderError extends Error {
  constructor() {
    super('Notification body cannot be rendered');
    this.name = 'NotificationRenderError';
  }
}

function fail(): never {
  throw new NotificationRenderError();
}

function lookup(event: NotificationEvent, path: string, nullable: boolean): TemplateScalar {
  let value: unknown = event;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) fail();
    value = (value as Record<string, unknown>)[part];
  }
  if (value === null) return nullable ? null : fail();
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return value;
  return fail();
}

function build(node: TemplateNode, event: NotificationEvent): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return lookup(event, node.path, node.nullable);
    case 'array':
      return node.items.map((item) => build(item, event));
    case 'object':
      return Object.fromEntries(node.entries.map(([key, child]) => [key, build(child, event)]));
  }
}

/** Exact body bytes for one delivery: the canonical envelope, or the template filled in. */
export function renderNotificationBody(
  template: NotificationTemplate | null,
  input: NotificationEvent,
): Uint8Array {
  let event: NotificationEvent;
  try {
    event = notificationEvent(input);
  } catch {
    fail();
  }
  if (template !== null && !template.events.includes(event.type)) fail();
  const bytes =
    template === null
      ? encodeNotificationEvent(event)
      : new TextEncoder().encode(JSON.stringify(build(template.root, event)));
  return bytes.byteLength > MAX_RENDERED_BYTES ? fail() : bytes;
}
