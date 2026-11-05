function shell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function tokenClientConfig(origin: string, project: string, token: string) {
  const url = new URL(origin);
  const projectUrl = `${url.origin}/${encodeURIComponent(project)}`;
  const registry = `registry=${projectUrl}/npm/`;
  const auth = `//${url.host}/${encodeURIComponent(project)}/npm/:_authToken=`;
  return {
    composer: `composer config ${shell(`repositories.${project}`)} composer ${shell(projectUrl)}`,
    composerAuth: JSON.stringify({ bearer: { [url.host]: token } }, null, 2),
    npm: `${registry}\n${auth}${token}`,
    ciComposer: `export COMPOSER_AUTH="$(printf ${shell(
      JSON.stringify({ bearer: { [url.host]: '%s' } })
        .replaceAll('%', '%%')
        .replace('%%s', '%s'),
    )} "$PACKAGE_BROKER_TOKEN")"\ncomposer install --no-interaction`,
    ciNpm: `${registry}\n${auth}\${PACKAGE_BROKER_TOKEN}`,
  };
}
