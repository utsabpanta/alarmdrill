import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';
import { LAB_METRICS, NOISY, outcome, run } from './fixtures.js';

const detected = (ms: number) => ({
  detected: true, timeToDetectMs: ms, firstDetectedAt: null, novel: [], preexisting: [NOISY],
});
const missed = {
  detected: false, timeToDetectMs: null, firstDetectedAt: null, novel: [], preexisting: [NOISY],
};
const graded = (verdict: 'correct' | 'partial' | 'incorrect', needsReview = false) => ({
  verdict, votes: [], disagreementRate: 0, needsReview, promptVersion: 'v1',
});

/** The lab's six planted faults, as SPEC.md describes them. */
const LAB_RUN = run([
  outcome({
    id: '1-payments-down', faultDescription: 'payments was stopped', target: 'payments',
    detection: detected(20_000), grade: graded('correct'),
  }),
  outcome({
    id: '2-latency', faultDescription: 'checkout to payments latency +800ms', target: 'checkout-to-payments',
    detection: detected(76_000), grade: graded('partial'),
  }),
  outcome({
    id: '3-redis-down', faultDescription: 'redis stopped', target: 'redis',
    detection: missed, grade: graded('correct'),
  }),
  outcome({
    id: '4-pool', faultDescription: 'database pool saturation', target: 'postgres',
    detection: detected(240_000), grade: graded('partial'),
  }),
  outcome({
    id: '5-declines', faultDescription: 'the payment processor began declining 60% of charges',
    target: 'psp-mock', detection: missed, grade: graded('correct'), expectedUndiagnosable: true,
  }),
  outcome({
    id: '6-blip', faultDescription: 'a harmless 200ms blip', target: 'gateway',
    detection: missed, grade: graded('incorrect'),
  }),
]);

describe('renderMarkdown', () => {
  const md = renderMarkdown({ run: LAB_RUN, knownMetrics: LAB_METRICS });

  it('leads with the findings, not the letter', () => {
    // A grade is a hook. The reason to run this tool is the list of things the
    // monitoring cannot see.
    const headline = md.split('\n')[2] ?? '';
    expect(headline).toContain('produced no alert at all');
    expect(headline).toContain('nothing records the failure');
  });

  it('orders findings by how badly they need attention', () => {
    const order = ['Not instrumented', 'Blind spot', 'Alerted, unhelpfully', 'Detected late', 'Working'];
    const positions = order.map((label) => md.indexOf(label)).filter((i) => i >= 0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('proposes a rule for the cache blind spot', () => {
    expect(md).toContain('CacheBackendUnavailable');
    expect(md).toContain('catalog_cache_lookups_total{result="error"}');
  });

  it('proposes NO rule for the uninstrumented decline fault', () => {
    // The single most important line in the report: some gaps cannot be closed
    // with PromQL, and saying so is more useful than a rule that cannot work.
    expect(md).toContain('instrumentation task, not an alerting one');
    expect(md).not.toContain('payments_charges_total');
  });

  it('says plainly that pre-existing alerts did not count as detection', () => {
    expect(md).toContain('not counted as detection');
    expect(md).toContain('HighMemoryUsage');
  });

  it('records provenance so a grade can be traced to its prompts', () => {
    expect(md).toContain('run-2026-01-01');
    expect(md).toContain('claude-opus-5');
    expect(md).toContain('Prompt `diagnostician`');
    expect(md).toContain('`v1`');
  });

  it('states the blinding, because a reader has to trust the number', () => {
    expect(md).toContain('told nothing about what had been broken');
  });

  it('emits valid-looking PromQL yaml', () => {
    const yaml = md.slice(md.indexOf('```yaml'), md.indexOf('```', md.indexOf('```yaml') + 7));
    expect(yaml).toContain('groups:');
    expect(yaml).toContain('- alert:');
    expect(yaml).toContain('for:');
    expect(yaml).toContain('severity:');
  });

  it('surfaces unsettled grades rather than burying them', () => {
    const withReview = renderMarkdown({
      run: run([outcome({ detection: missed, grade: graded('correct', true) })]),
      knownMetrics: LAB_METRICS,
    });
    expect(withReview).toContain('needs_review');
    expect(withReview).toContain('unsettled');
  });

  it('handles a clean run without claiming findings it does not have', () => {
    const clean = renderMarkdown({
      run: run([outcome({ id: 'ok', faultDescription: 'payments stopped', target: 'payments',
        detection: detected(15_000), grade: graded('correct') })]),
      knownMetrics: LAB_METRICS,
    });
    expect(clean).toContain('Every fault drilled was detected and correctly diagnosed');
    expect(clean).toContain('No rules to propose');
  });

  it('grades the lab around a C, as the lab was designed to', () => {
    expect(md).toMatch(/Grade \*\*C/);
  });
});

describe('markdown well-formedness', () => {
  const md = renderMarkdown({ run: LAB_RUN, knownMetrics: LAB_METRICS });

  it('keeps a blank line before every heading', () => {
    // A `###` directly after a blockquote line gets absorbed into the quote by
    // CommonMark lazy continuation, silently destroying the section structure.
    const lines = md.split('\n');
    lines.forEach((line, index) => {
      if (line.startsWith('#') && index > 0) {
        expect(lines[index - 1], `heading at line ${String(index + 1)} has no blank line before it`).toBe('');
      }
    });
  });

  it('pluralises rather than emitting "alert(s)"', () => {
    expect(md).not.toContain('(s)');
    expect(md).toContain('1 alert was already firing');
  });
});
