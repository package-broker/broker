FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

WORKDIR /build
RUN npm install --global pnpm@12.5.1

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ARG CONFIG=broker.config.ts
RUN pnpm pb build --config "$CONFIG" --target node

# Keep the lockfile-resolved native driver and its dependencies, without workspace links.
RUN node --input-type=module <<'NODE'
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

await mkdir('/out', { recursive: true });
for (const name of ['server.js', 'package.json', 'build-info.json', 'migrations', 'assets']) {
  if (name === 'assets' && !existsSync(join('.pb/node', name))) continue;
  await cp(join('.pb/node', name), join('/out', name), { recursive: true });
}
async function copyDependencies(target, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const require = createRequire(manifestPath);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const sourceManifest = require.resolve(`${name}/package.json`);
    const destination = join(target, 'node_modules', name);
    await cp(dirname(sourceManifest), destination, { recursive: true });
    await copyDependencies(destination, sourceManifest);
  }
}
const manifest = JSON.parse(await readFile('/out/package.json', 'utf8'));
const require = createRequire('/build/packages/runtime-node/package.json');
for (const name of Object.keys(manifest.dependencies)) {
  const sourceManifest = require.resolve(`${name}/package.json`);
  const destination = join('/out/node_modules', name);
  await cp(dirname(sourceManifest), destination, { recursive: true });
  await copyDependencies(destination, sourceManifest);
}
NODE

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini=0.19.0-1+b3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 1000 -g 1000 -m 0700 /data

WORKDIR /app
COPY --from=build /out/ ./
COPY --from=build /build/LICENSE ./LICENSE
# Apply the private creation mask before the server opens the database or blob store.
RUN printf '%s\n' 'process.umask(0o077);' > umask.cjs

ENV NODE_ENV=production \
    DEPLOYMENT_ID=docker \
    PORT=8787 \
    PB_SQLITE_PATH=/data/broker.sqlite \
    PB_BLOB_ROOT=/data/blobs

USER 1000:1000
# Runs on the target platform and fails the build if its native SQLite addon cannot load.
RUN node -e "const db = require('better-sqlite3')(':memory:'); db.prepare('SELECT 1').get(); db.close()"

VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM

# An open SQLite handle can survive chmod; check current file access as well as readiness.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "require('node:fs').accessSync(process.env.PB_SQLITE_PATH, require('node:fs').constants.R_OK); fetch('http://127.0.0.1:' + process.env.PORT + '/health/ready', { signal: AbortSignal.timeout(2000) }).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "--require", "./umask.cjs", "server.js"]
