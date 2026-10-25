import assert from 'node:assert/strict';
import type { Runtime } from './local.js';
import {
  archiveBytes,
  errorShape,
  projects,
  requireStatus,
  securityScenario,
  session,
  seedTruth,
  truth,
  versions,
} from './evidence.js';
import type { SecurityContext, Truth } from './evidence.js';

interface PackageItem {
  ecosystem: string;
  source: { id: string; name: string };
  id: string;
  name: string;
  versionCount: number;
  latestVersion: string;
}
interface Page<T> {
  items: T[];
  next: string | null;
}

export async function readPages<T>(read: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page = await read(after);
    assert(page.items.length <= 1, 'PageLimitIgnored');
    items.push(...page.items);
    after = page.next;
    if (after !== null) {
      assert(!cursors.has(after) && cursors.size < 100, 'PaginationCycle');
      cursors.add(after);
    }
  } while (after !== null);
  return items;
}

const metadataPath = (item: Truth, project = item.project) =>
  item.ecosystem === 'composer'
    ? `/${project}/p2/${item.name}.json`
    : `/${project}/npm/${encodeURIComponent(item.name)}`;

function validatorOf(response: Response): Record<string, string> {
  const etag = response.headers.get('etag');
  const modified = response.headers.get('last-modified');
  assert(etag || modified, 'MissingMetadataValidator');
  return etag ? { 'if-none-match': etag } : { 'if-modified-since': modified! };
}

async function metadata(context: SecurityContext, item: Truth, token: string) {
  const response = requireStatus(await context.get(metadataPath(item), token), 200);
  const body = (await response.json()) as {
    name?: string;
    packages?: Record<string, { version: string; dist: { url: string } }[]>;
    versions?: Record<string, { dist: { tarball: string } }>;
  };
  if (item.ecosystem === 'composer') assert.deepEqual(Object.keys(body.packages!), [item.name]);
  const encoded = JSON.stringify(body);
  for (const foreign of truth.filter((entry) => entry.project !== item.project))
    assert(!encoded.includes(foreign.name), 'ForeignMetadataFact');
  const actual =
    item.ecosystem === 'composer'
      ? body.packages![item.name]!.map((entry) => entry.version).sort()
      : Object.keys(body.versions!).sort();
  assert.deepEqual(actual, versions, 'MetadataTruthMismatch');
  if (item.ecosystem === 'npm') assert.equal(body.name, item.name);
  const dist =
    item.ecosystem === 'composer'
      ? body.packages![item.name]!.find((entry) => entry.version === '2.0.0')!.dist.url
      : body.versions!['2.0.0']!.dist.tarball;
  const url = new URL(dist);
  assert.equal(url.origin, context.broker.origin, 'ForeignDistOrigin');
  const bytes = requireStatus(await context.get(url.pathname, token), 200);
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), archiveBytes(item.name, '2.0.0'));
  return { path: url.pathname, validator: validatorOf(response) };
}

export async function isolationScenario(runtime: Runtime) {
  return securityScenario(runtime, 'project-isolation', async (context) => {
    const credentials = await seedTruth(context);
    const { get, check, admin } = context;
    const archives = new Map<string, { path: string; validator: Record<string, string> }>();
    for (const project of projects) {
      const { token } = credentials.get(project)!;
      const own = truth.filter((item) => item.project === project);
      await check(`${project}:project-list-pagination-count`, async () => {
        const listed = await readPages<{ slug: string }>(async (after) => {
          const response = requireStatus(
            await get(
              '/_pb/projects?limit=1' + (after ? `&after=${encodeURIComponent(after)}` : ''),
              token,
            ),
            200,
          );
          return (await response.json()) as Page<{ slug: string }>;
        });
        assert.deepEqual(
          listed.map((item) => item.slug),
          [project],
        );
      });
      await check(`${project}:package-list-pagination-counts-search`, async () => {
        const base = `/_pb/projects/${project}/packages`;
        const list = async (query: string) =>
          (await requireStatus(await get(base + query, token), 200).json()) as Page<PackageItem>;
        const full = await list('');
        assert.equal(full.next, null);
        assert.deepEqual(
          full.items.map((item) => item.name).sort(),
          own.map((item) => item.name).sort(),
        );
        const paged = await readPages<PackageItem>((after) =>
          list('?limit=1' + (after ? `&after=${encodeURIComponent(after)}` : '')),
        );
        assert.deepEqual(paged, full.items, 'PaginationTruthMismatch');
        for (const item of paged) {
          const key = item.ecosystem === 'npm' ? 'npm' : item.name;
          assert.equal(item.source.id, credentials.get(project)!.sources[key], 'ForeignSourceId');
          assert.equal(
            item.source.name,
            item.ecosystem === 'npm'
              ? `${project}-npm`
              : `${project}-composer-${item.name.split('/')[1]}`,
            'ForeignSourceName',
          );
          assert.equal(item.versionCount, 2);
          assert.equal(item.latestVersion, '2.0.0');
          const versionPage = await readPages<{ version: string }>(
            async (after) =>
              (await requireStatus(
                await get(
                  `${base}/${item.id}/versions?limit=1` +
                    (after ? `&after=${encodeURIComponent(after)}` : ''),
                  token,
                ),
                200,
              ).json()) as Page<{ version: string }>,
          );
          assert.deepEqual(versionPage.map((entry) => entry.version).sort(), versions);
        }
        const other = project === 'alpha' ? 'beta' : 'alpha';
        for (const prefix of [other, `@${other}`])
          assert.deepEqual((await list(`?q=${encodeURIComponent(prefix)}`)).items, []);
        for (const [prefix, ecosystem] of [
          [project, 'composer'],
          [`@${project}`, 'npm'],
        ] as const)
          assert.deepEqual(
            (await list(`?q=${encodeURIComponent(prefix)}`)).items.map((item) => item.name).sort(),
            own
              .filter((item) => item.ecosystem === ecosystem)
              .map((item) => item.name)
              .sort(),
          );
      });
      await check(`${project}:npm-search-counts`, async () => {
        const response = requireStatus(
          await get(`/${project}/npm/-/v1/search?text=${project}&size=50`, token),
          200,
        );
        const body = (await response.json()) as {
          objects: { package: { name: string } }[];
          total: number;
        };
        assert.equal(body.total, 2);
        assert.deepEqual(
          body.objects.map((item) => item.package.name).sort(),
          own
            .filter((item) => item.ecosystem === 'npm')
            .map((item) => item.name)
            .sort(),
        );
        const other = (await requireStatus(
          await get(
            `/${project}/npm/-/v1/search?text=${project === 'alpha' ? 'beta' : 'alpha'}`,
            token,
          ),
          200,
        ).json()) as { total: number; objects: unknown[] };
        assert.equal(other.total, 0);
        assert.deepEqual(other.objects, []);
      });
      await check(`${project}:composer-list`, async () => {
        const response = requireStatus(await get(`/${project}/packages.json`, token), 200);
        const body = (await response.json()) as { 'available-packages'?: string[] };
        assert.deepEqual(
          body['available-packages']?.sort(),
          own
            .filter((item) => item.ecosystem === 'composer')
            .map((item) => item.name)
            .sort(),
        );
      });
      for (const item of own)
        await check(
          `${project}:${item.ecosystem}:${item.name.split('/')[1]}:metadata-dist-cache`,
          async () => {
            await metadata(context, item, token);
            const cold = await metadata(context, item, token);
            archives.set(`${item.ecosystem}:${item.name}`, cold);
            const calls = context.fixture.count();
            const warm = await metadata(context, item, token);
            assert.deepEqual(warm, cold);
            const conditional = requireStatus(
              await get(metadataPath(item), token, cold.validator),
              304,
            );
            assert.equal(await conditional.text(), '');
            assert.equal(context.fixture.count(), calls, 'WarmCacheContactedUpstream');
          },
        );
    }
    // Beta is warm before alpha probes it, and alpha is warm before beta probes it.
    for (const project of projects) {
      const { token } = credentials.get(project)!;
      for (const item of truth.filter((item) => item.project !== project)) {
        await check(
          `${project}:${item.ecosystem}:${item.name.split('/')[1]}:invisible-equals-absent`,
          async () => {
            const calls = context.fixture.count();
            const missing = metadataPath(
              { ...item, name: item.ecosystem === 'composer' ? 'absent/none' : '@absent/none' },
              project,
            );
            const absent = await errorShape(await get(missing, token));
            assert.deepEqual(
              await errorShape(await get(metadataPath(item, project), token)),
              absent,
            );
            const archive = archives.get(`${item.ecosystem}:${item.name}`);
            assert(archive, 'MissingPositiveArchiveControl');

            assert.deepEqual(
              await errorShape(await get(metadataPath(item, project), token, archive.validator)),
              absent,
            );
            assert.deepEqual(
              await errorShape(
                await get(archive.path.replace(`/${item.project}/`, `/${project}/`), token),
              ),
              absent,
            );
            assert.equal(context.fixture.count(), calls, 'DeniedRequestReachedUpstream');
          },
        );
      }
      const other = project === 'alpha' ? 'beta' : 'alpha';
      await check(`${project}:excluded-project-conditional-equals-absent`, async () => {
        const warmed = truth.find((item) => item.project === other)!;
        const cached = archives.get(`${warmed.ecosystem}:${warmed.name}`);
        assert(cached, 'MissingOtherCredentialValidator');
        assert.deepEqual(
          await errorShape(await get(metadataPath(warmed), token, cached.validator)),
          await errorShape(await get('/absent/packages.json', token)),
        );
      });
      for (const [excluded, absent] of [
        [`/${other}/packages.json`, '/absent/packages.json'],
        [`/${other}/npm/-/v1/search?text=one`, '/absent/npm/-/v1/search?text=one'],
        [`/_pb/projects/${other}/packages`, '/_pb/projects/absent/packages'],
      ] as const)
        await check(`${project}:excluded-project-equals-absent:${excluded}`, async () => {
          assert.deepEqual(
            await errorShape(await get(excluded, token)),
            await errorShape(await get(absent, token)),
          );
        });
      await check(`${project}:foreign-package-id-equals-absent`, async () => {
        const { token: otherToken } = credentials.get(other)!;
        const foreign = (await requireStatus(
          await get(`/_pb/projects/${other}/packages`, otherToken),
          200,
        ).json()) as Page<PackageItem>;
        assert.equal(foreign.items.length, 4, 'ForeignPackageControlMissing');
        const absentId = '01' + 'Z'.repeat(24);
        for (const { id } of foreign.items)
          for (const [scope, suffix] of [
            [project, ''],
            [project, '/versions'],
            [other, ''],
            [other, '/versions'],
          ] as const)
            assert.deepEqual(
              await errorShape(await get(`/_pb/projects/${scope}/packages/${id}${suffix}`, token)),
              await errorShape(
                await get(
                  `/_pb/projects/${scope === project ? project : 'absent'}/packages/${absentId}${suffix}`,
                  token,
                ),
              ),
              `ForeignPackageIdDistinguishable:${scope === project ? 'own' : 'other'}${suffix}`,
            );
      });
      await check(`${project}:composer-metadata-variants-equal-absent`, async () => {
        for (const item of truth.filter(
          (entry) => entry.project === other && entry.ecosystem === 'composer',
        ))
          for (const variant of ['.json', '~dev.json'])
            for (const [path, absent] of [
              [`/${project}/p2/${item.name}${variant}`, `/${project}/p2/absent/none${variant}`],
              [`/${other}/p2/${item.name}${variant}`, `/absent/p2/${item.name}${variant}`],
            ] as const)
              assert.deepEqual(
                await errorShape(await get(path, token)),
                await errorShape(await get(absent, token)),
                `ComposerVariantDistinguishable:${variant}`,
              );
      });
      await check(`${project}:organization-surfaces-hide-other-project`, async () => {
        const foreign = credentials.get(other)!;
        const facts = [
          foreign.projectId,
          ...Object.values(foreign.sources),
          ...truth.filter((item) => item.project === other).map((item) => item.name),
          `${other}-npm`,
          `${other}-composer-`,
        ];
        const leaks = async (path: string) => {
          const response = await get(path, token);
          const body = await response.clone().text();
          assert(
            !facts.some((fact) => body.includes(fact)),
            `ForeignFactVisible:${path.split('/')[2]}`,
          );
          return response;
        };
        for (const path of ['/_pb/sources', '/_pb/organization', '/_pb/audit']) await leaks(path);
        for (const [path, absent] of [
          [`/_pb/sources/${Object.values(foreign.sources)[0]}`, `/_pb/sources/01${'Z'.repeat(24)}`],
          [`/_pb/projects/${other}`, '/_pb/projects/absent'],
          [`/_pb/projects/${other}/audit`, '/_pb/projects/absent/audit'],
        ] as const) {
          const [seen, missing] = [await leaks(path), await get(absent, token)];
          assert.equal(seen.status, missing.status, `ForeignSurfaceStatus:${path.split('/')[2]}`);
          if (seen.status === 404)
            assert.deepEqual(await errorShape(seen), await errorShape(missing));
        }
      });
    }
    await check('next-request-token-revocation', async () => {
      const { token, id } = credentials.get('alpha')!;
      const item = truth.find((item) => item.project === 'alpha')!;
      const warmed = await metadata(context, item, token);
      requireStatus(await admin.request(`/_pb/me/tokens/${id}`, undefined, 'DELETE'), 204);
      requireStatus(await get(metadataPath(item), token, warmed.validator), 401);
    });
    await check('next-request-grant-role-and-token-cap', () => liveAuthorization(context));
  });
}

async function liveAuthorization(context: SecurityContext) {
  const { broker, admin, check, get } = context;
  context.notRun(
    'project-scope-and-non-admin-grant-revocation',
    'needs an SSO identity; local accounts hold only the organization admin role',
  );
  const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    let result: { value: T } | undefined;
    await check(name, async () => {
      result = { value: await run() };
    });
    if (!result) throw new Error(`SetupStageFailed:${name}`);
    return result.value;
  };
  const reader = await stage('setup-reader-session', async () => {
    assert(broker.readerSetupToken, 'MissingReaderSetupToken');
    const opened = await session(
      { ...broker, setupToken: broker.readerSetupToken },
      'reader@example.test',
    );
    context.secrets.push(...opened.secrets());
    return opened;
  });
  const project = await stage(
    'setup-project-get',
    async () =>
      (await requireStatus(
        await admin.request('/_pb/projects/alpha', undefined, 'GET'),
        200,
      ).json()) as { id: string; revision: number },
  );
  const issue = async (issuer: typeof admin, name: string, scope: 'read' | 'full') => {
    const response = requireStatus(
      await issuer.request('/_pb/me/tokens', {
        name,
        scope,
        ...(scope === 'read' ? { readOnly: true } : {}),
        projectMode: 'selected',
        projectIds: [project.id],
      }),
      201,
    );
    const { token } = (await response.json()) as { token: string };
    context.secrets.push(token);
    return token;
  };
  const item = truth.find((item) => item.project === 'alpha' && item.ecosystem === 'composer')!;

  const full = await stage('setup-issue-full-token', () => issue(admin, 'live-full', 'full'));
  await check('next-request-token-cap', async () => {
    await metadata(context, item, full);
    requireStatus(await get('/_pb/projects/alpha/audit', full), 200);
    requireStatus(
      await admin.request('/_pb/projects/alpha', { tokenMaxScope: 'read' }, 'PATCH', {
        'if-match': `"r${project.revision}"`,
      }),
      204,
    );
    requireStatus(await get('/_pb/projects/alpha/audit', full), 403);
    await metadata(context, item, full);
  });
  await check('token-cap-restore', async () => {
    requireStatus(
      await admin.request('/_pb/projects/alpha', { tokenMaxScope: 'full' }, 'PATCH', {
        'if-match': `"r${project.revision + 1}"`,
      }),
      204,
    );
  });

  const [first, second] = await stage('setup-issue-reader-tokens', async () => [
    await issue(reader, 'live-reader-first', 'read'),
    await issue(reader, 'live-reader-second', 'read'),
  ]);
  const warm: { validator: Record<string, string> }[] = [];
  await check('reader-warm-cache', async () => {
    await metadata(context, item, first);
    await metadata(context, item, second);
    warm.push(await metadata(context, item, first), await metadata(context, item, second));
    for (const [index, token] of [first, second].entries())
      requireStatus(await get(metadataPath(item), token, warm[index]!.validator), 304);
  });
  const grant = await stage('setup-grants-get', async () => {
    const grants = (await requireStatus(
      await admin.request('/_pb/grants', undefined, 'GET'),
      200,
    ).json()) as Page<{ id: string; revision: number; roleId: string; subject: { value: string } }>;
    const found = grants.items.find((entry) => entry.subject.value === 'reader@example.test');
    assert(found, 'ReaderBootstrapGrantMissing');
    return found;
  });
  const emptyRole = await stage(
    'setup-role-create',
    async () =>
      (await requireStatus(
        await admin.request('/_pb/roles', {
          key: 'isolation_org',
          name: 'isolation_org',
          scope: 'organization',
          permissions: [],
        }),
        201,
      ).json()) as { id: string },
  );
  const change = async (roleId: string, revision: number) =>
    requireStatus(
      await admin.request(`/_pb/grants/${grant.id}`, { roleId }, 'PATCH', {
        'if-match': `"r${revision}"`,
      }),
      204,
    );
  const validator = (index: number) => warm[index]?.validator ?? {};
  await check('next-request-grant-role-change', async () => {
    await change(emptyRole.id, grant.revision);
    requireStatus(await get(metadataPath(item), first, validator(0)), 401);
  });
  await check('grant-role-restore-restores-token', async () => {
    await change(grant.roleId, grant.revision + 1);
    requireStatus(await get(metadataPath(item), second, validator(1)), 200, 304);
  });
  await check('next-request-grant-revocation', async () => {
    requireStatus(
      await admin.request(`/_pb/grants/${grant.id}`, undefined, 'DELETE', {
        'if-match': `"r${grant.revision + 2}"`,
      }),
      204,
    );
    requireStatus(await get(metadataPath(item), second, validator(1)), 401);
  });
}
