import { EXIT_CODES, type ExitCode } from './exit-codes.js';

/**
 * CI mode. A drill that finds blind spots should be able to fail a build, but
 * only against a threshold someone chose deliberately — a tool that fails the
 * build by default gets disabled by default.
 */
export interface ThresholdInput {
  readonly detectionRate: number;
  readonly diagnosisRate: number;
  readonly needsReview: number;
}

export interface ThresholdOptions {
  /** Minimum detection rate, 0..1. Unset means do not gate on it. */
  readonly minDetection?: number;
  readonly minDiagnosis?: number;
  /** Treat unsettled grades as a failure rather than a warning. */
  readonly failOnNeedsReview?: boolean;
}

export interface ThresholdResult {
  readonly passed: boolean;
  readonly exitCode: ExitCode;
  readonly reasons: readonly string[];
}

const pct = (n: number): string => `${String(Math.round(n * 100))}%`;

export function evaluateThresholds(
  input: ThresholdInput,
  options: ThresholdOptions,
): ThresholdResult {
  const reasons: string[] = [];

  if (options.minDetection !== undefined && input.detectionRate < options.minDetection) {
    reasons.push(
      `detection ${pct(input.detectionRate)} is below the required ${pct(options.minDetection)}`,
    );
  }
  if (options.minDiagnosis !== undefined && input.diagnosisRate < options.minDiagnosis) {
    reasons.push(
      `diagnosis ${pct(input.diagnosisRate)} is below the required ${pct(options.minDiagnosis)}`,
    );
  }
  if (options.failOnNeedsReview === true && input.needsReview > 0) {
    reasons.push(
      `${String(input.needsReview)} experiment(s) had no majority verdict and need review`,
    );
  }

  return {
    passed: reasons.length === 0,
    exitCode: reasons.length === 0 ? EXIT_CODES.ok : EXIT_CODES.belowThreshold,
    reasons,
  };
}
