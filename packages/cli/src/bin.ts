#!/usr/bin/env node
import { reportableErrorName } from '@package-broker/core/kernel/error-name';
import { run } from './cli.js';

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`error: ${reportableErrorName(error)}`);
    process.exit(1);
  },
);
