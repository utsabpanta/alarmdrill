import { describe, expect, it } from 'vitest';
import type { AlertRule } from '@alarmdrill/observers';
import { checkHoldTimes, describeHoldWarnings } from './hold-time.js';
import type { Suite } from './suite.js';

const rules: AlertRule[] = [
  { name: 'ServiceDown', expr: 'up == 0', state: 'inactive', forSeconds: 15 },
  { name: 'GatewayHighLatency', expr: 'histogram_quantile(...)', state: 'inactive', forSeconds: 60 },
];

const suite = (holds: Record<string, number | undefined>, defaultHold = 90_000): Suite =>
  ({
    defaults: { holdMs: defaultHold },
    experiments: Object.entries(holds).map(([id, holdMs]) => ({
      id,
      ...(holdMs === undefined ? {} : { holdMs }),
    })),
  }) as unknown as Suite;

describe('checkHoldTimes', () => {
  /**
   * The exact case this exists for: GatewayHighLatency needs `for: 60s` plus a
   * 1m rate window, and a 90s hold reverts the fault before it can fire. The
   * run then reports a blind spot that is really a too-short experiment — a
   * false accusation that looks identical to a true finding.
   */
  it('warns when a hold is shorter than the slowest rule needs', () => {
    const warnings = checkHoldTimes(suite({ latency: 90_000 }), rules);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ experimentId: 'latency', slowestRule: 'GatewayHighLatency' });
  });

  it('accepts a hold with enough room', () => {
    expect(checkHoldTimes(suite({ latency: 210_000 }), rules)).toEqual([]);
  });

  it('falls back to the suite default hold', () => {
    expect(checkHoldTimes(suite({ latency: undefined }, 60_000), rules)).toHaveLength(1);
    expect(checkHoldTimes(suite({ latency: undefined }, 300_000), rules)).toEqual([]);
  });

  it('measures against the slowest rule, not the average', () => {
    // A fast rule existing does not make a short hold safe for a slow one.
    const warnings = checkHoldTimes(suite({ e: 100_000 }), rules);
    expect(warnings[0]?.slowestRule).toBe('GatewayHighLatency');
  });

  it('says nothing when no rules are loaded', () => {
    expect(checkHoldTimes(suite({ e: 1_000 }), [])).toEqual([]);
  });

  it('explains what an undetected result would actually mean', () => {
    const text = describeHoldWarnings(checkHoldTimes(suite({ latency: 90_000 }), rules));
    expect(text).toContain('may mean the experiment was too short');
    expect(text).toContain('GatewayHighLatency');
  });
});
