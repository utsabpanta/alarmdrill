import { describe, expect, it } from 'vitest';
import type { Diagnosis } from './diagnostician.js';
import { gradeDiagnosis, renderGradingRequest, tallyVotes, type GroundTruth } from './grader.js';
import { createFakeModel } from './model.js';

const DIAGNOSIS: Diagnosis = {
  suspectedComponent: 'redis',
  faultCategory: 'dependency_unavailable',
  confidence: 'high',
  reasoning: 'Cache errors climbed while requests still succeeded.',
  evidenceCited: ['catalog_cache_lookups_total'],
  missingTelemetry: 'An alert on cache error rate.',
};

const TRUTH: GroundTruth = {
  description: 'The redis container was stopped.',
  expectedComponent: 'redis',
  expectedCategory: 'dependency_unavailable',
};

const vote = (verdict: 'correct' | 'partial' | 'incorrect') => ({ verdict, reasoning: 'because' });

describe('tallyVotes', () => {
  it('takes the mode of three votes', () => {
    expect(tallyVotes([vote('correct'), vote('correct'), vote('incorrect')])).toMatchObject({
      verdict: 'correct',
      needsReview: false,
    });
  });

  it('reports the disagreement rate', () => {
    const result = tallyVotes([vote('correct'), vote('correct'), vote('partial')]);
    expect(result.disagreementRate).toBeCloseTo(1 / 3);
  });

  it('reports zero disagreement on a unanimous vote', () => {
    const result = tallyVotes([vote('partial'), vote('partial'), vote('partial')]);
    expect(result).toMatchObject({ verdict: 'partial', disagreementRate: 0, needsReview: false });
  });

  /**
   * Three votes, three different answers: there is no mode, so there is no
   * verdict this tool is entitled to report as fact.
   */
  it('flags a three-way split for human review', () => {
    const result = tallyVotes([vote('correct'), vote('partial'), vote('incorrect')]);
    expect(result.needsReview).toBe(true);
  });

  it('flags an even split rather than picking a side', () => {
    expect(tallyVotes([vote('correct'), vote('incorrect')]).needsReview).toBe(true);
  });

  it('never claims success for an empty vote set', () => {
    expect(tallyVotes([])).toMatchObject({ verdict: 'incorrect', needsReview: true });
  });
});

describe('gradeDiagnosis', () => {
  it('votes three times by default', async () => {
    const model = createFakeModel({ responses: [vote('correct')] });
    const result = await gradeDiagnosis(DIAGNOSIS, TRUTH, { model });

    expect(model.callCount()).toBe(3);
    expect(result.verdict).toBe('correct');
    expect(result.votes).toHaveLength(3);
    expect(result.promptVersion).toBe('v1');
  });

  it('surfaces disagreement rather than hiding it behind the mode', async () => {
    const model = createFakeModel({
      responses: [vote('correct'), vote('partial'), vote('correct')],
    });
    const result = await gradeDiagnosis(DIAGNOSIS, TRUTH, { model });

    expect(result.verdict).toBe('correct');
    expect(result.disagreementRate).toBeCloseTo(1 / 3);
    expect(result.needsReview).toBe(false);
  });

  it('honours a configured vote count', async () => {
    const model = createFakeModel({ responses: [vote('partial')] });
    await gradeDiagnosis(DIAGNOSIS, TRUTH, { model, votes: 5 });
    expect(model.callCount()).toBe(5);
  });
});

describe('renderGradingRequest', () => {
  it('shows the grader both the truth and the diagnosis', () => {
    const rendered = renderGradingRequest(DIAGNOSIS, TRUTH);
    expect(rendered).toContain('The redis container was stopped.');
    expect(rendered).toContain('Component blamed: redis');
  });

  // The lab's declining-PSP fault produces no signal at all, so "I cannot tell"
  // is the right answer and must be gradeable as such.
  it('tells the grader when the fault was genuinely undiagnosable', () => {
    const rendered = renderGradingRequest(DIAGNOSIS, {
      ...TRUTH,
      expectedUndiagnosable: true,
    });
    expect(rendered).toContain('no usable signal');
  });

  it('omits the undiagnosable note when the fault was diagnosable', () => {
    expect(renderGradingRequest(DIAGNOSIS, TRUTH)).not.toContain('no usable signal');
  });
});
