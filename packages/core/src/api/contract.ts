import { safeParse, type $ZodType, type $ZodTypes } from 'zod/v4/core';
import { toJsonSchema } from './json-schema.js';
import type { OpenApiDocument } from './openapi.js';
import type { ApiRouteSpec } from './route.js';
import { errorEnvelopeSchema as baseErrorEnvelope } from './error-envelope-schema.js';

export interface ContractFinding {
  readonly check:
    | 'missing_operation'
    | 'no_sample'
    | 'required_accepted'
    | 'unknown_property_accepted'
    | 'response_mismatch';
  readonly operationId: string;
  readonly location?: string;
}

interface Sample {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

type ContractSpec =
  ApiRouteSpec | (Omit<ApiRouteSpec, 'api'> & { readonly api: { exempt: string } });

const errorEnvelopeSchema = baseErrorEnvelope.extend({
  error: baseErrorEnvelope.shape.error.refine(
    ({ code, problems }) => problems === undefined || code === 'weak_password',
  ),
});

function bodyObjects(schema: $ZodType): readonly $ZodType[] {
  const def = (schema as $ZodTypes)._zod.def;
  switch (def.type) {
    case 'object':
    case 'record':
      return [schema];
    case 'union':
      return def.options.flatMap((branch) => bodyObjects(branch));
    case 'intersection':
      return [...bodyObjects(def.left), ...bodyObjects(def.right)];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
      return bodyObjects(def.innerType);
    case 'lazy':
      return bodyObjects(def.getter());
    default:
      return [];
  }
}

function requestFor(spec: ContractSpec, sample: Sample, body: unknown): Request {
  const path = spec.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) =>
    encodeURIComponent(sample.params?.[name] ?? ''),
  );
  const url = new URL(path, 'https://contract.invalid');
  for (const [name, value] of Object.entries(sample.query ?? {})) {
    for (const item of typeof value === 'string' ? [value] : value) {
      url.searchParams.append(name, item);
    }
  }
  const headers = new Headers(sample.headers);
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(url, {
    method: spec.method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function runApiContract(input: {
  readonly specs: readonly ContractSpec[];
  readonly document: OpenApiDocument;
  readonly call: (request: Request) => Promise<Response>;
  readonly samples: Readonly<Record<string, Sample>>;
}): Promise<readonly ContractFinding[]> {
  const findings: ContractFinding[] = [];
  for (const spec of input.specs) {
    if ('exempt' in spec.api) continue;
    const { api } = spec;
    const { operationId } = api;
    const path = spec.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    const operation = input.document.paths[path]?.[spec.method.toLowerCase()];
    if (operation?.operationId !== operationId) {
      findings.push({ check: 'missing_operation', operationId });
    }
    const sample = Object.hasOwn(input.samples, operationId)
      ? input.samples[operationId]
      : undefined;
    if (sample === undefined) {
      findings.push({ check: 'no_sample', operationId });
      continue;
    }
    if (api.body !== undefined) {
      const body =
        sample.body !== null && typeof sample.body === 'object' && !Array.isArray(sample.body)
          ? (sample.body as Record<string, unknown>)
          : {};
      const schemas = bodyObjects(api.body).map((branch) => toJsonSchema(branch, 'input'));
      const bodySchema = api.body;
      const probe = async (
        changed: unknown,
        check: 'required_accepted' | 'unknown_property_accepted',
        location: string,
      ) => {
        if (safeParse(bodySchema, changed).success) return;
        const response = await input.call(requestFor(spec, sample, changed));
        if (response.status !== 400) findings.push({ check, operationId, location });
      };
      const fields = safeParse(api.body, sample.body).success ? Object.keys(body) : [];
      for (const field of fields) {
        const changed = Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));
        const escaped = field.replace(/~/g, '~0').replace(/\//g, '~1');
        await probe(changed, 'required_accepted', `/body/${escaped}`);
      }
      const properties = Object.assign(
        {},
        ...schemas.map((schema) => schema.properties ?? {}),
      ) as Record<string, unknown>;
      let extra = '__contract_unknown';
      while (Object.hasOwn(properties, extra) || Object.hasOwn(body, extra)) extra += '_';
      await probe({ ...body, [extra]: true }, 'unknown_property_accepted', '/body');
    }
    const response = await input.call(requestFor(spec, sample, sample.body));
    if (!Object.hasOwn(api.responses, response.status)) {
      findings.push({ check: 'response_mismatch', operationId });
      continue;
    }
    const schema = api.responses[response.status];
    let valid: boolean;
    try {
      valid =
        schema === null
          ? response.status >= 400
            ? safeParse(errorEnvelopeSchema, await response.json()).success
            : (await response.text()) === ''
          : schema !== undefined && safeParse(schema, await response.json()).success;
    } catch {
      valid = false;
    }
    if (!valid) findings.push({ check: 'response_mismatch', operationId });
  }
  return findings;
}
