import { open, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
import { brokerOrigin } from '../import/client.js';
import {
  AuditArtifactError,
  AuditArtifactVerifier,
  object,
  parseAuditHead,
  requireAudit,
  safeAuditItem,
  safeDisposition,
} from './audit-artifact.js';

export async function runAuditExport(argv: readonly string[]): Promise<number> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let output: string | undefined;
  let preserve = false;
  let argumentsValidated = false;
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      options: {
        broker: { type: 'string' },
        'cookie-env': { type: 'string' },
        output: { type: 'string' },
        resume: { type: 'string' },
        format: { type: 'string' },
      },
    });
    if (
      positionals.length ||
      !values.broker ||
      (!values.output && !values.resume) ||
      (values.output !== undefined && values.resume !== undefined) ||
      values.format !== 'jsonl' ||
      !values['cookie-env'] ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['cookie-env'])
    )
      throw new TypeError();
    let origin: string;
    try {
      origin = brokerOrigin(values.broker);
    } catch {
      throw new TypeError();
    }
    const cookie = process.env[values['cookie-env']];
    if (!cookie || !/^[\x20-\x7e]+$/.test(cookie)) throw new TypeError();
    argumentsValidated = true;
    output = values.resume ?? values.output!;
    const verifier = new AuditArtifactVerifier();
    const dispositions = new Set<string>();
    let pinned: ReturnType<typeof parseAuditHead> | undefined;
    let from: number | undefined;
    if (values.resume) {
      const size = (await stat(output)).size;
      let checkpoint = 0;
      let offset = 0;
      const stream = createReadStream(output);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          requireAudit(Buffer.byteLength(line) <= 131072);
          offset += Buffer.byteLength(line) + 1;
          if (offset > size) break;
          const value: unknown = JSON.parse(line);
          requireAudit(object(value) && value.kind !== 'end');
          if (checkpoint === 0 && offset === Buffer.byteLength(line) + 1) {
            requireAudit(value.broker === origin);
            checkpoint = offset;
          }
          if (value.kind === 'cursor') checkpoint = offset;
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      requireAudit(checkpoint > 0);
      const retained = createReadStream(output, { end: checkpoint - 1 });
      const retainedLines = createInterface({ input: retained, crlfDelay: Infinity });
      try {
        for await (const line of retainedLines) {
          const value: unknown = JSON.parse(line);
          await verifier.consume(value, line);
          if (object(value) && value.kind === 'disposition')
            dispositions.add(safeDisposition(value.entry).id);
        }
      } finally {
        retainedLines.close();
        retained.destroy();
      }
      const progress = verifier.progress();
      pinned = progress.head;
      from = pinned.headSeq === 0 ? 0 : progress.next;
      file = await open(output, 'r+');
      await file.truncate(checkpoint);
      await file.close();
      file = await open(output, 'a');
      preserve = true;
    } else {
      try {
        file = await open(output, 'wx', 0o600);
      } catch (error) {
        if (object(error) && error.code === 'EEXIST') throw new AuditArtifactError('output_exists');
        throw error;
      }
    }
    const write = async (value: unknown) => {
      const line = JSON.stringify(value);
      await verifier.consume(value, line);
      await file!.writeFile(line + '\n');
    };
    let requests = 0;
    let retries = 0;
    while (!pinned || from! <= pinned.headSeq) {
      if (requests > 0 && requests % 10 === 0) await delay(60001);
      requests++;
      const url = new URL('/_pb/audit/export', origin);
      if (from !== undefined && pinned && pinned.headSeq > 0) {
        url.searchParams.set('from_seq', String(from));
        url.searchParams.set('to_seq', String(Math.min(pinned.headSeq, from + 1999)));
      }
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { cookie, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new AuditArtifactError('request_failed');
      }
      if (response.status !== 200) {
        const retryAfter = response.headers.get('retry-after');
        let reauth = false;
        if (response.status === 403) {
          try {
            const error: unknown = await response.json();
            reauth = object(error) && object(error.error) && error.error.code === 'reauth_required';
          } catch {
            /* A non-JSON refusal still maps to forbidden. */
          }
        }
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429 && retries++ < 3) {
          const seconds =
            retryAfter === null
              ? 60
              : /^\d+$/.test(retryAfter)
                ? Number(retryAfter)
                : (Date.parse(retryAfter) - Date.now()) / 1000;
          if (Number.isFinite(seconds)) {
            await delay(Math.max(1000, Math.min(60000, seconds * 1000)));
            continue;
          }
        }
        throw new AuditArtifactError(
          response.status === 401 || reauth
            ? 'reauth_required'
            : response.status === 403
              ? 'forbidden'
              : response.status === 429
                ? 'rate_limited'
                : 'request_refused',
        );
      }
      retries = 0;
      requireAudit(response.body);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          requireAudit(size <= 32 * 1024 * 1024);
          chunks.push(chunk.value);
        }
      } catch (error) {
        if (error instanceof AuditArtifactError) throw error;
        throw new AuditArtifactError('request_failed');
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireAudit(object(body) && body.schema === 'audit-chain/1');
      const head = parseAuditHead(body.snapshot);
      if (!pinned) {
        pinned = head;
        await write({
          kind: 'audit-export',
          version: 1,
          schema: 'audit-chain/1',
          snapshot: pinned,
          broker: origin,
        });
        preserve = true;
        from = head.headSeq === 0 ? 0 : head.boundarySeq;
      }
      if (head.chainId !== pinned.chainId || head.epoch !== pinned.epoch)
        throw new AuditArtifactError('chain_changed');
      requireAudit(
        head.boundarySeq === pinned.boundarySeq &&
          head.boundaryPrevHash === pinned.boundaryPrevHash &&
          head.headSeq >= pinned.headSeq &&
          (head.headSeq !== pinned.headSeq || head.headHash === pinned.headHash),
      );
      const empty = pinned.boundarySeq > pinned.headSeq;
      const to = empty ? from! : Math.min(pinned.headSeq, from! + 1999);
      requireAudit(
        body.fromSeq === from &&
          body.toSeq === to &&
          body.next_from_seq === (to < head.headSeq ? to + 1 : null),
      );
      requireAudit(
        Array.isArray(body.items) &&
          body.items.length <= 2000 &&
          Array.isArray(body.dispositions) &&
          body.dispositions.length <= 2000,
      );
      for (const item of body.items) await write(await safeAuditItem(item));
      for (const value of body.dispositions) {
        const entry = safeDisposition(value);
        if (!dispositions.has(entry.id)) {
          await write({ kind: 'disposition', entry });
          dispositions.add(entry.id);
        }
      }
      await write({ kind: 'cursor', next: verifier.progress().next });
      await file.sync();
      from = to + 1;
      if (empty) break;
    }
    await write(verifier.footer());
    const result = verifier.result();
    await file.sync();
    await file.close();
    file = undefined;
    preserve = true;
    console.log(
      JSON.stringify({ result: 'exported', bodies: result.bodies, withheld: result.withheld }),
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof AuditArtifactError
        ? error.code
        : error instanceof TypeError
          ? argumentsValidated
            ? 'invalid_artifact'
            : 'invalid_input'
          : 'operation_refused';
    console.error(`audit export: ${code}`);
    return error instanceof TypeError && !argumentsValidated ? 2 : 1;
  } finally {
    if (file) {
      await file.close().catch(() => undefined);
      if (!preserve && output) await unlink(output).catch(() => undefined);
    }
  }
}
