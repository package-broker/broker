import {
  POLICY_COMPOSER_PACKAGE,
  POLICY_NPM_PACKAGE,
  json,
  npmBlock,
  policyWrite,
  readDenials,
  type PolicyBroker,
} from './policy-broker.js';

const decoder = new TextDecoder();

/** Warm tarballs and archives, block with a real write, then repeat every delivery form. */
export async function policyDistMatrix(broker: PolicyBroker) {
  const npm = `/${broker.project}/npm`;
  const body = (await json(await broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}`))) as {
    versions: Record<string, { dist: { tarball: string } }>;
  };
  const tarball = (version: string) => new URL(body.versions[version]!.dist.tarball).pathname;
  const deliver = async (version: string, init: { method?: string; range?: boolean } = {}) => {
    const response = await broker.fetch(tarball(version), {
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.range === true ? { headers: { range: 'bytes=0-3' } } : {}),
    });
    const text = init.method === 'HEAD' ? '' : decoder.decode(await response.arrayBuffer());
    return {
      status: response.status,
      bytes: text.startsWith('tarball') ? text : text.includes('tarball') ? 'leaked' : 'none',
      cacheControl: response.headers.get('cache-control'),
    };
  };
  const composerBody = (await json(
    await broker.fetch(`/${broker.project}/p2/${POLICY_COMPOSER_PACKAGE}.json`),
  )) as { packages: Record<string, { version: string; dist: { url: string } }[]> };
  const archive = (version: string) =>
    new URL(
      composerBody.packages[POLICY_COMPOSER_PACKAGE]!.find((entry) => entry.version === version)!
        .dist.url,
    ).pathname;
  const zip = async (version: string, cache = false) => {
    const response = await broker.fetch(archive(version));
    const text = decoder.decode(await response.arrayBuffer());
    return {
      status: response.status,
      bytes: text === 'zip bytes' ? 'zip' : 'none',
      ...(cache ? { cacheControl: response.headers.get('cache-control') } : {}),
    };
  };

  const warm = {
    first: await deliver('1.0.0'),
    second: await deliver('2.0.0'),
    head: await deliver('2.0.0', { method: 'HEAD' }),
    cached: await deliver('2.0.0'),
    archive: await zip('2.0.0'),
    otherArchive: await zip('1.0.0'),
  };
  const fetchedBefore = broker.upstreamCalls();

  const block = await policyWrite(broker, '/_pb/policies', 'POST', npmBlock(['2.0.0']));
  const composerBlock = await policyWrite(broker, '/_pb/policies', 'POST', {
    ecosystem: 'composer',
    package: POLICY_COMPOSER_PACKAGE,
    kind: 'block',
    members: ['2.0.0.0'],
    reasonCode: 'security_review',
  });
  const blocked = {
    get: await deliver('2.0.0'),
    head: await deliver('2.0.0', { method: 'HEAD' }),
    range: await deliver('2.0.0', { range: true }),
    allowed: await deliver('1.0.0'),
    archive: await zip('2.0.0', true),
    allowedArchive: await zip('1.0.0'),
  };
  const fetchedAfter = broker.upstreamCalls() - fetchedBefore;
  const evidence = (await readDenials(broker)).filter((kind) => kind === 'dist').length;

  await broker.breakReadAudit();
  const outage = await (async () => {
    const response = await broker.fetch(tarball('2.0.0'));
    const text = decoder.decode(await response.arrayBuffer());
    return {
      status: response.status,
      code: (JSON.parse(text) as { code?: unknown }).code,
      retryAfter: response.headers.get('retry-after'),
      leaked: text.includes('tarball 2.0.0'),
    };
  })();
  const outageAllowed = (await deliver('1.0.0')).status;
  await broker.restoreReadAudit();

  return {
    warm,
    block: block.status,
    composerBlock: composerBlock.status,
    blocked,
    fetchedAfter,
    evidence,
    outage,
    outageAllowed,
  };
}

const GOVERNED = 'private, no-cache';
/** The uniform 404 of a direct denial, never stored by any cache; metadata denials match it. */
const NOT_FOUND = 'private, no-store';

export const POLICY_DIST_EXPECTED = {
  warm: {
    first: { status: 200, bytes: 'tarball 1.0.0', cacheControl: GOVERNED },
    second: { status: 200, bytes: 'tarball 2.0.0', cacheControl: GOVERNED },
    head: { status: 200, bytes: 'none', cacheControl: GOVERNED },
    cached: { status: 200, bytes: 'tarball 2.0.0', cacheControl: GOVERNED },
    archive: { status: 200, bytes: 'zip' },
    otherArchive: { status: 200, bytes: 'zip' },
  },
  block: 201,
  composerBlock: 201,
  blocked: {
    get: { status: 404, bytes: 'none', cacheControl: NOT_FOUND },
    head: { status: 404, bytes: 'none', cacheControl: NOT_FOUND },
    range: { status: 404, bytes: 'none', cacheControl: NOT_FOUND },
    allowed: { status: 200, bytes: 'tarball 1.0.0', cacheControl: GOVERNED },
    archive: { status: 404, bytes: 'none', cacheControl: NOT_FOUND },
    allowedArchive: { status: 200, bytes: 'zip' },
  },
  fetchedAfter: 0,
  evidence: 4,
  outage: { status: 503, code: 'policy_unavailable', retryAfter: '5', leaked: false },
  outageAllowed: 200,
} as const;
