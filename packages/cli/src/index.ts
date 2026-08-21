import { createRequire } from 'node:module';
import { createLogger, systemClock } from '@alarmdrill/core';
import {
  createFileJournal,
  createInjectionSession,
  createDockerControl,
  createLatencyInjector,
  createStopContainerInjector,
  createDeclineRateInjector,
  createToxiproxyClient,
  installSignalCleanup,
} from '@alarmdrill/injectors';
import { Command } from 'commander';

export { EXIT_CODES, exitCodeFor, type ExitCode } from './exit-codes.js';
export { evaluateThresholds, type ThresholdOptions, type ThresholdResult } from './threshold.js';
export { renderHuman, toJson, type JsonExperiment, type JsonRun } from './output.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export interface GlobalOptions {
  json?: boolean;
  journalDir?: string;
  toxiproxyUrl?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('alarmdrill')
    .description('Inject a known fault, then grade whether your monitoring caught it.')
    .version(pkg.version ?? '0.0.0')
    .option('--json', 'emit machine-readable output instead of the human summary')
    .option('--journal-dir <path>', 'where injection journals live', '.alarmdrill/journal')
    .option('--toxiproxy-url <url>', 'toxiproxy API', 'http://localhost:8474')
    .option('--log-level <level>', 'trace|debug|info|warn|error', 'info')
    .showHelpAfterError();

  program
    .command('sweep')
    .description('revert anything a previous run left applied, then exit')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      const logger = createLogger({ level: globals.logLevel ?? 'info', pretty: true });
      const session = buildSession(globals, logger);

      const result = await session.sweepOrphans();
      if (globals.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            reverted: result.reverted.map((e) => ({ id: e.id, kind: e.kind, target: e.target })),
            failed: result.failed.map((f) => ({ id: f.entry.id, reason: f.reason })),
          })}\n`,
        );
      } else if (result.reverted.length === 0 && result.failed.length === 0) {
        process.stdout.write('Nothing to sweep — no injections were left applied.\n');
      } else {
        for (const entry of result.reverted) {
          process.stdout.write(`reverted ${entry.kind} on ${entry.target}\n`);
        }
        for (const failure of result.failed) {
          process.stderr.write(`FAILED to revert ${failure.entry.target}: ${failure.reason}\n`);
        }
      }

      if (result.failed.length > 0) process.exitCode = 5;
    });

  // `run`, `plan`, `report` and `replay` are wired in the next milestone —
  // they need a suite definition format, which M8 introduces. Nothing is
  // registered here before it works.
  return program;
}

function buildSession(globals: GlobalOptions, logger: ReturnType<typeof createLogger>) {
  const toxiproxy = createToxiproxyClient({
    baseUrl: globals.toxiproxyUrl ?? 'http://localhost:8474',
  });
  const latency = createLatencyInjector(toxiproxy);
  const stopContainer = createStopContainerInjector(createDockerControl());
  const declineRate = createDeclineRateInjector();

  const session = createInjectionSession({
    journal: createFileJournal({
      dir: globals.journalDir ?? '.alarmdrill/journal',
      clock: systemClock,
    }),
    clock: systemClock,
    logger,
    // Sweep must be able to revert anything it finds, so every kind is
    // registered even when this invocation is not going to inject.
    registry: {
      [latency.kind]: latency,
      [stopContainer.kind]: stopContainer,
      [declineRate.kind]: declineRate,
    },
    // A bare sweep injects nothing, so an empty allowlist is correct here:
    // reverting is always permitted, injecting never is without a policy.
    policy: { allow: [] },
  });

  installSignalCleanup({ session, logger });
  return session;
}
