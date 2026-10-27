import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { parseRuntimeProviders } from '@package-broker/plugin-sso-oidc/definitions';
import { CloudflareError } from './api.js';

export type ProvidersOption =
  { kind: 'absent' } | { kind: 'remove' } | { kind: 'set'; value: string; ids: string[] };
type Stage = 'deploy' | 'setup';
function invalid(problem: string, stage: Stage): never {
  const error = new CloudflareError('invalid_input', 2, false, stage);
  error.message = `Invalid providers: ${problem}`;
  throw error;
}

async function readBoundedFile(path: string, stage: Stage): Promise<Uint8Array> {
  const check = (info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) invalid('unreadable', stage);
    if (info.size > 65536) invalid('file_too_large', stage);
  };
  check(await stat(path));
  await using file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  check(await file.stat());
  const buffer = Buffer.alloc(65537);
  let offset = 0,
    bytesRead: number;
  do {
    ({ bytesRead } = await file.read(buffer, offset, buffer.length - offset, null));
    offset += bytesRead;
  } while (bytesRead && offset < buffer.length);
  return buffer.subarray(0, offset);
}

function scanMembers(raw: string, stage: Stage): void {
  const stack: (Set<string> | null)[] = [];
  let key = '';
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === '"') {
      const start = i++;
      for (; raw[i] !== '"'; i++) if (raw[i] === '\\') i++;
      key = JSON.parse(raw.slice(start, i + 1));
    } else if (token === ':') {
      const keys = stack.at(-1);
      if (keys?.has(key)) invalid('duplicate_member', stage);
      keys?.add(key);
    }
  }
}

export async function readProvidersOption(
  value: string | undefined,
  readFile = readBoundedFile,
  stage: Stage = 'deploy',
): Promise<ProvidersOption> {
  if (value === undefined) return { kind: 'absent' };
  if (value === 'none') return { kind: 'remove' };
  let problem = 'unreadable';
  try {
    const bytes = await readFile(value, stage);
    if (bytes.byteLength > 65536) return invalid('file_too_large', stage);
    problem = 'encoding';
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    problem = 'syntax';
    const compact = JSON.stringify(JSON.parse(raw));
    scanMembers(raw, stage);
    const parsed = parseRuntimeProviders(compact);
    if (parsed.documentProblem !== null) return invalid(parsed.documentProblem, stage);
    const rejected = parsed.rejected.map(({ index, id, codes }) => ({ index, id, codes }));
    if (rejected.length) return invalid(`invalid_entries: ${JSON.stringify(rejected)}`, stage);
    return { kind: 'set', value: compact, ids: parsed.accepted.map(({ id }) => id) };
  } catch (error) {
    if (error instanceof CloudflareError) throw error;
    return invalid(problem, stage);
  }
}
