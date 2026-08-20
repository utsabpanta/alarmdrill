import { z } from 'zod';

/**
 * The planner decides which experiments are worth running.
 *
 * It is not blinded — it reads the alert rules and the topology on purpose,
 * because its whole job is to find the gaps between them. It runs BEFORE any
 * injection, so there is no diagnosis for it to contaminate.
 *
 * It is also deliberately not a model call. Ranking by "which dependency has
 * no rule covering it" is a set difference, and a set difference does not need
 * an LLM — it needs to be right every time.
 */
export interface ServiceNode {
  readonly name: string;
  /** Services and datastores this one talks to. */
  readonly dependsOn: readonly string[];
  /** Whether Prometheus scrapes it at all. */
  readonly scraped: boolean;
}

export interface AlertRuleSummary {
  readonly name: string;
  /** The PromQL, used to work out which metrics anything actually watches. */
  readonly expr: string;
}

export interface Topology {
  readonly services: readonly ServiceNode[];
  /** Metric names known to exist, from Prometheus' own label values. */
  readonly knownMetrics: readonly string[];
}

export const experimentKinds = [
  'stop_dependency',
  'add_latency',
  'saturate_resource',
  'corrupt_business_outcome',
] as const;

export type ExperimentKind = (typeof experimentKinds)[number];

export const proposedExperimentSchema = z.object({
  id: z.string(),
  kind: z.enum(experimentKinds),
  target: z.string(),
  /** Higher means a more suspicious gap. */
  score: z.number(),
  rationale: z.string(),
  /** What we expect to be missing: a rule, an instrument, or nothing. */
  suspectedGap: z.enum(['no_rule', 'no_metric', 'no_scrape', 'covered']),
});

export type ProposedExperiment = z.infer<typeof proposedExperimentSchema>;

/**
 * Scores are ordinal, not physical — they exist to rank, and the reasons are
 * spelled out so a human can disagree with the ordering.
 */
const SCORE = {
  /** Nobody is even scraping it. Nothing can alert on what is never collected. */
  noScrape: 100,
  /** The metric does not exist, so no rule could be written today. */
  noMetric: 90,
  /** The metric exists and nothing reads it. The cheapest gap to close. */
  noRule: 70,
  /** Something covers it. Still worth confirming the cover actually works. */
  covered: 20,
} as const;

export interface PlanDeps {
  readonly topology: Topology;
  readonly rules: readonly AlertRuleSummary[];
  /** Metrics a fault of this kind would move, by kind. */
  readonly signalsByKind?: Readonly<Record<ExperimentKind, readonly string[]>>;
}

const DEFAULT_SIGNALS: Readonly<Record<ExperimentKind, readonly string[]>> = {
  stop_dependency: ['up'],
  add_latency: ['http_request_duration_seconds_bucket'],
  saturate_resource: ['db_pool_connections'],
  corrupt_business_outcome: [],
};

export function planExperiments(deps: PlanDeps): ProposedExperiment[] {
  const watched = watchedMetrics(deps.rules);
  const known = new Set(deps.topology.knownMetrics);
  const signals = deps.signalsByKind ?? DEFAULT_SIGNALS;
  const proposals: ProposedExperiment[] = [];

  // A shared datastore is depended on by several services, so collect
  // dependents first and emit ONE experiment per target. Emitting one per edge
  // would rank the same fault several times and crowd out rarer gaps.
  const unscrapedDependents = new Map<string, string[]>();

  for (const service of deps.topology.services) {
    for (const dependency of service.dependsOn) {
      const target = deps.topology.services.find((s) => s.name === dependency);

      // A dependency nobody scrapes cannot produce `up == 0`. This is the
      // redis case, and it is the highest-value experiment in the lab.
      if (target !== undefined && !target.scraped) {
        unscrapedDependents.set(dependency, [
          ...(unscrapedDependents.get(dependency) ?? []),
          service.name,
        ]);
        continue;
      }

      proposals.push(
        scoreFor({
          id: `latency-${service.name}-to-${dependency}`,
          kind: 'add_latency',
          target: `${service.name}-to-${dependency}`,
          signals: signals.add_latency,
          watched,
          known,
          rationale: `${service.name} → ${dependency} is a dependency hop.`,
        }),
      );
    }
  }

  for (const [dependency, dependents] of unscrapedDependents) {
    proposals.push({
      id: `stop-${dependency}`,
      kind: 'stop_dependency',
      target: dependency,
      score: SCORE.noScrape,
      suspectedGap: 'no_scrape',
      rationale: `${dependents.join(' and ')} depend${dependents.length === 1 ? 's' : ''} on ${dependency}, which Prometheus does not scrape. If it fails, no up==0 signal exists anywhere.`,
    });
  }

  // A business outcome nobody records is the "instrument this first" finding:
  // no PromQL can watch a number that was never written down.
  if (signals.corrupt_business_outcome.length === 0) {
    proposals.push({
      id: 'corrupt-business-outcome',
      kind: 'corrupt_business_outcome',
      target: 'payments',
      score: SCORE.noMetric,
      suspectedGap: 'no_metric',
      rationale:
        'No metric records business outcomes, so a dependency that fails while returning HTTP 200 would be invisible to any rule.',
    });
  }

  proposals.push(
    scoreFor({
      id: 'saturate-db-pool',
      kind: 'saturate_resource',
      target: 'postgres',
      signals: signals.saturate_resource,
      watched,
      known,
      rationale: 'Connection pool depth is a classic silent saturation point.',
    }),
  );

  // Highest suspicion first; ties broken by id so plans are reproducible.
  return proposals.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function scoreFor(input: {
  id: string;
  kind: ExperimentKind;
  target: string;
  signals: readonly string[];
  watched: ReadonlySet<string>;
  known: ReadonlySet<string>;
  rationale: string;
}): ProposedExperiment {
  const missingMetric = input.signals.filter((metric) => !input.known.has(metric));
  if (input.signals.length > 0 && missingMetric.length === input.signals.length) {
    return {
      id: input.id, kind: input.kind, target: input.target,
      score: SCORE.noMetric, suspectedGap: 'no_metric',
      rationale: `${input.rationale} None of its signals (${input.signals.join(', ')}) exist as metrics.`,
    };
  }

  const unwatched = input.signals.filter((metric) => !input.watched.has(metric));
  if (unwatched.length > 0) {
    return {
      id: input.id, kind: input.kind, target: input.target,
      score: SCORE.noRule, suspectedGap: 'no_rule',
      rationale: `${input.rationale} ${unwatched.join(', ')} exists but no alert rule reads it.`,
    };
  }

  return {
    id: input.id, kind: input.kind, target: input.target,
    score: SCORE.covered, suspectedGap: 'covered',
    rationale: `${input.rationale} An alert rule already reads its signals; worth confirming it fires.`,
  };
}

/** Metric names mentioned by any alert rule. Crude on purpose: over-matching
 *  here makes the planner more conservative, never less safe. */
export function watchedMetrics(rules: readonly AlertRuleSummary[]): Set<string> {
  const names = new Set<string>();
  for (const rule of rules) {
    for (const match of rule.expr.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
      names.add(match[0]);
    }
  }
  return names;
}
