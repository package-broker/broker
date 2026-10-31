import { sha256Hex } from '../../auth/primitives.js';
import { expect, it } from 'vitest';
import { isValidServicePrincipalName } from '../../authz/service-principal-name.js';
import { trustedPublisherPrincipalName } from './trusted-publishers-name.js';
import { trustedPublisherInput } from './trusted-publishers-input.js';

const hash = async (
  repository: string,
  workflow: string,
  packageName: string,
  environment: string,
) =>
  (await sha256Hex(JSON.stringify([repository, workflow, packageName, environment]))).slice(0, 8);

it('names scoped packages with an environment using only the repository, workflow and binding hash', async () => {
  const name = await trustedPublisherPrincipalName(
    'owner/repo',
    'publish.yml',
    '@scope/widget',
    'prod',
  );
  expect(name).toBe(
    `trusted:owner/repo:publish.yml~${await hash('owner/repo', 'publish.yml', '@scope/widget', 'prod')}`,
  );
  expect(isValidServicePrincipalName(name)).toBe(true);
});

it.each([100, 101])('bounds labels of %i code points including the hash suffix', async (length) => {
  const repository = 'owner/' + 'r'.repeat(length - 35);
  const prefix = `trusted:${repository}:publish.yml`;
  expect(Array.from(prefix + '~12345678')).toHaveLength(length);
  const suffix = await hash(repository, 'publish.yml', 'widget', '');
  const name = await trustedPublisherPrincipalName(repository, 'publish.yml', 'widget', '');
  expect(name).toBe(
    `${length === 100 ? prefix : Array.from(prefix).slice(0, 90).join('') + '…'}~${suffix}`,
  );
  expect(Array.from(name)).toHaveLength(100);
  expect(isValidServicePrincipalName(name)).toBe(true);
});

it('distinguishes bindings sharing repository and workflow by package and environment', async () => {
  const bindings = [
    ['widget', ''],
    ['other', ''],
    ['widget', 'prod'],
  ];
  const names = await Promise.all(
    bindings.map(([pkg, env]) =>
      trustedPublisherPrincipalName('owner/repo', 'publish.yml', pkg!, env!),
    ),
  );
  expect(new Set(names).size).toBe(3);
  for (const [index, [pkg, env]] of bindings.entries()) {
    expect(names[index]).toBe(
      `trusted:owner/repo:publish.yml~${await hash('owner/repo', 'publish.yml', pkg!, env!)}`,
    );
    expect(isValidServicePrincipalName(names[index])).toBe(true);
  }
});

it('shortens multibyte prefixes by code point without splitting surrogate pairs', async () => {
  const workflow = '😀'.repeat(80) + '.yml';
  const prefix = `trusted:owner/repo:${workflow}`;
  const name = await trustedPublisherPrincipalName('owner/repo', workflow, 'widget', 'prod');
  expect(Array.from(name)).toHaveLength(100);
  expect(name).toBe(
    `${Array.from(prefix).slice(0, 90).join('')}…~${await hash('owner/repo', workflow, 'widget', 'prod')}`,
  );
  expect(isValidServicePrincipalName(name)).toBe(true);
});

it.each(['publish\u200b.yml', ' publish.yml'])(
  'falls back when the assembled label fails the shared principal name validator: %s',
  async (workflow) => {
    const repository = 'owner/token';
    const name = await trustedPublisherPrincipalName(repository, workflow, 'widget', '');
    expect(name).toBe(`trusted~${await hash(repository, workflow, 'widget', '')}`);
    expect(isValidServicePrincipalName(name)).toBe(true);
  },
);

it('uses the exchange workflow grammar and folds only ASCII environment letters', () => {
  const body = {
    packageName: 'widget',
    repository: 'owner/repo',
    workflow: 'publish.yml',
    environment: 'ProdÄ',
  };
  expect(trustedPublisherInput(body).environment).toBe('prodÄ');
  for (const workflow of ['bad@name.yml', 'é'.repeat(126) + '.yml']) {
    expect(() => trustedPublisherInput({ ...body, workflow })).toThrow();
  }
  expect(trustedPublisherInput({ ...body, workflow: 'folder\\name.yml' }).workflow).toBe(
    'folder\\name.yml',
  );
});

it('refuses unsafe content in binding fields before assembling the name', async () => {
  await expect(
    trustedPublisherPrincipalName('owner/repo', 'publish.yml', 'widget', 'person@example.test'),
  ).rejects.toThrow('invalid_publisher_name');
  await expect(
    trustedPublisherPrincipalName('owner/repo', 'publish\n.yml', 'widget', ''),
  ).rejects.toThrow('invalid_publisher_name');
});

it('distinguishes long workflow and environment bindings sharing the shortened prefix', async () => {
  const repository = 'owner/' + 'r'.repeat(90);
  const names = await Promise.all([
    trustedPublisherPrincipalName(repository, '😀'.repeat(20) + '.yml', 'widget', 'prod'),
    trustedPublisherPrincipalName(repository, '😀'.repeat(20) + 'x.yml', 'widget', 'prod'),
    trustedPublisherPrincipalName(repository, '😀'.repeat(20) + '.yml', 'widget', 'stage'),
  ]);
  expect(new Set(names).size).toBe(3);
  for (const name of names) {
    expect(Array.from(name).length).toBeLessThanOrEqual(100);
    expect(isValidServicePrincipalName(name)).toBe(true);
  }
  expect(names[0]).toBe(
    await trustedPublisherPrincipalName(repository, '😀'.repeat(20) + '.yml', 'widget', 'prod'),
  );
});
