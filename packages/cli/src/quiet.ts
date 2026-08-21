import type { Clock, Logger } from '@alarmdrill/core';
import type { AlertmanagerClient } from '@alarmdrill/observers';

/**
 * Wait until the system stops changing, rather than for a fixed number of
 * seconds.
 *
 * A fixed settle was tried and is not sound: `GatewayHighLatency` reads a 1m
 * rate and has `for: 1m`, so after a latency fault ends it keeps firing for
 * roughly two more minutes. With a 60s settle the next experiment began while
 * the previous fault's alerts were still up, and scored them as its own
 * detection — 2 seconds after injection, which no `for: 1m` alert can ever
 * legitimately produce.
 *
 * Quiet means the set of firing alerts has not changed for several consecutive
 * polls. That adapts to whatever the rules actually are instead of encoding an
 * assumption about them.
 */
export interface QuietDeps {
  readonly alertmanager: AlertmanagerClient;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Consecutive unchanged polls required. */
  readonly stablePolls?: number;
  readonly intervalMs?: number;
  /** Give up waiting after this long and proceed, loudly. */
  readonly maxWaitMs?: number;
}

export interface QuietResult {
  readonly quiet: boolean;
  readonly waitedMs: number;
  readonly firing: readonly string[];
}

export async function waitUntilQuiet(deps: QuietDeps): Promise<QuietResult> {
  const stablePolls = deps.stablePolls ?? 4;
  const intervalMs = deps.intervalMs ?? 5_000;
  const maxWaitMs = deps.maxWaitMs ?? 300_000;

  let previous: string | undefined;
  let stable = 0;
  let waitedMs = 0;
  let firing: string[] = [];

  for (;;) {
    firing = await deps.alertmanager
      .activeAlerts()
      .then((alerts) => alerts.map((a) => a.fingerprint).sort())
      .catch(() => firing);

    const signature = firing.join(',');
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;

    if (stable >= stablePolls) {
      return { quiet: true, waitedMs, firing };
    }
    if (waitedMs >= maxWaitMs) {
      // Proceeding anyway would silently attribute someone else's alerts to
      // the next fault, so say so plainly.
      deps.logger.warn(
        { waitedMs, firing },
        'system never settled; the next experiment may attribute lingering alerts to its own fault',
      );
      return { quiet: false, waitedMs, firing };
    }

    await deps.clock.sleep(intervalMs);
    waitedMs += intervalMs;
  }
}
