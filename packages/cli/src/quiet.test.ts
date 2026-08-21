import { createFakeClock, createSilentLogger } from '@alarmdrill/core';
import type { AlertmanagerClient, ObservedAlert } from '@alarmdrill/observers';
import { describe, expect, it } from 'vitest';
import { waitUntilQuiet } from './quiet.js';

const alert = (name: string): ObservedAlert => ({
  fingerprint: `fp-${name}`,
  alertname: name,
  severity: 'warning',
  labels: {},
  annotations: {},
  startsAt: '',
  silenced: false,
});

/** Returns each scripted alert set in turn, repeating the last one forever. */
function scripted(script: ObservedAlert[][]): AlertmanagerClient {
  let call = 0;
  return {
    activeAlerts: () => {
      const alerts = script[Math.min(call, script.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(alerts);
    },
  };
}

const base = (alertmanager: AlertmanagerClient, clock: ReturnType<typeof createFakeClock>) => ({
  alertmanager,
  clock,
  logger: createSilentLogger(),
  stablePolls: 3,
  intervalMs: 5_000,
});

describe('waitUntilQuiet', () => {
  it('returns once the firing set stops changing', async () => {
    const clock = createFakeClock(0);
    const client = scripted([
      [alert('A'), alert('B')],
      [alert('A')],
      [alert('A')],
      [alert('A')],
      [alert('A')],
    ]);

    const waiting = waitUntilQuiet(base(client, clock));
    await clock.advance(120_000);
    const result = await waiting;

    expect(result.quiet).toBe(true);
    expect(result.firing).toEqual(['fp-A']);
  });

  /**
   * The bug this exists for: GatewayHighLatency reads a 1m rate and has
   * `for: 1m`, so it keeps firing well after its fault ends. A fixed 60s wait
   * let the next experiment start while it was still up, and it was scored as
   * that experiment's own detection two seconds after injection.
   */
  it('keeps waiting while an alert is still clearing', async () => {
    const clock = createFakeClock(0);
    const client = scripted([
      [alert('Latency'), alert('Memory')],
      [alert('Latency'), alert('Memory')],
      [alert('Latency'), alert('Memory')],
      [alert('Memory')], // finally clears
      [alert('Memory')],
      [alert('Memory')],
      [alert('Memory')],
    ]);

    const waiting = waitUntilQuiet(base(client, clock));
    await clock.advance(120_000);
    const result = await waiting;

    expect(result.quiet).toBe(true);
    expect(result.firing).toEqual(['fp-Memory']);
  });

  it('gives up loudly rather than waiting forever on a flapping system', async () => {
    const clock = createFakeClock(0);
    let call = 0;
    const flapping: AlertmanagerClient = {
      activeAlerts: () => {
        call += 1;
        return Promise.resolve(call % 2 === 0 ? [alert('A')] : [alert('B')]);
      },
    };

    const waiting = waitUntilQuiet({ ...base(flapping, clock), maxWaitMs: 30_000 });
    await clock.advance(120_000);
    const result = await waiting;

    // Proceeding silently would attribute these alerts to the next fault.
    expect(result.quiet).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30_000);
  });

  it('treats a quiet system as quiet immediately', async () => {
    const clock = createFakeClock(0);
    const waiting = waitUntilQuiet(base(scripted([[]]), clock));
    await clock.advance(60_000);
    const result = await waiting;

    expect(result.quiet).toBe(true);
    expect(result.firing).toEqual([]);
  });

  it('survives a failed poll instead of aborting the wait', async () => {
    const clock = createFakeClock(0);
    let call = 0;
    const flaky: AlertmanagerClient = {
      activeAlerts: () => {
        call += 1;
        return call === 2
          ? Promise.reject(new Error('connection reset'))
          : Promise.resolve([alert('A')]);
      },
    };

    const waiting = waitUntilQuiet(base(flaky, clock));
    await clock.advance(120_000);
    expect((await waiting).quiet).toBe(true);
  });

  it('ignores ordering, so alert order cannot look like a change', async () => {
    const clock = createFakeClock(0);
    const client = scripted([
      [alert('A'), alert('B')],
      [alert('B'), alert('A')],
      [alert('A'), alert('B')],
      [alert('B'), alert('A')],
    ]);

    const waiting = waitUntilQuiet(base(client, clock));
    await clock.advance(120_000);
    expect((await waiting).quiet).toBe(true);
  });
});
