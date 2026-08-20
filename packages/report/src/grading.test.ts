import { describe, expect, it } from 'vitest';
import { buildScorecard, scoreOutcome } from './grading.js';
import { NOISY, outcome, run } from './fixtures.js';

const detected = (ms: number) => ({
  detected: true, timeToDetectMs: ms, firstDetectedAt: null, novel: [], preexisting: [],
});
const missed = {
  detected: false, timeToDetectMs: null, firstDetectedAt: null, novel: [], preexisting: [NOISY],
};
const graded = (verdict: 'correct' | 'partial' | 'incorrect', needsReview = false) => ({
  verdict, votes: [], disagreementRate: 0, needsReview, promptVersion: 'v1',
});

describe('scoreOutcome', () => {
  it('gives a partial diagnosis half credit', () => {
    expect(scoreOutcome(outcome({ detection: detected(1_000), grade: graded('partial') })))
      .toEqual({ detected: 1, diagnosed: 0.5 });
  });

  it('scores detection and diagnosis independently', () => {
    // Alerted loudly, diagnosed wrongly — the case that matters most.
    expect(scoreOutcome(outcome({ detection: detected(1_000), grade: graded('incorrect') })))
      .toEqual({ detected: 1, diagnosed: 0 });

    // Never alerted, but a responder could still work it out from metrics.
    expect(scoreOutcome(outcome({ detection: missed, grade: graded('correct') })))
      .toEqual({ detected: 0, diagnosed: 1 });
  });
});

describe('buildScorecard', () => {
  it('lands the lab around a C, as the lab was designed to', () => {
    // Two caught cleanly, two invisible, one late-and-partial, one noisy.
    const card = buildScorecard(
      run([
        outcome({ id: '1', detection: detected(20_000), grade: graded('correct') }),
        outcome({ id: '2', detection: detected(76_000), grade: graded('partial') }),
        outcome({ id: '3', detection: missed, grade: graded('correct') }),
        outcome({ id: '4', detection: missed, grade: graded('incorrect') }),
      ]),
    );

    expect(card.detected).toBe(2);
    expect(card.diagnosed).toBe(2.5);
    expect(card.grade).toMatch(/^[CD]/);
  });

  it('weighs detection and diagnosis equally', () => {
    const allDetectedNoneDiagnosed = buildScorecard(
      run([outcome({ detection: detected(1_000), grade: graded('incorrect') })]),
    );
    const noneDetectedAllDiagnosed = buildScorecard(
      run([outcome({ detection: missed, grade: graded('correct') })]),
    );
    expect(allDetectedNoneDiagnosed.grade).toBe(noneDetectedAllDiagnosed.grade);
  });

  it('reports no median when nothing was detected', () => {
    const card = buildScorecard(run([outcome({ detection: missed, grade: graded('incorrect') })]));
    expect(card.medianTimeToDetectMs).toBeNull();
    expect(card.grade).toBe('F');
  });

  it('counts experiments the graders could not agree on', () => {
    const card = buildScorecard(
      run([
        outcome({ id: '1', detection: detected(1_000), grade: graded('correct', true) }),
        outcome({ id: '2', detection: detected(1_000), grade: graded('correct') }),
      ]),
    );
    expect(card.needsReview).toBe(1);
  });

  it('does not divide by zero on an empty run', () => {
    expect(buildScorecard(run([]))).toMatchObject({ total: 0, grade: 'F', detectionRate: 0 });
  });

  it('awards an A only when everything was caught and diagnosed', () => {
    const card = buildScorecard(
      run([
        outcome({ id: '1', detection: detected(10_000), grade: graded('correct') }),
        outcome({ id: '2', detection: detected(12_000), grade: graded('correct') }),
      ]),
    );
    expect(card.grade).toBe('A+');
    expect(card.medianTimeToDetectMs).toBe(11_000);
  });
});

describe('curve calibration', () => {
  /**
   * SPEC.md's worked example states this combination as a C+. It is the only
   * published example of this tool's output, so it anchors the curve — if this
   * test fails, either the curve moved or the spec did, and one of them is wrong.
   */
  it("matches SPEC.md's worked example: detection 3/4, diagnosis 2/4 is a C+", () => {
    const card = buildScorecard(
      run([
        outcome({ id: '1', detection: detected(76_000), grade: graded('correct') }),
        outcome({ id: '2', detection: detected(20_000), grade: graded('correct') }),
        outcome({ id: '3', detection: detected(40_000), grade: graded('incorrect') }),
        outcome({ id: '4', detection: missed, grade: graded('incorrect') }),
      ]),
    );

    expect(card.detected).toBe(3);
    expect(card.diagnosed).toBe(2);
    expect(card.grade).toBe('C+');
  });

  it('reserves F for monitoring that is effectively absent', () => {
    const card = buildScorecard(
      run([
        outcome({ id: '1', detection: missed, grade: graded('incorrect') }),
        outcome({ id: '2', detection: missed, grade: graded('incorrect') }),
      ]),
    );
    expect(card.grade).toBe('F');
  });
});
