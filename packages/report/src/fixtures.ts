import type { ObservedAlert } from '@alarmdrill/observers';
import type { ExperimentOutcome, RunSummary } from './types.js';

const alert = (name: string): ObservedAlert => ({
  fingerprint: `fp-${name}`,
  alertname: name,
  severity: 'warning',
  labels: { alertname: name },
  annotations: {},
  startsAt: '2026-01-01T09:00:00.000Z',
  silenced: false,
});

export const NOISY = alert('HighMemoryUsage');

export function outcome(overrides: Partial<ExperimentOutcome> = {}): ExperimentOutcome {
  return {
    id: 'exp-1',
    faultDescription: 'a fault',
    target: 'thing',
    detection: {
      detected: false,
      timeToDetectMs: null,
      firstDetectedAt: null,
      novel: [],
      preexisting: [NOISY],
    },
    diagnosis: {
      suspectedComponent: 'unknown',
      faultCategory: 'unknown',
      confidence: 'low',
      reasoning: 'nothing stood out',
      evidenceCited: [],
      missingTelemetry: 'something that records this',
    },
    grade: {
      verdict: 'incorrect',
      votes: [],
      disagreementRate: 0,
      needsReview: false,
      promptVersion: 'v1',
    },
    ...overrides,
  };
}

export function run(outcomes: ExperimentOutcome[]): RunSummary {
  return {
    runId: 'run-2026-01-01',
    startedAt: '2026-01-01T12:00:00.000Z',
    outcomes,
    promptVersions: { diagnostician: 'v1', grader: 'v1' },
    modelName: 'claude-opus-5',
  };
}

/** Everything the lab actually records. Note what is absent. */
export const LAB_METRICS = [
  'up',
  'http_request_duration_seconds_bucket',
  'http_requests_total',
  'process_resident_memory_bytes',
  'catalog_cache_lookups_total',
  'db_pool_connections',
];
