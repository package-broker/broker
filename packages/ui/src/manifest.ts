export const UI_CONTENT_TYPES = [
  'text/html',
  'text/javascript',
  'text/css',
  'application/json',
  'image/svg+xml',
  'font/woff2',
] as const;

export type UiContentType = (typeof UI_CONTENT_TYPES)[number];

export interface UiManifestFile {
  readonly contentType: UiContentType;
  readonly bytes: number;
}

export interface UiManifest {
  readonly version: 1;
  readonly entry: string;
  readonly files: Readonly<Record<string, UiManifestFile>>;
}

const BUDGET_GROWTH_PERCENT = 10;
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, UiContentType>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function isContentType(value: unknown): value is UiContentType {
  return (UI_CONTENT_TYPES as readonly unknown[]).includes(value);
}

export function parseUiManifest(text: string): UiManifest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('UI manifest is not valid JSON');
  }
  if (!isRecord(body)) throw new Error('UI manifest must be a JSON object');
  if (body.version !== 1) throw new Error('UI manifest version must be 1');
  if (typeof body.entry !== 'string') throw new Error('UI manifest entry must be a string');
  if (!isRecord(body.files)) throw new Error('UI manifest files must be an object');

  const files: Record<string, UiManifestFile> = Object.create(null);
  for (const [name, descriptor] of Object.entries(body.files)) {
    if (!isSafeFileName(name)) throw new Error(`UI manifest file name is not allowed: ${name}`);
    if (!isRecord(descriptor)) throw new Error(`UI manifest file ${name} must be an object`);
    const { contentType, bytes } = descriptor;
    if (!isContentType(contentType)) {
      throw new Error(`UI manifest content type is not allowed for ${name}`);
    }
    const extension = /\.[^.]+$/.exec(name)?.[0];
    const expectedType = extension ? CONTENT_TYPE_BY_EXTENSION[extension] : undefined;
    if (expectedType && contentType !== expectedType) {
      throw new Error(`UI manifest content type does not match extension for ${name}`);
    }
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`UI manifest bytes must be a non-negative integer for ${name}`);
    }
    files[name] = { contentType, bytes };
  }
  if (!Object.hasOwn(files, body.entry)) {
    throw new Error(`UI manifest entry is not a listed file: ${body.entry}`);
  }
  return { version: 1, entry: body.entry, files };
}

export function findInlineCode(html: string): string[] {
  const found: string[] = [];
  if (/<script\b(?![^>]*(?<![\w-])src\s*=)[^>]*>/i.test(html)) found.push('inline script');
  if (/<style\b/i.test(html)) found.push('style element');
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) found.push('style attribute');
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) found.push('event handler attribute');
  if (/javascript:/i.test(html)) found.push('javascript URL');
  return found;
}

export function checkBudget(total: number, budget: number): { ok: boolean; limit: number } {
  const limit = Math.floor((budget * (100 + BUDGET_GROWTH_PERCENT)) / 100);
  return { ok: total <= limit, limit };
}
