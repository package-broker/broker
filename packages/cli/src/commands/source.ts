import { SESSION_COOKIE, COOKIE_VALUE_PATTERN } from '@package-broker/core/auth/cookies';
import { isUlid } from '@package-broker/core/ids';

export interface AcceptRemovalOptions {
  readonly url: string;
  readonly source: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

export async function runSourceAcceptRemoval(options: AcceptRemovalOptions): Promise<number> {
  const say = (message: string) => console.error(`source accept-removal: ${message}`);
  let origin: URL;
  try {
    origin = new URL(options.url);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new TypeError();
  } catch {
    say('invalid broker origin; use an HTTPS origin');
    return 2;
  }
  if (!isUlid(options.source)) {
    say('invalid source');
    return 2;
  }
  const session = options.env['PB_SESSION'];
  const csrf = options.env['PB_CSRF_TOKEN'];
  if (
    !session ||
    !COOKIE_VALUE_PATTERN.test(session) ||
    !csrf ||
    !/^[A-Za-z0-9_-]{43}$/.test(csrf)
  ) {
    say('set PB_SESSION and PB_CSRF_TOKEN from an organization admin session');
    return 2;
  }
  try {
    const response = await (options.fetch ?? fetch)(
      new URL(`/_pb/sources/${options.source}/accept-removal`, origin),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          origin: origin.origin,
          cookie: `${SESSION_COOKIE}=${session}`,
          'x-csrf-token': csrf,
        },
      },
    );
    if (response.status === 204) {
      console.log('Removal acceptance armed for the next refused sync.');
      return 0;
    }
    say(
      response.status === 409
        ? 'no acceptable refusal to accept'
        : response.status === 404
          ? 'source not found'
          : response.status === 401 || response.status === 403
            ? 'authorization refused'
            : 'request failed',
    );
    return 1;
  } catch {
    say('outcome unknown; check source state before retrying');
    return 6;
  }
}
