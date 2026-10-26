import { describe, expect, it } from 'vitest';
import { defineConfig } from '../config.js';
import type { Platform } from '../plugin.js';
import { DEFAULT_MAX_BLOB_BYTES, DEFAULT_UPLOAD_BUDGET_BYTES } from './blob.js';
import {
  MAX_CACHE_BYTES,
  MAX_JOBS_RUNNING,
  validatePlatformPorts,
  type PlatformPortConfig,
} from './port-config.js';

type Section = Record<string, unknown>;
interface Stanza {
  [key: string]: Section;
  blob: Section;
  cache: Section;
  jobs: Section;
  observability: Section;
}

function cloudflare(): Stanza {
  return {
    blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
    cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
    jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
    observability: {
      adapter: 'workers',
      analyticsBinding: 'ANALYTICS',
      deploymentIdEnv: 'DEPLOYMENT_ID',
    },
  };
}

function node(): Stanza {
  return {
    blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
    cache: { adapter: 'lru', maxBytes: 33554432 },
    jobs: { adapter: 'database', maxRunning: 2 },
    observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
  };
}

function wrap(stanza: unknown, target: Platform): unknown {
  return { [target]: stanza };
}

function check(stanza: unknown, target: Platform): readonly string[] {
  return validatePlatformPorts(wrap(stanza, target), target);
}

function problems(stanza: unknown, target: Platform): string {
  return check(stanza, target).join('\n');
}

describe('validatePlatformPorts', () => {
  it('accepts a full stanza for each target', () => {
    expect(check(cloudflare(), 'cloudflare')).toEqual([]);
    expect(check(node(), 'node')).toEqual([]);
  });

  it('accepts the node S3 alternative', () => {
    const stanza = node();
    stanza.blob = {
      adapter: 's3',
      endpointEnv: 'PB_S3_ENDPOINT',
      regionEnv: 'PB_S3_REGION',
      bucketEnv: 'PB_S3_BUCKET',
      accessKeyIdEnv: 'PB_S3_ACCESS_KEY_ID',
      secretAccessKeyEnv: 'PB_S3_SECRET_ACCESS_KEY',
      sessionTokenEnv: 'PB_S3_SESSION_TOKEN',
      pathStyle: true,
      maxBytes: 1024,
    };
    stanza.observability.endpointEnv = 'OTEL_ENDPOINT';
    stanza.observability.headersEnv = 'OTEL_HEADERS';
    expect(check(stanza, 'node')).toEqual([]);
  });

  it('rejects a missing port', () => {
    const stanza: Partial<Stanza> = cloudflare();
    delete stanza.jobs;
    expect(problems(stanza, 'cloudflare')).toContain('jobs: required');
  });

  it('rejects a partial stanza and non-objects', () => {
    expect(problems({ blob: cloudflare().blob }, 'cloudflare')).toContain('cache: required');
    expect(problems({ blob: cloudflare().blob }, 'cloudflare')).toContain(
      'observability: required',
    );
    expect(problems(null, 'node')).toContain('node: must be an object');
    expect(problems([], 'node')).toContain('node: must be an object');
  });

  it('rejects unknown keys at every level', () => {
    const stanza = cloudflare();
    stanza.extra = {};
    stanza.blob.secret = 'x';
    stanza.cache.ttl = 1;
    expect(problems(stanza, 'cloudflare')).toContain('extra: unknown key');
    expect(problems(stanza, 'cloudflare')).toContain('blob.secret: unknown key');
    expect(problems(stanza, 'cloudflare')).toContain('cache.ttl: unknown key');
  });

  it('rejects non-positive and non-integer budgets', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '5']) {
      const stanza = node();
      stanza.blob.maxBytes = bad;
      stanza.jobs.maxRunning = bad;
      stanza.cache.maxBytes = bad;
      const out = problems(stanza, 'node');
      expect(out).toContain('blob.maxBytes: must be a positive integer');
      expect(out).toContain('jobs.maxRunning: must be a positive integer');
      expect(out).toContain('cache.maxBytes: must be a positive integer');
    }
  });

  it('rejects maxBytes above the product cap', () => {
    const stanza = node();
    stanza.blob.maxBytes = DEFAULT_MAX_BLOB_BYTES + 1;
    expect(problems(stanza, 'node')).toContain('blob.maxBytes: exceeds the product cap');
    stanza.blob.maxBytes = DEFAULT_MAX_BLOB_BYTES;
    expect(check(stanza, 'node')).toEqual([]);
  });

  it('rejects over-long and malformed identifiers', () => {
    const stanza = cloudflare();
    stanza.blob.binding = 'B'.repeat(65);
    stanza.cache.namespace = 'n'.repeat(65);
    stanza.jobs.binding = 'bad name';
    const out = problems(stanza, 'cloudflare');
    expect(out).toContain('blob.binding: invalid identifier');
    expect(out).toContain('cache.namespace: invalid identifier');
    expect(out).toContain('jobs.binding: invalid identifier');
  });

  it('rejects duplicate binding names', () => {
    const stanza = cloudflare();
    stanza.jobs.binding = 'STORAGE';
    expect(problems(stanza, 'cloudflare')).toContain('jobs.binding: duplicate binding name');
    stanza.jobs.binding = 'JOBS';
    stanza.observability.analyticsBinding = 'JOBS';
    expect(problems(stanza, 'cloudflare')).toContain(
      'observability.analyticsBinding: duplicate binding name',
    );
  });

  it('rejects bad env reference names', () => {
    const stanza = node();
    stanza.blob.rootEnv = 'lower_case';
    stanza.observability.endpointEnv = 'HAS SPACE';
    expect(problems(stanza, 'node')).toContain('blob.rootEnv: invalid env reference name');
    expect(problems(stanza, 'node')).toContain(
      'observability.endpointEnv: invalid env reference name',
    );
  });

  it('rejects credential-looking values in env reference fields without echoing them', () => {
    const accessKey = 'AKIAABCDEFGHIJKLMNOP';
    const hex = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const mixed = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    for (const value of [accessKey, hex, mixed, 'ASIAABCDEFGHIJKLMNOP']) {
      const stanza = node();
      stanza.blob = {
        adapter: 's3',
        endpointEnv: 'PB_S3_ENDPOINT',
        regionEnv: 'PB_S3_REGION',
        bucketEnv: 'PB_S3_BUCKET',
        accessKeyIdEnv: value,
        secretAccessKeyEnv: 'PB_S3_SECRET_ACCESS_KEY',
        maxBytes: 1024,
      };
      const out = check(stanza, 'node');
      expect(out.join('\n')).toContain('blob.accessKeyIdEnv');
      expect(out.join('\n')).not.toContain(value);
    }
  });

  it('rejects adapters outside the target matrix', () => {
    expect(problems(node(), 'cloudflare')).toContain('blob.adapter');
    expect(problems(cloudflare(), 'node')).toContain('blob.adapter');
    expect(problems(cloudflare(), 'node')).toContain('jobs.adapter');
  });

  it('requires adapter-specific references', () => {
    const stanza = cloudflare();
    delete stanza.blob.binding;
    delete stanza.jobs.binding;
    expect(problems(stanza, 'cloudflare')).toContain('blob.binding: required');
    expect(problems(stanza, 'cloudflare')).toContain('jobs.binding: required');
    const n = node();
    delete n.blob.rootEnv;
    expect(problems(n, 'node')).toContain('blob.rootEnv: required');
  });

  it('requires deploymentIdEnv to be DEPLOYMENT_ID', () => {
    const stanza = node();
    stanza.observability.deploymentIdEnv = 'HOSTNAME';
    expect(problems(stanza, 'node')).toContain(
      'observability.deploymentIdEnv: must be DEPLOYMENT_ID',
    );
    delete stanza.observability.deploymentIdEnv;
    expect(problems(stanza, 'node')).toContain(
      'observability.deploymentIdEnv: must be DEPLOYMENT_ID',
    );
  });
});

describe('validatePlatformPorts map', () => {
  it('treats an omitted map as disabled', () => {
    expect(validatePlatformPorts(undefined, 'node')).toEqual([]);
    expect(validatePlatformPorts({}, 'cloudflare')).toEqual([]);
  });

  it('rejects a non-object map and unknown target keys', () => {
    expect(validatePlatformPorts('x', 'node').join()).toContain('platformPorts: must be an object');
    expect(validatePlatformPorts([], 'node').join()).toContain('platformPorts: must be an object');
    expect(validatePlatformPorts({ deno: {} }, 'node').join()).toContain('deno: unknown key');
    expect(validatePlatformPorts({ toString: {} }, 'node').join()).toContain(
      'toString: unknown key',
    );
  });

  it('rejects an unknown target and prototype keys', () => {
    expect(validatePlatformPorts({}, 'toString' as Platform).join()).toContain('unknown platform');
    expect(validatePlatformPorts({}, '__proto__' as Platform).join()).toContain('unknown platform');
    const stanza = node();
    Object.defineProperty(stanza, 'constructor', { value: {}, enumerable: true });
    expect(problems(stanza, 'node')).toContain('constructor: unknown key');
  });

  it('validates every present stanza against its own platform', () => {
    const map = { cloudflare: cloudflare(), node: { blob: 3, extra: {} } };
    const out = validatePlatformPorts(map, 'cloudflare').join('\n');
    expect(out).toContain('node.blob: must be an object');
    expect(out).toContain('node.extra: unknown key');
    expect(out).toContain('node.cache: required');
    expect(validatePlatformPorts({ node: {} }, 'cloudflare').join('\n')).toContain(
      'node.blob: required',
    );
  });

  it('reports a secret in the other target stanza', () => {
    const other = node();
    other.blob.rootEnv = 'AKIAABCDEFGHIJKLMNOP';
    const out = validatePlatformPorts({ cloudflare: cloudflare(), node: other }, 'cloudflare').join(
      '\n',
    );
    expect(out).toContain('node.blob.rootEnv: looks like a credential');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts over-long and credential-looking unknown key names', () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const long = 'k'.repeat(200);
    const stanza = node();
    stanza.blob = { ...stanza.blob, [secret]: 1, [long]: 1 };
    const out = problems(stanza, 'node');
    expect(out).toContain('<redacted>: unknown key');
    expect(out).not.toContain(secret);
    expect(out).not.toContain(long);
  });
});

describe('validatePlatformPorts bounds and references', () => {
  it('caps jobs.maxRunning and cache.maxBytes', () => {
    const stanza = node();
    stanza.jobs.maxRunning = MAX_JOBS_RUNNING + 1;
    stanza.cache.maxBytes = MAX_CACHE_BYTES + 1;
    stanza.blob.maxBytes = Number.POSITIVE_INFINITY;
    const out = problems(stanza, 'node');
    expect(out).toContain('jobs.maxRunning: exceeds the jobs cap');
    expect(out).toContain('cache.maxBytes: exceeds the cache cap');
    expect(out).toContain('blob.maxBytes: must be a positive integer');
    stanza.jobs.maxRunning = MAX_JOBS_RUNNING;
    stanza.cache.maxBytes = MAX_CACHE_BYTES;
    stanza.blob.maxBytes = 1;
    expect(check(stanza, 'node')).toEqual([]);
  });

  it('keeps the blob cap within the upload budget', () => {
    expect(DEFAULT_MAX_BLOB_BYTES).toBeLessThanOrEqual(DEFAULT_UPLOAD_BUDGET_BYTES);
  });

  it('rejects reserved worker names and cross-field name reuse on cloudflare', () => {
    const stanza = cloudflare();
    stanza.blob.binding = 'DB';
    stanza.jobs.binding = 'DEPLOYMENT_ID';
    const out = problems(stanza, 'cloudflare');
    expect(out).toContain('blob.binding: reserved binding name');
    expect(out).toContain('jobs.binding: reserved binding name');
    const env = cloudflare();
    env.observability.endpointEnv = 'STORAGE';
    expect(problems(env, 'cloudflare')).toContain(
      'observability.endpointEnv: duplicate env reference name',
    );
  });

  it('rejects the same env reference reused across fields', () => {
    const stanza = node();
    stanza.blob.rootEnv = 'PB_SHARED';
    stanza.observability.endpointEnv = 'PB_SHARED';
    expect(problems(stanza, 'node')).toContain(
      'observability.endpointEnv: duplicate env reference name',
    );
    stanza.observability.endpointEnv = 'DEPLOYMENT_ID';
    expect(problems(stanza, 'node')).toContain(
      'observability.endpointEnv: duplicate env reference name',
    );
  });

  it('rejects fields the chosen adapter does not use', () => {
    const cf = cloudflare();
    cf.cache.maxBytes = 1024;
    cf.blob.rootEnv = 'PB_BLOB_ROOT';
    cf.jobs.maxRunning = 2;
    const out = problems(cf, 'cloudflare');
    expect(out).toContain('cache.maxBytes: not used by cache-api');
    expect(out).toContain('blob.rootEnv: not used by r2');
    const n = node();
    n.cache.namespace = 'ns';
    n.jobs.binding = 'JOBS';
    n.blob.pathStyle = true;
    const nodeOut = problems(n, 'node');
    expect(nodeOut).toContain('cache.namespace: not used by lru');
    expect(nodeOut).toContain('jobs.binding: not used by database');
    expect(nodeOut).toContain('blob.pathStyle: not used by filesystem');
  });

  it('requires endpointEnv alongside headersEnv', () => {
    const stanza = node();
    stanza.observability.headersEnv = 'OTEL_HEADERS';
    expect(problems(stanza, 'node')).toContain('observability.headersEnv: requires endpointEnv');
  });

  it('rejects high-entropy and secret-shaped env reference names', () => {
    const shapes = [
      'XK3F_9QZP_TT7M_LW2B_RR8D_HHJK',
      'JBSWY3DPEHPK3PXP',
      'BCDFGHJKLMNP',
      'A'.repeat(49),
      'TRAILING_',
      'DOUBLE__UNDERSCORE',
      '_LEADING',
    ];
    for (const value of shapes) {
      const stanza = node();
      stanza.blob.rootEnv = value;
      const out = problems(stanza, 'node');
      expect(out).toContain('blob.rootEnv');
      expect(out).not.toContain(value);
    }
  });

  it('rejects long mixed and long single-word secrets, accepts long plain names', () => {
    const secrets = [
      'K7QX9ZA0B8M1RT4WE2Y6UPLN3S5DVHJC',
      'XOXB1234567890ABCDEFGHIJKLMNOPQR',
      'GHP0A1B2C3D4E5F6G7H8I9JKLMNOPQRSTU',
      'SK_LIVE_51HABCDEFGHIJKLMNOPQRSTU',
    ];
    for (const value of secrets) {
      const stanza = node();
      stanza.blob.rootEnv = value;
      const out = problems(stanza, 'node');
      expect(out).toContain('blob.rootEnv');
      expect(out).not.toContain(value);
    }
    const ok = node();
    ok.blob.rootEnv = 'PB_BLOBSTORAGEDIRECTORY';
    expect(check(ok, 'node')).toEqual([]);
  });

  it('reserves DEPLOYMENT_ID on both targets', () => {
    const stanza = node();
    stanza.blob.rootEnv = 'DEPLOYMENT_ID';
    expect(problems(stanza, 'node')).toContain('blob.rootEnv: duplicate env reference name');
  });

  it('rejects credential-looking endpointEnv, headersEnv and rootEnv', () => {
    const value = 'AKIAABCDEFGHIJKLMNOP';
    const stanza = node();
    stanza.blob.rootEnv = value;
    stanza.observability.endpointEnv = value;
    stanza.observability.headersEnv = value;
    const out = problems(stanza, 'node');
    expect(out).toContain('blob.rootEnv: looks like a credential');
    expect(out).toContain('observability.endpointEnv: looks like a credential');
    expect(out).toContain('observability.headersEnv: looks like a credential');
    expect(out).not.toContain(value);
  });

  it('requires every S3 reference and a boolean pathStyle', () => {
    const stanza = node();
    stanza.blob = { adapter: 's3', pathStyle: 'yes', maxBytes: 1024 };
    const out = problems(stanza, 'node');
    for (const key of [
      'endpointEnv',
      'regionEnv',
      'bucketEnv',
      'accessKeyIdEnv',
      'secretAccessKeyEnv',
    ]) {
      expect(out).toContain(`blob.${key}: required`);
    }
    expect(out).toContain('blob.pathStyle: must be a boolean');
  });

  it('rejects namespace characters outside the allowed set', () => {
    for (const namespace of ['Bad', 'has space', '-lead', 'a/b']) {
      const stanza = cloudflare();
      stanza.cache.namespace = namespace;
      expect(problems(stanza, 'cloudflare')).toContain('cache.namespace: invalid identifier');
    }
  });
});

describe('BrokerConfig.platformPorts', () => {
  it('stays optional and source-compatible', () => {
    const config = defineConfig({ platform: 'node', plugins: [] });
    expect(config.platformPorts).toBeUndefined();
    const nodeTyped: PlatformPortConfig = {
      blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
      cache: { adapter: 'lru', maxBytes: 1024 },
      jobs: { adapter: 'database', maxRunning: 2 },
      observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
    };
    const withPorts = defineConfig({
      platform: 'node',
      plugins: [],
      platformPorts: { node: nodeTyped },
    });
    expect(withPorts.platformPorts?.node).toBeDefined();
  });
});

describe('Workers automatic tracing', () => {
  it.each([
    { enabled: true },
    { enabled: false },
    { enabled: true, headSamplingRate: 0.05, destinations: ['collector'], persist: false },
    { enabled: true, headSamplingRate: 1, destinations: ['collector'], persist: true },
    { enabled: true, destinations: ['a.A_0-', 'b'.repeat(64)] },
    { enabled: true, destinations: Array.from({ length: 10 }, (_, i) => `collector-${i}`) },
  ])('accepts tracing config %j', (traces) => {
    const stanza = cloudflare();
    stanza.observability.traces = traces;
    expect(check(stanza, 'cloudflare')).toEqual([]);
  });

  it.each<[unknown, string]>([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [true, 'must be an object'],
    [{}, 'enabled: must be a boolean'],
    [{ enabled: 'PRIVATE_SENTINEL' }, 'enabled: must be a boolean'],
    ...[0, -1, 1.01, NaN, Infinity, -Infinity, 'PRIVATE_SENTINEL', null].map(
      (value): [unknown, string] => [
        { enabled: true, headSamplingRate: value },
        'headSamplingRate: must be finite and greater than 0 and at most 1',
      ],
    ),
    ...[
      ['PRIVATE_SENTINEL', 'must be an array'],
      [[], 'must contain 1 to 10 entries'],
      [Array.from({ length: 11 }, (_, i) => `collector-${i}`), 'must contain 1 to 10 entries'],
      ...[[null], [null, null], Array(1), [''], [1], ['x'.repeat(65)]].map((value) => [
        value,
        'entries must be strings of trimmed length 1 to 64',
      ]),
      ...[['a/b'], ['a b'], ['a?token'], ['é']].map((value) => [
        value,
        'entries may contain only A-Z, a-z, 0-9, dot, underscore and hyphen',
      ]),
      [['same', 'same'], 'entries must be unique after trimming'],
      [[' a.A_0- '], 'entries must not have leading or trailing whitespace'],
      [[' a.A_0-'], 'entries must not have leading or trailing whitespace'],
      [['a.A_0- '], 'entries must not have leading or trailing whitespace'],
    ].map(([value, rule]): [unknown, string] => [
      { enabled: true, destinations: value },
      `destinations: ${rule}`,
    ]),
    [{ enabled: true, persist: 'PRIVATE_SENTINEL' }, 'persist: must be a boolean'],
    [{ enabled: true, extra: 'PRIVATE_SENTINEL' }, 'extra: unknown key'],
    [{ enabled: true, 'https://PRIVATE_SENTINEL': true }, '<redacted>: unknown key'],
  ])('rejects invalid tracing config %j', (traces, diagnostic) => {
    const stanza = cloudflare();
    stanza.observability.traces = traces;
    const output = problems(stanza, 'cloudflare');
    expect(check(stanza, 'cloudflare')).toEqual([
      `cloudflare.observability.traces${diagnostic.startsWith('must be') ? ': ' : '.'}${diagnostic}`,
    ]);
    expect(output).not.toContain('PRIVATE_SENTINEL');
  });

  it.each([
    [
      ['', '   '],
      [
        'entries must be strings of trimmed length 1 to 64',
        'entries must not have leading or trailing whitespace',
      ],
    ],
    [
      [' same ', 'same'],
      [
        'entries must not have leading or trailing whitespace',
        'entries must be unique after trimming',
      ],
    ],
  ])('reports each violated destination rule once for %j', (destinations, rules) => {
    const stanza = cloudflare();
    stanza.observability.traces = { enabled: true, destinations };
    expect(check(stanza, 'cloudflare')).toEqual(
      rules.map((rule) => `cloudflare.observability.traces.destinations: ${rule}`),
    );
  });

  it.each([
    { enabled: true },
    { enabled: 'bad', headSamplingRate: -1, destinations: [], persist: null, extra: true },
    null,
  ])('rejects tracing on node with one diagnostic: %j', (traces) => {
    const stanza = node();
    stanza.observability.traces = traces;
    expect(check(stanza, 'node')).toEqual(['node.observability.traces: not used by stdio']);
  });
});
