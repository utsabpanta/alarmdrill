export { observationError } from './errors.js';
export {
  createAlertmanagerClient,
  toObserved,
  type AlertmanagerClient,
  type AlertmanagerDeps,
  type ObservedAlert,
  type RawAlert,
} from './alertmanager.js';
export {
  createPrometheusClient,
  type MetricSample,
  type MetricSeries,
  type PrometheusClient,
  type PrometheusDeps,
  type TimeRange,
} from './prometheus.js';
export {
  scoreDetection,
  summariseDetection,
  type AlertPoll,
  type DetectionInput,
  type DetectionResult,
  type SuiteDetectionSummary,
} from './detection.js';
export {
  buildEvidenceBundle,
  collectMetrics,
  STANDARD_QUERIES,
  type CollectMetricsDeps,
  type EvidenceBundle,
  type EvidenceInput,
  type NamedSeries,
} from './evidence.js';
export { startAlertWatch, captureBaseline, type WatchDeps, type WatchHandle } from './watch.js';
