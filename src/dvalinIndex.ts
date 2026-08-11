#!/usr/bin/env node
import { runDvalinCli } from './dvalinCli.js';
import { EXIT, UsageError } from './core/exitCodes.js';

runDvalinCli(process.argv).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dvalin: ${message}`);
  process.exitCode = error instanceof UsageError ? EXIT.usageError : EXIT.runtimeError;
});
