#!/usr/bin/env node
import { runCli } from './cli.js';
import { EXIT, UsageError } from './core/exitCodes.js';

runCli(process.argv).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dvalincode: ${message}`);
  process.exitCode = error instanceof UsageError ? EXIT.usageError : EXIT.runtimeError;
});

