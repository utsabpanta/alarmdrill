import { describe, expect, it } from 'vitest';
import { renderHuman, toJson, type JsonExperiment } from './output.js';
import { evaluateThresholds } from './threshold.js';

const scorecard = {
  detected: 3, diagnosed: 2, total: 4,
  detectionRate: 0.75, diagnosisRate: 0.5,
  medianTimeToDetectMs: 76_000, grade: 'C+', needsReview: 0,
};

const experiments: JsonExperiment[] = [
  {
    id: 'latency: checkout → payments +800ms',
    detected: true, timeToDetectMs: 76_000, verdict: 'correct',
    needsReview: false, finding: 'late', proposedRule: null,
  },
  {
    id: 'dependency down: redis',
    detected: false, timeToDetectMs: null, verdict: 'incorrect',
    needsReview: false, finding: 'blind_spot', proposedRule: 'CacheBackendUnavailable',
  },
];

const passing = evaluateThresholds({ detectionRate: 0.75, diagnosisRate: 0.5, needsReview: 0 }, {});

describe('renderHuman', () => {
  const text = renderHuman({ runId: 'run-1', scorecard, experiments, thresholds: passing });

  // The shape SPEC.md advertises. If this drifts, the README lies.
  it('matches the shape from the spec', () => {
    expect(text).toContain('[1/2] latency: checkout → payments +800ms');
    expect(text).toContain('detected 76s · diagnosis ✓ correct');
    expect(text).toContain('detected never');
    expect(text).toContain('✗ BLIND SPOT');
    expect(text).toContain('Grade: C+ (detection 3/4 · diagnosis 2/4)');
  });

  it('flags unsettled verdicts inline where they will be seen', () => {
    const withReview = renderHuman({
      runId: 'run-1', scorecard, thresholds: passing,
      experiments: [{ ...experiments[0]!, needsReview: true }],
    });
    expect(withReview).toContain('graders disagreed');
  });

  it('prints why a threshold failed, not just that it did', () => {
    const failed = evaluateThresholds(
      { detectionRate: 0.75, diagnosisRate: 0.5, needsReview: 0 },
      { minDetection: 0.9 },
    );
    const text2 = renderHuman({ runId: 'r', scorecard, experiments, thresholds: failed });
    expect(text2).toContain('FAIL: detection 75% is below the required 90%');
  });
});

describe('toJson', () => {
  const json = toJson({ runId: 'run-1', scorecard, experiments, thresholds: passing });

  it('is a versioned contract CI can parse', () => {
    expect(json.schemaVersion).toBe(1);
    expect(json.grade).toBe('C+');
    expect(json.detection).toEqual({ rate: 0.75, detected: 3, total: 4 });
  });

  it('carries no prose — machines get data, humans get the summary', () => {
    const serialized = JSON.stringify(json);
    for (const phrase of ['BLIND SPOT', 'Grade:', '✓', '·']) {
      expect(serialized).not.toContain(phrase);
    }
  });

  it('round-trips through JSON unchanged', () => {
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('names the rule it proposed so CI can diff it', () => {
    expect(json.experiments[1]?.proposedRule).toBe('CacheBackendUnavailable');
  });
});

describe('detect-only output', () => {
  const skipped: JsonExperiment[] = [
    {
      id: 'redis-down', detected: false, timeToDetectMs: null,
      verdict: 'skipped', needsReview: false, finding: 'blind_spot', proposedRule: null,
    },
  ];
  const card = { ...scorecard, detected: 0, diagnosed: 0, total: 1, detectionRate: 0, diagnosisRate: 0 };

  it('reports no grade rather than inventing one', () => {
    // A grade combines detection and diagnosis. With no diagnosis attempted
    // there is nothing to grade, and printing a letter anyway would be a lie.
    const text = renderHuman({
      runId: 'r', scorecard: card, experiments: skipped, thresholds: passing, detectOnly: true,
    });
    expect(text).toContain('no grade — diagnosis was skipped');
    expect(text).not.toMatch(/Grade: [A-F]/);
  });

  it('marks the diagnosis as skipped, not as wrong', () => {
    const text = renderHuman({
      runId: 'r', scorecard: card, experiments: skipped, thresholds: passing, detectOnly: true,
    });
    expect(text).toContain('diagnosis — skipped');
    expect(text).not.toContain('✗ wrong');
  });

  it('nulls the diagnosis numbers in json instead of reporting zero', () => {
    // Zero would read as "diagnosed nothing", which is a much worse claim than
    // "did not try".
    const json = toJson({
      runId: 'r', scorecard: card, experiments: skipped, thresholds: passing, detectOnly: true,
    });
    expect(json.grade).toBe('n/a');
    expect(json.diagnosis).toEqual({ rate: null, diagnosed: null, skipped: true });
  });

  it('still reports detection honestly', () => {
    const json = toJson({
      runId: 'r', scorecard: card, experiments: skipped, thresholds: passing, detectOnly: true,
    });
    expect(json.detection).toEqual({ rate: 0, detected: 0, total: 1 });
  });
});
