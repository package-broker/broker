import { beforeAll } from 'vitest';
import {
  describeCodecContract,
  loadCodecRunner,
  type CodecRunner,
  type CodecSpec,
} from '@package-broker/db-sqlite/contract/codec-contract';
import { nodeCodecs } from './node-codec.js';

let runner: CodecRunner;
beforeAll(async () => {
  runner = await loadCodecRunner(nodeCodecs);
});

describeCodecContract('node', (spec: CodecSpec) => runner(spec));
