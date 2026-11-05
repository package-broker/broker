import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from './events.js';

export const TEMPLATE_FORMAT = 'json-v1';
export const MAX_TEMPLATE_BYTES = 8192;
export const MAX_TEMPLATE_DEPTH = 8;
export const MAX_TEMPLATE_NODES = 128;

export type TemplateScalar = string | number | boolean | null;

export type TemplateNode =
  | { readonly kind: 'literal'; readonly value: TemplateScalar }
  | { readonly kind: 'path'; readonly path: string; readonly nullable: boolean }
  | { readonly kind: 'array'; readonly items: readonly TemplateNode[] }
  | {
      readonly kind: 'object';
      readonly entries: readonly (readonly [string, TemplateNode])[];
    };

export interface NotificationTemplate {
  readonly format: typeof TEMPLATE_FORMAT;
  readonly events: readonly NotificationEventType[];
  readonly root: TemplateNode;
}

export class NotificationTemplateError extends Error {
  constructor() {
    super('Invalid notification template');
    this.name = 'NotificationTemplateError';
  }
}

const ENVELOPE_PATHS: Readonly<Record<string, boolean>> = {
  schemaVersion: false,
  id: false,
  type: false,
  occurredAt: false,
  operationId: false,
  organizationId: false,
  projectId: false,
  'package.ecosystem': false,
  'package.name': false,
};

/** Scalar paths a template may substitute for each event type; the value says whether it may be null. */
export const TEMPLATE_PATHS: {
  readonly [T in NotificationEventType]: Readonly<Record<string, boolean>>;
} = {
  'npm.package.published': { ...ENVELOPE_PATHS, 'package.version': false },
  'npm.package.released': {
    ...ENVELOPE_PATHS,
    'package.version': false,
    'data.releaseCause': false,
  },
  'npm.package.unpublished': {
    ...ENVELOPE_PATHS,
    'package.version': true,
    'data.removalScope': false,
    'data.removalKind': false,
  },
  'npm.package.deprecation_changed': {
    ...ENVELOPE_PATHS,
    'package.version': false,
    'data.deprecated': false,
  },
  'npm.package.dist_tag_changed': {
    ...ENVELOPE_PATHS,
    'package.version': true,
    'data.tag': false,
    'data.previousVersion': true,
    'data.version': true,
    'data.cause': false,
  },
};

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const SUBSTITUTION = /^\{\{([A-Za-z]+(?:\.[A-Za-z]+)?)\}\}$/;

function fail(): never {
  throw new NotificationTemplateError();
}

function selectedEvents(events: readonly unknown[]): readonly NotificationEventType[] {
  if (!Array.isArray(events) || events.length === 0 || new Set(events).size !== events.length)
    fail();
  for (const event of events) {
    if (!(NOTIFICATION_EVENT_TYPES as readonly unknown[]).includes(event)) fail();
  }
  return events as NotificationEventType[];
}

/** Null when the path is unavailable for any selected type; otherwise whether any type allows null. */
function pathNullability(path: string, events: readonly NotificationEventType[]): boolean | null {
  let nullable = false;
  for (const event of events) {
    const paths = TEMPLATE_PATHS[event];
    if (!Object.hasOwn(paths, path)) return null;
    nullable ||= paths[path] === true;
  }
  return nullable;
}

/** Parses and validates a `json-v1` template against every selected event type. */
export function parseNotificationTemplate(
  text: string,
  events: readonly NotificationEventType[],
): NotificationTemplate {
  const selected = selectedEvents(events);
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_TEMPLATE_BYTES)
    fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail();
  }
  if (typeof parsed !== 'object' || parsed === null) fail();
  let nodes = 0;
  const visit = (value: unknown, depth: number): TemplateNode => {
    nodes += 1;
    if (nodes > MAX_TEMPLATE_NODES || depth > MAX_TEMPLATE_DEPTH) fail();
    if (value === null || typeof value === 'boolean') return { kind: 'literal', value };
    if (typeof value === 'number') {
      return Number.isFinite(value) ? { kind: 'literal', value } : fail();
    }
    if (typeof value === 'string') {
      const match = SUBSTITUTION.exec(value);
      if (match === null) {
        return value.includes('{{') || value.includes('}}') ? fail() : { kind: 'literal', value };
      }
      const path = match[1] ?? '';
      const nullable = pathNullability(path, selected);
      return nullable === null ? fail() : { kind: 'path', path, nullable };
    }
    if (Array.isArray(value)) {
      return { kind: 'array', items: value.map((item) => visit(item, depth + 1)) };
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const entries = Object.keys(value).map((key) => {
        if (FORBIDDEN_KEYS.has(key) || key.includes('{{') || key.includes('}}')) fail();
        return [key, visit((value as Record<string, unknown>)[key], depth + 1)] as const;
      });
      return { kind: 'object', entries };
    }
    return fail();
  };
  return { format: TEMPLATE_FORMAT, events: selected, root: visit(parsed, 1) };
}
