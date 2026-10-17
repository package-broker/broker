import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as mini from 'zod/mini';
import { type $ZodType } from 'zod/v4/core';
import { assertRepresentable, toJsonSchema, UnrepresentableSchemaError } from './json-schema.js';

function refuses(schema: $ZodType, reason: string): void {
  expect(() => assertRepresentable(schema, 'registration')).toThrow(
    expect.objectContaining({ name: 'UnrepresentableSchemaError', label: 'registration', reason }),
  );
}

function expectSorted(value: unknown): void {
  if (Array.isArray(value)) value.forEach(expectSorted);
  else if (typeof value === 'object' && value !== null) {
    expect(Object.keys(value)).toEqual(Object.keys(value).sort());
    Object.values(value).forEach(expectSorted);
  }
}

describe('assertRepresentable', () => {
  it('refuses catch fallbacks', () => refuses(z.string().catch('fallback'), 'transform'));
  it.each([/value/i, /value/g, /value/m, /value/s, /value/u, /value/y])(
    'refuses regex flags %s',
    (pattern) => refuses(z.string().regex(pattern), 'unrepresentable_type'),
  );
  it('accepts regex checks without flags', () => {
    expect(toJsonSchema(z.string().regex(/^value$/), 'input')).toEqual({
      pattern: '^value$',
      type: 'string',
    });
  });
  it.each([z.promise(z.string()), z.success(z.string()), z.file()])(
    'refuses non-JSON types %#',
    (schema) => refuses(schema, 'unrepresentable_type'),
  );
  it('refuses a lazy that creates a fresh lazy on every resolution', () => {
    const fresh = (): z.ZodType => z.lazy(fresh);
    refuses(fresh(), 'cycle');
  });
  it('uses the cached lazy resolution', () => {
    let calls = 0;
    const schema = z.lazy(() => {
      calls++;
      return calls === 1 ? z.string().refine(() => true) : z.string();
    });
    expect(schema._zod.innerType).toBe(schema._zod.innerType);
    refuses(schema, 'custom_check');
    expect(calls).toBe(1);
  });
  it('refuses transforms', () => refuses(z.string().transform(String), 'transform'));
  it('refuses pipes without transforms', () => refuses(z.string().pipe(z.string()), 'transform'));
  it('refuses overwrites that change parsed values', () => {
    refuses(z.string().trim(), 'transform');
  });
  it('walks schema parts of template literals', () => {
    refuses(z.templateLiteral([z.string().refine(() => true)]), 'custom_check');
  });
  it('accepts a string without a transform or refinement', () => {
    expect(() => assertRepresentable(z.string().min(1), 'string')).not.toThrow();
  });
  it('refuses refine checks', () =>
    refuses(
      z.string().refine(() => true),
      'custom_check',
    ));
  it('refuses superRefine checks', () => {
    refuses(
      z.string().superRefine(() => undefined),
      'custom_check',
    );
  });
  it('refuses mini custom checks', () => {
    refuses(mini.string().check(mini.refine(() => true)), 'custom_check');
  });
  it('pins the public definition shape used to detect custom checks', () => {
    for (const schema of [
      z.string().refine(() => true),
      z.string().superRefine(() => undefined),
      mini.string().check(mini.refine(() => true)),
      mini.string().check(mini.superRefine(() => undefined)),
    ]) {
      expect(schema._zod.def).toMatchObject({
        type: 'string',
        checks: [{ _zod: { def: { check: 'custom' } } }],
      });
    }
  });
  it('refuses objects that strip unknown keys', () => refuses(z.object({}), 'lenient_object'));
  it('refuses objects that pass unknown keys through', () => {
    refuses(z.looseObject({}), 'lenient_object');
  });
  it('refuses objects with a validating catchall', () => {
    refuses(z.object({}).catchall(z.string()), 'lenient_object');
  });
  it('refuses dates', () => refuses(z.date(), 'unrepresentable_type'));
  it.each([
    z.bigint(),
    z.symbol(),
    z.function(),
    z.map(z.string(), z.string()),
    z.set(z.string()),
    z.nan(),
    z.undefined(),
    z.void(),
    z.custom(),
    z.literal(1n),
  ])('refuses other unrepresentable types %#', (schema) => {
    refuses(schema, 'unrepresentable_type');
  });
  it('refuses a cycle', () => {
    const schema: z.ZodType = z.lazy(() => z.strictObject({ child: schema }));
    refuses(schema, 'cycle');
  });
  it.each([
    z.strictObject({ child: z.array(z.string().refine(() => true)) }),
    z.tuple([z.string().refine(() => true)]),
    z.union([z.string(), z.number().refine(() => true)]),
    z.record(
      z.string(),
      z.string().refine(() => true),
    ),
    z.lazy(() => z.string().refine(() => true)),
    z
      .string()
      .refine(() => true)
      .optional()
      .default('a'),
    z.intersection(
      z.string(),
      z.string().refine(() => true),
    ),
  ])('walks nested schemas %#', (schema) => refuses(schema, 'custom_check'));
  it('keeps schema descriptions out of error messages', () => {
    try {
      assertRepresentable(z.date().describe('route-SCHEMA-ONLY-SUFFIX'), 'route');
      expect.fail('must refuse date');
    } catch (error) {
      expect(error).toBeInstanceOf(UnrepresentableSchemaError);
      expect((error as Error).message).toBe('route: unrepresentable_type');
    }
  });
});

describe('toJsonSchema', () => {
  it('omits function defaults and prefaults for deterministic exports', () => {
    let counter = 0;
    const schema = z.strictObject({
      value: z.string().default(() => String(++counter)),
      before: z.string().prefault(() => String(++counter)),
    });
    for (const io of ['input', 'output'] as const) {
      const first = JSON.stringify(toJsonSchema(schema, io));
      expect(first).toBe(JSON.stringify(toJsonSchema(schema, io)));
      expect(first).not.toContain('default');
    }
  });
  it('exports only title and description metadata and omits default values', () => {
    const sentinel = 'SCHEMA-ONLY-SENTINEL';
    const schema = z.strictObject({
      value: z
        .string()
        .default(sentinel)
        .meta({
          title: 'Value',
          description: 'Public description',
          examples: [sentinel],
          'x-internal': sentinel,
          pattern: sentinel,
          $ref: sentinel,
          $defs: { hidden: sentinel },
        }),
    });
    for (const io of ['input', 'output'] as const) {
      const result = toJsonSchema(schema, io);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(result.properties).toEqual({
        value: { title: 'Value', description: 'Public description', type: 'string' },
      });
    }
  });
  it('strips metadata IDs and inlines reused schemas without references', () => {
    const shared = z.string().meta({ id: 'review-round-one-shared', title: 'Shared' });
    const schema = z.strictObject({ a: shared, b: shared }).meta({ id: 'review-round-one-root' });
    const result = toJsonSchema(schema, 'input');
    expect(result.properties).toEqual({
      a: { title: 'Shared', type: 'string' },
      b: { title: 'Shared', type: 'string' },
    });
    const bytes = JSON.stringify(result);
    expect(bytes).not.toContain('$defs');
    expect(bytes).not.toContain('$ref');
    expect(bytes).not.toContain('review-round-one');
  });
  it('exports strict objects with unknown properties refused for both IO modes', () => {
    for (const io of ['input', 'output'] as const) {
      expect(toJsonSchema(z.strictObject({ name: z.string() }), io)).toEqual({
        additionalProperties: false,
        properties: { name: { type: 'string' } },
        required: ['name'],
        type: 'object',
      });
    }
  });
  it('guards the exporter', () => {
    expect(() =>
      toJsonSchema(
        z.string().refine(() => true),
        'input',
      ),
    ).toThrow(UnrepresentableSchemaError);
  });
  it('produces identical sorted bytes for classic, mini and repeated exports', () => {
    const shared = z.string().min(1);
    const classic = z.strictObject({
      z: shared,
      a: z.array(z.strictObject({ y: shared, b: z.number() })),
    });
    const small = mini.strictObject({
      z: mini.string().check(mini.minLength(1)),
      a: mini.array(
        mini.strictObject({ y: mini.string().check(mini.minLength(1)), b: mini.number() }),
      ),
    });
    const result = toJsonSchema(classic, 'output');
    expect(JSON.stringify(result)).toBe(JSON.stringify(toJsonSchema(small, 'output')));
    expect(JSON.stringify(result)).toBe(JSON.stringify(toJsonSchema(classic, 'output')));
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('$defs');
    expectSorted(result);
  });
  it('makes defaults optional in input and required in output', () => {
    const schema = z.strictObject({ value: z.string().default('default') });
    expect(toJsonSchema(schema, 'input').required).toBeUndefined();
    expect(toJsonSchema(schema, 'output').required).toEqual(['value']);
  });
});
