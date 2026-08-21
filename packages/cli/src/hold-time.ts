import type { AlertRule } from '@alarmdrill/observers';
import type { Suite } from './suite.js';

/**
 * Catch experiments that are too short for the alerts they are testing.
 *
 * A rule with `for: 1m` over a `[1m]` rate needs roughly two minutes of
 * sustained fault before it can fire. Hold the fault for ninety seconds and it
 * never gets the chance — and the run reports a blind spot that is really a
 * badly-designed experiment. That is a false accusation against someone's
 * monitoring, and it looks exactly like a true one.
 *
 * The margin below covers the rate window a rule reads, which Prometheus does
 * not report separately, plus a scrape or two.
 */
export const RULE_WINDOW_MARGIN_SECONDS = 90;

export interface HoldWarning {
  readonly experimentId: string;
  readonly holdMs: number;
  readonly needsMs: number;
  readonly slowestRule: string;
}

export function checkHoldTimes(suite: Suite, rules: readonly AlertRule[]): HoldWarning[] {
  const slowest = [...rules].sort((a, b) => b.forSeconds - a.forSeconds)[0];
  if (slowest === undefined) return [];

  const needsMs = (slowest.forSeconds + RULE_WINDOW_MARGIN_SECONDS) * 1_000;

  return suite.experiments
    .map((experiment) => ({
      experimentId: experiment.id,
      holdMs: experiment.holdMs ?? suite.defaults.holdMs,
      needsMs,
      slowestRule: slowest.name,
    }))
    .filter((warning) => warning.holdMs < needsMs);
}

export function describeHoldWarnings(warnings: readonly HoldWarning[]): string {
  return warnings
    .map(
      (w) =>
        `  ! ${w.experimentId} holds its fault for ${String(Math.round(w.holdMs / 1_000))}s, but ` +
        `${w.slowestRule} needs about ${String(Math.round(w.needsMs / 1_000))}s to fire. ` +
        'An undetected result here may mean the experiment was too short, not that the alerting missed it.',
    )
    .join('\n');
}
