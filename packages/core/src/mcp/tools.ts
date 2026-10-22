import * as z from 'zod/mini';
import type { $ZodType } from 'zod/v4/core';
import { toJsonSchema, type JsonObject } from '../api/json-schema.js';
import { apiError } from '../api/response.js';
import { validateInput, type ValidationDetail } from '../api/validate.js';
import type { Kernel } from '../kernel/kernel.js';
import { parsePublicOrigin } from '../kernel/public-origin.js';
import type { ApiSlot, RouteDefinition } from '../plugin.js';
import { dispatchTool } from './dispatch.js';
import { McpError, type McpHandler } from './transport.js';

export interface McpToolsOptions {
  readonly routes: readonly Pick<RouteDefinition, 'method' | 'path' | 'api'>[];
  readonly publicOrigin: string;
  readonly kernel: Pick<Kernel, 'fetch'>;
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  listProjects: 'list_projects',
  getProject: 'get_project',
  listProjectPackages: 'list_packages',
  listProjectPackageVersions: 'get_package_versions',
  getMe: 'whoami',
};
const empty = z.strictObject({});
const argumentShape = z.strictObject({
  params: z.optional(z.unknown()),
  query: z.optional(z.unknown()),
});
const callShape = z.strictObject({
  name: z.string(),
  arguments: z.optional(z.unknown()),
  _meta: z.optional(z.unknown()),
});

function stringFields(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

interface Tool {
  readonly path: string;
  readonly api: ApiSlot;
  readonly description: string;
  readonly name: string;
  readonly inputSchema: JsonObject;
}

function inputSchema(api: ApiSlot): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const location of ['params', 'query'] as const) {
    const schema = toJsonSchema(api[location] ?? empty, 'input');
    if (schema.type !== 'object') throw new TypeError('MCP input schema must be an object');
    properties[location] = schema;
    if (Array.isArray(schema.required) && schema.required.length > 0) required.push(location);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function check(schema: $ZodType | undefined, value: unknown, location: string): ValidationDetail[] {
  const result = validateInput(schema ?? empty, value === undefined ? {} : value);
  return result.ok
    ? []
    : result.details.map((detail) => ({ path: `/${location}${detail.path}`, code: detail.code }));
}

export function createMcpTools(options: McpToolsOptions): Readonly<Record<string, McpHandler>> {
  const origin = parsePublicOrigin(options.publicOrigin, { http: 'allow' });
  if (origin !== options.publicOrigin) throw new TypeError('MCP public origin must be canonical');
  const tools = new Map<string, Tool>();
  for (const route of options.routes) {
    const api = route.api;
    if (api === undefined || api.exempt !== undefined || api.mcp !== true) continue;
    if (route.method !== 'GET' || api.body !== undefined)
      throw new TypeError('MCP tools must be GET routes without a body');
    if (!route.path.startsWith('/_pb/') || /[?#\\]/.test(route.path))
      throw new TypeError('Invalid MCP route path');
    const name = Object.hasOwn(TOOL_NAMES, api.operationId)
      ? TOOL_NAMES[api.operationId]!
      : api.operationId.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (tools.has(name)) throw new TypeError('Duplicate MCP tool name');
    const schema = inputSchema(api);
    const params = (schema.properties as JsonObject)['params'] as JsonObject;
    const names = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
    const properties = (params.properties ?? {}) as JsonObject;
    if (
      names.some((param) => !Object.hasOwn(properties, param)) ||
      Object.keys(properties).some((param) => !names.includes(param))
    )
      throw new TypeError('MCP path and params schema disagree');
    tools.set(name, { path: route.path, api, name, description: api.summary, inputSchema: schema });
  }

  return Object.freeze({
    'tools/list': async () => ({
      tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    }),
    'tools/call': async (raw, ctx) => {
      const call = validateInput(callShape, raw);
      if (!call.ok) throw new McpError(-32602);
      const tool = tools.get(call.data.name);
      if (tool === undefined) throw new McpError(-32602);
      const args = validateInput(
        argumentShape,
        call.data.arguments === undefined ? {} : call.data.arguments,
      );
      const details = args.ok
        ? [
            ...check(tool.api.params, args.data.params, 'params'),
            ...check(tool.api.query, args.data.query, 'query'),
          ].slice(0, 20)
        : args.details;
      const input = call.data.arguments;
      const locations =
        typeof input === 'object' && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      return dispatchTool(
        {
          kernel: options.kernel,
          origin,
          path: tool.path,
          params: stringFields(locations['params']),
          query: stringFields(locations['query']),
          ...(!args.ok || details.length > 0
            ? { validationError: await apiError('invalid_request', ctx.requestId, details).text() }
            : {}),
          paginated:
            tool.api.query !== undefined &&
            Object.hasOwn(
              ((tool.inputSchema.properties as JsonObject)['query'] as JsonObject)
                .properties as JsonObject,
              'limit',
            ),
        },
        ctx,
      );
    },
  } satisfies Record<string, McpHandler>);
}
