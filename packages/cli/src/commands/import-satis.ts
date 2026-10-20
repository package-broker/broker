import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DIAGNOSTIC_TEXT,
  WARNING_TEXT,
  planSatisImport,
  type Diagnostic,
  type PlanInput,
  type PlanResult,
} from '../import/satis.js';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export interface ImportSatisPlanOptions {
  readonly config: string;
  readonly out: string;
  readonly project?: string;
  readonly credentials?: string;
  readonly repositoryMap?: string;
  readonly baseline?: string;
  readonly mode?: 'merge' | 'override';
}

class LocalError extends Error {
  constructor(
    readonly code: 'input_unreadable' | 'input_too_large' | 'output_exists' | 'output_unwritable',
  ) {
    super(code);
  }
}

async function readInput(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new LocalError('input_unreadable');
    if (info.size > MAX_INPUT_BYTES) throw new LocalError('input_too_large');
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new LocalError('input_too_large');
    return text;
  } catch (error) {
    throw error instanceof LocalError ? error : new LocalError('input_unreadable');
  }
}

async function writeNew(path: string, bytes: string): Promise<void> {
  const temporary = join(dirname(path), `.pb-import-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new LocalError('output_unwritable');
  }
  try {
    await link(temporary, path);
  } catch (error) {
    throw new LocalError(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'output_exists' : 'output_unwritable',
    );
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function describe(diagnostic: Diagnostic): string {
  const cap = diagnostic.cap === undefined ? '' : ` [${diagnostic.cap}]`;
  return `  ${diagnostic.code} ${diagnostic.pointer || '/'} (${diagnostic.file})${cap}: ${DIAGNOSTIC_TEXT[diagnostic.code]}`;
}

function printList(title: string, lines: readonly string[]): void {
  console.log(`${title} (${lines.length})${lines.length > 0 ? ':' : ''}`);
  for (const line of lines) console.log(`  ${line}`);
}

function printWarnings(result: PlanResult): void {
  printList(
    'Warnings',
    result.warnings.map((w) => `${w.code} ${w.package}: ${WARNING_TEXT[w.code]}`),
  );
}

function printSummary(result: PlanResult, out: string): void {
  console.log('Satis import plan (offline; package and source configuration only)');
  if (!result.ok) {
    printWarnings(result);
    console.log(`Refused entries (${result.diagnostics.length}):`);
    for (const diagnostic of result.diagnostics) console.log(describe(diagnostic));
    console.log('No manifest was written.');
    return;
  }
  const { summary } = result;
  printList(
    'New sources',
    summary.sources.map((s) => `${s.name}  ${s.kind}  ${s.target}`),
  );
  if (summary.existingSources.length > 0)
    printList('Existing sources referenced', summary.existingSources);
  printList('Registered names', summary.names);
  printList(
    'Attachments to existing projects',
    summary.attachments.map((a) => `${a.project} <- ${a.source}`),
  );
  printWarnings(result);
  printList('Refused entries', []);
  console.log(
    `Not imported: ${summary.unselectedRepositories} configured repositories outside the selection, ` +
      `${summary.ignoredPresentationKeys} presentation keys, ${summary.disabledDefaultRepositories} disabled default repositories.`,
  );
  console.log('Sources start paused; enabling, sync and approval stay explicit in the UI.');
  console.log(
    'This migrates package and source configuration, not dependency locks, version history or archives.',
  );
  if (summary.noChanges) console.log('No changes.');
  console.log(`Plan hash: ${result.hash}`);
  console.log(`Manifest: ${out}`);
}

export async function runImportSatisPlan(options: ImportSatisPlanOptions): Promise<number> {
  try {
    const input: PlanInput = {
      satis: await readInput(options.config),
      ...(options.repositoryMap === undefined
        ? {}
        : { repositoryMap: await readInput(options.repositoryMap) }),
      ...(options.credentials === undefined
        ? {}
        : { credentials: await readInput(options.credentials) }),
      ...(options.baseline === undefined ? {} : { baseline: await readInput(options.baseline) }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    };
    const result = await planSatisImport(input);
    if (result.ok) await writeNew(options.out, result.canonical);
    printSummary(result, options.out);
    if (!result.ok) console.error('plan_refused');
    return result.ok ? 0 : 2;
  } catch (error) {
    console.error(error instanceof LocalError ? error.code : 'import_satis_failed');
    return 2;
  }
}
