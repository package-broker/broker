export function tokenClientConfig(origin: string, project: string, token: string) {
  const url = new URL(origin);
  const projectUrl = `${url.origin}/${encodeURIComponent(project)}`;
  return {
    composer: `composer config repositories.${project} composer ${projectUrl}\ncomposer config --auth bearer.${url.host} ${token}`,
    npm: `registry=${projectUrl}/npm/\n//${url.host}/${encodeURIComponent(project)}/npm/:_authToken=${token}`,
  };
}
