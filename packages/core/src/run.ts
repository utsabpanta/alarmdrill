import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import { runError } from './errors.js';

/**
 * The run lifecycle.
 *
 * Core owns orchestration but imports none of the other packages — the ports
 * below are structural, so injectors, observers and agents all depend on core
 * and never the other way round. That is what keeps the dependency graph
 * acyclic while still putting the sequencing in one readable place.
 *
 * The sequence matters, and one ordering decision is load-bearing: the
 * baseline is captured BEFORE injection. Alerts already firing then are not
 * detections, and without that snapshot a chronically-noisy alert would make
 * every blind spot look caught.
 */
/**
 * The minimum core needs to log an alert. Callers supply their own richer type
 * as the `Alert` parameter below — core never needs to know what else is on it,
 * and widening this to fit one caller would drag observability details into
 * the orchestrator.
 */
export interface AlertLike {
  readonly fingerprint: string;
  readonly alertname: string;
}

export interface DetectionLike<Alert extends AlertLike = AlertLike> {
  readonly detected: boolean;
  readonly timeToDetectMs: number | null;
  readonly novel: readonly Alert[];
  readonly preexisting: readonly Alert[];
}

export interface WatchLike<Poll> {
  readonly stop: () => Promise<Poll[]>;
}

export interface ActiveInjectionLike {
  readonly id: string;
  readonly revert: () => Promise<void>;
}

/** Everything an experiment needs, supplied by the CLI. */
export interface ExperimentPorts<Poll, Evidence, Diagnosis, Grade, Alert extends AlertLike = AlertLike> {
  readonly captureBaseline: () => Promise<Alert[]>;
  readonly startWatch: () => WatchLike<Poll>;
  readonly inject: () => Promise<ActiveInjectionLike>;
  readonly scoreDetection: (input: {
    baseline: readonly Alert[];
    polls: readonly Poll[];
    windowStart: Date;
  }) => DetectionLike<Alert>;
  /**
   * Builds the evidence bundle. Receives a window only — never the fault, and
   * never the moment it was applied.
   */
  readonly collectEvidence: (window: { from: Date; to: Date }) => Promise<Evidence>;
  readonly diagnose: (evidence: Evidence) => Promise<Diagnosis>;
  readonly grade: (diagnosis: Diagnosis) => Promise<Grade>;
}

export interface ExperimentOptions {
  readonly id: string;
  /** How long to leave the fault applied. */
  readonly holdMs: number;
  /**
   * How far before injection the evidence window reaches back. Padding it is
   * deliberate: a window starting exactly at injection would tell the
   * diagnostician when the fault began, which is most of a diagnosis.
   */
  readonly windowPaddingMs?: number;
}

export interface ExperimentResult<Evidence, Diagnosis, Grade, Alert extends AlertLike = AlertLike> {
  readonly id: string;
  readonly detection: DetectionLike<Alert>;
  readonly evidence: Evidence;
  readonly diagnosis: Diagnosis;
  readonly grade: Grade;
}

export interface ExperimentDeps {
  readonly clock: Clock;
  readonly logger: Logger;
}

export const DEFAULT_WINDOW_PADDING_MS = 120_000;

export async function runExperiment<Poll, Evidence, Diagnosis, Grade, Alert extends AlertLike>(
  ports: ExperimentPorts<Poll, Evidence, Diagnosis, Grade, Alert>,
  options: ExperimentOptions,
  deps: ExperimentDeps,
): Promise<ExperimentResult<Evidence, Diagnosis, Grade, Alert>> {
  const padding = options.windowPaddingMs ?? DEFAULT_WINDOW_PADDING_MS;

  // 1. What was already wrong before we touched anything.
  const baseline = await ports.captureBaseline();
  deps.logger.info(
    { experiment: options.id, preexisting: baseline.map((a) => a.alertname) },
    'baseline captured',
  );

  const windowStart = deps.clock.now();
  const watch = ports.startWatch();

  let active: ActiveInjectionLike | undefined;
  // Assigned in `finally`, so it is set on both the success and failure paths.
  let polls: Poll[];

  try {
    // 2. Break it. The injector journals before applying.
    active = await ports.inject();
    deps.logger.info({ experiment: options.id, injection: active.id }, 'fault applied');

    // 3. Let it run.
    await deps.clock.sleep(options.holdMs);
  } finally {
    // 4. Put it back, always — including when injection itself threw. The
    //    watch is stopped first so a detection landing during revert is not
    //    attributed to the fault still being present.
    polls = await watch.stop().catch(() => []);
    if (active !== undefined) {
      await active.revert();
      deps.logger.info({ experiment: options.id }, 'fault reverted');
    }
  }

  const detection = ports.scoreDetection({ baseline, polls, windowStart });

  // 5. Gather what an engineer would see. The window reaches back before the
  //    injection so its start is not a marker for when things changed.
  const evidence = await ports.collectEvidence({
    from: new Date(windowStart.getTime() - padding),
    to: deps.clock.now(),
  });

  // 6. Blinded diagnosis, then grading against ground truth.
  const diagnosis = await ports.diagnose(evidence);
  const grade = await ports.grade(diagnosis);

  return { id: options.id, detection, evidence, diagnosis, grade };
}

export interface SuiteOptions {
  readonly runId: string;
  /** Stop the whole suite if an experiment fails, rather than pressing on. */
  readonly failFast?: boolean;
  /**
   * Called between experiments to let the system finish recovering.
   *
   * A callback rather than a duration, because how long recovery takes depends
   * on the alert rules being drilled. A fixed wait that is too short makes the
   * next experiment score the previous fault's lingering alerts as its own
   * detection, and nothing downstream can tell that happened.
   */
  readonly settle?: () => Promise<unknown>;
}

export interface SuiteExperiment<Poll, Evidence, Diagnosis, Grade, Alert extends AlertLike = AlertLike> {
  readonly options: ExperimentOptions;
  readonly ports: ExperimentPorts<Poll, Evidence, Diagnosis, Grade, Alert>;
}

export interface SuiteResult<Evidence, Diagnosis, Grade, Alert extends AlertLike = AlertLike> {
  readonly runId: string;
  readonly results: readonly ExperimentResult<Evidence, Diagnosis, Grade, Alert>[];
  readonly failures: readonly { id: string; reason: string }[];
}

export async function runSuite<Poll, Evidence, Diagnosis, Grade, Alert extends AlertLike>(
  experiments: readonly SuiteExperiment<Poll, Evidence, Diagnosis, Grade, Alert>[],
  options: SuiteOptions,
  deps: ExperimentDeps,
): Promise<SuiteResult<Evidence, Diagnosis, Grade, Alert>> {
  const results: ExperimentResult<Evidence, Diagnosis, Grade, Alert>[] = [];
  const failures: { id: string; reason: string }[] = [];

  // Strictly sequential: one fault at a time, so a diagnosis is never
  // ambiguous about which fault it was explaining.
  let first = true;
  for (const experiment of experiments) {
    if (!first && options.settle !== undefined) {
      deps.logger.info('waiting for the system to settle before the next experiment');
      await options.settle();
    }
    first = false;

    try {
      results.push(await runExperiment(experiment.ports, experiment.options, deps));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.error({ experiment: experiment.options.id, err: error }, 'experiment failed');
      failures.push({ id: experiment.options.id, reason });
      if (options.failFast === true) {
        throw runError(`experiment ${experiment.options.id} failed: ${reason}`, { cause: error });
      }
    }
  }

  return { runId: options.runId, results, failures };
}
