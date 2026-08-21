import { describe, expect, it } from 'vitest';
import type { MetricSeries, PrometheusClient } from '@alarmdrill/observers';
import { describeIssues, preflight } from './preflight.js';
import type { Suite } from './suite.js';

const suite = {} as Suite;

const series = (labels: Record<string, string>, value: number): MetricSeries => ({
  labels,
  samples: [{ at: '2026-01-01T00:00:00Z', value }],
});

function prom(responses: Record<string, MetricSeries[]>): PrometheusClient {
  return {
    queryInstant: (query) => Promise.resolve(responses[query] ?? []),
    queryRange: () => Promise.resolve([]),
    listAlertRules: () => Promise.resolve([]),
  };
}

const HEALTHY = {
  up: [series({ job: 'gateway' }, 1), series({ job: 'checkout' }, 1)],
  'sum(rate(http_requests_total[1m]))': [series({}, 12.5)],
};

describe('preflight', () => {
  it('passes a healthy, loaded system', async () => {
    expect(await preflight({ suite, prometheus: prom(HEALTHY) })).toEqual([]);
  });

  /**
   * The check that would have saved three wasted drills: the lab's gateway and
   * load generator had silently failed to start, so no traffic flowed, no
   * latency alert could fire, and the tool reported a blind spot that was
   * really a broken test rig.
   */
  it('refuses to drill a system with no traffic', async () => {
    const issues = await preflight({
      suite,
      prometheus: prom({ ...HEALTHY, 'sum(rate(http_requests_total[1m]))': [series({}, 0)] }),
    });
    expect(issues.map((i) => i.check)).toContain('traffic');
    expect(issues[0]?.detail).toContain('would be reported as undetected');
  });

  it('refuses to drill when something is already down', async () => {
    const issues = await preflight({
      suite,
      prometheus: prom({ ...HEALTHY, up: [series({ job: 'gateway' }, 0), series({ job: 'checkout' }, 1)] }),
    });
    expect(issues[0]?.check).toBe('services healthy');
    expect(issues[0]?.detail).toContain('gateway');
  });

  it('notices when prometheus is scraping nothing at all', async () => {
    const issues = await preflight({ suite, prometheus: prom({ ...HEALTHY, up: [] }) });
    expect(issues.map((i) => i.check)).toContain('scrape targets');
  });

  it('reports every problem at once rather than one per run', async () => {
    const issues = await preflight({
      suite,
      prometheus: prom({ up: [series({ job: 'g' }, 0)], 'sum(rate(http_requests_total[1m]))': [series({}, 0)] }),
    });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts a caller-supplied traffic floor', async () => {
    const quiet = { ...HEALTHY, 'sum(rate(http_requests_total[1m]))': [series({}, 0.6)] };
    expect(await preflight({ suite, prometheus: prom(quiet) })).toEqual([]);
    const strict = await preflight({ suite, prometheus: prom(quiet), minRequestRate: 5 });
    expect(strict.map((i) => i.check)).toContain('traffic');
  });

  it('renders issues so a human knows what to fix', () => {
    const text = describeIssues([{ check: 'traffic', detail: 'only 0.00 req/s observed' }]);
    expect(text).toContain('✗ traffic');
  });
});
