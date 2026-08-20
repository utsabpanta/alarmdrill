import { describe, expect, it } from 'vitest';
import { planExperiments, watchedMetrics, type PlanDeps } from './planner.js';

/** The lab, as the planner would see it before anything is injected. */
const LAB: PlanDeps = {
  topology: {
    services: [
      { name: 'gateway', dependsOn: ['checkout', 'catalog'], scraped: true },
      { name: 'checkout', dependsOn: ['payments', 'postgres'], scraped: true },
      { name: 'payments', dependsOn: ['psp-mock'], scraped: true },
      { name: 'catalog', dependsOn: ['redis', 'postgres'], scraped: true },
      { name: 'psp-mock', dependsOn: [], scraped: true },
      // Datastores nobody scrapes — the lab's deliberate omission.
      { name: 'redis', dependsOn: [], scraped: false },
      { name: 'postgres', dependsOn: [], scraped: false },
    ],
    knownMetrics: [
      'up',
      'http_request_duration_seconds_bucket',
      'http_requests_total',
      'process_resident_memory_bytes',
      'catalog_cache_lookups_total',
      'db_pool_connections',
    ],
  },
  rules: [
    { name: 'ServiceDown', expr: 'up{job=~"gateway|checkout"} == 0' },
    {
      name: 'GatewayHighLatency',
      expr: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[1m]))) > 0.5',
    },
    { name: 'HighMemoryUsage', expr: 'process_resident_memory_bytes > 25e6' },
  ],
};

describe('planExperiments', () => {
  const plan = planExperiments(LAB);

  it('ranks unscraped dependencies above everything else', () => {
    // Nothing can alert on what is never collected, so this is the most
    // valuable experiment available — and it is the lab's flagship blind spot.
    const top = plan.slice(0, 2).map((p) => p.target);
    expect(top).toContain('redis');
    expect(plan[0]?.suspectedGap).toBe('no_scrape');
  });

  it('explains why, in terms a human can argue with', () => {
    const redis = plan.find((p) => p.target === 'redis');
    expect(redis?.rationale).toContain('does not scrape');
    expect(redis?.rationale).toContain('up==0');
  });

  it('separates "no metric exists" from "no rule reads it"', () => {
    // These produce different findings in the report: one says write a rule,
    // the other says go instrument the thing first.
    const gaps = new Set(plan.map((p) => p.suspectedGap));
    expect(gaps.has('no_metric')).toBe(true);
    expect(gaps.has('no_rule')).toBe(true);
  });

  it('proposes the uninstrumented business outcome as a no_metric gap', () => {
    const outcome = plan.find((p) => p.kind === 'corrupt_business_outcome');
    expect(outcome?.suspectedGap).toBe('no_metric');
    expect(outcome?.rationale).toContain('HTTP 200');
  });

  it('flags the db pool as instrumented but unwatched', () => {
    const pool = plan.find((p) => p.id === 'saturate-db-pool');
    expect(pool?.suspectedGap).toBe('no_rule');
    expect(pool?.rationale).toContain('db_pool_connections');
  });

  it('scores a covered signal lowest without dropping it', () => {
    // A rule that exists still deserves confirming — "covered" is a hypothesis,
    // not a fact, until an experiment proves the alert actually fires.
    const covered = plan.filter((p) => p.suspectedGap === 'covered');
    for (const proposal of covered) {
      expect(proposal.score).toBeLessThan(70);
    }
  });

  it('is deterministic — the same input yields the same ordering', () => {
    expect(planExperiments(LAB).map((p) => p.id)).toEqual(plan.map((p) => p.id));
  });

  it('sorts strictly by descending score', () => {
    const scores = plan.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('reacts when a gap is closed', () => {
    // Add a rule reading the pool gauge and that experiment must stop being
    // ranked as an unwatched gap.
    const withPoolRule = {
      ...LAB,
      rules: [...LAB.rules, { name: 'PoolSaturated', expr: 'db_pool_connections > 4' }],
    };
    const pool = planExperiments(withPoolRule).find((p) => p.id === 'saturate-db-pool');
    expect(pool?.suspectedGap).toBe('covered');
  });
});

describe('watchedMetrics', () => {
  it('extracts metric names from PromQL', () => {
    const watched = watchedMetrics(LAB.rules);
    expect(watched.has('up')).toBe(true);
    expect(watched.has('process_resident_memory_bytes')).toBe(true);
  });

  it('does not claim a metric no rule mentions', () => {
    const watched = watchedMetrics(LAB.rules);
    expect(watched.has('catalog_cache_lookups_total')).toBe(false);
    expect(watched.has('db_pool_connections')).toBe(false);
  });
});

describe('deduplication', () => {
  it('proposes one experiment per shared datastore, not one per edge', () => {
    // postgres is depended on by both checkout and catalog. Emitting an
    // experiment per edge would rank the same fault twice and push rarer gaps
    // — like redis — out of the top of the plan.
    const plan = planExperiments(LAB);
    const ids = plan.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const postgres = plan.filter((p) => p.target === 'postgres' && p.kind === 'stop_dependency');
    expect(postgres).toHaveLength(1);
    expect(postgres[0]?.rationale).toContain('checkout and catalog');
  });

  it('keeps both unscraped datastores in the plan', () => {
    const targets = planExperiments(LAB)
      .filter((p) => p.suspectedGap === 'no_scrape')
      .map((p) => p.target);
    expect(new Set(targets)).toEqual(new Set(['redis', 'postgres']));
  });
});
