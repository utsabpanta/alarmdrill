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

export async function captureBaseline(client: AlertmanagerClient): Promise<ObservedAlert[]> {
  return await client.activeAlerts();
}
