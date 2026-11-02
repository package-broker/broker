import { describe, expect, it } from 'vitest';
import { openApiDocument } from './openapi-document.js';
import { POLICY_API_SPECS } from './routes/policies-schemas.js';

type Operation = {
  readonly operationId: string;
  readonly requestBody?: { content: Record<string, { schema: unknown }> };
  readonly responses: Record<string, unknown>;
};
const paths = (openApiDocument as unknown as { paths: Record<string, Record<string, Operation>> })
  .paths;

function openApiPath(path: string): string {
  return path.replace(/:([a-z]+)/g, '{$1}');
}

function policyOperations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (/polic/i.test(path) || /Polic/.test(operation.operationId)) {
        found.set(operation.operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return found;
}

function bodyOf(path: string, method: string): string {
  const operation = paths[openApiPath(path)]?.[method.toLowerCase()];
  return JSON.stringify(operation?.requestBody?.content['application/json']?.schema ?? null);
}

describe('generated registry policy API contract', () => {
  it('documents exactly the declared management operations', () => {
    const declared = new Map(
      POLICY_API_SPECS.map((spec) => [
        spec.api.operationId,
        `${spec.method} ${openApiPath(spec.path)}`,
      ]),
    );
    expect(policyOperations()).toEqual(declared);
  });

  it('carries the denyUnknown flag, member sets and fixed reasons in the request bodies', () => {
    for (const path of ['/_pb/policies', '/_pb/projects/:project/policies']) {
      const create = bodyOf(path, 'POST');
      expect(create).toContain('"denyUnknown":{"type":"boolean"}');
      expect(create).toContain('"members"');
      const patch = bodyOf(`${path}/:policy`, 'PATCH');
      expect(patch).toContain('"members"');
      expect(patch).toContain('"denyUnknown":{"type":"boolean"}');
      expect(patch).toContain('"false_positive","emergency_compatibility","superseded","other"');
    }
  });
});
