import { describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exit-codes.js';
import { evaluateThresholds } from './threshold.js';

const run = { detectionRate: 0.5, diagnosisRate: 0.75, needsReview: 0 };

describe('evaluateThresholds', () => {
  // A tool that fails the build by default gets disabled by default.
  it('passes when no threshold was set', () => {
    expect(evaluateThresholds(run, {})).toMatchObject({ passed: true, exitCode: EXIT_CODES.ok });
  });

  it('fails below the detection threshold with a distinct exit code', () => {
    const result = evaluateThresholds(run, { minDetection: 0.8 });
    expect(result.passed).toBe(false);
    // Distinct from a crash: the run worked, the monitoring did not.
    expect(result.exitCode).toBe(EXIT_CODES.belowThreshold);
    expect(result.reasons[0]).toContain('detection 50% is below the required 80%');
  });

  it('fails below the diagnosis threshold', () => {
    expect(evaluateThresholds(run, { minDiagnosis: 0.9 }).reasons[0]).toContain('diagnosis 75%');
  });

  it('reports every reason, not just the first', () => {
    const result = evaluateThresholds(run, { minDetection: 0.9, minDiagnosis: 0.9 });
    expect(result.reasons).toHaveLength(2);
  });

  it('passes when exactly on the threshold', () => {
    expect(evaluateThresholds(run, { minDetection: 0.5 }).passed).toBe(true);
  });

  it('gates on unsettled grades only when asked', () => {
    const unsettled = { ...run, needsReview: 2 };
    expect(evaluateThresholds(unsettled, {}).passed).toBe(true);
    expect(evaluateThresholds(unsettled, { failOnNeedsReview: true })).toMatchObject({
      passed: false,
      exitCode: EXIT_CODES.belowThreshold,
    });
  });
});
