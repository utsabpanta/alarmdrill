import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildEvidenceBundle,
  collectMetrics,
  createAlertmanagerClient,
  createPrometheusClient,
  type ObservedAlert,
} from '../src/index.js';

/**
 * Parses what the real lab actually emits. The unit tests use payloads captured
 * from these same services, but a capture goes stale — this keeps the schemas
 * honest against the running versions.
 *
 * Needs `pnpm lab:up`.
 */
const ALERTMANAGER = process.env['ALERTMANAGER_URL'] ?? 'http://localhost:9093';
const PROMETHEUS = process.env['PROMETHEUS_URL'] ?? 'http://localhost:9090';

let reachable = false;

beforeAll(async () => {
  try {
    const [am, prom] = await Promise.all([
      fetch(`${ALERTMANAGER}/api/v2/status`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${PROMETHEUS}/-/ready`, { signal: AbortSignal.timeout(2_000) }),
    ]);
    reachable = am.ok && prom.ok;
  } catch {
    reachable = false;
  }
});

const requireLab = (): void => {
  if (!reachable) {
    throw new Error(
      `lab not reachable (${ALERTMANAGER}, ${PROMETHEUS}). Run 'pnpm lab:up' first.`,
    );
  }
};

/**
 * A freshly started lab has no alerts yet: HighMemoryUsage needs its 30s `for:`
 * to elapse plus a scrape or two. Poll for it rather than assuming a warm lab —
 * asserting immediately passes on a developer machine that has been running the
 * stack for an hour and fails on a CI runner that started it ten seconds ago.
 */
async function waitForAlerts(deadlineMs = 120_000): Promise<ObservedAlert[]> {
  const client = createAlertmanagerClient({ baseUrl: ALERTMANAGER });
  const deadline = Date.now() + deadlineMs;

  for (;;) {
    const alerts = await client.activeAlerts();
    if (alerts.length > 0) return alerts;
    if (Date.now() > deadline) {
      throw new Error(
        `no alerts fired within ${String(deadlineMs / 1000)}s of the lab starting. ` +
          'HighMemoryUsage should always be firing — check the lab is scraping.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

describe('observing the real lab', () => {
  it('parses live alertmanager alerts', async () => {
    requireLab();
    const alerts = await waitForAlerts();

    // The lab's chronically-noisy memory alert is always firing once warm,
    // which is exactly why it makes a dependable fixture.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.map((a) => a.alertname)).toContain('HighMemoryUsage');
    for (const alert of alerts) {
      expect(alert.fingerprint).not.toBe('');
      expect(Number.isNaN(Date.parse(alert.startsAt))).toBe(false);
    }
  }, 180_000);

  it('runs every standard query against live prometheus', async () => {
    requireLab();
    const prometheus = createPrometheusClient({ baseUrl: PROMETHEUS });
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 60_000);

    // Each query must at least parse. Empty results are legitimate — a metric
    // that does not exist is a finding, not a failure.
    const metrics = await collectMetrics({ prometheus, window: { from, to }, stepSeconds: 30 });

    expect(metrics).toHaveLength(6);
    const up = metrics.find((m) => m.query === 'up');
    expect(up?.series.length).toBeGreaterThan(0);
    expect(up?.series[0]?.samples.every((s) => Number.isFinite(s.value))).toBe(true);
  }, 180_000);

  it('builds a bundle from live data that still leaks nothing', async () => {
    requireLab();
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 60_000);
    const bundle = buildEvidenceBundle({
      window: { from, to },
      alerts: await waitForAlerts(),
      metrics: await collectMetrics({
        prometheus: createPrometheusClient({ baseUrl: PROMETHEUS }),
        window: { from, to },
        stepSeconds: 60,
      }),
      services: ['gateway', 'checkout', 'payments', 'catalog', 'psp-mock'],
    });

    const serialized = JSON.stringify(bundle).toLowerCase();
    for (const term of ['toxiproxy', 'inject', 'fault', 'revert', 'alarmdrill']) {
      expect(serialized, `live bundle leaked "${term}"`).not.toContain(term);
    }
  }, 180_000);
});
