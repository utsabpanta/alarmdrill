import type { Clock, Logger } from '@alarmdrill/core';
import type { AlertmanagerClient, ObservedAlert } from './alertmanager.js';
import type { AlertPoll } from './detection.js';

export interface WatchDeps {
  readonly alertmanager: AlertmanagerClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
}

export interface WatchHandle {
  /** Stops polling and returns everything observed. */
  readonly stop: () => Promise<AlertPoll[]>;
}

/**
 * Polls Alertmanager for the duration of an experiment.
 *
 * A failed poll is recorded as an empty one and does not abort the watch: a
 * transient blip must not turn a detected fault into a reported blind spot.
 * Repeated failures show up as a suspiciously empty timeline, which the run
 * trace makes visible.
 */
export function startAlertWatch(deps: WatchDeps): WatchHandle {
  const intervalMs = deps.pollIntervalMs ?? 2_000;
  const polls: AlertPoll[] = [];
  let running = true;
  let cancel: (() => void) | undefined;

  const poll = async (): Promise<void> => {
    if (!running) return;
    try {
      const alerts = await deps.alertmanager.activeAlerts();
      polls.push({ at: deps.clock.now(), alerts });
    } catch (error: unknown) {
      deps.logger.warn({ err: error }, 'alert poll failed, continuing');
      polls.push({ at: deps.clock.now(), alerts: [] });
    }
    if (running) cancel = deps.clock.setTimer(intervalMs, () => void poll());
  };

  cancel = deps.clock.setTimer(0, () => void poll());

  return {
    stop: async () => {
      running = false;
      cancel?.();
      // One final poll, so a detection landing in the last interval still counts.
      try {
        polls.push({ at: deps.clock.now(), alerts: await deps.alertmanager.activeAlerts() });
      } catch {
        // Already logged by the loop; the timeline stands as collected.
      }
      return polls;
    },
  };
}

export interface BaselineDeps {
  readonly alertmanager: AlertmanagerClient;
  readonly clock: Clock;
  /** Samples to union. One is not enough — see below. */
  readonly samples?: number;
  readonly intervalMs?: number;
}

/**
 * What was already wrong before we touched anything.
 *
 * Sampled several times and unioned, never captured as a single snapshot.
 * Alertmanager expires an alert if Prometheus briefly stops re-sending it, so
 * one badly-timed read can return an empty list — and an empty baseline makes
 * every chronically-firing alert look like a fresh detection, turning a blind
 * spot into a false pass. That failure is silent and flattering, which is the
 * worst combination.
 */
export async function captureBaseline(deps: BaselineDeps): Promise<ObservedAlert[]> {
  const samples = Math.max(1, deps.samples ?? 3);
  const seen = new Map<string, ObservedAlert>();

  for (let i = 0; i < samples; i += 1) {
    if (i > 0) await deps.clock.sleep(deps.intervalMs ?? 2_000);
    try {
      for (const alert of await deps.alertmanager.activeAlerts()) {
        seen.set(alert.fingerprint, alert);
      }
    } catch {
      // A failed sample must not shrink the baseline; the others still count.
    }
  }
  return [...seen.values()];
}
