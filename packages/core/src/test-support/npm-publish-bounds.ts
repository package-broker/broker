import { entry, manifest, pax } from './npm-publish.js';

export function* publishPathFlood(count = 24_000): Generator<Uint8Array> {
  yield entry('package/package.json', manifest);
  for (let i = 0; i < count; i++) {
    const path = 'package/' + String(i).padStart(5, '0') + 'é'.repeat(2000);
    yield entry('extension', pax('path', path), 'x');
    yield entry('placeholder');
  }
  yield new Uint8Array(1024);
}

export function* repositoryRuleFlood(
  kind: 'ignore' | 'manifest' | 'compiled' = 'ignore',
  count = 600,
): Generator<Uint8Array> {
  yield entry(
    'repo/package.json',
    kind === 'manifest'
      ? JSON.stringify({
          name: 'test-package',
          version: '1.0.0',
          dependencies: Object.fromEntries(Array.from({ length: count }, (_, i) => ['p' + i, '*'])),
          bundleDependencies: Array.from({ length: count }, (_, i) => 'p' + i),
        })
      : manifest,
  );
  for (let i = 0; i < count; i++) {
    if (kind === 'manifest')
      yield entry(
        'repo/node_modules/p' + i + '/package.json',
        '{"padding":"' + ' '.repeat(262120) + '"}',
      );
    else if (kind === 'compiled') {
      const list = '{' + Array.from({ length: 16 }, (_, j) => j).join(',') + '}';
      yield entry('repo/d' + i + '/.npmignore', 'a'.repeat(3000) + i + list);
    } else yield entry('repo/d' + i + '/.gitignore', '#' + 'x'.repeat(262143));
  }
  yield new Uint8Array(1024);
}

export function fixtureStream(
  parts: Iterable<Uint8Array>,
  signals: {
    pulls?: number;
    bytes?: number;
    pull?: () => void;
    cancel?: (reason: unknown) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const iterator = parts[Symbol.iterator]();
  return new ReadableStream(
    {
      pull(controller) {
        const next = iterator.next();
        if (next.done) controller.close();
        else {
          signals.pulls = (signals.pulls ?? 0) + 1;
          signals.bytes = (signals.bytes ?? 0) + next.value.length;
          signals.pull?.();
          controller.enqueue(next.value);
        }
      },
      cancel(reason) {
        signals.cancel?.(reason);
        iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}
