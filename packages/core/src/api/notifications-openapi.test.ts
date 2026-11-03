import { describe, expect, it } from 'vitest';
import { generateOpenApi } from './openapi.js';
import { openApiDocument } from './openapi-document.js';
import { NOTIFICATION_API_SPECS } from './routes/notifications-schemas.js';

const SECRET_PROPERTY = /^(url|headers|signingKey|template|credentialId|destination)$/;
const REAUTH = new Set([
  'createNotificationEndpoint',
  'updateNotificationEndpoint',
  'deleteNotificationEndpoint',
]);
const generated = generateOpenApi(NOTIFICATION_API_SPECS, {
  title: openApiDocument.info.title,
  version: openApiDocument.info.version,
});
const notificationPaths = (paths: typeof openApiDocument.paths) =>
  Object.fromEntries(
    Object.entries(paths).filter(([path]) =>
      path.startsWith('/_pb/projects/{project}/notifications'),
    ),
  );

function properties(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => properties(item, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && child !== null && typeof child === 'object')
        found.push(...Object.keys(child));
      properties(child, found);
    }
  }
  return found;
}

describe('notification API contract', () => {
  it('matches the committed document; run pnpm openapi:sync after a schema change', () => {
    expect(notificationPaths(openApiDocument.paths)).toEqual(notificationPaths(generated.paths));
  });

  it('documents every notification route exactly once', () => {
    const operations = Object.values(notificationPaths(openApiDocument.paths)).flatMap((methods) =>
      Object.values(methods as Record<string, { operationId: string }>).map((op) => op.operationId),
    );
    expect(operations.sort()).toEqual(
      NOTIFICATION_API_SPECS.map((spec) => spec.api.operationId).sort(),
    );
  });

  it('documents session-only access, If-Match and no secret in any response', () => {
    for (const methods of Object.values(notificationPaths(openApiDocument.paths))) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, Record<string, unknown>>,
      )) {
        expect(operation['x-pb-session-only']).toBe(true);
        expect(operation['x-pb-permission']).toBe('project:settings:write');
        expect(
          properties(operation.responses).filter((name) => SECRET_PROPERTY.test(name)),
        ).toEqual([]);
        const ifMatch = JSON.stringify(operation.parameters ?? []).includes('"If-Match"');
        expect(ifMatch).toBe(
          method === 'patch' ||
            method === 'delete' ||
            /enable|disable/.test(String(operation.operationId)),
        );
      }
    }
  });

  it('states the reauthentication requirement on create, replacement and delete only', () => {
    for (const spec of NOTIFICATION_API_SPECS) {
      expect(/reauthentication/i.test(spec.api.summary)).toBe(REAUTH.has(spec.api.operationId));
    }
  });
});
