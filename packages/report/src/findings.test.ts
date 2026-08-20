import { describe, expect, it } from 'vitest';
import { deriveFinding, ruleFor } from './findings.js';
import { LAB_METRICS, NOISY, outcome } from './fixtures.js';

const deps = { knownMetrics: LAB_METRICS };

describe('deriveFinding', () => {
  /**
   * The distinction the whole report exists to make. Both faults are invisible;
   * only one of them can be fixed with PromQL.
   */
  it('calls an undetected fault with a recorded signal a blind spot, and proposes a rule', () => {
    const finding = deriveFinding(
      outcome({ id: 'redis', faultDescription: 'redis stopped', target: 'redis' }),
      deps,
    );

    expect(finding.kind).toBe('blind_spot');
    expect(finding.proposedRule?.expr).toContain('catalog_cache_lookups_total');
    expect(finding.explanation).toContain('nothing was reading it');
  });

  it('calls an undetected fault with NO recorded signal an instrumentation task, and proposes nothing', () => {
    const finding = deriveFinding(
      outcome({
        id: 'declines',
        faultDescription: 'the payment processor began declining 60% of charges',
        target: 'psp-mock',
      }),
      deps,
    );

    expect(finding.kind).toBe('needs_instrumentation');
    // A rule against a metric that does not exist looks actionable and is not.
    expect(finding.proposedRule).toBeUndefined();
    expect(finding.explanation).toContain('instrumentation task, not an alerting one');
  });

  it('quotes what the responder said it needed', () => {
    const finding = deriveFinding(
      outcome({
        faultDescription: 'declines',
        target: 'psp-mock',
        diagnosis: {
          ...outcome().diagnosis,
          missingTelemetry: 'a counter of payment outcomes by result',
        },
      }),
      deps,
    );
    expect(finding.explanation).toContain('a counter of payment outcomes by result');
  });

  it('calls a fault that alerted but was misdiagnosed noisy, not covered', () => {
    const finding = deriveFinding(
      outcome({
        faultDescription: 'a 200ms blip',
        target: 'gateway',
        detection: {
          detected: true, timeToDetectMs: 30_000, firstDetectedAt: null,
          novel: [], preexisting: [NOISY],
        },
        grade: { verdict: 'incorrect', votes: [], disagreementRate: 0, needsReview: false, promptVersion: 'v1' },
      }),
      deps,
    );

    // Firing is not the same as helping.
    expect(finding.kind).toBe('noisy');
    expect(finding.explanation).toContain('symptom rather than a cause');
  });

  it('calls slow detection late', () => {
    const finding = deriveFinding(
      outcome({
        faultDescription: 'database pool saturation',
        target: 'postgres',
        detection: {
          detected: true, timeToDetectMs: 240_000, firstDetectedAt: null,
          novel: [], preexisting: [],
        },
        grade: { verdict: 'correct', votes: [], disagreementRate: 0, needsReview: false, promptVersion: 'v1' },
      }),
      deps,
    );

    expect(finding.kind).toBe('late');
    expect(finding.explanation).toContain('4m');
    expect(finding.proposedRule?.alertName).toBe('DatabasePoolSaturated');
  });

  it('calls a fast, correctly diagnosed fault working', () => {
    const finding = deriveFinding(
      outcome({
        faultDescription: 'payments stopped',
        target: 'payments',
        detection: {
          detected: true, timeToDetectMs: 20_000, firstDetectedAt: null,
          novel: [], preexisting: [],
        },
        grade: { verdict: 'correct', votes: [], disagreementRate: 0, needsReview: false, promptVersion: 'v1' },
      }),
      deps,
    );

    expect(finding.kind).toBe('covered');
  });
});

describe('ruleFor', () => {
  it('never proposes a rule against a metric that does not exist', () => {
    // Same fault, but the cache counter has been removed from the system.
    const withoutCacheMetric = new Set(LAB_METRICS.filter((m) => m !== 'catalog_cache_lookups_total'));
    const redis = outcome({ faultDescription: 'redis stopped', target: 'redis' });

    expect(ruleFor(redis, new Set(LAB_METRICS))).toBeDefined();
    expect(ruleFor(redis, withoutCacheMetric)).toBeUndefined();
  });

  it('explains why the metric it chose is the right one', () => {
    const rule = ruleFor(outcome({ faultDescription: 'redis stopped', target: 'redis' }), new Set(LAB_METRICS));
    expect(rule?.rationale).toContain('keeps returning 200s');
  });
});
