import { createRequire } from 'node:module';
import { createLogger, systemClock } from '@alarmdrill/core';
import { createPrometheusClient } from '@alarmdrill/observers';
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
import { createTraceStore, createAnthropicModel, replayRun } from '@alarmdrill/agents';
import { planExperiments } from '@alarmdrill/agents';
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { loadSuite, type Suite } from './suite.js';

export { EXIT_CODES, exitCodeFor, type ExitCode } from './exit-codes.js';
export { evaluateThresholds, type ThresholdOptions, type ThresholdResult } from './threshold.js';
export { renderHuman, toJson, type JsonExperiment, type JsonRun } from './output.js';
export { loadSuite, suiteSchema, targetOf, type FaultSpec, type Suite } from './suite.js';
export { runCommand, type RunDeps, type RunOutcome } from './commands/run.js';
export { preflight, describeIssues, type PreflightIssue } from './preflight.js';

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

  program
    .command('run')
    .description('drill a suite: inject each fault, then grade what the monitoring did')
    .requiredOption('-s, --suite <path>', 'suite file (yaml or json)')
    .option('--trace-dir <path>', 'where run traces are written', '.alarmdrill/traces')
    .option('--report <path>', 'also write a markdown report to this path')
    .option('--min-detection <rate>', 'fail below this detection rate, 0..1', parseRate)
    .option('--min-diagnosis <rate>', 'fail below this diagnosis rate, 0..1', parseRate)
    .option('--fail-on-needs-review', 'treat unsettled grades as a failure')
    .option('--detect-only', 'measure detection only; do not call a model')
    .option('--skip-preflight', 'drill even if the system already looks unhealthy')
    .action(async (options: RunCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const logger = createLogger({ level: globals.logLevel ?? 'info', pretty: globals.json !== true });
      const suite = loadSuite(options.suite);
      const session = buildSession(globals, logger, suite);

      const result = await runCommand({
        suite,
        session,
        logger,
        traceDir: options.traceDir,
        json: globals.json === true,
        ...(options.detectOnly === true ? { detectOnly: true } : {}),
        ...(options.skipPreflight === true ? { skipPreflight: true } : {}),
        ...(options.report === undefined ? {} : { reportPath: options.report }),
        thresholds: {
          ...(options.minDetection === undefined ? {} : { minDetection: options.minDetection }),
          ...(options.minDiagnosis === undefined ? {} : { minDiagnosis: options.minDiagnosis }),
          ...(options.failOnNeedsReview === true ? { failOnNeedsReview: true } : {}),
        },
      });

      process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
    });

  program
    .command('plan')
    .description('rank experiments by suspected blind spot, without breaking anything')
    .requiredOption('-s, --suite <path>', 'suite file, used for its endpoints')
    .action(async (options: { suite: string }) => {
      const globals = program.opts<GlobalOptions>();
      const suite = loadSuite(options.suite);
      const topology = await describeTopology(suite);
      const proposals = planExperiments(topology);

      if (globals.json === true) {
        process.stdout.write(`${JSON.stringify(proposals, null, 2)}\n`);
        return;
      }
      process.stdout.write('\n');
      for (const proposal of proposals) {
        process.stdout.write(
          `  ${String(proposal.score).padStart(3)}  ${proposal.suspectedGap.padEnd(10)} ${proposal.id}\n        ${proposal.rationale}\n\n`,
        );
      }
    });

  program
    .command('replay <runId>')
    .description('re-grade a recorded run against the current grader prompt — no injection')
    .option('--trace-dir <path>', 'where run traces live', '.alarmdrill/traces')
    .action(async (runId: string, options: { traceDir: string }) => {
      const globals = program.opts<GlobalOptions>();
      const store = createTraceStore({ dir: options.traceDir, clock: systemClock });
      const results = await replayRun(runId, { store, model: createAnthropicModel() });

      if (globals.json === true) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
        return;
      }
      for (const result of results) {
        const marker = result.changed ? 'CHANGED' : '      =';
        process.stdout.write(
          `  ${marker}  ${result.experimentId}: ${result.previous.verdict} (${result.previous.promptVersion}) -> ${result.regraded.verdict}\n`,
        );
      }
    });

  return program;
}

interface RunCommandOptions {
  suite: string;
  traceDir: string;
  report?: string;
  minDetection?: number;
  minDiagnosis?: number;
  failOnNeedsReview?: boolean;
  detectOnly?: boolean;
  skipPreflight?: boolean;
}

function parseRate(value: string): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`rate must be between 0 and 1, got "${value}"`);
  }
  return rate;
}

/**
 * Reads the running system rather than trusting a hand-written topology: which
 * services exist, which are scraped, and which metrics are real. A planner fed
 * an out-of-date map would propose experiments against gaps that were closed
 * months ago.
 */
async function describeTopology(suite: Suite) {
  const prometheus = createPrometheusClient({ baseUrl: suite.endpoints.prometheus });
  const up = await prometheus.queryInstant('up');
  const scraped = new Set(
    up.map((s) => s.labels['job']).filter((j): j is string => j !== undefined),
  );

  // Datastores appear as dependencies but are not scraped — that asymmetry is
  // exactly what the planner ranks on.
  const datastores = ['redis', 'postgres'];
  const services = [
    ...[...scraped].map((name) => ({
      name,
      dependsOn: DEPENDENCIES[name] ?? [],
      scraped: true,
    })),
    ...datastores.map((name) => ({ name, dependsOn: [], scraped: scraped.has(name) })),
  ];

  const knownMetrics: string[] = [];
  for (const metric of [
    'up',
    'http_request_duration_seconds_bucket',
    'http_requests_total',
    'process_resident_memory_bytes',
    'catalog_cache_lookups_total',
    'db_pool_connections',
  ]) {
    const series = await prometheus.queryInstant(metric).catch(() => []);
    if (series.length > 0) knownMetrics.push(metric);
  }

  // Read the rules that are really loaded. Passing an empty list made every
  // metric look unwatched and every hop look like a gap.
  const rules = await prometheus.listAlertRules();
  return { topology: { services, knownMetrics }, rules };
}

const DEPENDENCIES: Readonly<Record<string, string[]>> = {
  gateway: ['checkout', 'catalog'],
  checkout: ['payments', 'postgres'],
  payments: ['psp-mock'],
  catalog: ['redis', 'postgres'],
};

function buildSession(
  globals: GlobalOptions,
  logger: ReturnType<typeof createLogger>,
  suite?: Suite,
) {
  const toxiproxy = createToxiproxyClient({
    baseUrl: suite?.endpoints.toxiproxy ?? globals.toxiproxyUrl ?? 'http://localhost:8474',
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
    // Reverting is always permitted; injecting requires the suite's allowlist.
    // A bare sweep passes no suite, and an empty allowlist is right there.
    policy: { allow: suite?.safety.allow ?? [] },
  });

  installSignalCleanup({ session, logger });
  return session;
}
