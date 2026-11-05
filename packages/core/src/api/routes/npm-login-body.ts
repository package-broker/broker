const STRING = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const MEMBER = `${STRING}[ \\t\\n\\r]*:[ \\t\\n\\r]*(?:${STRING}|true|false)`;
const OBJECT = new RegExp(
  `^[ \\t\\n\\r]*\\{[ \\t\\n\\r]*(?:${MEMBER}(?:[ \\t\\n\\r]*,[ \\t\\n\\r]*${MEMBER})?)?[ \\t\\n\\r]*\\}[ \\t\\n\\r]*$`,
);
const encoder = new TextEncoder();
async function readBody(request: Request, approval: boolean): Promise<Record<string, unknown>> {
  const fail = () => new Error('invalid_request');
  const reader = request.body?.getReader();
  let bytes = new Uint8Array(0);
  if (reader !== undefined) {
    try {
      for (let reads = 0; ; reads++) {
        if (reads >= 2048) throw fail();
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes.length + value.length > 2048) throw fail();
        const next = new Uint8Array(bytes.length + value.length);
        next.set(bytes);
        next.set(value, bytes.length);
        bytes = next;
      }
    } catch {
      void reader.cancel().catch(() => undefined);
      throw fail();
    } finally {
      reader.releaseLock();
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail();
  }
  if (text === '' && !approval) return {};
  if (!OBJECT.test(text)) throw fail();
  let value: Record<string, unknown>;
  let names: string[];
  try {
    names = [
      ...text.matchAll(
        new RegExp(`(${STRING})[ \\t\\n\\r]*:[ \\t\\n\\r]*(?:${STRING}|true|false)`, 'g'),
      ),
    ].map((match) => JSON.parse(match[1]!) as string);
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw fail();
  }
  if (
    new Set(names).size !== names.length ||
    names.some((name) => (approval ? name !== 'scope' : name !== 'create' && name !== 'hostname'))
  )
    throw fail();
  if (approval) {
    if (value['scope'] !== 'read' && value['scope'] !== 'write') throw fail();
    return value;
  }
  if (value.create !== undefined && typeof value.create !== 'boolean') throw fail();
  if (
    value.hostname !== undefined &&
    (typeof value.hostname !== 'string' ||
      encoder.encode(value.hostname).length > 253 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.hostname))
  )
    throw fail();
  return value;
}

export async function readNpmLoginBody(
  request: Request,
): Promise<{ hostname?: string; create?: boolean }> {
  return (await readBody(request, false)) as { hostname?: string; create?: boolean };
}
export async function readNpmLoginApprovalBody(request: Request): Promise<void> {
  await readBody(request, true);
}
