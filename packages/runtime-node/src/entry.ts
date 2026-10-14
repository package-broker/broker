import { plugins } from '#pb-manifest';
import { createNodeServer } from './index.js';

const broker = createNodeServer(plugins);
broker.server.listen(Number(process.env['PORT'] ?? 8787));
