import { redactValue } from '../audit/redact.js';

// API schemas require flagless patterns. Spell out Cc, Cf, Zl and Zp, and count
// surrogate pairs as one character while refusing lone surrogates (Cs).
const unsafeBmp =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;
const unsafeAstral =
  /\ud804[\udcbd\udccd]|\ud80d[\udc30-\udc3f]|\ud82f[\udca0-\udca3]|\ud834[\udd73-\udd7a]|\udb40[\udc01\udc20-\udc7f]/;
const codePoint = /(?:[\ud800-\udbff][\udc00-\udfff]|[^\ud800-\udfff])/;

export const SERVICE_PRINCIPAL_NAME_PATTERN = new RegExp(
  `^(?![\\s\\S]*(?:${unsafeBmp.source}|${unsafeAstral.source}))${codePoint.source}{1,100}(?![\\s\\S])`,
);

export function isValidServicePrincipalName(name: unknown): name is string {
  if (typeof name !== 'string' || !SERVICE_PRINCIPAL_NAME_PATTERN.test(name)) return false;
  const cleaned = redactValue(name, 200, 'name');
  return cleaned.ok && cleaned.value === name;
}
