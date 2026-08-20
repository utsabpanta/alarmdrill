import type { ObservedAlert } from './alertmanager.js';
import type { MetricSeries, PrometheusClient, TimeRange } from './prometheus.js';

/**
 * THE evidence bundle. One constructor, on purpose.
 *
 * This is everything the diagnostician gets to see, and it is deliberately
 * impossible to put fault information in here: nothing in `EvidenceInput`
 * carries a fault name, an injector config, or an injection timestamp, so a
 * leak would require changing this file — which is a code review a human will
 * actually notice. See SPEC.md, "Two things that must not break".
 *
 * On timestamps: the bundle's window is intentionally wider than the
 * experiment and is anchored to rounded boundaries. An engineer paged at 3am
 * sees alerts and dashboards, not a marker reading "the fault began here" —
 * and knowing the exact second something changed is most of a diagnosis.
 */
export interface EvidenceInput {
  readonly window: TimeRange;
  readonly alerts: readonly ObservedAlert[];
  readonly metrics: readonly NamedSeries[];
  readonly services: readonly string[];
}

export interface NamedSeries {
  readonly query: string;
  readonly description: string;
  readonly series: readonly MetricSeries[];
}

export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly window: { readonly from: string; readonly to: string };
  readonly firingAlerts: readonly ObservedAlert[];
  readonly metrics: readonly NamedSeries[];
  readonly services: readonly string[];
}

export function buildEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  return {
    schemaVersion: 1,
    window: {
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
    },
    // Sorted by name so the prompt is stable across runs; ordering by time
    // would hint at which alert arrived first, and therefore at the fault.
    firingAlerts: [...input.alerts].sort((a, b) => a.alertname.localeCompare(b.alertname)),
    metrics: input.metrics,
    services: [...input.services].sort(),
  };
}

/**
 * The standing questions any on-call engineer would ask of a dashboard. Note
 * what is missing: nothing here targets the specific thing we broke, because
 * a query aimed at the fault would hand over the answer.
 */
export const STANDARD_QUERIES: readonly { query: string; description: string }[] = [
  { query: 'up', description: 'scrape health per service' },
  {
    query:
      'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))',
    description: 'p95 latency by service',
  },
  {
    query: 'sum by (service, status) (rate(http_requests_total[1m]))',
    description: 'request rate by service and status',
  },
  { query: 'process_resident_memory_bytes', description: 'resident memory by service' },
  {
    query: 'sum by (service, state) (db_pool_connections)',
    description: 'database pool depth by service',
  },
  {
    query: 'sum by (result) (rate(catalog_cache_lookups_total[1m]))',
    description: 'catalog cache lookups by outcome',
  },
];

export interface CollectMetricsDeps {
  readonly prometheus: PrometheusClient;
  readonly window: TimeRange;
  readonly stepSeconds?: number;
  readonly queries?: readonly { query: string; description: string }[];
}

export async function collectMetrics(deps: CollectMetricsDeps): Promise<NamedSeries[]> {
  const queries = deps.queries ?? STANDARD_QUERIES;
  const collected: NamedSeries[] = [];

  for (const entry of queries) {
    // A query that returns nothing is itself a finding — it usually means the
    // metric does not exist. Record it rather than dropping it.
    const series = await deps.prometheus.queryRange(entry.query, deps.window, deps.stepSeconds);
    collected.push({ query: entry.query, description: entry.description, series });
  }
  return collected;
}
