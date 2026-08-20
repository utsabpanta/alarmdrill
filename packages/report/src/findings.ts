import type { ExperimentOutcome, Finding, ProposedRule } from './types.js';

/**
 * Turns outcomes into findings, and — where it can — into a rule that would
 * close the gap.
 *
 * The distinction this file exists to preserve: **"write this rule" is not the
 * same finding as "go instrument this."** No PromQL can watch a number nobody
 * records, and a report that proposes a rule against a nonexistent metric is
 * worse than useless — it looks actionable and is not.
 */
export interface FindingDeps {
  /** Metric names Prometheus actually knows about. */
  readonly knownMetrics: readonly string[];
}

export function deriveFindings(
  outcomes: readonly ExperimentOutcome[],
  deps: FindingDeps,
): Finding[] {
  return outcomes.map((outcome) => deriveFinding(outcome, deps));
}

export function deriveFinding(outcome: ExperimentOutcome, deps: FindingDeps): Finding {
  const known = new Set(deps.knownMetrics);
  const candidate = ruleFor(outcome, known);

  if (!outcome.detection.detected) {
    // Nothing novel fired. Which kind of nothing decides the finding.
    if (candidate === undefined) {
      return {
        experimentId: outcome.id,
        kind: 'needs_instrumentation',
        title: `${outcome.faultDescription} is invisible, and no rule can fix it`,
        explanation:
          `Nothing alerted, and nothing could have: no metric records this failure. ` +
          `The agent noted it would have needed ${quote(outcome.diagnosis.missingTelemetry)}. ` +
          `This is an instrumentation task, not an alerting one — write the metric first, then the rule.`,
      };
    }
    return {
      experimentId: outcome.id,
      kind: 'blind_spot',
      title: `${outcome.faultDescription} went undetected`,
      explanation:
        `No alert fired, but the signal was already being recorded — nothing was reading it. ` +
        `This gap can be closed with a rule today.`,
      proposedRule: candidate,
    };
  }

  // Detected, but was the alert any use? An alert that fires while the
  // diagnosis fails is volume, not value.
  if (outcome.grade.verdict === 'incorrect') {
    return {
      experimentId: outcome.id,
      kind: 'noisy',
      title: `${outcome.faultDescription} alerted, but the alert did not help`,
      explanation:
        `An alert fired and the fault was still misdiagnosed. ` +
        `The alert names a symptom rather than a cause, so it pages someone without telling them where to look.`,
      ...(candidate === undefined ? {} : { proposedRule: candidate }),
    };
  }

  const slow = (outcome.detection.timeToDetectMs ?? 0) > 120_000;
  if (slow) {
    return {
      experimentId: outcome.id,
      kind: 'late',
      title: `${outcome.faultDescription} was detected late`,
      explanation:
        `Detection took ${formatDuration(outcome.detection.timeToDetectMs ?? 0)}, ` +
        `and only once the failure had knocked on far enough to trip an unrelated threshold.`,
      ...(candidate === undefined ? {} : { proposedRule: candidate }),
    };
  }

  return {
    experimentId: outcome.id,
    kind: 'covered',
    title: `${outcome.faultDescription} was caught and correctly diagnosed`,
    explanation: `Detected in ${formatDuration(
      outcome.detection.timeToDetectMs ?? 0,
    )} and diagnosed correctly. This one works.`,
  };
}

/**
 * Proposes a rule only when the metric it would read actually exists. Returning
 * undefined is a real answer here, and it is what produces the
 * "needs_instrumentation" finding.
 */
export function ruleFor(
  outcome: ExperimentOutcome,
  knownMetrics: ReadonlySet<string>,
): ProposedRule | undefined {
  for (const template of RULE_TEMPLATES) {
    if (!template.matches(outcome)) continue;
    if (!knownMetrics.has(template.metric)) continue;
    return template.build(outcome);
  }
  return undefined;
}

interface RuleTemplate {
  readonly metric: string;
  readonly matches: (outcome: ExperimentOutcome) => boolean;
  readonly build: (outcome: ExperimentOutcome) => ProposedRule;
}

const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    metric: 'catalog_cache_lookups_total',
    matches: (o) => /redis|cache/i.test(`${o.target} ${o.faultDescription}`),
    build: () => ({
      alertName: 'CacheBackendUnavailable',
      expr: 'sum(rate(catalog_cache_lookups_total{result="error"}[2m])) > 0',
      forDuration: '1m',
      severity: 'critical',
      rationale:
        'The catalog already counts failed cache lookups; it degrades to the database and keeps returning 200s, so this counter is the only signal that anything changed.',
    }),
  },
  {
    metric: 'db_pool_connections',
    matches: (o) => /pool|postgres|database/i.test(`${o.target} ${o.faultDescription}`),
    build: () => ({
      alertName: 'DatabasePoolSaturated',
      expr: 'sum by (service) (db_pool_connections{state="waiting"}) > 0',
      forDuration: '2m',
      severity: 'warning',
      rationale:
        'Pool depth is already exported. Waiting connections precede the latency this currently surfaces as, so this fires earlier and names the right component.',
    }),
  },
  {
    metric: 'http_request_duration_seconds_bucket',
    matches: (o) => /latency|slow/i.test(`${o.target} ${o.faultDescription}`),
    build: (o) => ({
      alertName: 'DependencyLatencyHigh',
      expr: `histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[2m]))) > 0.5`,
      forDuration: '2m',
      severity: 'warning',
      rationale: `Breaking the existing edge-latency alert out per service would name ${o.target} instead of reporting that the whole shop is slow.`,
    }),
  },
];

const quote = (text: string): string => `"${text.replace(/"/g, "'")}"`;

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 120) return `${String(seconds)}s`;
  return `${String(Math.round(seconds / 60))}m`;
}
