import { NPM_HOSTNAME_CHECK, NPM_PACKAGE_NAME_CHECK } from './npm-identity-checks.js';
import { UTF8_REASON_CHECK } from './utf8-reason.js';
import {
  globalRegistry,
  registry,
  toJSONSchema,
  type $ZodLazy,
  type $ZodType,
  type $ZodTypes,
} from 'zod/v4/core';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type UnrepresentableReason =
  'transform' | 'custom_check' | 'unrepresentable_type' | 'lenient_object' | 'cycle';

export class UnrepresentableSchemaError extends Error {
  override readonly name = 'UnrepresentableSchemaError';

  constructor(
    readonly label: string,
    readonly reason: UnrepresentableReason,
  ) {
    super(`${label}: ${reason}`);
  }
}

const EXPORT_OPTIONS = {
  target: 'draft-2020-12',
  unrepresentable: 'throw',
  cycles: 'throw',
  reused: 'inline',
  override: ({
    zodSchema,
    jsonSchema,
  }: {
    zodSchema: $ZodType;
    jsonSchema: {
      default?: unknown;
      'x-pb-max-utf8-bytes'?: number;
      'x-pb-npm-package-name'?: boolean;
    };
  }) => {
    delete jsonSchema.default;
    if (zodSchema._zod.def.checks?.some((check) => check === UTF8_REASON_CHECK))
      jsonSchema['x-pb-max-utf8-bytes'] = 1000;
    if (zodSchema._zod.def.checks?.some((check) => check === NPM_HOSTNAME_CHECK))
      jsonSchema['x-pb-max-utf8-bytes'] = 253;
    if (zodSchema._zod.def.checks?.some((check) => check === NPM_PACKAGE_NAME_CHECK))
      jsonSchema['x-pb-npm-package-name'] = true;
  },
} as const;

function children(schema: $ZodTypes): readonly $ZodType[] {
  const def = schema._zod.def;
  switch (def.type) {
    case 'object':
      return [...Object.values(def.shape), ...(def.catchall ? [def.catchall] : [])];
    case 'array':
      return [def.element];
    case 'tuple':
      return [...def.items, ...(def.rest ? [def.rest] : [])];
    case 'union':
      return def.options;
    case 'intersection':
      return [def.left, def.right];
    case 'record':
      return [def.keyType, def.valueType];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
      return [def.innerType];
    case 'lazy':
      return [(schema as $ZodLazy)._zod.innerType];
    case 'template_literal':
      return def.parts.flatMap((part) => (typeof part === 'object' && part !== null ? [part] : []));
    default:
      return [];
  }
}

function validateRepresentable(schema: $ZodType, label: string) {
  const metadata = registry<{ title?: string; description?: string }>();
  const active = new Set<$ZodType>();
  const visited = new Set<$ZodType>();
  const refuse = (reason: UnrepresentableReason): never => {
    throw new UnrepresentableSchemaError(label, reason);
  };
  function visit(node: $ZodType, depth: number): void {
    if (depth >= 128) refuse('cycle');
    if (active.has(node)) refuse('cycle');
    if (visited.has(node)) return;
    active.add(node);
    const def = (node as $ZodTypes)._zod.def;
    if (def.type === 'transform' || def.type === 'pipe' || def.type === 'catch')
      refuse('transform');
    const meta = globalRegistry.get(node);
    metadata.add(node, {
      ...(typeof meta?.title === 'string' ? { title: meta.title } : {}),
      ...(typeof meta?.description === 'string' ? { description: meta.description } : {}),
    });
    for (const check of def.checks ?? []) {
      const checkDef = check._zod.def;
      if ('pattern' in checkDef && checkDef.pattern instanceof RegExp && checkDef.pattern.flags) {
        refuse('unrepresentable_type');
      }
      if (
        check._zod.def.check === 'custom' &&
        check !== UTF8_REASON_CHECK &&
        check !== NPM_HOSTNAME_CHECK &&
        check !== NPM_PACKAGE_NAME_CHECK
      )
        refuse('custom_check');
      if (check._zod.def.check === 'overwrite') refuse('transform');
    }
    switch (def.type) {
      case 'promise':
      case 'success':
      case 'file':
      case 'date':
      case 'bigint':
      case 'symbol':
      case 'function':
      case 'map':
      case 'set':
      case 'nan':
      case 'undefined':
      case 'void':
      case 'custom':
        refuse('unrepresentable_type');
    }
    if (def.type === 'object' && def.catchall?._zod.def.type !== 'never') {
      refuse('lenient_object');
    }
    for (const child of children(node as $ZodTypes)) visit(child, depth + 1);
    active.delete(node);
    visited.add(node);
  }
  visit(schema, 0);
  // The exporter also detects unsupported literal values and constraints on built-in types.
  try {
    toJSONSchema(schema, { ...EXPORT_OPTIONS, metadata, io: 'input' });
    toJSONSchema(schema, { ...EXPORT_OPTIONS, metadata, io: 'output' });
  } catch {
    refuse('unrepresentable_type');
  }
  return metadata;
}

export function assertRepresentable(schema: $ZodType, label: string): void {
  validateRepresentable(schema, label);
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key] as JsonValue)]),
    );
  }
  return value;
}

export function toJsonSchema(schema: $ZodType, io: 'input' | 'output'): JsonObject {
  const metadata = validateRepresentable(schema, 'schema');
  const json = toJSONSchema(schema, { ...EXPORT_OPTIONS, metadata, io });
  delete json.$schema;
  return sortKeys(json as JsonObject) as JsonObject;
}
