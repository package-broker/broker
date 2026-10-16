import { envelopeResponse } from './errors.js';

export const DENIAL_MESSAGE =
  'You do not have access. Ask an organization administrator to assign you to a project.';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Access denied</title>
</head>
<body>
<main>
<h1>Access denied</h1>
<p>${DENIAL_MESSAGE}</p>
</main>
</body>
</html>
`;

function quality(accept: string, types: readonly string[]): number {
  let best = 0;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    if (!types.includes(range)) continue;
    const q = params.find((param) => param.startsWith('q='));
    const value = q === undefined ? 1 : Number(q.slice(2));
    if (Number.isFinite(value) && value >= 0 && value <= 1 && value > best) best = value;
  }
  return best;
}

function prefersHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  const html = quality(accept, ['text/html']);
  return html > 0 && html > quality(accept, ['application/json', 'application/*', '*/*']);
}

/** Generic 403 for an authenticated caller: static page for browsers, the envelope otherwise. */
export function denialResponse(request: Request, requestId: string): Response {
  if (!prefersHtml(request)) {
    const response = envelopeResponse(403, 'forbidden', 'Forbidden', requestId);
    response.headers.set('vary', 'Accept');
    return response;
  }
  return new Response(PAGE, {
    status: 403,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      vary: 'Accept',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}
