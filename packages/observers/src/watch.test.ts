import { createFakeClock, createSilentLogger } from '@alarmdrill/core';
import { describe, expect, it } from 'vitest';
import type { AlertmanagerClient, ObservedAlert } from './alertmanager.js';
import { captureBaseline, startAlertWatch } from './watch.js';

const alert = (name: string): ObservedAlert => ({
  fingerprint: `fp-${name}`,
  alertname: name,
  severity: 'critical',
  labels: {},
  annotations: {},
  startsAt: '2026-01-01T00:00:00.000Z',
  silenced: false,
});

function scriptedClient(script: ObservedAlert[][]): AlertmanagerClient {
  let call = 0;
  return {
    activeAlerts: () => {
      const alerts = script[Math.min(call, script.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(alerts);
    },
  };
}

describe('alert watch', () => {
  it('polls on the configured interval', async () => {
    const clock = createFakeClock(0);
    const watch = startAlertWatch({
      alertmanager: scriptedClient([[], [], [alert('ServiceDown')]]),
      clock,
      logger: createSilentLogger(),
      pollIntervalMs: 2_000,
    });

    await clock.advance(4_100);
    const polls = await watch.stop();

    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls.some((p) => p.alerts.some((a) => a.alertname === 'ServiceDown'))).toBe(true);
  });

  it('keeps polling after a failed poll instead of aborting the watch', async () => {
    const clock = createFakeClock(0);
    let call = 0;
    const flaky: AlertmanagerClient = {
      activeAlerts: () => {
        call += 1;
        // A transient blip must not turn a detected fault into a reported
        // blind spot.
        return call === 2
          ? Promise.reject(new Error('connection reset'))
          : Promise.resolve([alert('ServiceDown')]);
      },
    };

    const watch = startAlertWatch({
      alertmanager: flaky, clock, logger: createSilentLogger(), pollIntervalMs: 1_000,
    });

    await clock.advance(3_100);
    const polls = await watch.stop();

    expect(polls.some((p) => p.alerts.length === 0)).toBe(true); // the failed poll
    expect(polls.some((p) => p.alerts.length > 0)).toBe(true); // recovery
  });

  it('takes a final poll on stop so a late detection still counts', async () => {
    const clock = createFakeClock(0);
    const watch = startAlertWatch({
      alertmanager: scriptedClient([[], [alert('LateAlert')]]),
      clock,
      logger: createSilentLogger(),
      pollIntervalMs: 60_000,
    });

    await clock.advance(10);
    const polls = await watch.stop();

    expect(polls.at(-1)?.alerts.map((a) => a.alertname)).toEqual(['LateAlert']);
  });

  it('stops scheduling once stopped', async () => {
    const clock = createFakeClock(0);
    const watch = startAlertWatch({
      alertmanager: scriptedClient([[]]), clock,
      logger: createSilentLogger(), pollIntervalMs: 1_000,
    });
    await clock.advance(1_100);
    await watch.stop();

    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('captureBaseline', () => {
  it('unions several samples so one bad read cannot empty the baseline', async () => {
    const clock = createFakeClock(0);
    let call = 0;
    const flaky: AlertmanagerClient = {
      activeAlerts: () => {
        call += 1;
        // Alertmanager expires an alert if Prometheus briefly stops re-sending
        // it. A single snapshot landing in that gap reports no baseline, and
        // every chronic alert then looks like a fresh detection — a blind spot
        // silently reported as a pass.
        return Promise.resolve(call === 2 ? [] : [alert('HighMemoryUsage')]);
      },
    };

    const baseline = captureBaseline({ alertmanager: flaky, clock, samples: 3, intervalMs: 1_000 });
    await clock.advance(5_000);

    expect((await baseline).map((a) => a.alertname)).toEqual(['HighMemoryUsage']);
  });

  it('deduplicates an alert seen in every sample', async () => {
    const clock = createFakeClock(0);
    const steady: AlertmanagerClient = {
      activeAlerts: () => Promise.resolve([alert('HighMemoryUsage')]),
    };
    const baseline = captureBaseline({ alertmanager: steady, clock, samples: 3, intervalMs: 500 });
    await clock.advance(5_000);
    expect(await baseline).toHaveLength(1);
  });

  it('survives a sample that throws rather than shrinking the baseline', async () => {
    const clock = createFakeClock(0);
    let call = 0;
    const flaky: AlertmanagerClient = {
      activeAlerts: () => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('connection reset'))
          : Promise.resolve([alert('HighMemoryUsage')]);
      },
    };
    const baseline = captureBaseline({ alertmanager: flaky, clock, samples: 3, intervalMs: 500 });
    await clock.advance(5_000);
    expect(await baseline).toHaveLength(1);
  });
});
