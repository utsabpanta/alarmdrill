import type { Clock, ExperimentPorts, Logger } from '@alarmdrill/core';
import {
  diagnose,
  gradeDiagnosis,
  type Diagnosis,
  type GradeResult,
  type ModelClient,
} from '@alarmdrill/agents';
import {
  createDeclineRateInjector,
  createDockerControl,
  createLatencyInjector,
  createStopContainerInjector,
  createToxiproxyClient,
  type InjectionSession,
  type Injector,
} from '@alarmdrill/injectors';
import {
  buildEvidenceBundle,
  captureBaseline,
  collectMetrics,
  createAlertmanagerClient,
  createPrometheusClient,
  scoreDetection,
  startAlertWatch,
  type AlertPoll,
  type EvidenceBundle,
  type ObservedAlert,
} from '@alarmdrill/observers';
import type { Suite, SuiteExperimentSpec } from './suite.js';

/**
 * Where the packages meet.
 *
 * Note the shape of this file: injectors and observers are both constructed
 * here, in the CLI, and never see each other. `collectEvidence` receives a
 * time window and nothing else, and `diagnose` receives only the bundle that
 * comes back. The ground truth goes to the grader and stops there.
 */
export interface WiringDeps {
  readonly suite: Suite;
  /**
   * Fingerprints seen firing in any earlier experiment's baseline.
   *
   * A chronically-noisy alert can be momentarily absent when one baseline is
   * taken and back by the next experiment, where it would look novel. Carrying
   * known noise forward across the run stops that, and matches how an operator
   * thinks: an alert that has been firing all afternoon is not news.
   */
  readonly knownNoise?: Map<string, ObservedAlert>;
  readonly session: InjectionSession;
  readonly model: ModelClient;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ServiceCatalog {
  readonly services: readonly string[];
}

export function buildInjectorRegistry(suite: Suite): Record<string, Pick<Injector<never>, 'revert'>> {
  const toxiproxy = createToxiproxyClient({ baseUrl: suite.endpoints.toxiproxy });
  const latency = createLatencyInjector(toxiproxy);
  const stop = createStopContainerInjector(createDockerControl());
  const decline = createDeclineRateInjector();

  // Config types differ per injector; the session dispatches on `kind` and
  // only ever calls revert() through this registry, which is config-agnostic.
  return {
    [latency.kind]: latency,
    [stop.kind]: stop,
    [decline.kind]: decline,
  };
}

export function buildPorts(
  experiment: SuiteExperimentSpec,
  deps: WiringDeps,
  catalog: ServiceCatalog,
): ExperimentPorts<AlertPoll, EvidenceBundle, Diagnosis, GradeResult, ObservedAlert> {
  const alertmanager = createAlertmanagerClient({ baseUrl: deps.suite.endpoints.alertmanager });
  const prometheus = createPrometheusClient({ baseUrl: deps.suite.endpoints.prometheus });

  return {
    captureBaseline: async () => {
      const sampled = await captureBaseline({
        alertmanager,
        clock: deps.clock,
        samples: 3,
        intervalMs: 2_000,
      });
      for (const alert of sampled) deps.knownNoise?.set(alert.fingerprint, alert);
      return [...(deps.knownNoise?.values() ?? sampled)];
    },

    startWatch: () =>
      startAlertWatch({
        alertmanager,
        clock: deps.clock,
        logger: deps.logger,
        pollIntervalMs: deps.suite.defaults.pollIntervalMs,
      }),

    inject: () => applyFault(experiment, deps),

    scoreDetection: (input) =>
      scoreDetection({
        baseline: input.baseline,
        polls: input.polls,
        windowStart: input.windowStart,
      }),

    // Receives a window. Not the fault, not the target, not the moment of
    // injection — there is nothing here that could carry them.
    collectEvidence: async (window) =>
      buildEvidenceBundle({
        window,
        alerts: await alertmanager.activeAlerts(),
        metrics: await collectMetrics({ prometheus, window, stepSeconds: 15 }),
        services: catalog.services,
      }),

    diagnose: async (evidence) => (await diagnose(evidence, { model: deps.model })).diagnosis,

    // The grader is the only place ground truth enters.
    grade: async (diagnosis) =>
      await gradeDiagnosis(
        diagnosis,
        {
          description: experiment.description,
          expectedComponent: experiment.groundTruth.component,
          expectedCategory: experiment.groundTruth.category,
          expectedUndiagnosable: experiment.groundTruth.undiagnosable,
        },
        { model: deps.model },
      ),
  };
}

async function applyFault(
  experiment: SuiteExperimentSpec,
  deps: WiringDeps,
): Promise<{ id: string; revert: () => Promise<void> }> {
  const maxDurationMs = experiment.maxDurationMs ?? deps.suite.defaults.maxDurationMs;
  const options = { maxDurationMs };
  const fault = experiment.fault;

  // Dispatched explicitly rather than through the registry: each injector has
  // its own config type, and a switch keeps that checked instead of cast away.
  switch (fault.kind) {
    case 'docker.stop':
      return await deps.session.inject(
        createStopContainerInjector(createDockerControl()),
        { container: fault.container },
        options,
      );

    case 'toxiproxy.latency':
      return await deps.session.inject(
        createLatencyInjector(createToxiproxyClient({ baseUrl: deps.suite.endpoints.toxiproxy })),
        {
          proxy: fault.proxy,
          latencyMs: fault.latencyMs,
          ...(fault.jitterMs === undefined ? {} : { jitterMs: fault.jitterMs }),
        },
        options,
      );

    case 'http.decline-rate':
      return await deps.session.inject(
        createDeclineRateInjector(),
        {
          controlUrl: fault.controlUrl,
          target: fault.target,
          declineRate: fault.declineRate,
        },
        options,
      );
  }
}
