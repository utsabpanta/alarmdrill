import type { Scorecard } from '@alarmdrill/report';
import type { ThresholdResult } from './threshold.js';

/**
 * `--json` is for machines and the default output is for humans; neither is a
 * reformatting of the other. The JSON shape is a contract — CI parses it — so
 * it is versioned and never carries prose.
 */
export interface JsonRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly grade: string;
  readonly detection: { readonly rate: number; readonly detected: number; readonly total: number };
  readonly diagnosis: { readonly rate: number; readonly diagnosed: number };
  readonly medianTimeToDetectMs: number | null;
  readonly needsReview: number;
  readonly experiments: readonly JsonExperiment[];
  readonly thresholds: { readonly passed: boolean; readonly reasons: readonly string[] };
}

export interface JsonExperiment {
  readonly id: string;
  readonly detected: boolean;
  readonly timeToDetectMs: number | null;
  readonly verdict: string;
  readonly needsReview: boolean;
  readonly finding: string;
  readonly proposedRule: string | null;
}

export function toJson(input: {
  runId: string;
  scorecard: Scorecard;
  experiments: readonly JsonExperiment[];
  thresholds: ThresholdResult;
}): JsonRun {
  return {
    schemaVersion: 1,
    runId: input.runId,
    grade: input.scorecard.grade,
    detection: {
      rate: input.scorecard.detectionRate,
      detected: input.scorecard.detected,
      total: input.scorecard.total,
    },
    diagnosis: { rate: input.scorecard.diagnosisRate, diagnosed: input.scorecard.diagnosed },
    medianTimeToDetectMs: input.scorecard.medianTimeToDetectMs,
    needsReview: input.scorecard.needsReview,
    experiments: input.experiments,
    thresholds: { passed: input.thresholds.passed, reasons: input.thresholds.reasons },
  };
}

/** The terminal summary from SPEC.md's example. */
export function renderHuman(input: {
  runId: string;
  scorecard: Scorecard;
  experiments: readonly JsonExperiment[];
  thresholds: ThresholdResult;
}): string {
  const lines: string[] = ['', `  ${input.runId}`, ''];

  input.experiments.forEach((experiment, index) => {
    const position = `[${String(index + 1)}/${String(input.experiments.length)}]`;
    lines.push(`  ${position} ${experiment.id}`);

    const detection = experiment.detected
      ? `detected ${formatMs(experiment.timeToDetectMs)}`
      : 'detected never';
    const verdict =
      experiment.verdict === 'correct'
        ? 'diagnosis ✓ correct'
        : experiment.verdict === 'partial'
          ? 'diagnosis ~ partial'
          : 'diagnosis ✗ wrong';
    const flag = !experiment.detected ? '  ✗ BLIND SPOT' : '';

    lines.push(`        ${detection} · ${verdict}${flag}`);
    if (experiment.needsReview) {
      lines.push('        ! graders disagreed — verdict unsettled');
    }
  });

  lines.push(
    '',
    `  Grade: ${input.scorecard.grade} (detection ${String(input.scorecard.detected)}/${String(
      input.scorecard.total,
    )} · diagnosis ${String(input.scorecard.diagnosed)}/${String(input.scorecard.total)})`,
  );

  if (!input.thresholds.passed) {
    lines.push('');
    for (const reason of input.thresholds.reasons) {
      lines.push(`  FAIL: ${reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function formatMs(ms: number | null): string {
  if (ms === null) return 'never';
  return ms < 1_000 ? `${String(ms)}ms` : `${String(Math.round(ms / 1_000))}s`;
}
