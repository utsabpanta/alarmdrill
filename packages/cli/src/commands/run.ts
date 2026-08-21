import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runSuite, systemClock, type ExperimentPorts, type Logger } from '@alarmdrill/core';
import {
  createAnthropicModel,
  createTraceStore,
  CURRENT_PROMPT_VERSIONS,
  type ModelClient,
} from '@alarmdrill/agents';
import type { InjectionSession } from '@alarmdrill/injectors';
import { createAlertmanagerClient, createPrometheusClient } from '@alarmdrill/observers';
import { buildScorecard, deriveFindings, renderMarkdown } from '@alarmdrill/report';
import type { ExperimentOutcome } from '@alarmdrill/report';
import { renderHuman, toJson, type JsonExperiment } from '../output.js';
import type { Suite } from '../suite.js';
import { describeIssues, preflight } from '../preflight.js';
import { waitUntilQuiet } from '../quiet.js';
import { evaluateThresholds, type ThresholdOptions } from '../threshold.js';
import { buildPorts } from '../wire.js';

export interface RunDeps {
  readonly suite: Suite;
  /**
   * Inject and measure detection, but skip the blinded agent entirely.
   *
   * Useful without an API key, and useful in CI that only cares about MTTD.
   * It answers "did anything alert?" and deliberately does not pretend to
   * answer "could anyone have diagnosed it?" — a skipped diagnosis is reported
   * as skipped, never as a failure.
   */
  readonly detectOnly?: boolean;
  readonly session: InjectionSession;
  readonly logger: Logger;
  readonly model?: ModelClient;
  readonly traceDir: string;
  readonly reportPath?: string;
  readonly json: boolean;
  readonly thresholds: ThresholdOptions;
  /** Drill even if the system looks unhealthy. Rarely what you want. */
  readonly skipPreflight?: boolean;
}

export interface RunOutcome {
  readonly exitCode: number;
  readonly stdout: string;
}

export async function runCommand(deps: RunDeps): Promise<RunOutcome> {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const detectOnly = deps.detectOnly === true;
  const model = detectOnly ? SKIPPED_MODEL : (deps.model ?? createAnthropicModel());

  // Sweep first. A previous run that died could have left a fault applied, and
  // drilling on top of it would poison every result that follows.
  const swept = await deps.session.sweepOrphans();
  if (swept.reverted.length > 0) {
    deps.logger.warn(
      { reverted: swept.reverted.map((e) => e.target) },
      'reverted faults left behind by a previous run before starting',
    );
  }
  if (swept.failed.length > 0) {
    throw new Error(
      `refusing to start: ${String(swept.failed.length)} fault(s) from a previous run could not be reverted — ${swept.failed
        .map((f) => `${f.entry.target}: ${f.reason}`)
        .join('; ')}`,
    );
  }

  const prometheus = createPrometheusClient({ baseUrl: deps.suite.endpoints.prometheus });

  if (deps.skipPreflight !== true) {
    const issues = await preflight({ suite: deps.suite, prometheus });
    if (issues.length > 0) {
      throw new Error(
        `the system is not healthy enough to drill:\n${describeIssues(issues)}\n\n` +
          'Grading monitoring against an already-broken system produces numbers that ' +
          'look fine and mean nothing. Fix the above, or pass --skip-preflight.',
      );
    }
  }

  const catalog = { services: await discoverServices(prometheus) };
  const wiring = {
    suite: deps.suite,
    session: deps.session,
    model,
    clock: systemClock,
    logger: deps.logger,
  };

  const suiteResult = await runSuite(
    deps.suite.experiments.map((experiment) => ({
      options: {
        id: experiment.id,
        holdMs: experiment.holdMs ?? deps.suite.defaults.holdMs,
        windowPaddingMs: deps.suite.defaults.windowPaddingMs,
      },
      ports: detectOnly
        ? withoutDiagnosis(buildPorts(experiment, wiring, catalog))
        : buildPorts(experiment, wiring, catalog),
    })),
    {
      runId,
      // Wait until the firing-alert set stops changing, not for a fixed delay:
      // a latency alert with `for: 1m` over a 1m rate keeps firing for roughly
      // two minutes after its fault ends.
      settle: () =>
        waitUntilQuiet({
          alertmanager: createAlertmanagerClient({ baseUrl: deps.suite.endpoints.alertmanager }),
          clock: systemClock,
          logger: deps.logger,
          maxWaitMs: deps.suite.defaults.settleMs,
        }),
    },
    { clock: systemClock, logger: deps.logger },
  );

  // Traces before reporting: a crash while rendering must not lose the run.
  const traces = createTraceStore({ dir: deps.traceDir, clock: systemClock });
  const outcomes: ExperimentOutcome[] = [];

  for (const result of suiteResult.results) {
    const spec = deps.suite.experiments.find((e) => e.id === result.id);
    if (spec === undefined) continue;

    outcomes.push({
      id: result.id,
      faultDescription: spec.description,
      target: spec.groundTruth.component,
      detection: result.detection as ExperimentOutcome['detection'],
      diagnosis: result.diagnosis,
      grade: result.grade,
      expectedUndiagnosable: spec.groundTruth.undiagnosable,
    });

    await traces.write({
      schemaVersion: 1,
      runId,
      experimentId: result.id,
      createdAt: systemClock.now().toISOString(),
      promptVersions: CURRENT_PROMPT_VERSIONS,
      modelName: model.name,
      evidence: result.evidence,
      diagnosis: result.diagnosis,
      groundTruth: {
        description: spec.description,
        expectedComponent: spec.groundTruth.component,
        expectedCategory: spec.groundTruth.category,
        expectedUndiagnosable: spec.groundTruth.undiagnosable,
      },
      detection: {
        detected: result.detection.detected,
        timeToDetectMs: result.detection.timeToDetectMs,
        novelAlertNames: result.detection.novel.map((a) => a.alertname),
        preexistingAlertNames: result.detection.preexisting.map((a) => a.alertname),
      },
      grade: { ...result.grade, votes: [...result.grade.votes] },
    });
  }

  const scorecard = buildScorecard({
    runId,
    startedAt: runId,
    outcomes,
    promptVersions: CURRENT_PROMPT_VERSIONS,
    modelName: model.name,
  });

  const knownMetrics = await discoverMetrics(prometheus);
  const findings = deriveFindings(outcomes, { knownMetrics });

  const experiments: JsonExperiment[] = outcomes.map((outcome, index) => ({
    id: outcome.id,
    detected: outcome.detection.detected,
    timeToDetectMs: outcome.detection.timeToDetectMs,
    verdict: outcome.grade.verdict,
    needsReview: outcome.grade.needsReview,
    finding: findings[index]?.kind ?? 'unknown',
    proposedRule: findings[index]?.proposedRule?.alertName ?? null,
  }));

  const thresholds = evaluateThresholds(
    {
      detectionRate: scorecard.detectionRate,
      diagnosisRate: scorecard.diagnosisRate,
      needsReview: scorecard.needsReview,
    },
    // Gating on diagnosis makes no sense when no diagnosis was attempted.
    detectOnly ? stripDiagnosisGate(deps.thresholds) : deps.thresholds,
  );

  if (deps.reportPath !== undefined && !detectOnly) {
    const markdown = renderMarkdown({
      knownMetrics,
      run: {
        runId,
        startedAt: runId,
        outcomes,
        promptVersions: CURRENT_PROMPT_VERSIONS,
        modelName: model.name,
      },
    });
    await mkdir(join(deps.reportPath, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(deps.reportPath, markdown, 'utf8');
  }

  const stdout = deps.json
    ? `${JSON.stringify(toJson({ runId, scorecard, experiments, thresholds, detectOnly }), null, 2)}\n`
    : renderHuman({ runId, scorecard, experiments, thresholds, detectOnly });

  // A failed experiment is not the same as monitoring that scored badly, so it
  // gets its own exit code rather than being folded into the threshold gate.
  const exitCode = suiteResult.failures.length > 0 ? 3 : thresholds.exitCode;
  return { exitCode, stdout };
}

async function discoverServices(
  prometheus: ReturnType<typeof createPrometheusClient>,
): Promise<string[]> {
  const series = await prometheus.queryInstant('up');
  const names = new Set(series.map((s) => s.labels['job']).filter((j): j is string => j !== undefined));
  return [...names].sort();
}

async function discoverMetrics(
  prometheus: ReturnType<typeof createPrometheusClient>,
): Promise<string[]> {
  // Which metrics exist decides whether a gap is "write a rule" or "go
  // instrument this", so it is read from the system rather than assumed.
  const probes = [
    'catalog_cache_lookups_total',
    'db_pool_connections',
    'http_request_duration_seconds_bucket',
    'http_requests_total',
    'process_resident_memory_bytes',
    'up',
  ];
  const found: string[] = [];
  for (const metric of probes) {
    const series = await prometheus.queryInstant(metric).catch(() => []);
    if (series.length > 0) found.push(metric);
  }
  return found;
}

/** Stands in for the agent when --detect-only is set. Never calls anything. */
const SKIPPED_MODEL: ModelClient = {
  name: 'skipped',
  complete: () => Promise.reject(new Error('the model is not called in --detect-only mode')),
};

function withoutDiagnosis<P, E, D, G, A extends { fingerprint: string; alertname: string }>(
  ports: ExperimentPorts<P, E, D, G, A>,
): ExperimentPorts<P, E, D, G, A> {
  return {
    ...ports,
    diagnose: () =>
      Promise.resolve({
        suspectedComponent: 'not attempted',
        faultCategory: 'unknown',
        confidence: 'low',
        reasoning: 'Diagnosis was skipped: this run measured detection only.',
        evidenceCited: [],
        missingTelemetry: 'n/a — no diagnosis was attempted',
      } as unknown as D),
    grade: () =>
      Promise.resolve({
        verdict: 'skipped',
        votes: [],
        disagreementRate: 0,
        needsReview: false,
        promptVersion: 'n/a',
      } as unknown as G),
  };
}

function stripDiagnosisGate(options: ThresholdOptions): ThresholdOptions {
  const { minDiagnosis: _ignored, ...rest } = options;
  return rest;
}
