import { NotificationError, type NotificationSecretInput } from '../../notifications/endpoints.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute, type RouteOutcome } from '../route.js';
import { projectSessionCallContext } from './context.js';
import {
  endpointBody,
  humanProject,
  readOutcome,
  type NotificationRouteDeps,
} from './notifications-read.js';
import { NOTIFICATION_API_SPECS } from './notifications-schemas.js';

type Spec = (typeof NOTIFICATION_API_SPECS)[number];
type Outcome = RouteOutcome<Spec>;

interface SecretBody {
  readonly url: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly signingKey: string;
  readonly template?: string | null | undefined;
}

function secretInput(body: SecretBody): NotificationSecretInput {
  return {
    url: body.url,
    headers: (body.headers ?? []).map((header) => [header.name, header.value]),
    signingKey: body.signingKey,
    template: body.template ?? null,
  };
}

/** Create, destination or secret replacement and delete need a recent reauthentication. */
export function notificationWriteRoutes(deps: NotificationRouteDeps): readonly RouteDefinition[] {
  const [, create, , update, enable, disable, remove] = NOTIFICATION_API_SPECS;

  function call(ctx: RequestContext) {
    return humanProject(ctx) === null ? null : projectSessionCallContext(ctx, deps);
  }

  async function fresh(
    ctx: RequestContext,
    c: NonNullable<ReturnType<typeof call>>,
  ): Promise<boolean> {
    const authenticated = await deps.sessions.authenticate(c.org, ctx.request);
    return (
      authenticated !== null &&
      authenticated.session.id === c.fence.sessionId &&
      authenticated.session.userId === c.fence.userId &&
      deps.sessions.isReauthFresh(authenticated)
    );
  }

  async function serviced(run: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NotificationError) return { serviceError: error.code };
      throw error;
    }
  }

  async function current(
    c: NonNullable<ReturnType<typeof call>>,
    id: string,
    status: 200 | 201,
  ): Promise<Outcome> {
    return readOutcome(async () => {
      const found = await deps.reads.getEndpoint(c.org, c.projectId, id);
      return found === null
        ? { error: 'not_found' }
        : { status, body: endpointBody(found), etag: found.revision };
    });
  }

  return [
    apiRoute(create, async ({ ctx, body }) => {
      const c = call(ctx);
      if (c === null) return { error: 'forbidden' };
      if (!(await fresh(ctx, c))) return { error: 'reauth_required' };
      return serviced(async () => {
        const created = await deps.service.create(
          c.org,
          c.fence,
          c.projectId,
          {
            name: body.name,
            method: body.method,
            events: body.events,
            packagePattern: body.packagePattern,
            secret: secretInput(body.secret),
          },
          c.call,
        );
        return current(c, created.id, 201);
      });
    }),
    apiRoute(update, async ({ ctx, params, body, expectedRevision }) => {
      const c = call(ctx);
      if (c === null) return { error: 'forbidden' };
      if (body.options === undefined && body.secret === undefined)
        return { error: 'invalid_request', details: [{ path: '/body', code: 'invalid' }] };
      if (body.secret !== undefined && !(await fresh(ctx, c))) return { error: 'reauth_required' };
      return serviced(async () => {
        await deps.service.update(
          c.org,
          c.fence,
          c.projectId,
          params.id,
          {
            expectedRevision: expectedRevision!,
            ...(body.options === undefined ? {} : { options: body.options }),
            ...(body.secret === undefined ? {} : { secret: secretInput(body.secret) }),
          },
          c.call,
        );
        return current(c, params.id, 200);
      });
    }),
    ...(
      [
        [enable, 'enable'],
        [disable, 'disable'],
      ] as const
    ).map(([spec, kind]) =>
      apiRoute(spec, async ({ ctx, params, expectedRevision }) => {
        const c = call(ctx);
        if (c === null) return { error: 'forbidden' };
        return serviced(async () => {
          await deps.service[kind](
            c.org,
            c.fence,
            c.projectId,
            params.id,
            expectedRevision!,
            c.call,
          );
          return current(c, params.id, 200);
        });
      }),
    ),
    apiRoute(remove, async ({ ctx, params, expectedRevision }) => {
      const c = call(ctx);
      if (c === null) return { error: 'forbidden' };
      if (!(await fresh(ctx, c))) return { error: 'reauth_required' };
      return serviced(async () => {
        await deps.service.delete(
          c.org,
          c.fence,
          c.projectId,
          params.id,
          expectedRevision!,
          c.call,
        );
        return { status: 204 };
      });
    }),
  ];
}
