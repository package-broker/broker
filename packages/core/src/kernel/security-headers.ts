const HSTS = 'max-age=31536000; includeSubDomains';

export function finaliseSecurityHeaders(
  response: Response,
  https: boolean,
  noStore: boolean,
): Response {
  const copy = new Response(response.body, response);
  if (!copy.headers.has('x-content-type-options')) {
    copy.headers.set('x-content-type-options', 'nosniff');
  }
  if (!copy.headers.has('referrer-policy')) {
    copy.headers.set('referrer-policy', 'no-referrer');
  }
  if (https) copy.headers.set('strict-transport-security', HSTS);
  else copy.headers.delete('strict-transport-security');
  if (noStore) copy.headers.set('cache-control', 'no-store');
  return copy;
}
