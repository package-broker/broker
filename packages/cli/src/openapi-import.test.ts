import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateOpenApi } from '@package-broker/core/api/openapi';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import { expect, it } from 'vitest';

it('imports OpenAPI helpers through core API subpaths from the CLI package', () => {
  const document = generateOpenApi([], { title: 'Package Broker', version: '2.0.0' });
  expect(document.openapi).toBe('3.1.0');
  expect(openApiRoute(document)).toMatchObject({ method: 'GET', path: '/_pb/openapi.json' });

  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { generateOpenApi } from '@package-broker/core/api/openapi';
       import { openApiRoute } from '@package-broker/core/api/openapi-route';
       const document = generateOpenApi([], { title: 'Package Broker', version: '2.0.0' });
       console.log(JSON.stringify({ version: document.openapi, path: openApiRoute(document).path }));`,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  expect(JSON.parse(output)).toEqual({ version: '3.1.0', path: '/_pb/openapi.json' });
});
