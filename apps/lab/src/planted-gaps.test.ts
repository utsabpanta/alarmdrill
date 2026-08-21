import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The lab's blind spots are a contract, not an accident.
 *
 * These tests bind three things together: the alert rules that exist, the
 * metrics that exist, and what README.md claims about both. Closing a planted
 * gap without documenting it breaks the build — which is the point, because a
 * silently-fixed lab makes alarmdrill look better than it is.
 */

const LAB = new URL('../', import.meta.url);
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, LAB)), 'utf8');

const ALERTS = read('prometheus/alerts.yml');
const README = read('README.md');
const METRICS_SOURCE = read('src/metrics.ts');

const EXPECTED_ALERTS = [
  'ServiceDown',
  'GatewayHighLatency',
  'GatewayErrorRate',
  'HighMemoryUsage',
];

/** Instrumented, and deliberately not read by any rule. */
const UNALERTED_METRICS = ['catalog_cache_lookups_total', 'db_pool_connections'];

const alertRulesSchema = (value: unknown): { alert: string; expr: string }[] => {
  const groups = (value as { groups?: { rules?: { alert?: string; expr?: string }[] }[] }).groups;
  return (groups ?? []).flatMap((group) =>
    (group.rules ?? []).map((rule) => ({ alert: rule.alert ?? '', expr: rule.expr ?? '' })),
  );
};

const rules = alertRulesSchema(parse(ALERTS));

describe('alert rules', () => {
  it('contains exactly the documented rules — no more, no fewer', () => {
    expect(rules.map((rule) => rule.alert)).toEqual(EXPECTED_ALERTS);
  });

  it('documents every rule in README.md', () => {
    for (const alert of EXPECTED_ALERTS) {
      expect(README, `${alert} is missing from README.md`).toContain(`\`${alert}\``);
    }
  });

  it('leaves the cache and pool metrics unalerted', () => {
    const expressions = rules.map((rule) => rule.expr).join('\n');
    for (const metric of UNALERTED_METRICS) {
      expect(
        expressions,
        `${metric} now has an alert rule — update README.md's planted blind spots table, ` +
          'because a fault that used to be invisible is now caught',
      ).not.toContain(metric);
    }
  });

  it('keeps the noisy memory alert noisy', () => {
    const memory = rules.find((rule) => rule.alert === 'HighMemoryUsage');
    // A healthy Node process sits well above this. Raising the threshold to
    // something sensible would silence the alert and delete the fault that
    // tests whether alarmdrill scores alert value or alert volume.
    expect(memory?.expr).toContain('25e6');
  });
});

describe('instrumentation', () => {
  const defined = [...METRICS_SOURCE.matchAll(/name: '([a-z_]+)'/g)].map((match) => match[1]);

  it('defines exactly the metrics the lab documents', () => {
    expect(defined).toEqual([
      'http_request_duration_seconds',
      'http_requests_total',
      ...UNALERTED_METRICS,
    ]);
  });

  it('records payment outcomes nowhere', () => {
    // The whole "you must instrument this first" finding rests on this.
    const labSources = ['src/metrics.ts', 'src/services/payments.ts', 'src/services/checkout.ts']
      .map(read)
      .join('\n');
    const outcomeMetric = /name: '[a-z_]*(charge|payment|decline|settle)[a-z_]*'/;
    expect(
      outcomeMetric.test(labSources),
      'a payment-outcome metric appeared — the PSP decline fault is no longer a ' +
        'missing-instrumentation finding, so update README.md',
    ).toBe(false);
  });
});

describe('the proposed-rules directory', () => {
  const proposedDir = fileURLToPath(new URL('prometheus/proposed', LAB));

  /**
   * The lab's blind spots only mean something while nothing is closing them.
   * A rule left in this directory silently changes what the baseline drill
   * measures, and the run would still look perfectly normal.
   */
  it('is empty, so the documented blind spots are still blind', () => {
    const rules = readdirSync(proposedDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(
      rules,
      'a proposed rule is loaded — the lab no longer demonstrates its documented gaps',
    ).toEqual([]);
  });

  it('is wired into prometheus, so applying a rule there actually takes effect', () => {
    const config = read('prometheus/prometheus.yml');
    expect(config).toContain('/etc/prometheus/proposed/*.yml');
  });
});
