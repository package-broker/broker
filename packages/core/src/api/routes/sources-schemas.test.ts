import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../json-schema.js';
import { generateOpenApi } from '../openapi.js';
import { openApiDocument } from '../openapi-document.js';
import { SOURCE_API_SPECS } from './sources-schemas.js';

const github = { provider: 'github', repository: 'acme/widgets', repositoryId: 42 };

describe('source repository identity contract', () => {
  for (const boundary of ['organization', 'project']) {
    const specs = SOURCE_API_SPECS.filter((spec) => spec.boundary === boundary);
    for (const method of ['POST', 'PATCH']) {
      const spec = specs.find((spec) => spec.method === method)!;
      it(`refuses client-supplied GitHub ids in ${boundary} ${method} bodies`, () => {
        if (!('body' in spec.api)) throw new Error('expected request body');
        const body = spec.api.body;
        const base =
          method === 'POST' ? { name: 'Widgets', type: 'vcs', ecosystem: 'composer' } : {};
        const manual = { provider: 'github', repository: 'acme/widgets' };
        expect(body.safeParse({ ...base, config: manual }).success).toBe(true);
        for (const repositoryId of [
          1,
          42,
          Number.MAX_SAFE_INTEGER,
          0,
          -1,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          '42',
          null,
        ]) {
          expect(body.safeParse({ ...base, config: { ...github, repositoryId } }).success).toBe(
            false,
          );
        }
        for (const provider of ['git', 'ssh']) {
          expect(body.safeParse({ ...base, config: { ...github, provider } }).success).toBe(false);
        }
        expect(body.safeParse({ ...base, config: { ...github, managed: true } }).success).toBe(
          false,
        );
      });
    }
  }

  it('publishes repository ids only in responses in the served OpenAPI contract', () => {
    const generated = generateOpenApi(SOURCE_API_SPECS, {
      title: 'Package Broker',
      version: '2.0.0',
    });
    for (const path of ['/_pb/sources', '/_pb/projects/{project}/sources']) {
      for (const method of ['post', 'patch'] as const) {
        const target = method === 'patch' ? `${path}/{source}` : path;
        const operation = generated.paths[target]![method]!;
        expect(openApiDocument.paths[target]![method]!.requestBody).toEqual(operation.requestBody);
        const requestBody = operation.requestBody as JsonObject;
        const content = requestBody.content as JsonObject;
        const media = content['application/json'] as JsonObject;
        const schema = media.schema as JsonObject;
        const properties = schema.properties as JsonObject;
        const config = properties.config as JsonObject;
        const branches = config.anyOf as JsonObject[];
        const github = branches.find((branch) => {
          const properties = branch.properties as JsonObject;
          return (properties.provider as JsonObject | undefined)?.const === 'github';
        });
        expect(github).toMatchObject({
          required: ['provider', 'repository'],
          additionalProperties: false,
        });
        expect(github!.properties).not.toHaveProperty('repositoryId');
        for (const branch of branches) {
          expect(branch.properties).not.toHaveProperty('repositoryId');
        }
      }
      expect(openApiDocument.paths[path]!.get!.responses).toEqual(
        generated.paths[path]!.get!.responses,
      );
      expect(JSON.stringify(generated.paths[path]!.get!.responses)).toContain('"repositoryId"');
    }
  });
});
