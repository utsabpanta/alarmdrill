import type { ExperimentOutcome, RunSummary } from './types.js';

/**
 * The grade.
 *
 * Detection and diagnosis are scored separately and then combined, because
 * they fail independently and conflating them hides the interesting cases: an
 * alert that fires but tells you nothing scores well on detection and badly on
 * diagnosis, and that gap is the finding.
 */
export interface Scorecard {
  readonly detected: number;
  readonly diagnosed: number;
  readonly total: number;
  readonly detectionRate: number;
  readonly diagnosisRate: number;
  readonly medianTimeToDetectMs: number | null;
  readonly grade: string;
  /** Experiments whose diagnosis was actually graded. */
  readonly graded: number;
  readonly needsReview: number;
}

/**
 * The curve is anchored to SPEC.md's worked example: detection 3/4 and
 * diagnosis 2/4 is stated there as a C+, and that combination scores 0.625
 * here. A school grading scale would call that an F, which is both
 * discouraging and uninformative — an F should mean "your monitoring is
 * effectively absent", not "you caught most things and could explain half".
 *
 * These bands are a judgement, not a measurement. Change them and every past
 * run's letter changes meaning, so the run trace records the numbers too.
 */
const LETTERS: readonly { min: number; letter: string }[] = [
  { min: 0.95, letter: 'A+' },
  { min: 0.85, letter: 'A' },
  { min: 0.8, letter: 'A-' },
  { min: 0.75, letter: 'B+' },
  { min: 0.7, letter: 'B' },
  { min: 0.675, letter: 'B-' },
  { min: 0.6, letter: 'C+' },
  { min: 0.5, letter: 'C' },
  { min: 0.45, letter: 'C-' },
  { min: 0.3, letter: 'D' },
  { min: 0, letter: 'F' },
];

/**
 * A correct diagnosis counts fully; a partial one counts half. An experiment
 * whose fault was genuinely undiagnosable counts as diagnosed when the agent
 * said so — refusing to guess from absent evidence is the right answer, and
 * penalising it would push the tool toward rewarding confident invention.
 */
export function scoreOutcome(outcome: ExperimentOutcome): {
  detected: number;
  diagnosed: number;
  graded: boolean;
} {
  const detected = outcome.detection.detected ? 1 : 0;
  if (outcome.grade.verdict === 'skipped') {
    // Not scored at all. Counting it as zero would report a diagnosis failure
    // that never happened.
    return { detected, diagnosed: 0, graded: false };
  }
  const diagnosed =
    outcome.grade.verdict === 'correct' ? 1 : outcome.grade.verdict === 'partial' ? 0.5 : 0;
  return { detected, diagnosed, graded: true };
}

export function buildScorecard(run: RunSummary): Scorecard {
  const total = run.outcomes.length;
  const scores = run.outcomes.map(scoreOutcome);
  const detected = scores.reduce((sum, s) => sum + s.detected, 0);
  const diagnosed = scores.reduce((sum, s) => sum + s.diagnosed, 0);
  const gradedCount = scores.filter((s) => s.graded).length;

  const times = run.outcomes
    .map((o) => o.detection.timeToDetectMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  const detectionRate = total === 0 ? 0 : detected / total;
  // Averaged over experiments that were actually graded, so a detect-only run
  // does not read as a diagnosis failure.
  const diagnosisRate = gradedCount === 0 ? 0 : diagnosed / gradedCount;
  // Detection and diagnosis weigh equally: knowing something broke is worth no
  // more than being able to work out what.
  const overall =
    total === 0 ? 0 : gradedCount === 0 ? detectionRate : (detectionRate + diagnosisRate) / 2;

  return {
    detected,
    diagnosed,
    total,
    detectionRate,
    diagnosisRate,
    medianTimeToDetectMs: medianOf(times),
    graded: gradedCount,
    grade:
      gradedCount === 0 ? 'n/a' : (LETTERS.find((entry) => overall >= entry.min)?.letter ?? 'F'),
    needsReview: run.outcomes.filter((o) => o.grade.needsReview).length,
  };
}

function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}
