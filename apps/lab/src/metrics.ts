import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { ServiceName } from './config.js';

/**
 * What the lab measures — and, just as importantly, what it does not.
 *
 * There is deliberately no payment-outcome metric anywhere in this lab. A
 * declining PSP is invisible here not because a rule is missing but because
 * nobody instrumented it, and the report has to be able to tell those two
 * situations apart. See ../README.md before adding a metric.
 */

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface LabMetrics {
  readonly registry: Registry;
  readonly observeHttp: (labels: HttpLabels, durationSeconds: number) => void;
}

export interface HttpLabels {
  method: string;
  route: string;
  status: number;
}

export function createMetrics(service: ServiceName): LabMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const total = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  return {
    registry,
    observeHttp: ({ method, route, status }, durationSeconds) => {
      const labels = { method, route, status: String(status) };
      duration.observe(labels, durationSeconds);
      total.inc(labels);
    },
  };
}

export type CacheLookupResult = 'hit' | 'miss' | 'error';

export interface CacheMetrics {
  readonly recordLookup: (result: CacheLookupResult) => void;
}

/**
 * The cache IS instrumented. Stopping Redis therefore shows up clearly in the
 * metrics — there is simply no alert rule reading them, which makes it a
 * "write this rule" finding rather than a "go instrument this" finding.
 */
export function createCacheMetrics(registry: Registry): CacheMetrics {
  const lookups = new Counter({
    name: 'catalog_cache_lookups_total',
    help: 'Catalog cache lookups by outcome',
    labelNames: ['result'],
    registers: [registry],
  });
  // Touch every label value so the series exists before the first fault.
  for (const result of ['hit', 'miss', 'error'] satisfies CacheLookupResult[]) {
    lookups.inc({ result }, 0);
  }
  return { recordLookup: (result) => lookups.inc({ result }) };
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/** Pool depth is instrumented too, and also has no rule reading it. */
export function createPoolMetrics(registry: Registry, read: () => PoolStats): void {
  new Gauge({
    name: 'db_pool_connections',
    help: 'Postgres pool connections by state',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      const stats = read();
      this.set({ state: 'total' }, stats.total);
      this.set({ state: 'idle' }, stats.idle);
      this.set({ state: 'waiting' }, stats.waiting);
    },
  });
}
