import type { Diagnosis } from './diagnostician.js';
import type { GradeDeps, GradeResult } from './grader.js';
import { gradeDiagnosis } from './grader.js';
import type { RunTrace, TraceStore } from './trace.js';

export interface ReplayResult {
  readonly experimentId: string;
  readonly previous: { verdict: string; promptVersion: string };
  readonly regraded: GradeResult;
  readonly changed: boolean;
}

/**
 * Re-grades a completed run offline, against whatever the current grader prompt
 * is. Nothing is injected and no experiment is re-run — this reads traces and
 * calls the grader.
 *
 * The diagnostician is never invoked here. Its diagnosis is replayed as
 * recorded, because a trace contains the ground truth and re-prompting a
 * blinded agent from a file that holds the answer would be exactly the leak
 * this project exists to prevent.
 */
export async function replayRun(
  runId: string,
  deps: GradeDeps & { store: TraceStore },
): Promise<ReplayResult[]> {
  const traces = await deps.store.list(runId);
  const results: ReplayResult[] = [];

  for (const trace of traces) {
    results.push(await replayTrace(trace, deps));
  }
  return results;
}

export async function replayTrace(
  trace: RunTrace,
  deps: GradeDeps,
): Promise<ReplayResult> {
  const regraded = await gradeDiagnosis(
    trace.diagnosis,
    {
      description: trace.groundTruth.description,
      expectedComponent: trace.groundTruth.expectedComponent,
      expectedCategory: trace.groundTruth.expectedCategory as Diagnosis['faultCategory'],
      ...(trace.groundTruth.expectedUndiagnosable === undefined
        ? {}
        : { expectedUndiagnosable: trace.groundTruth.expectedUndiagnosable }),
    },
    deps,
  );

  return {
    experimentId: trace.experimentId,
    previous: { verdict: trace.grade.verdict, promptVersion: trace.grade.promptVersion },
    regraded,
    changed: regraded.verdict !== trace.grade.verdict,
  };
}
