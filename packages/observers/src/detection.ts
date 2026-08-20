import type { ObservedAlert } from './alertmanager.js';

/**
 * Detection scoring, and the one judgement call that decides whether this tool
 * is useful or merely plausible.
 *
 * An alert that was ALREADY FIRING before the experiment began is not a
 * detection. The lab has a chronically-firing memory alert precisely to test
 * this: during a harmless blip something is firing, and calling that a
 * detection would mean measuring alert volume instead of alert value. Every
 * such fault would score as caught, and the tool would confidently report
 * excellent observability for a system nobody could actually debug.
 *
 * So detection means a NOVEL alert — one whose fingerprint was not in the
 * baseline taken immediately before injection.
 */
export interface AlertPoll {
  readonly at: Date;
  readonly alerts: readonly ObservedAlert[];
}

export interface DetectionInput {
  /** Alerts already firing before anything was injected. */
  readonly baseline: readonly ObservedAlert[];
  /** Polls taken during the experiment, in chronological order. */
  readonly polls: readonly AlertPoll[];
  /** When the experiment window opened. */
  readonly windowStart: Date;
}

export interface DetectionResult {
  readonly detected: boolean;
  /** Milliseconds from window start to the first novel alert. */
  readonly timeToDetectMs: number | null;
  /** Alerts that appeared during the window. */
  readonly novel: readonly ObservedAlert[];
  /** Alerts that were already firing. Noise, reported so it can be seen. */
  readonly preexisting: readonly ObservedAlert[];
  readonly firstDetectedAt: string | null;
}

export function scoreDetection(input: DetectionInput): DetectionResult {
  const baselineFingerprints = new Set(input.baseline.map((alert) => alert.fingerprint));
  const preexisting = [...input.baseline];

  const seen = new Map<string, { alert: ObservedAlert; at: Date }>();
  for (const poll of input.polls) {
    for (const alert of poll.alerts) {
      if (baselineFingerprints.has(alert.fingerprint)) continue;
      // Silenced alerts reach nobody, so they cannot be a detection either.
      if (alert.silenced) continue;
      if (!seen.has(alert.fingerprint)) {
        seen.set(alert.fingerprint, { alert, at: poll.at });
      }
    }
  }

  const novelInOrder = [...seen.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = novelInOrder[0];

  return {
    detected: first !== undefined,
    timeToDetectMs:
      first === undefined ? null : first.at.getTime() - input.windowStart.getTime(),
    firstDetectedAt: first?.at.toISOString() ?? null,
    novel: novelInOrder.map((entry) => entry.alert),
    preexisting,
  };
}

export interface SuiteDetectionSummary {
  readonly total: number;
  readonly detected: number;
  readonly detectionRate: number;
  /** Median MTTD across detected experiments only. Undetected ones have no time. */
  readonly medianTimeToDetectMs: number | null;
}

export function summariseDetection(results: readonly DetectionResult[]): SuiteDetectionSummary {
  const detected = results.filter((result) => result.detected);
  const times = detected
    .map((result) => result.timeToDetectMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  return {
    total: results.length,
    detected: detected.length,
    detectionRate: results.length === 0 ? 0 : detected.length / results.length,
    medianTimeToDetectMs: median(times),
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  return low === undefined || high === undefined ? null : (low + high) / 2;
}
