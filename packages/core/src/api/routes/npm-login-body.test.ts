import { expect, it, vi } from 'vitest';
import { readNpmLoginBody, readNpmLoginApprovalBody } from './npm-login-body.js';
const read = (body: string) =>
  readNpmLoginBody(new Request('https://test', { method: 'POST', body }));
it('accepts only empty input or flat create/hostname objects', async () => {
  for (const body of ['', '{}', '{"create":true,"hostname":"cli"}'])
    await expect(read(body)).resolves.toBeDefined();
  for (const body of [
    '[]',
    'null',
    '{"extra":1}',
    '{"extra":true}',
    '{"create":"true"}',
    '{"hostname":{}}',
    '{"create":true,"create":false}',
    '{"hostname":"\\u0000"}',
  ])
    await expect(read(body)).rejects.toThrow('invalid_request');
});
it('caps bytes before parsing, members, hostname bytes and nesting', async () => {
  for (const body of [
    ' '.repeat(2049),
    ' '.repeat(2047) + '{}',
    '{"hostname":"' + 'é'.repeat(127) + '"}',
    '{"a":{"a":{}}}',
    '{"a":1,"b":2,"c":3}',
  ])
    await expect(read(body)).rejects.toThrow('invalid_request');
  await expect(read('{"hostname":"' + 'x'.repeat(253) + '"}')).resolves.toEqual({
    hostname: 'x'.repeat(253),
  });
});
it('bounds stream reads and rejects malformed UTF-8', async () => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ < 2049) controller.enqueue(new Uint8Array());
      else controller.close();
    },
  });
  const request = new Request('https://test', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  await expect(readNpmLoginBody(request)).rejects.toThrow('invalid_request');
  await expect(
    readNpmLoginBody(new Request('https://test', { method: 'POST', body: new Uint8Array([255]) })),
  ).rejects.toThrow('invalid_request');
});

it('accepts only a bounded one-field read or write approval', async () => {
  for (const scope of ['read', 'write'])
    await expect(
      readNpmLoginApprovalBody(
        new Request('https://test', { method: 'POST', body: JSON.stringify({ scope }) }),
      ),
    ).resolves.toBeUndefined();
  for (const body of [
    '',
    '{}',
    '{"scope":"full"}',
    '{"scope":"read","scope":"write"}',
    '{"scope":"read","extra":true}',
    ' '.repeat(2049),
    '[]',
    '{"scope":{"read":true}}',
  ])
    await expect(
      readNpmLoginApprovalBody(new Request('https://test', { method: 'POST', body })),
    ).rejects.toThrow('invalid_request');
});

it('accepts only JSON whitespace and maps parser failures to invalid_request', async () => {
  await expect(read(' \t\r\n{ "hostname" : "cli" } \n')).resolves.toEqual({ hostname: 'cli' });
  for (const space of ['\u00a0', '\u000b', '\u000c', '\u2028', '\ufeff']) {
    for (const body of [
      space + '{}',
      '{' + space + '"hostname":"cli"}',
      '{"hostname"' + space + ':"cli"}',
    ])
      await expect(read(body)).rejects.toThrow('invalid_request');
  }
});

it.each(['member', 'object'])('normalizes a %s JSON parser failure', async (part) => {
  const parse = vi.spyOn(JSON, 'parse');
  if (part === 'object') parse.mockReturnValueOnce('hostname');
  parse.mockImplementationOnce(() => {
    throw new SyntaxError('private parser diagnostic');
  });
  try {
    await expect(read('{"hostname":"cli"}')).rejects.toThrow('invalid_request');
  } finally {
    parse.mockRestore();
  }
});

it('refuses non-JSON whitespace before invoking the JSON parser', async () => {
  const parse = vi.spyOn(JSON, 'parse');
  try {
    for (const body of ['\u00a0{}', '{\u000b"hostname":"cli"}', '{"hostname"\u2028:"cli"}']) {
      await expect(read(body)).rejects.toThrow('invalid_request');
      expect(parse).not.toHaveBeenCalled();
    }
  } finally {
    parse.mockRestore();
  }
});
