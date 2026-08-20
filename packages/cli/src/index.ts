import { createRequire } from 'node:module';
import { Command } from 'commander';

export { EXIT_CODES, exitCodeFor, type ExitCode } from './exit-codes.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('alarmdrill')
    .description('Inject a known fault, then grade whether your monitoring caught it.')
    .version(pkg.version ?? '0.0.0')
    .showHelpAfterError();

  // Commands land with their milestones: `run` (M2-M4), `replay` (M4),
  // `plan` (M5), `report` (M6). Nothing is registered before it works.
  return program;
}
