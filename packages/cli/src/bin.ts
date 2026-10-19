#!/usr/bin/env node
import { reportableErrorName } from '@package-broker/core/kernel/error-name';
import { BuildConfigError } from './build.js';
import { run } from './cli.js';

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const detail =
      error instanceof BuildConfigError
        ? `: invalid broker config: ${error.configKeys.join(', ')}`
        : '';
    console.error(`error: ${reportableErrorName(error)}${detail}`);
    process.exit(1);
  },
);
