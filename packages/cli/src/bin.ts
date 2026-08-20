#!/usr/bin/env node
import { buildProgram, exitCodeFor } from './index.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`alarmdrill: ${message}\n`);
  process.exitCode = exitCodeFor(error);
}
