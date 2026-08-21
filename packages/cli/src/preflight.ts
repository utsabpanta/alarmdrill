import type { PrometheusClient } from '@alarmdrill/observers';
import type { Suite } from './suite.js';

/**
 * Refuse to drill a system that is already broken.
 *
 * This exists because three full drills were run against a lab whose gateway
 * and load generator had silently failed to start. There was no traffic, so no
 * latency alert could possibly fire, and the tool dutifully reported a blind
 * spot that was really a broken test rig. Every number from those runs was
 * meaningless and looked entirely plausible.
 *
 * A tool that grades monitoring has to be able to tell "your alerting missed
 * this" from "there was nothing to miss".
 */
export interface PreflightIssue {
  readonly check: string;
  readonly detail: string;
}

export interface PreflightDeps {
  readonly suite: Suite;
  readonly prometheus: PrometheusClient;
  /** Minimum request rate that counts as a system under load. */
  readonly minRequestRate?: number;
}

export async function preflight(deps: PreflightDeps): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];

  // 1. Is anything down before we start? A pre-existing outage makes every
  //    later detection ambiguous.
  const up = await deps.prometheus.queryInstant('up').catch(() => []);
  if (up.length === 0) {
    issues.push({
      check: 'scrape targets',
      detail: 'prometheus reports no scrape targets at all — is it configured?',
    });
  }
  const down = up.filter((series) => series.samples[0]?.value === 0);
  if (down.length > 0) {
    issues.push({
      check: 'services healthy',
      detail: `already down before any fault was injected: ${down
        .map((s) => s.labels['job'] ?? '?')
        .join(', ')}`,
    });
  }

  // 2. Is the system actually serving traffic? Without load, a latency fault
  //    produces no samples and reads as a blind spot.
  const rate = await deps.prometheus
    .queryInstant('sum(rate(http_requests_total[1m]))')
    .catch(() => []);
  const observed = rate[0]?.samples[0]?.value ?? 0;
  const minimum = deps.minRequestRate ?? 0.5;
  if (observed < minimum) {
    issues.push({
      check: 'traffic',
      detail: `only ${observed.toFixed(2)} req/s observed (need ${String(minimum)}). ` +
        'With no load, a latency fault produces no samples and would be reported as undetected.',
    });
  }

  return issues;
}

export function describeIssues(issues: readonly PreflightIssue[]): string {
  return issues.map((issue) => `  ✗ ${issue.check}: ${issue.detail}`).join('\n');
}
